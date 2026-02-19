/**
 * Lock state returned from the backend as part of a note payload.
 */
export type LockInfo = {
    isLocked: boolean;
    lockedBy: string | null;
    expiresAt: string | null; // ISO timestamp
};

/**
 * Note payload as returned by the backend.
 */
export type Note = {
    id: number;
    title: string;
    content: string;
    updatedAt: string; // ISO timestamp
    lock: LockInfo;
};

/**
 * Body shape used by backend when a lock is denied (e.g. 423 Locked).
 */
export type LockErrorBody = {
    lockedBy?: string;
    expiresAt?: string;
};
