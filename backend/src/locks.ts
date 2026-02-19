import type {PoolConnection, RowDataPacket} from "mysql2/promise";
import {config} from "./config.js";

/**
 * Public lock payload returned by the API.
 */
export type LockInfo = {
    noteId: number;
    lockedBy: string;
    lockedAt: string; // DB datetime string
    expiresAt: string; // DB datetime string
};

/**
 * MySQL row shape for note_locks, typed as RowDataPacket so mysql2 generics work.
 */
type NoteLockRow = RowDataPacket & {
    note_id: number;
    locked_by: string;
    locked_at: string;
    expires_at: string;
    is_expired: number; // 0/1 computed column
};

/**
 * Produces SQL for "now + TTL" in UTC.
 *
 * MySQL: DATE_ADD(UTC_TIMESTAMP(), INTERVAL X SECOND)
 * Returns a SQL expression (not a parameter).
 */
function nowPlusTtlSqlExpression(): string {
    return `DATE_ADD(UTC_TIMESTAMP(), INTERVAL ${config.lockTtlSeconds} SECOND)`;
}

/**
 * Reads the current lock row for a note, including computed expiry flag.
 * Returns null if no lock row exists.
 */
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

/**
 * Atomically acquires or renews a note lock.
 *
 * Rules:
 * - If no lock exists: create lock for caller.
 * - If lock is expired: take over and become owner.
 * - If caller already owns lock: renew TTL.
 * - If another caller owns non-expired lock: do not modify; return 423 info.
 *
 * Atomicity:
 * - Guaranteed by PRIMARY KEY (note_id) + MySQL upsert statement.
 */
export async function acquireOrRenewLock(
    connection: PoolConnection,
    noteId: number,
    sessionId: string
): Promise<{ ok: true; lock: LockInfo } | { ok: false; lock: Pick<LockInfo, "lockedBy" | "expiresAt"> }> {
    await connection.query(
        `
            INSERT INTO note_locks (note_id, locked_by, locked_at, expires_at)
            VALUES (?, ?, UTC_TIMESTAMP(), ${nowPlusTtlSqlExpression()}) ON DUPLICATE KEY
            UPDATE
                locked_by = CASE
                WHEN expires_at <= UTC_TIMESTAMP() THEN
            VALUES (locked_by) -- takeover expired
                WHEN locked_by =
            VALUES (locked_by) THEN
            VALUES (locked_by) -- renew same owner
                ELSE locked_by -- keep other owner
            END
            ,
      locked_at = CASE
        WHEN expires_at <= UTC_TIMESTAMP() THEN UTC_TIMESTAMP()
        WHEN locked_by = VALUES(locked_by) THEN UTC_TIMESTAMP()
        ELSE locked_at
            END
            ,
      expires_at = CASE
        WHEN expires_at <= UTC_TIMESTAMP() THEN VALUES(expires_at)
        WHEN locked_by = VALUES(locked_by) THEN VALUES(expires_at)
        ELSE expires_at
            END
        `,
        [noteId, sessionId]
    );

    const currentLockRow = await readNoteLockRow(connection, noteId);

    // Defensive: should not happen because upsert guarantees a row.
    if (!currentLockRow) {
        return {ok: false, lock: {lockedBy: "unknown", expiresAt: new Date(0).toISOString()}};
    }

    const lockIsExpired = currentLockRow.is_expired === 1;
    const callerIsOwner = currentLockRow.locked_by === sessionId;

    if (callerIsOwner && !lockIsExpired) {
        return {
            ok: true,
            lock: {
                noteId: currentLockRow.note_id,
                lockedBy: currentLockRow.locked_by,
                lockedAt: currentLockRow.locked_at,
                expiresAt: currentLockRow.expires_at,
            },
        };
    }

    return {
        ok: false,
        lock: {
            lockedBy: currentLockRow.locked_by,
            expiresAt: currentLockRow.expires_at,
        },
    };
}

/**
 * Releases a lock if the caller owns it and it is not expired.
 *
 * If expired: cleanup and return noop.
 * If missing: noop.
 * If owned by another caller: forbidden.
 */
export async function releaseLock(
    connection: PoolConnection,
    noteId: number,
    sessionId: string
): Promise<"released" | "forbidden" | "noop"> {
    const currentLockRow = await readNoteLockRow(connection, noteId);
    if (!currentLockRow) return "noop";

    const lockIsExpired = currentLockRow.is_expired === 1;
    if (lockIsExpired) {
        await connection.query(`DELETE
                                FROM note_locks
                                WHERE note_id = ?`, [noteId]);
        return "noop";
    }

    if (currentLockRow.locked_by !== sessionId) return "forbidden";

    await connection.query(`DELETE
                            FROM note_locks
                            WHERE note_id = ?
                              AND locked_by = ?`, [noteId, sessionId]);
    return "released";
}

/**
 * Ensures the caller holds a valid (unexpired) lock.
 *
 * Returns ok=true only if:
 * - lock exists
 * - lock not expired
 * - locked_by matches sessionId
 */
export async function ensureValidLock(
    connection: PoolConnection,
    noteId: number,
    sessionId: string
): Promise<{ ok: true } | { ok: false; lockedBy?: string; expiresAt?: string }> {
    const currentLockRow = await readNoteLockRow(connection, noteId);
    if (!currentLockRow) return {ok: false};

    const lockIsExpired = currentLockRow.is_expired === 1;
    if (lockIsExpired) {
        await connection.query(`DELETE
                                FROM note_locks
                                WHERE note_id = ?`, [noteId]);
        return {ok: false};
    }

    if (currentLockRow.locked_by !== sessionId) {
        return {ok: false, lockedBy: currentLockRow.locked_by, expiresAt: currentLockRow.expires_at};
    }

    return {ok: true};
}
