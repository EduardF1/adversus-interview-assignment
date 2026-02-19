import type { Note } from "./domain.types";
import { requestJson } from "./http.client";

/**
 * Fetches all notes with computed lock state.
 */
export async function fetchNotes(): Promise<Note[]> {
    return requestJson<Note[]>("/notes");
}

/**
 * Attempts to acquire or renew a lock for the given note.
 * - 200: lock acquired or renewed
 * - 423: locked by another session
 */
export async function acquireOrRenewNoteLock(
    noteId: number
): Promise<{ expiresAt?: string }> {
    return requestJson<{ expiresAt?: string }>(`/notes/${noteId}/lock`, {
        method: "POST",
        // No body required by backend
    });
}

/**
 * Releases the current session's lock (best effort).
 * - 204: released or already absent
 * - 403: different owner
 */
export async function releaseNoteLock(noteId: number): Promise<void> {
    await requestJson<void>(`/notes/${noteId}/lock`, {
        method: "DELETE",
        // No body
    });
}

/**
 * Updates a note. Backend enforces that the caller holds a valid lock.
 */
export async function updateNote(
    noteId: number,
    title: string,
    content: string
): Promise<{ ok: true }> {
    return requestJson<{ ok: true }>(`/notes/${noteId}`, {
        method: "PUT",
        body: JSON.stringify({ title, content }),
    });
}
