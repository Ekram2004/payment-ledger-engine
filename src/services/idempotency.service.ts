import crypto from "crypto";
import { PoolClient } from "pg";
import { db } from "../db/index.js";

export interface IdempotencyRecord {
  id: string;
  merchantId: string;
  key: string;
  requestHash: string;
  responseCode: number | null;
  responseBody: any;
  status: "IN_PROGRESS" | "COMPLETED";
}

export class IdempotencyConflictError extends Error {
  constructor(
    message: string,
    public statusCode: number = 409,
  ) {
    super(message);
    this.name = "IdempotencyConflictError";
  }
}


export class IdempotencyService {
  generateRequestHash(path: string, body: any): string {
    const raw = `${path}:${JSON.stringify(body || {})}`;
    return crypto.createHash("sha256").update(raw).digest("hex");
  }

  async lockKey(
    merchantId: string,
    key: string,
    requestHash: string,
  ): Promise<{ isNew: boolean; existingRecord?: IdempotencyRecord }> {
    const client: PoolClient = await db.connect();

    try {
      await client.query("BEGIN");

      const existingRes = await client.query(
        `SELECT id, merchant_id, key, request_hash,response_code, response_body, status FROM idempotency_keys WHERE merchant_id = $1 AND key = $2 FOR UPDATE`,
        [merchantId, key],
      );

      if (existingRes.rowCount && existingRes.rowCount > 0) {
        await client.query("COMMIT");
        const existing = existingRes.rows[0];
        if (existing.request_hash !== requestHash) {
          throw new IdempotencyConflictError(
            "Idempotency key reused with a different request payload.",
            422,
          );
        }
        if (existing.status === "IN_PROGRESS") {
          throw new IdempotencyConflictError(
            "A request with this idempotency key is currently being processed.",
            409,
          );
        }

        return {
          isNew: false,
          existingRecord: {
            id: existing.id,
            merchantId: existing.merchant_id,
            key: existing.key,
            requestHash: existing.request_hash,
            responseCode: existing.response_code,
            responseBody: existing.response_body,
            status: existing.status,
          },
        };
      }
      await client.query(
        `INSERT INTO idempotency_keys (merchant_id, key, request_hash, status)
         VALUES ($1, $2, $3, 'IN_PROGRESS')`,
        [merchantId, key, requestHash],
      );

      await client.query("COMMIT");
      return { isNew: true };
    } catch (err: any) {
      await client.query("ROLLBACK");

      if (err.code === "23505") {
        throw new IdempotencyConflictError(
          "Concurrent request detected with the same idempotency key.",
          409,
        );
      }
      throw err;
    } finally {
      client.release();
    }
  }
  async saveResponse(
    merchantId: string,
    key: string,
    responseCode: number,
    responseBody: any,
  ): Promise<void> {
    await db.query(
      `UPDATE idempotency_keys
       SET status = 'COMPLETED', response_code = $1, response_body = $2, updated_at = NOW()
       WHERE merchant_id = $3 AND key = $4`,
      [responseCode, JSON.stringify(responseBody), merchantId, key],
    );
  }
}

export const idempotencyService = new IdempotencyService();
