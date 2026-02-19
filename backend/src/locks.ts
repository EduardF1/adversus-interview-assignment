import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { config } from "./config.js";

export type LockInfo = {
    noteId: number;
    lockedBy: string;
    lockedAt: string;  // DB datetime
    expiresAt: string; // DB datetime
};

type NoteLockRow = RowDataPacket & {
    note_id: number;
    locked_by: string;
    locked_at: string;
    expires_at: string;
    is_expired: 0 | 1;
};

function nowPlusTtlSql(): string {
    return `DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${config.lockTtlSeconds} SECOND)`;
}

async function readNoteLockRow(connection: PoolConnection, noteId: number): Promise<NoteLockRow | null> {
    const [rows] = await connection.query<NoteLockRow[]>(
        `
            SELECT note_id,
                   locked_by,
                   locked_at,
                   expires_at,
                   (expires_at <= UTC_TIMESTAMP()) AS is_expired
            FROM note_locks
            WHERE note_id = ?
        `,
        [noteId]
    );

    return rows[0] ?? null;
}

export async function acquireOrRenewLock(
    connection: PoolConnection,
    noteId: number,
    sessionId: string
): Promise<
    | { ok: true; lock: LockInfo }
    | { ok: false; lock: Pick<LockInfo, "lockedBy" | "expiresAt"> }
> {
    // Upsert:
    // - Insert if missing
    // - Takeover if expired
    // - Renew if same owner
    // - Otherwise keep current owner
    await connection.query(
        `
      INSERT INTO note_locks (note_id, locked_by, locked_at, expires_at)
      VALUES (?, ?, UTC_TIMESTAMP(), ${nowPlusTtlSql()})
      ON DUPLICATE KEY UPDATE
        locked_by = CASE
          WHEN expires_at <= UTC_TIMESTAMP() THEN VALUES(locked_by)
          WHEN locked_by = VALUES(locked_by) THEN VALUES(locked_by)
          ELSE locked_by
        END,
        locked_at = CASE
          WHEN expires_at <= UTC_TIMESTAMP() THEN UTC_TIMESTAMP()
          WHEN locked_by = VALUES(locked_by) THEN UTC_TIMESTAMP()
          ELSE locked_at
        END,
        expires_at = CASE
          WHEN expires_at <= UTC_TIMESTAMP() THEN VALUES(expires_at)
          WHEN locked_by = VALUES(locked_by) THEN VALUES(expires_at)
          ELSE expires_at
        END
    `,
        [noteId, sessionId]
    );

    const row = await readNoteLockRow(connection, noteId);

    // Defensive: should not happen
    if (!row) {
        return { ok: false, lock: { lockedBy: "unknown", expiresAt: new Date(0).toISOString() } };
    }

    const callerIsOwner = row.locked_by === sessionId;

    if (callerIsOwner) {
        return {
            ok: true,
            lock: {
                noteId: row.note_id,
                lockedBy: row.locked_by,
                lockedAt: row.locked_at,
                expiresAt: row.expires_at,
            },
        };
    }

    return {
        ok: false,
        lock: {
            lockedBy: row.locked_by,
            expiresAt: row.expires_at,
        },
    };
}

export async function releaseLock(
    connection: PoolConnection,
    noteId: number,
    sessionId: string
): Promise<"released" | "forbidden" | "noop"> {
    const row = await readNoteLockRow(connection, noteId);
    if (!row) return "noop";

    if (row.is_expired === 1) {
        await connection.query("DELETE FROM note_locks WHERE note_id = ?", [noteId]);
        return "noop";
    }

    if (row.locked_by !== sessionId) return "forbidden";

    await connection.query("DELETE FROM note_locks WHERE note_id = ? AND locked_by = ?", [noteId, sessionId]);
    return "released";
}

export async function ensureValidLock(
    connection: PoolConnection,
    noteId: number,
    sessionId: string
): Promise<{ ok: true } | { ok: false; lockedBy?: string; expiresAt?: string }> {
    const row = await readNoteLockRow(connection, noteId);
    if (!row) return { ok: false };

    if (row.is_expired === 1) {
        await connection.query("DELETE FROM note_locks WHERE note_id = ?", [noteId]);
        return { ok: false };
    }

    if (row.locked_by !== sessionId) {
        return { ok: false, lockedBy: row.locked_by, expiresAt: row.expires_at };
    }

    return { ok: true };
}