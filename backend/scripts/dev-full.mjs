// Starts MySQL via docker compose, waits for HEALTHY, then starts backend dev server.
// Assumes Docker is already running.

import { spawn } from "node:child_process";

const COMPOSE_FILE = "../docker-compose.yml";
const MYSQL_CONTAINER_NAME = "adversus_mysql";

const IS_WIN = process.platform === "win32";

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

/**
 * Runs npm in a Windows-safe way.
 * - Windows: cmd /c npm <args>
 * - *nix: npm <args>
 */
function runNpm(args, options = {}) {
  if (IS_WIN) return run("cmd", ["/c", "npm", ...args], options);
  return run("npm", args, options);
}

async function waitForMysqlHealthy({ timeoutMs = 120_000, pollMs = 1500 } = {}) {
  const startedAt = Date.now();

  process.stdout.write("⏳ Waiting for MySQL to become healthy");
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
        process.stdout.write("\n✅ MySQL is healthy\n");
        return;
      }
      if (status === "unhealthy") throw new Error(`MySQL container is unhealthy: ${MYSQL_CONTAINER_NAME}`);
    } catch {
      // container might not exist yet; keep polling
    }

    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, pollMs));
  }

  process.stdout.write("\n");
  throw new Error(`Timed out waiting for MySQL to become healthy (${MYSQL_CONTAINER_NAME}).`);
}

async function main() {
  console.log("🚀 dev:full — bringing up MySQL (docker compose) ...");
  await run("docker", ["compose", "-f", COMPOSE_FILE, "up", "-d", "mysql"]);

  await waitForMysqlHealthy();

  console.log("▶ Starting backend dev server (tsx watch) ...");
  // This keeps running until you stop it (Ctrl+C)
  await runNpm(["run", "dev"]);
}

main().catch((error) => {
  console.error(`❌ dev:full failed: ${error?.message ?? error}`);
  process.exit(1);
});
