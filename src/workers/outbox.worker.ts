import { db } from "../db/index.js";

export class OutboxWorker {
    private isRunning = false;
    private timer: NodeJS.Timeout | null = null;

    constructor(private pollIntervalsMs: number = 3000) { }
    
    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        console.log('Outbox background worker started...');

        this.timer = setInterval(async () => {
          await this.processPendingEvents();
        }, this.pollIntervalsMs);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.isRunning = false;
        console.log('Outbox background worker stopped.');
    }

    async processPendingEvents() {
        const client = await db.connect();
        try {
            await client.query('BEGIN');
            const res = await client.query(
                `SELECT id, aggregate_type, aggregate_id, event_type, payload, retry_count
                FROM outbox_events
                WHERE status = 'PENDING'
                ORDER BY created_at ASC
                LIMIT 10
                FOR UPDATE SKIP LOCKED`
            );
            if (res.rowCount === 0) {
                await client.query('COMMIT');
                return;
            }
            const events = res.rows;
            console.log(`Outbox worker found ${events.length} pending events to publish.`);

            for (const event of events) {
                try {
                    await this.simulateWebhookDelivery(event.event_type, event.payload);

                    await client.query(
                        `UPDATE outbox_events SET status = 'PUBLISHED', updated_at=NOW() WHERE id = $1`,
                        [event.id]
                    );
                    console.log(`Successfully published outbox event: ${event.id}(${event.event_type})`);
                } catch (webhookErr: any) {
                    console.error(`Failed to deliver event ${event.id}: ${webhookErr.message}`);

                    const newRetryCount = event.retry_count + 1;
                    const newStatus = newRetryCount >= 5 ? 'FAILED' : 'PENDING';

                    await client.query(
                        `UPDATE outbox_events 
             SET retry_count = $1, status = $2, updated_at = NOW() 
             WHERE id = $3`,
                        [newRetryCount, newStatus, event.id]
                    );
                }
            }
            await client.query('COMMIT');
        } catch (err: any) {
            await client.query("ROLLBACK");
            console.error('Outbox worker processing error:', err.message);
        } finally {
            client.release();
        }
    }

    private async simulateWebhookDelivery(eventType: string, payload: any): Promise<void>{
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                if (Math.random() < 0.1) {
                    reject(new Error('Simulated network timeout connecting to merchant webhook URL'));
                } else {
                    resolve();
                }
            }, 200);
        });
    }
}

export const outboxWorker = new OutboxWorker();