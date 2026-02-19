import dotenv from "dotenv";

dotenv.config();

/**
 * Reads a required environment variable or throws with a clear message.
 */
function requireEnv(variableName: string): string {
    const value = process.env[variableName];
    if (!value) throw new Error(`Missing env var: ${variableName}`);
    return value;
}

/**
 * Central configuration for the backend.
 *
 * Conventions:
 * - Use UTC timestamps in SQL (UTC_TIMESTAMP()).
 * - `LOCK_TTL_SECONDS` defines how long a lock is valid without renewal.
 */
export const config = {
    port: Number(process.env.PORT ?? 8080),
    db: {
        host: requireEnv("DB_HOST"),
        port: Number(process.env.DB_PORT ?? 3306),
        user: requireEnv("DB_USER"),
        password: requireEnv("DB_PASSWORD"),
        database: requireEnv("DB_NAME"),
    },
    lockTtlSeconds: Number(process.env.LOCK_TTL_SECONDS ?? 120),
} as const;
