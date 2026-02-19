import { describe, test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.js";
import { pool } from "../src/db.js";

type LockResponseBody = {
    noteId: number;
    lockedBy: string;
    lockedAt: string;
    expiresAt: string;
};

describe("Notes API - per-note locking", () => {
    beforeEach(async () => {
        // Arrange: deterministic lock state per test
        await pool.query(`DELETE FROM note_locks`);
    });

    afterEach(async () => {
        // Critical: ensure we don't leave locks behind after ANY test,
        // otherwise test:full smoke step may wait for TTL expiry.
        await pool.query(`DELETE FROM note_locks`);
    });

    after(async () => {
        // Ensure Node's test runner doesn't detect dangling DB handles.
        await pool.end();
    });

    test(
        "Given note is unlocked, when session A locks then session B is denied, updates require lock, and lock can be released",
        async () => {
            // Arrange
            const app = buildApp({ logger: false });
            await app.ready();

            const noteId = 1;
            const sessionA = "sessionA";
            const sessionB = "sessionB";

            try {
                // Act + Assert: A acquires lock
                const lockByAResponse = await app.inject({
                    method: "POST",
                    url: `/notes/${noteId}/lock`,
                    headers: { "x-session-id": sessionA },
                });
                assert.equal(lockByAResponse.statusCode, 200);

                // Act + Assert: B denied
                const lockByBResponse = await app.inject({
                    method: "POST",
                    url: `/notes/${noteId}/lock`,
                    headers: { "x-session-id": sessionB },
                });
                assert.equal(lockByBResponse.statusCode, 423);

                // Act + Assert: B cannot update
                const updateByBResponse = await app.inject({
                    method: "PUT",
                    url: `/notes/${noteId}`,
                    headers: { "x-session-id": sessionB, "content-type": "application/json" },
                    payload: { content: "B should not update" },
                });
                assert.equal(updateByBResponse.statusCode, 423);

                // Act + Assert: A can update
                const updateByAResponse = await app.inject({
                    method: "PUT",
                    url: `/notes/${noteId}`,
                    headers: { "x-session-id": sessionA, "content-type": "application/json" },
                    payload: { content: "Updated by A" },
                });
                assert.equal(updateByAResponse.statusCode, 200);

                // Act + Assert: A releases lock
                const releaseByAResponse = await app.inject({
                    method: "DELETE",
                    url: `/notes/${noteId}/lock`,
                    headers: { "x-session-id": sessionA },
                });
                assert.equal(releaseByAResponse.statusCode, 204);

                // Act + Assert: B can now acquire
                const lockByBAfterReleaseResponse = await app.inject({
                    method: "POST",
                    url: `/notes/${noteId}/lock`,
                    headers: { "x-session-id": sessionB },
                });
                assert.equal(lockByBAfterReleaseResponse.statusCode, 200);
            } finally {
                await app.close();
            }
        }
    );

    test(
        "Given session A holds a lock, when A re-acquires the lock then the lock is renewed and session B is still denied",
        async () => {
            // Arrange
            const app = buildApp({ logger: false });
            await app.ready();

            const noteId = 1;
            const sessionA = "sessionA";
            const sessionB = "sessionB";

            try {
                const firstAcquireResponse = await app.inject({
                    method: "POST",
                    url: `/notes/${noteId}/lock`,
                    headers: { "x-session-id": sessionA },
                });
                assert.equal(firstAcquireResponse.statusCode, 200);

                const firstAcquireBody = firstAcquireResponse.json() as LockResponseBody;

                // small delay so renewed timestamp differs (keeps it robust on fast machines)
                await new Promise((resolve) => setTimeout(resolve, 25));

                // Act: renew by same owner
                const renewResponse = await app.inject({
                    method: "POST",
                    url: `/notes/${noteId}/lock`,
                    headers: { "x-session-id": sessionA },
                });
                assert.equal(renewResponse.statusCode, 200);

                const renewBody = renewResponse.json() as LockResponseBody;

                // Assert: still owned by A
                assert.equal(renewBody.lockedBy, sessionA);

                // Assert: expiresAt moved forward (>=)
                const firstExpiresAtMs = Date.parse(firstAcquireBody.expiresAt);
                const renewedExpiresAtMs = Date.parse(renewBody.expiresAt);
                assert.ok(
                    renewedExpiresAtMs >= firstExpiresAtMs,
                    `Expected renewed expiresAt (${renewBody.expiresAt}) to be >= initial expiresAt (${firstAcquireBody.expiresAt})`
                );

                // Assert: B still denied
                const acquireByBResponse = await app.inject({
                    method: "POST",
                    url: `/notes/${noteId}/lock`,
                    headers: { "x-session-id": sessionB },
                });
                assert.equal(acquireByBResponse.statusCode, 423);
            } finally {
                await app.close();
            }
        }
    );

    test(
        "Given session A holds a lock, when the lock expires then session B can take over and session A can no longer update",
        async () => {
            // Arrange
            const app = buildApp({ logger: false });
            await app.ready();

            const noteId = 1;
            const sessionA = "sessionA";
            const sessionB = "sessionB";

            try {
                const acquireByAResponse = await app.inject({
                    method: "POST",
                    url: `/notes/${noteId}/lock`,
                    headers: { "x-session-id": sessionA },
                });
                assert.equal(acquireByAResponse.statusCode, 200);

                // Force-expire the lock in DB (no sleeping, no flakiness)
                await pool.query(
                    `UPDATE note_locks SET expires_at = DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE note_id = ?`,
                    [noteId]
                );

                // Act + Assert: B can acquire after expiry
                const acquireByBResponse = await app.inject({
                    method: "POST",
                    url: `/notes/${noteId}/lock`,
                    headers: { "x-session-id": sessionB },
                });
                assert.equal(acquireByBResponse.statusCode, 200);

                // Act + Assert: A can no longer update (lock is gone / owned by B)
                const updateByAResponse = await app.inject({
                    method: "PUT",
                    url: `/notes/${noteId}`,
                    headers: { "x-session-id": sessionA, "content-type": "application/json" },
                    payload: { content: "A should NOT be able to update after expiry takeover" },
                });
                assert.equal(updateByAResponse.statusCode, 423);

                // And B can update
                const updateByBResponse = await app.inject({
                    method: "PUT",
                    url: `/notes/${noteId}`,
                    headers: { "x-session-id": sessionB, "content-type": "application/json" },
                    payload: { content: "Updated by B after takeover" },
                });
                assert.equal(updateByBResponse.statusCode, 200);
            } finally {
                await app.close();
            }
        }
    );
});
