import { db } from "../db/index.js";

export interface ExternalProviderTransaction {
  providerRef: string;
  amount: bigint;
  status: "SUCCESS" | "FAILED" | "PENDING";
}

export interface ReconciliationDiscrepancy {
  paymentIntentId: string;
  providerRef: string;
  internalStatus: string;
  externalStatus: string;
  issue: string;
}

export class ReconciliationJob {
  async runDailyReconciliation(
    externalGatewayRecords: ExternalProviderTransaction[],
  ): Promise<{ checked: number; discrepancies: ReconciliationDiscrepancy[] }> {
    const discrepancies: ReconciliationDiscrepancy[] = [];
    let checked = 0;

    for (const ext of externalGatewayRecords) {
      checked++;

      const res = await db.query(
        `SELECT id, status, amount FROM payment_intents WHERE provider_ref = $1`,
        [ext.providerRef],
      );

      if (res.rowCount === 0) {
        discrepancies.push({
          paymentIntentId: "NOT_FOUND_INTERNALLY",
          providerRef: ext.providerRef,
          internalStatus: "NONE",
          externalStatus: ext.status,
          issue:
            "Transaction exists at gateway but is missing in internal database!",
        });
        continue;
      }
      const internal = res.rows[0];
      const internalStatus = internal.status;

      let expectedInternalStatus = "PROCESSING";
      if (ext.status === "SUCCESS") expectedInternalStatus = "SUCCEEDED";
      if (ext.status === "FAILED") expectedInternalStatus = "FAILED";

      if (internalStatus !== expectedInternalStatus) {
        discrepancies.push({
          paymentIntentId: internal.id,
          providerRef: ext.providerRef,
          internalStatus,
          externalStatus: ext.status,
          issue: `State mismatch! Internal status is '${internalStatus}' but gateway reported '${ext.status}'.`,
        });
      }
      if (BigInt(internal.amount) !== ext.amount) {
        discrepancies.push({
          paymentIntentId: internal.id,
          providerRef: ext.providerRef,
          internalStatus,
          externalStatus: ext.status,
          issue: `Amount mismatch! Internal amount (${internal.amount}) != Gateway amount (${ext.amount}).`,
        });
      }
    }
    console.log(
      `Reconciliation complete. Checked: ${checked}, Discrepancies found: ${discrepancies.length}`,
    );
    return { checked, discrepancies };
  }
}

export const reconciliationJob = new ReconciliationJob();