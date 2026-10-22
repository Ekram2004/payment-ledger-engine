import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../src/db/index.js";
import { paymentService } from "../src/services/payment.service.js";
import { reconciliationJob } from "../src/jobs/reconciliation.job.js";

describe("Financial Reconciliation Engine", () => {
  let merchantId: string;

  beforeAll(async () => {
    const mRes = await db.query(
      `INSERT INTO merchants (name, api_key_hash) VALUES ('Recon Merchant', 'hash_recon_123') RETURNING id`,
    );
    merchantId = mRes.rows[0].id;
  });

  afterAll(async () => {
    await db.query("DELETE FROM payment_intents");
    await db.query("DELETE FROM merchants");
  });

  it("should flag discrepancies when external gateway records do not match internal state", async () => {

    const pi = await paymentService.createPaymentIntent({
      merchantId,
      amount: 100000n, 
    });
    await paymentService.transitionStatus(
      pi.id,
      "PROCESSING",
      "gateway_txn_mismatch",
    );

    
    const gatewayReport = [
      {
        providerRef: "gateway_txn_mismatch",
        amount: 100000n,
        status: "SUCCESS" as const, 
      },
      {
        providerRef: "gateway_txn_ghost_record",
        amount: 50000n,
        status: "SUCCESS" as const, 
      },
    ];

    const result =
      await reconciliationJob.runDailyReconciliation(gatewayReport);

    expect(result.checked).toBe(2);
    expect(result.discrepancies.length).toBe(2);
    expect(result.discrepancies[0].issue).toContain("State mismatch");
    expect(result.discrepancies[1].issue).toContain(
      "missing in internal database",
    );
  });
});
