import { buildApp } from "./app.js";
import { outboxWorker } from "./workers/outbox.worker.js";
import dotenv from 'dotenv'

dotenv.config()

const start = async () => {
    const app = buildApp();
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

    try {
        await app.listen({ port, host: '0.0.0.0' });
        console.log(`Payment Ledger Engine running on http://localhost:${port}`);
        outboxWorker.start();
    } catch (err) {
        app.log.error(err);
        process.exit(1)
    }
}

start();