import Fastify from "fastify";
import cors from "@fastify/cors";
import { config } from "./config";

async function main() {
    const app = Fastify({ logger: true });

    await app.register(cors, {
        origin: true,
        allowedHeaders: ["Content-Type", "X-Session-Id"],
    });

    app.get("/health", async () => ({ ok: true }));

    await app.listen({ port: config.port, host: "0.0.0.0" });
    app.log.info(`Server running on http://localhost:${config.port}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
