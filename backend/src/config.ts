export const config = {
    port: Number(process.env.PORT ?? 8080),
    db: {
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 3306),
        user: process.env.DB_USER ?? "root",
        password: process.env.DB_PASSWORD ?? "root",
        database: process.env.DB_NAME ?? "notesdb",
    },
    locking: {
        ttlSeconds: Number(process.env.LOCK_TTL_SECONDS ?? 120),
    },
};
