import Fastify from "fastify";
import cors from "@fastify/cors";
import type {RowDataPacket, ResultSetHeader} from "mysql2/promise";
import {pool} from "./db.js";
import {config} from "./config.js";
import {acquireOrRenewLock, ensureValidLock, releaseLock} from "./locks.js";

export function buildApp(options?: { logger?: boolean }) {
    const app = Fastify({logger: options?.logger ?? true});
    app.register(cors, {origin: true});

    function getSessionIdHeader(request: any): string | null {
        const headerValue = request.headers["x-session-id"];
        if (!headerValue) return null;
        if (Array.isArray(headerValue)) return headerValue[0] ?? null;
        return String(headerValue);
    }

    app.get("/health", async () => ({ok: true}));

    type NoteListRow = RowDataPacket & {
        id: number;
        title: string;
        content: string;
        updatedAt: string;
        lockedBy: string | null;
        expiresAt: string | null;
        isLocked: number;
    };

    app.get("/notes", async () => {
        await pool.query(`DELETE
                          FROM note_locks
                          WHERE expires_at <= UTC_TIMESTAMP()`);

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

        return noteRows.map((noteRow) => ({
            id: noteRow.id,
            title: noteRow.title,
            content: noteRow.content,
            updatedAt: noteRow.updatedAt,
            lock:
                noteRow.isLocked === 1
                    ? {isLocked: true, lockedBy: noteRow.lockedBy, expiresAt: noteRow.expiresAt}
                    : {isLocked: false, lockedBy: null, expiresAt: null},
        }));
    });

    app.post<{ Params: { id: string } }>("/notes/:id/lock", async (request, reply) => {
        const sessionId = getSessionIdHeader(request);
        if (!sessionId) return reply.code(400).send({error: "Missing x-session-id"});

        const noteId = Number(request.params.id);
        if (!Number.isFinite(noteId)) return reply.code(400).send({error: "Invalid note id"});

        const connection = await pool.getConnection();
        try {
            const [noteExistsRows] = await connection.query<RowDataPacket[]>(`SELECT id
                                                                              FROM notes
                                                                              WHERE id = ?`, [noteId]);
            if (!noteExistsRows[0]) return reply.code(404).send({error: "Note not found"});

            const lockAttemptResult = await acquireOrRenewLock(connection, noteId, sessionId);
            if (lockAttemptResult.ok) return reply.code(200).send(lockAttemptResult.lock);
            return reply.code(423).send(lockAttemptResult.lock);
        } finally {
            connection.release();
        }
    });

    app.delete<{ Params: { id: string } }>("/notes/:id/lock", async (request, reply) => {
        const sessionId = getSessionIdHeader(request);
        if (!sessionId) return reply.code(400).send({error: "Missing x-session-id"});

        const noteId = Number(request.params.id);
        if (!Number.isFinite(noteId)) return reply.code(400).send({error: "Invalid note id"});

        const connection = await pool.getConnection();
        try {
            const releaseResult = await releaseLock(connection, noteId, sessionId);
            if (releaseResult === "forbidden") return reply.code(403).send({error: "Forbidden"});
            return reply.code(204).send();
        } finally {
            connection.release();
        }
    });

    app.put<{ Params: { id: string }; Body: { title?: string; content?: string } }>("/notes/:id", async (request, reply) => {
        const sessionId = getSessionIdHeader(request);
        if (!sessionId) return reply.code(400).send({error: "Missing x-session-id"});

        const noteId = Number(request.params.id);
        if (!Number.isFinite(noteId)) return reply.code(400).send({error: "Invalid note id"});

        const {title, content} = request.body ?? {};
        if (typeof title !== "string" && typeof content !== "string") {
            return reply.code(400).send({error: "Nothing to update"});
        }

        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const lockCheckResult = await ensureValidLock(connection, noteId, sessionId);
            if (!lockCheckResult.ok) {
                await connection.rollback();
                return reply.code(423).send({
                    lockedBy: lockCheckResult.lockedBy ?? null,
                    expiresAt: lockCheckResult.expiresAt ?? null,
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
                [typeof title === "string" ? title : null, typeof content === "string" ? content : null, noteId]
            );

            if (updateResult.affectedRows === 0) {
                await connection.rollback();
                return reply.code(404).send({error: "Note not found"});
            }

            await connection.commit();
            return reply.code(200).send({ok: true});
        } catch (error) {
            await connection.rollback();
            request.log.error(error);
            return reply.code(500).send({error: "Internal error"});
        } finally {
            connection.release();
        }
    });

    return app;
}
