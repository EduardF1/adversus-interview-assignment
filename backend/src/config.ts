import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`Missing env var: ${name}`);
    return value;
}

function readIntEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;

    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) throw new Error(`Env var ${name} must be an integer (got: "${raw}")`);
    return parsed;
}

function clampInt(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

const port = readIntEnv("PORT", 8080);

const lockTtlSecondsRaw = readIntEnv("LOCK_TTL_SECONDS", 120);
const lockTtlSeconds = clampInt(lockTtlSecondsRaw, 10, 10 * 60);

export const config = {
    port,
    db: {
        host: requireEnv("DB_HOST"),
        port: readIntEnv("DB_PORT", 3306),
        user: requireEnv("DB_USER"),
        password: requireEnv("DB_PASSWORD"),
        database: requireEnv("DB_NAME"),
    },
    lockTtlSeconds,
} as const;