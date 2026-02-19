import { getOrCreateSessionId } from "./session.identity";
import type { LockErrorBody } from "./domain.types";

/**
 * Strongly-typed HTTP error that carries HTTP status and parsed JSON body (if any).
 */
export class HttpError extends Error {
    public readonly status: number;
    public readonly body: unknown;

    constructor(message: string, status: number, body: unknown) {
        super(message);
        this.status = status;
        this.body = body;
    }

    /**
     * Attempts to interpret the error body as a lock error.
     */
    public asLockErrorBody(): LockErrorBody | null {
        if (!this.body || typeof this.body !== "object") return null;
        return this.body as LockErrorBody;
    }
}

/**
 * Single source of truth for API base URL.
 * - In dev: default to http://localhost:8080
 * - In prod: can be set via VITE_API_BASE_URL
 */
const API_BASE_URL =
    (import.meta as any).env?.VITE_API_BASE_URL?.toString?.() || "http://localhost:8080";

/**
 * Builds a final URL:
 * - If url is absolute -> leave as-is
 * - If url is relative -> prefix with API_BASE_URL
 */
function resolveUrl(url: string): string {
    if (/^https?:\/\//i.test(url)) return url;
    return `${API_BASE_URL}${url.startsWith("/") ? "" : "/"}${url}`;
}

/**
 * Sends requests to the backend, always including `x-session-id`.
 * - Only sets JSON content-type if a JSON body is present.
 */
export async function requestJson<TResponse>(
    url: string,
    init: RequestInit = {}
): Promise<TResponse> {
    const sessionId = getOrCreateSessionId();

    const finalUrl = resolveUrl(url);

    const hasBody = init.body !== undefined && init.body !== null;

    // If body exists and is NOT FormData, we assume JSON unless caller overrides.
    const isFormData =
        typeof FormData !== "undefined" && init.body instanceof FormData;

    const headers = new Headers(init.headers);

    headers.set("x-session-id", sessionId);

    // IMPORTANT: Only set content-type when we actually send a JSON body.
    // This prevents Fastify from throwing on DELETE with no body.
    if (hasBody && !isFormData && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
    }

    const response = await fetch(finalUrl, {
        ...init,
        headers,
    });

    // 204 No Content
    if (response.status === 204) return undefined as TResponse;

    const text = await response.text();

    let parsed: unknown = null;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            // Non-JSON response (shouldn't happen in this app, but keep safe)
            parsed = text;
        }
    }

    if (!response.ok) {
        throw new HttpError(
            `Request failed: ${response.status} ${response.statusText}`,
            response.status,
            parsed
        );
    }

    return parsed as TResponse;
}
