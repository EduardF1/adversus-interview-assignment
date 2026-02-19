import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function startServer(): Promise<void> {
    const [{ buildApp }, { config }] = await Promise.all([
        import("./app.js"),
        import("./config.js"),
    ]);

    const app = buildApp({ logger: true });

    try {
        await app.listen({ port: config.port, host: "0.0.0.0" });
        app.log.info(`Server listening on port ${config.port}`);
    } catch (error: unknown) {
        app.log.error(error as Error, "Failed to start server");
        process.exit(1);
    }

    const shutdown = async () => {
        try {
            app.log.info("Shutting down server...");
            await app.close();
            process.exit(0);
        } catch (error: unknown) {
            app.log.error(error as Error, "Error during shutdown");
            process.exit(1);
        }
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

startServer();