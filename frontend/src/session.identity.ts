const SESSION_STORAGE_KEY = "sessionId";

/**
 * Returns the current session id stored in localStorage.
 * If absent, generates a new UUID and persists it.
 *
 * This matches the assignment requirement for identifying users/sessions. :contentReference[oaicite:1]{index=1}
 */
export function getOrCreateSessionId(): string {
    const existingSessionId = localStorage.getItem(SESSION_STORAGE_KEY);
    if (existingSessionId) return existingSessionId;

    const newSessionId = crypto.randomUUID();
    localStorage.setItem(SESSION_STORAGE_KEY, newSessionId);
    return newSessionId;
}
