import { test, expect } from "@playwright/test";

test("page loads and lists notes", async ({ page, request }) => {
    // Best-effort reset (if backend started with E2E=1)
    await request.post("http://localhost:8080/__test__/reset").catch(() => {});

    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh" })).toBeVisible();

    // Sanity: at least one Edit button exists
    await expect(page.getByRole("button", { name: "Edit" }).first()).toBeVisible();
});