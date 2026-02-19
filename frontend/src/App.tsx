import {useCallback, useEffect, useMemo, useRef, useState} from "react";
import type {Note} from "./domain.types";
import {getOrCreateSessionId} from "./session.identity";
import {HttpError} from "./http.client";
import {
    acquireOrRenewNoteLock,
    fetchNotes,
    releaseNoteLock,
    updateNote,
} from "./notes.api";

type EditorState =
    | { kind: "idle" }
    | { kind: "locking"; noteId: number }
    | {
    kind: "editing";
    noteId: number;
    title: string;
    content: string;
    /** ISO timestamp for when the current lock expires (server time). */
    expiresAt: string | null;
}
    | {
    kind: "blocked";
    noteId: number;
    lockedBy: string | null;
    expiresAt: string | null;
};

/**
 * Some MySQL drivers return DATETIME as:
 *  - "YYYY-MM-DD HH:mm:ss"   (no timezone)
 *  - or ISO with "Z"
 *
 * Our backend uses UTC timestamps. If a timezone is missing, we must
 * interpret it as UTC to avoid "locks appear expired" in local timezones.
 */
function normalizeUtcIsoTimestamp(rawTimestamp: string | null | undefined): string | null {
    if (!rawTimestamp) return null;

    const trimmed = rawTimestamp.trim();

    // Already ISO with timezone (Z or ±hh:mm)
    if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed)) {
        return trimmed;
    }

    // MySQL DATETIME "YYYY-MM-DD HH:mm:ss" -> treat as UTC
    // Convert space to "T" and append "Z"
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
        return `${trimmed.replace(" ", "T")}Z`;
    }

    // ISO without timezone: "YYYY-MM-DDTHH:mm:ss" -> treat as UTC
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
        return `${trimmed}Z`;
    }

    // Unknown format; keep as-is (best effort)
    return trimmed;
}

/** Returns true if the timestamp (assumed UTC) is in the future. */
function isFutureUtcTimestamp(expiresAtIso: string | null): boolean {
    const normalized = normalizeUtcIsoTimestamp(expiresAtIso);
    if (!normalized) return false;

    const expiresAtMs = Date.parse(normalized);
    if (Number.isNaN(expiresAtMs)) return false;

    return expiresAtMs > Date.now();
}

/**
 * Hook that provides a stable "now" that ticks on an interval.
 * Used for countdown UI without creating per-card intervals.
 */
function useNowMs(tickMilliseconds = 1000): number {
    const [nowMs, setNowMs] = useState(() => Date.now());

    useEffect(() => {
        const intervalId = window.setInterval(() => setNowMs(Date.now()), tickMilliseconds);
        return () => window.clearInterval(intervalId);
    }, [tickMilliseconds]);

    return nowMs;
}

/** Returns milliseconds until expiry. If expiry is invalid or past, returns 0. */
function millisecondsUntil(expiresAtIso: string | null | undefined, nowMs: number): number {
    const normalized = normalizeUtcIsoTimestamp(expiresAtIso ?? null);
    if (!normalized) return 0;

    const expiresAtMs = Date.parse(normalized);
    if (Number.isNaN(expiresAtMs)) return 0;

    return Math.max(0, expiresAtMs - nowMs);
}

/** Formats milliseconds as "m:ss". */
function formatCountdownMmSs(millisecondsRemaining: number): string {
    const totalSeconds = Math.floor(millisecondsRemaining / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export default function App() {
    const sessionId = useMemo(() => getOrCreateSessionId(), []);
    const nowMs = useNowMs(1000);

    const [notes, setNotes] = useState<Note[]>([]);
    const [isRefreshing, setIsRefreshing] = useState(false);
    const [globalError, setGlobalError] = useState<string | null>(null);
    const [editorState, setEditorState] = useState<EditorState>({kind: "idle"});

    const lockHeartbeatIntervalId = useRef<number | null>(null);

    const stopHeartbeat = useCallback((): void => {
        if (lockHeartbeatIntervalId.current !== null) {
            window.clearInterval(lockHeartbeatIntervalId.current);
            lockHeartbeatIntervalId.current = null;
        }
    }, []);

    const refreshNotes = useCallback(async (): Promise<void> => {
        setIsRefreshing(true);
        setGlobalError(null);

        try {
            const serverNotes = await fetchNotes();
            setNotes(serverNotes);

            // If editing, align the editor lock expiry with the latest backend projection.
            setEditorState((currentState) => {
                if (currentState.kind !== "editing") return currentState;

                const matchingNote = serverNotes.find((note) => note.id === currentState.noteId);
                const projectedExpiresAt = matchingNote?.lock?.expiresAt ?? currentState.expiresAt;

                return {
                    ...currentState,
                    expiresAt: projectedExpiresAt ? normalizeUtcIsoTimestamp(projectedExpiresAt) : currentState.expiresAt,
                };
            });
        } catch (error: unknown) {
            setGlobalError(error instanceof Error ? error.message : "Failed to load notes");
        } finally {
            setIsRefreshing(false);
        }
    }, []);

    useEffect(() => {
        refreshNotes();
        return () => stopHeartbeat();
    }, [refreshNotes, stopHeartbeat]);

    const beginEditing = useCallback(
        async (note: Note): Promise<void> => {
            setGlobalError(null);
            setEditorState({kind: "locking", noteId: note.id});

            try {
                const lockResult = await acquireOrRenewNoteLock(note.id);

                const normalizedExpiresAt =
                    normalizeUtcIsoTimestamp(lockResult.expiresAt ?? note.lock.expiresAt ?? null);

                setEditorState({
                    kind: "editing",
                    noteId: note.id,
                    title: note.title,
                    content: note.content,
                    expiresAt: normalizedExpiresAt,
                });

                stopHeartbeat();

                // Renew lock every 30 seconds (heartbeat).
                lockHeartbeatIntervalId.current = window.setInterval(async () => {
                    try {
                        const renewedLock = await acquireOrRenewNoteLock(note.id);
                        const renewedExpiresAt = normalizeUtcIsoTimestamp(renewedLock.expiresAt ?? null);

                        if (renewedExpiresAt) {
                            setEditorState((currentState) => {
                                if (currentState.kind !== "editing") return currentState;
                                if (currentState.noteId !== note.id) return currentState;
                                return {...currentState, expiresAt: renewedExpiresAt};
                            });
                        }
                    } catch (renewError: unknown) {
                        if (renewError instanceof HttpError && renewError.status === 423) {
                            const lockInfo = renewError.asLockErrorBody();
                            setEditorState({
                                kind: "blocked",
                                noteId: note.id,
                                lockedBy: lockInfo?.lockedBy ?? null,
                                expiresAt: normalizeUtcIsoTimestamp(lockInfo?.expiresAt ?? null),
                            });
                            stopHeartbeat();
                            refreshNotes();
                        }
                    }
                }, 30_000);

                // Best-effort release on tab close.
                const handleBeforeUnload = () => {
                    releaseNoteLock(note.id).catch(() => {
                    });
                };
                window.addEventListener("beforeunload", handleBeforeUnload, {once: true});
            } catch (error: unknown) {
                if (error instanceof HttpError && error.status === 423) {
                    const lockInfo = error.asLockErrorBody();
                    setEditorState({
                        kind: "blocked",
                        noteId: note.id,
                        lockedBy: lockInfo?.lockedBy ?? note.lock.lockedBy ?? null,
                        expiresAt: normalizeUtcIsoTimestamp(lockInfo?.expiresAt ?? note.lock.expiresAt ?? null),
                    });
                } else {
                    setGlobalError(error instanceof Error ? error.message : "Failed to acquire lock");
                    setEditorState({kind: "idle"});
                }

                refreshNotes();
            }
        },
        [refreshNotes, stopHeartbeat]
    );

    const cancelEditing = useCallback(async (): Promise<void> => {
        if (editorState.kind !== "editing") return;

        const noteId = editorState.noteId;
        setGlobalError(null);

        try {
            await releaseNoteLock(noteId);
        } catch {
            // Best-effort
        } finally {
            stopHeartbeat();
            setEditorState({kind: "idle"});
            refreshNotes();
        }
    }, [editorState, refreshNotes, stopHeartbeat]);

    const saveEditing = useCallback(async (): Promise<void> => {
        if (editorState.kind !== "editing") return;

        const {noteId, title, content} = editorState;
        setGlobalError(null);

        try {
            await updateNote(noteId, title, content);
            await releaseNoteLock(noteId);

            stopHeartbeat();
            setEditorState({kind: "idle"});
            refreshNotes();
        } catch (error: unknown) {
            if (error instanceof HttpError && error.status === 423) {
                const lockInfo = error.asLockErrorBody();
                setEditorState({
                    kind: "blocked",
                    noteId,
                    lockedBy: lockInfo?.lockedBy ?? null,
                    expiresAt: normalizeUtcIsoTimestamp(lockInfo?.expiresAt ?? null),
                });
                stopHeartbeat();
                refreshNotes();
            } else {
                setGlobalError(error instanceof Error ? error.message : "Failed to save note");
            }
        }
    }, [editorState, refreshNotes, stopHeartbeat]);

    const activeNoteId =
        editorState.kind === "editing" || editorState.kind === "locking" || editorState.kind === "blocked"
            ? editorState.noteId
            : null;

    return (
        <div className="min-h-full bg-slate-50 text-slate-900">
            <div className="mx-auto max-w-3xl px-4 py-8">
                <div className="flex items-start justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-semibold">Notes</h1>
                        <p className="mt-1 text-xs text-slate-600">
                            Session: <span className="font-mono">{sessionId}</span>
                        </p>
                    </div>

                    <button
                        className="rounded-md bg-white px-3 py-2 text-sm font-medium shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                        onClick={refreshNotes}
                        disabled={isRefreshing}
                    >
                        {isRefreshing ? "Refreshing…" : "Refresh"}
                    </button>
                </div>

                {globalError && (
                    <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                        {globalError}
                    </div>
                )}

                <div className="mt-6 space-y-3">
                    {notes.map((note) => {
                        const normalizedNoteExpiresAt = normalizeUtcIsoTimestamp(note.lock.expiresAt);
                        const isLockActive = note.lock.isLocked && isFutureUtcTimestamp(normalizedNoteExpiresAt);

                        const isLockedByAnotherSession =
                            isLockActive && note.lock.lockedBy !== null && note.lock.lockedBy !== sessionId;

                        const isLockedByThisSession =
                            isLockActive && note.lock.lockedBy !== null && note.lock.lockedBy === sessionId;

                        const isActiveCard = activeNoteId === note.id;

                        const effectiveExpiresAt =
                            editorState.kind === "editing" && editorState.noteId === note.id
                                ? normalizeUtcIsoTimestamp(editorState.expiresAt)
                                : normalizedNoteExpiresAt;

                        const millisecondsRemaining = millisecondsUntil(effectiveExpiresAt, nowMs);

                        return (
                            <div key={note.id} className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
                                <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <h2 className="truncate text-lg font-semibold">{note.title}</h2>
                                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                        #{note.id}
                      </span>
                                        </div>

                                        <div className="mt-1 text-xs text-slate-600">
                                            {!isLockActive ? (
                                                <span>Unlocked</span>
                                            ) : isLockedByThisSession ? (
                                                <span>
                          Locked by <span className="font-mono">you</span> (expires in{" "}
                                                    <span className="font-mono">{formatCountdownMmSs(millisecondsRemaining)}</span>)
                        </span>
                                            ) : (
                                                <span>
                          Locked by <span className="font-mono">{note.lock.lockedBy}</span> (expires in{" "}
                                                    <span className="font-mono">{formatCountdownMmSs(millisecondsRemaining)}</span>)
                        </span>
                                            )}
                                        </div>
                                    </div>

                                    <button
                                        className={[
                                            "rounded-md px-3 py-2 text-sm font-medium shadow-sm ring-1",
                                            isLockedByAnotherSession
                                                ? "cursor-not-allowed bg-slate-100 text-slate-400 ring-slate-200"
                                                : "bg-slate-900 text-white ring-slate-900 hover:bg-slate-800",
                                        ].join(" ")}
                                        disabled={isLockedByAnotherSession || editorState.kind === "locking"}
                                        onClick={() => beginEditing(note)}
                                    >
                                        {isActiveCard && editorState.kind === "locking" ? "Locking…" : "Edit"}
                                    </button>
                                </div>

                                {!isActiveCard && (
                                    <p className="mt-3 whitespace-pre-wrap text-sm text-slate-800">{note.content}</p>
                                )}

                                {isActiveCard && editorState.kind === "blocked" && (
                                    <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                                        Locked by{" "}
                                        <span className="font-mono">{editorState.lockedBy ?? "another session"}</span>
                                        {editorState.expiresAt ? (
                                            <>
                                                {" "}
                                                until{" "}
                                                <span className="font-mono">
                          {new Date(normalizeUtcIsoTimestamp(editorState.expiresAt) ?? editorState.expiresAt).toLocaleTimeString()}
                        </span>
                                            </>
                                        ) : null}
                                        <div className="mt-2">
                                            <button
                                                className="rounded-md bg-white px-3 py-2 text-sm font-medium shadow-sm ring-1 ring-amber-200 hover:bg-amber-100"
                                                onClick={() => {
                                                    setEditorState({kind: "idle"});
                                                    refreshNotes();
                                                }}
                                            >
                                                OK
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {isActiveCard && editorState.kind === "editing" && (
                                    <div className="mt-3 space-y-3">
                                        <div className="grid gap-2">
                                            <label className="text-xs font-medium text-slate-600">Title</label>
                                            <input
                                                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
                                                value={editorState.title}
                                                onChange={(event) =>
                                                    setEditorState((currentState) =>
                                                        currentState.kind === "editing"
                                                            ? {...currentState, title: event.target.value}
                                                            : currentState
                                                    )
                                                }
                                            />
                                        </div>

                                        <div className="grid gap-2">
                                            <label className="text-xs font-medium text-slate-600">Content</label>
                                            <textarea
                                                className="min-h-[120px] w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-slate-400"
                                                value={editorState.content}
                                                onChange={(event) =>
                                                    setEditorState((currentState) =>
                                                        currentState.kind === "editing"
                                                            ? {...currentState, content: event.target.value}
                                                            : currentState
                                                    )
                                                }
                                            />
                                        </div>

                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                            <div className="text-xs text-slate-600">
                                                Lock expires in{" "}
                                                <span className="font-mono">{formatCountdownMmSs(millisecondsRemaining)}</span>
                                            </div>

                                            <div className="flex gap-2">
                                                <button
                                                    className="rounded-md bg-white px-3 py-2 text-sm font-medium shadow-sm ring-1 ring-slate-200 hover:bg-slate-50"
                                                    onClick={cancelEditing}
                                                >
                                                    Cancel
                                                </button>

                                                <button
                                                    className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm ring-1 ring-emerald-600 hover:bg-emerald-500"
                                                    onClick={saveEditing}
                                                >
                                                    Save
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                <p className="mt-8 text-xs text-slate-500">
                    Open this app in an incognito window to simulate a second session and verify lock behavior.
                </p>
            </div>
        </div>
    );
}