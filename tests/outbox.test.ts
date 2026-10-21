import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../src/db/index.js";
import { paymentService } from "../src/services/payment.service.js";
import { OutboxWorker } from "../src/workers/outbox.worker.js";

describe('Transactional Outbox Pattern', () => {
    let merchantId: string;
    let customerAccountId: string;
    let merchantAccountId: string;
    let worker: OutboxWorker;
 
    beforeAll(async () => {
        const merchantRes = await db.query(
            `INSERT INTO merchants (name, api_key_hash) VALUES ('Outbox Test Merchant', 'hash_outbox_123') RETURNING id`,
        );
        merchantId = merchantRes.rows[0].id;

        const custAcc = await db.query(
            `INSERT INTO accounts (merchant_id, type, currency) VALUES ($1, 'CUSTOMER_FUNDS', 'ETB') RETURNING id`,
            [merchantId],
        );
        customerAccountId = custAcc.rows[0].id;

        const merchAcc = await db.query(
            `INSERT INTO accounts (merchant_id, type, currency) VALUES ($1, 'MERCHANT_CLEARING', 'ETB') RETURNING id`,
            [merchantId],
        );
        merchantAccountId = merchAcc.rows[0].id;
        worker = new OutboxWorker(500);
    });
    afterAll(async () => {
        worker.stop();
        await db.query("DELETE FROM outbox_events");
        await db.query("DELETE FROM ledger_entries");
        await db.query("DELETE FROM ledger_transactions");
        await db.query("DELETE FROM payment_intents");
        await db.query("DELETE FROM accounts");
        await db.query("DELETE FROM merchants");
    });

    it('should write an outbox event atomatically when payment succeeds and publish it', async () => {
        const pi = await paymentService.createPaymentIntent({
            merchantId,
            amount: 500000n,
        });

        await paymentService.transitionStatus(
            pi.id,
            "PROCESSING",
            "txn_prov_999",
        );

        await paymentService.transitionStatus(
            pi.id,
            'SUCCEEDED',
            undefined,
            customerAccountId,
            merchantAccountId
        );

        const checkRes = await db.query(
            `SELECT id, status, event_type FROM outbox_events WHERE aggregate_id = $1`,
            [pi.id]
        );
        expect(checkRes.rowCount).toBe(1);
        expect(checkRes.rows[0].event_type).toBe("PAYMENT_SUCCEEDED");
        expect(checkRes.rows[0].status).toBe("PENDING");

        await worker.processPendingEvents();

        const publishedRes = await db.query(
            `SELECT status FROM outbox_events WHERE id = $1`,
            [checkRes.rows[0].id],
        );
        expect(publishedRes.rows[0].status).toBe("PUBLISHED");
    });
});