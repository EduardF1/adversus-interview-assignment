// backend/scripts/test-full.mjs
// Brings up MySQL (docker compose), runs build + integration tests,
// then runs smoke tests.
// If backend already runs on localhost:8080, we reuse it (no port conflict).
// Otherwise we start backend (with E2E=1), smoke test, then stop it.

import { spawn } from "node:child_process";

const COMPOSE_FILE = "../docker-compose.yml";
const MYSQL_CONTAINER_NAME = "adversus_mysql";
const BASE_URL = "http://localhost:8080";
const HEALTH_URL = `${BASE_URL}/health`;

const IS_WIN = process.platform === "win32";

// -------------------------
// ANSI Colors
// -------------------------
const c = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    gray: "\x1b[90m",
};

// -------------------------
// Console helpers
// -------------------------
const INDENT = "  ";

function step(title) {
    console.log(`\n${c.cyan}${c.bold}${title}${c.reset}`);
}

function info(msg) {
    console.log(`${INDENT}${msg}`);
}

function ok(msg) {
    console.log(`${INDENT}${c.green}${msg}${c.reset}`);
}

function warn(msg) {
    console.log(`${INDENT}${c.yellow}${msg}${c.reset}`);
}

function fail(msg) {
    console.error(`${INDENT}${c.red}${msg}${c.reset}`);
}

function dots(prefix) {
    process.stdout.write(`${INDENT}${c.gray}${prefix}${c.reset}`);
}

function dot() {
    process.stdout.write(`${c.gray}.${c.reset}`);
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
    if (IS_WIN) return run("cmd", ["/c", "npm", ...args], options);
    return run("npm", args, options);
}

// -------------------------
// Docker / health checks
// -------------------------
async function waitForMysqlHealthy({ timeoutMs = 120_000, pollMs = 1500 } = {}) {
    const startedAt = Date.now();
    dots("Waiting for MySQL to become healthy");

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

            if (status === "unhealthy")
                throw new Error(`MySQL container is unhealthy: ${MYSQL_CONTAINER_NAME}`);
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
    dots(`Waiting for backend health at ${HEALTH_URL}`);

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const res = await fetch(HEALTH_URL, { method: "GET" });
            if (res.ok) {
                nl();
                ok("Backend is healthy");
                return;
            }
        } catch {}

        dot();
        await new Promise((r) => setTimeout(r, 500));
    }

    nl();
    throw new Error("Backend did not become healthy in time");
}

// -------------------------
// Backend lifecycle
// -------------------------
function spawnBackend() {
    return spawn("node", ["dist/server.js"], {
        stdio: "inherit",
        shell: false,
        env: {
            ...process.env,
            E2E: "1",
        },
    });
}

async function stopProcess(child, { timeoutMs = 5000 } = {}) {
    if (!child || child.killed) return;

    info("Stopping backend server...");
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
        await run("powershell", [
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            "scripts/smoke-locks.ps1",
        ]);
        return;
    }
    throw new Error("Smoke script requires PowerShell (pwsh) on non-Windows.");
}

// -------------------------
// Main
// -------------------------
async function main() {
    step("test:full");

    info("Bringing up MySQL (docker compose)...");
    await run("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "mysql"]);
    await waitForMysqlHealthy();

    info("Building project...");
    await runNpm(["run", "build"]);

    info("Running integration tests...");
    await runNpm(["test"]);

    const alreadyRunning = await isBackendAlreadyRunning();

    if (alreadyRunning) {
        warn("Backend already running on http://localhost:8080 — reusing it.");
        info("Running smoke tests...");
        await runSmoke();
        ok("test:full PASSED");
        return;
    }

    info("Starting backend server...");
    const server = spawnBackend();

    try {
        await waitForBackendHealthy();
        info("Running smoke tests...");
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