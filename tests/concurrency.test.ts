import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../src/db/index.js";
import { buildApp } from "../src/app.js";



describe('Idempotency & Concurrency Guarantees', () => {
    const app = buildApp();
    let merchantId: string;

    beforeAll(async () => {
        await app.ready();
        const res = await app.inject({
            method: 'POST',
            url: '/api/merchants',
            payload: { name: 'Concurrency Store', apiKeyHash: 'hash_conc_999' }
        });
        merchantId = res.json().merchant.id
    });
    afterAll(async () => {
        await db.query("DELETE FROM idempotency_keys");
        await db.query("DELETE FROM payment_intents");
        await db.query("DELETE FROM accounts");
        await db.query("DELETE FROM merchants");
        await app.close();
    });

    it('should create exactly ONE payment when 50 concurrent requests use the same idempotency key', async () => {
        const idempotencyKey = 'req_idemp_burst_001';
        const payload = { merchantId, amount: 250000 };

        const requestPromises = Array.from({ length: 50 }).map(() => app.inject({
            method: 'POST',
            url: '/api/payment-intents',
            headers: {
                'idempotency-key': idempotencyKey,
                'content-type': 'application/json'
            },
            payload
        }));

        const responses = await Promise.all(requestPromises);
        const createdResponses = responses.filter((r) => r.statusCode === 201 || r.statusCode === 200);
        const conflictResponses = responses.filter((r) => r.statusCode === 409);
        console.log(
            `Concurrent Burst Results -> Success/Cached: ${createdResponses.length}, Conflicts (409): ${conflictResponses.length}`,
        );

        const dbCheck = await db.query(`SELECT COUNT(*) FROM payment_intents WHERE merchant_id = $1`, [merchantId]);
        expect(Number(dbCheck.rows[0].count)).toBe(1);

        const firstPaymentId = createdResponses[0].json().id;
        for (const res of createdResponses) {
            expect(res.json().id).toBe(firstPaymentId);
        }
    });

    it("should Reject key reuse when request payload differes (Fingerprint Mismatch)", async () => {
      const idempotencyKey = "req_idemp_mismatch_002";

      await app.inject({
        method: "POST",
        url: "/api/payment-intents",
        headers: {
          "idempotency-key": idempotencyKey,
          "content-type": "application/json",
        },
        payload: { merchantId, amount: 600000 },
      });
      const mismatchRes = await app.inject({
        method: "POST",
        url: "/api/payment-intents",
        headers: {
          "idempotency-key": idempotencyKey,
          "content-type": "application/json",
        },
        payload: { merchantId, amount: 500000 },
      });

      expect(mismatchRes.statusCode).toBe(422); 
      expect(mismatchRes.json().error).toContain("different request payload");
    });

});