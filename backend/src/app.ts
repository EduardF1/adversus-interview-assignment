import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { pool } from "./db.js";
import { acquireOrRenewLock, ensureValidLock, releaseLock } from "./locks.js";

export type BuildAppOptions = {
    logger?: boolean;
};

type SessionId = string;

type NoteListRow = RowDataPacket & {
    id: number;
    title: string;
    content: string;
    updatedAt: string;
    lockedBy: string | null;
    expiresAt: string | null;
    isLocked: 0 | 1;
};

function isTestResetEnabled(): boolean {
    return process.env.NODE_ENV === "test" || process.env.E2E === "1";
}

function readSessionId(request: FastifyRequest): SessionId | null {
    const headerValue = request.headers["x-session-id"];
    if (!headerValue) return null;
    if (Array.isArray(headerValue)) return headerValue[0] ? String(headerValue[0]) : null;
    return String(headerValue);
}

function parseNoteId(raw: string): number | null {
    const noteId = Number(raw);
    return Number.isFinite(noteId) ? noteId : null;
}

function badRequest(reply: FastifyReply, error: string) {
    return reply.code(400).send({ error });
}

function notFound(reply: FastifyReply, error: string) {
    return reply.code(404).send({ error });
}

function forbidden(reply: FastifyReply, error: string) {
    return reply.code(403).send({ error });
}

function locked(reply: FastifyReply, body: { lockedBy: string | null; expiresAt: string | null }) {
    return reply.code(423).send(body);
}

export function buildApp(options?: BuildAppOptions): FastifyInstance {
    const app = Fastify({ logger: options?.logger ?? true });

    app.register(cors, {
        origin: true,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["content-type", "x-session-id"],
    });

    app.get("/health", async () => ({ ok: true }));

    if (isTestResetEnabled()) {
        app.post("/__test__/reset", async () => {
            await pool.query("DELETE FROM note_locks");
            return { ok: true };
        });
    }

    app.get("/notes", async () => {
        // Cleanup expired locks first (best-effort)
        await pool.query("DELETE FROM note_locks WHERE expires_at <= UTC_TIMESTAMP()");

        const [noteRows] = await pool.query<NoteListRow[]>(
            `
        SELECT notes.id,
               notes.title,
               notes.content,
               notes.updated_at                          AS updatedAt,
               note_locks.locked_by                      AS lockedBy,
               note_locks.expires_at                     AS expiresAt,
               (note_locks.expires_at > UTC_TIMESTAMP()) AS isLocked
        FROM notes
                 LEFT JOIN note_locks ON note_locks.note_id = notes.id
        ORDER BY notes.id ASC
      `
        );

        return noteRows.map((row) => ({
            id: row.id,
            title: row.title,
            content: row.content,
            updatedAt: row.updatedAt,
            lock:
                row.isLocked === 1
                    ? { isLocked: true, lockedBy: row.lockedBy, expiresAt: row.expiresAt }
                    : { isLocked: false, lockedBy: null, expiresAt: null },
        }));
    });

    app.post<{ Params: { id: string } }>("/notes/:id/lock", async (request, reply) => {
        const sessionId = readSessionId(request);
        if (!sessionId) return badRequest(reply, "Missing x-session-id");

        const noteId = parseNoteId(request.params.id);
        if (noteId === null) return badRequest(reply, "Invalid note id");

        const connection = await pool.getConnection();
        try {
            const [existsRows] = await connection.query<RowDataPacket[]>(
                "SELECT id FROM notes WHERE id = ?",
                [noteId]
            );

            if (!existsRows[0]) return notFound(reply, "Note not found");

            const lockAttempt = await acquireOrRenewLock(connection, noteId, sessionId);
            if (lockAttempt.ok) return reply.code(200).send(lockAttempt.lock);

            // Same payload, different status
            return reply.code(423).send(lockAttempt.lock);
        } finally {
            connection.release();
        }
    });

    app.delete<{ Params: { id: string } }>("/notes/:id/lock", async (request, reply) => {
        const sessionId = readSessionId(request);
        if (!sessionId) return badRequest(reply, "Missing x-session-id");

        const noteId = parseNoteId(request.params.id);
        if (noteId === null) return badRequest(reply, "Invalid note id");

        const connection = await pool.getConnection();
        try {
            const releaseResult = await releaseLock(connection, noteId, sessionId);
            if (releaseResult === "forbidden") return forbidden(reply, "Forbidden");
            return reply.code(204).send();
        } finally {
            connection.release();
        }
    });

    app.put<{ Params: { id: string }; Body: { title?: string; content?: string } }>(
        "/notes/:id",
        async (request, reply) => {
            const sessionId = readSessionId(request);
            if (!sessionId) return badRequest(reply, "Missing x-session-id");

            const noteId = parseNoteId(request.params.id);
            if (noteId === null) return badRequest(reply, "Invalid note id");

            const { title, content } = request.body ?? {};
            const hasTitle = typeof title === "string";
            const hasContent = typeof content === "string";

            if (!hasTitle && !hasContent) {
                return badRequest(reply, "Nothing to update");
            }

            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();

                const lockCheck = await ensureValidLock(connection, noteId, sessionId);
                if (!lockCheck.ok) {
                    await connection.rollback();
                    return locked(reply, {
                        lockedBy: lockCheck.lockedBy ?? null,
                        expiresAt: lockCheck.expiresAt ?? null,
                    });
                }

                const [updateResult] = await connection.query<ResultSetHeader>(
                    `
            UPDATE notes
            SET title      = COALESCE(?, title),
                content    = COALESCE(?, content),
                updated_at = UTC_TIMESTAMP()
            WHERE id = ?
          `,
                    [hasTitle ? title : null, hasContent ? content : null, noteId]
                );

                if (updateResult.affectedRows === 0) {
                    await connection.rollback();
                    return notFound(reply, "Note not found");
                }

                await connection.commit();
                return reply.code(200).send({ ok: true });
            } catch (error) {
                await connection.rollback();
                request.log.error(error);
                return reply.code(500).send({ error: "Internal error" });
            } finally {
                connection.release();
            }
        }
    );

    return app;
}