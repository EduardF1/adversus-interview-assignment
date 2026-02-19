// backend/scripts/test-full.mjs
// Brings up MySQL (docker compose), runs build + integration tests,
// then runs smoke tests.
// If backend already runs on localhost:8080, we reuse it (no port conflict).
// Otherwise we start backend, smoke test, then stop it.

import { spawn } from "node:child_process";

const COMPOSE_FILE = "../docker-compose.yml";
const MYSQL_CONTAINER_NAME = "adversus_mysql";
const BASE_URL = "http://localhost:8080";
const HEALTH_URL = `${BASE_URL}/health`;

const IS_WIN = process.platform === "win32";

// -------------------------
// Console helpers (indentation / structure)
// -------------------------
const INDENT = "  ";
function step(title) {
    console.log(`\n${title}`);
}
function info(msg) {
    console.log(`${INDENT}${msg}`);
}
function ok(msg) {
    console.log(`${INDENT}✅ ${msg}`);
}
function warn(msg) {
    console.log(`${INDENT}ℹ️  ${msg}`);
}
function fail(msg) {
    console.error(`${INDENT}❌ ${msg}`);
}
function dots(prefix) {
    process.stdout.write(`${INDENT}${prefix}`);
}
function dot() {
    process.stdout.write(".");
}
function nl() {
    process.stdout.write("\n");
}

// -------------------------
// Process helpers
// -------------------------
function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: "inherit",
            shell: false,
            ...options,
        });

        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
        });
    });
}

function runCapture(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
            ...options,
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString()));
        child.stderr.on("data", (d) => (stderr += d.toString()));

        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(`${command} ${args.join(" ")} failed (${code}). ${stderr}`));
        });
    });
}

function runNpm(args, options = {}) {
    // Windows-safe npm spawning
    if (IS_WIN) return run("cmd", ["/c", "npm", ...args], options);
    return run("npm", args, options);
}

// -------------------------
// Docker / health checks
// -------------------------
async function waitForMysqlHealthy({ timeoutMs = 120_000, pollMs = 1500 } = {}) {
    const startedAt = Date.now();
    dots("⏳ Waiting for MySQL to become healthy");

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const { stdout } = await runCapture("docker", [
                "inspect",
                "-f",
                "{{.State.Health.Status}}",
                MYSQL_CONTAINER_NAME,
            ]);

            const status = stdout.trim();
            if (status === "healthy") {
                nl();
                ok("MySQL is healthy");
                return;
            }
            if (status === "unhealthy") throw new Error(`MySQL container is unhealthy: ${MYSQL_CONTAINER_NAME}`);
        } catch {
            // container might not exist yet
        }

        dot();
        await new Promise((r) => setTimeout(r, pollMs));
    }

    nl();
    throw new Error(`Timed out waiting for MySQL to become healthy (${MYSQL_CONTAINER_NAME}).`);
}

async function isBackendAlreadyRunning() {
    try {
        const res = await fetch(HEALTH_URL, { method: "GET" });
        return res.ok;
    } catch {
        return false;
    }
}

async function waitForBackendHealthy({ timeoutMs = 30_000 } = {}) {
    const startedAt = Date.now();
    dots(`⏳ Waiting for backend health at ${HEALTH_URL}`);

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const res = await fetch(HEALTH_URL, { method: "GET" });
            if (res.ok) {
                nl();
                ok("Backend is healthy");
                return;
            }
        } catch {
            // retry
        }

        dot();
        await new Promise((r) => setTimeout(r, 500));
    }

    nl();
    throw new Error("Backend did not become healthy in time");
}

// -------------------------
// Backend process lifecycle
// -------------------------
function spawnBackend() {
    // run compiled server directly
    return spawn("node", ["dist/server.js"], { stdio: "inherit", shell: false });
}

async function stopProcess(child, { timeoutMs = 5000 } = {}) {
    if (!child || child.killed) return;

    info("🛑 stopping backend server ...");
    child.kill("SIGTERM");

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (child.exitCode !== null) return;
        await new Promise((r) => setTimeout(r, 100));
    }

    child.kill("SIGKILL");
}

// -------------------------
// Smoke runner
// -------------------------
async function runSmoke() {
    if (IS_WIN) {
        await run("powershell", ["-ExecutionPolicy", "Bypass", "-File", "scripts/smoke-locks.ps1"]);
        return;
    }
    throw new Error("Smoke script is PowerShell-only on non-Windows (requires pwsh).");
}

// -------------------------
// Main
// -------------------------
async function main() {
    step("🧪 test:full");

    info("bringing up MySQL (docker compose) ...");
    await run("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "mysql"]);
    await waitForMysqlHealthy();

    info("🏗️  build ...");
    await runNpm(["run", "build"]);

    info("🧪 integration tests ...");
    await runNpm(["test"]);

    const alreadyRunning = await isBackendAlreadyRunning();

    if (alreadyRunning) {
        warn("Backend already running on http://localhost:8080 — reusing it for smoke tests.");
        info("💨 smoke tests ...");
        await runSmoke();
        ok("test:full PASSED");
        return;
    }

    info("▶ starting backend server ...");
    const server = spawnBackend();

    try {
        await waitForBackendHealthy();
        info("💨 smoke tests ...");
        await runSmoke();
        ok("test:full PASSED");
    } finally {
        await stopProcess(server);
    }
}

main().catch((err) => {
    fail(`test:full failed: ${err?.message ?? err}`);
    process.exit(1);
});
