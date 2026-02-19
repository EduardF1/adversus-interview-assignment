import { test, expect, type Page, type Locator } from "@playwright/test";

const API_BASE = "http://localhost:8080";

async function resetLocks(request: any) {
    await request.post(`${API_BASE}/__test__/reset`);
}

function noteCards(page: Page): Locator {
    return page.locator("div.rounded-lg");
}

function noteCardById(page: Page, noteId: string): Locator {
    return noteCards(page).filter({ has: page.getByText(`#${noteId}`) }).first();
}

async function waitForNotesLoaded(page: Page) {
    // Wait for the list to exist
    await expect(noteCards(page).first()).toBeVisible({ timeout: 15000 });

    // Wait for initial refresh to finish (button text becomes "Refresh")
    // (Your UI toggles label, so use that as a stable signal)
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible({ timeout: 15000 });
}

async function getNoteIdFromCard(card: Locator): Promise<string> {
    const idText = await card.getByText(/^#\d+$/).first().innerText();
    return idText.replace("#", "").trim();
}

async function tryOpenEditorOnCard(card: Locator): Promise<"editing" | "blocked"> {
    await card.getByRole("button", { name: "Edit" }).click();

    const saveInCard = card.getByRole("button", { name: "Save" });
    const lockedByInCard = card.getByText("Locked by");

    const result = await Promise.race([
        saveInCard.waitFor({ state: "visible", timeout: 8000 }).then(() => "editing" as const),
        lockedByInCard.waitFor({ state: "visible", timeout: 8000 }).then(() => "blocked" as const),
    ]);

    if (result === "blocked") {
        const ok = card.getByRole("button", { name: "OK" });
        if (await ok.isVisible().catch(() => false)) await ok.click();
    }

    return result;
}

async function openAnyNoteForEditing(page: Page): Promise<{ noteId: string; card: Locator }> {
    await waitForNotesLoaded(page);

    const cards = noteCards(page);
    const count = await cards.count();

    for (let i = 0; i < count; i++) {
        const card = cards.nth(i);

        const edit = card.getByRole("button", { name: "Edit" });
        if (!(await edit.isVisible().catch(() => false))) continue;

        const noteId = await getNoteIdFromCard(card);
        const outcome = await tryOpenEditorOnCard(card);

        if (outcome === "editing") return { noteId, card };
    }

    throw new Error("Could not open any note in editing mode (notes not ready or all truly locked).");
}

async function fetchLockState(request: any, noteId: string) {
    const res = await request.get(`${API_BASE}/notes`);
    expect(res.ok()).toBeTruthy();
    const notes = (await res.json()) as any[];
    const note = notes.find((n) => String(n.id) === String(noteId));
    if (!note) throw new Error(`Note ${noteId} not found from API`);
    return note.lock;
}

test("lock blocks other session and releases after save/cancel", async ({ browser, request }) => {
    // Reset once at test start (avoid inheriting locks)
    await resetLocks(request);

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await pageA.goto("/");
    await pageB.goto("/");

    await expect(pageA.getByRole("heading", { name: "Notes" })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "Notes" })).toBeVisible();

    // Ensure both pages actually loaded notes before interacting
    await waitForNotesLoaded(pageA);
    await waitForNotesLoaded(pageB);

    // A: open any note in edit mode
    const { noteId } = await openAnyNoteForEditing(pageA);

    const cardA = noteCardById(pageA, noteId);
    const cardB = noteCardById(pageB, noteId);

    await expect(cardA).toBeVisible();
    await expect(cardB).toBeVisible();

    // B tries to edit -> should be blocked
    await cardB.getByRole("button", { name: "Edit" }).click();
    await expect(cardB.getByText("Locked by")).toBeVisible({ timeout: 10000 });
    await expect(cardB.getByRole("button", { name: "OK" })).toBeVisible();

    // A saves (UI flow also releases lock)
    await cardA.locator("textarea").fill(`Updated by E2E ${Date.now()}`);
    await cardA.getByRole("button", { name: "Save" }).click();

    // Wait until backend actually reports unlocked (most stable signal)
    await expect
        .poll(async () => {
            const lock = await fetchLockState(request, noteId);
            return lock?.isLocked === false;
        }, { timeout: 15000, intervals: [250, 500, 1000] })
        .toBe(true);

    // Now B refreshes once and opens editor successfully
    await pageB.getByRole("button", { name: "Refresh" }).click();

    // Clear any lingering modal if present
    const okB = cardB.getByRole("button", { name: "OK" });
    if (await okB.isVisible().catch(() => false)) await okB.click();

    await cardB.getByRole("button", { name: "Edit" }).click();
    await expect(cardB.getByRole("button", { name: "Save" })).toBeVisible({ timeout: 10000 });

    await ctxA.close();
    await ctxB.close();
});