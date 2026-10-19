import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../src/db/index.js';
import { LedgerService, LedgerInvariantError, ledgerService } from '../src/services/ledger.service.js';

describe('Double-Entry Ledger Service Invariants', () => {
    let merchantId: string;
    let customerAccountId: string;
    let merchantAccountId: string;
    let paymentIntentId: string;

    beforeAll(async () => {
      const merchantRes = await db.query(
        `INSERT INTO merchants (name, api_key_hash)
            VALUES ('test Merchant Corp', 'test_hash_123')
            RETURNING id
            `,
      );
      merchantId = merchantRes.rows[0].id;

      const custAcc = await db.query(
        `INSERT INTO accounts(merchant_id, type, currency)
            VALUES($1, 'CUSTOMER_FUNDS', 'ETB') RETURNING id`,
        [merchantId],
      );
      customerAccountId = custAcc.rows[0].id;

      const merchAcc = await db.query(
        `INSERT INTO accounts (merchant_id, type, currency) VALUES ($1, 'MERCHANT_CLEARING', 'ETB') RETURNING id`,
        [merchantId],
      );
      merchantAccountId = merchAcc.rows[0].id;

      const piRes = await db.query(
        `INSERT INTO payment_intents (merchant_id, amount, currency, status) 
       VALUES ($1, 250000, 'ETB', 'PROCESSING') RETURNING id`,
        [merchantId],
      );
      paymentIntentId = piRes.rows[0].id;
    });


    afterAll(async () => {
        await db.query(
          "TRUNCATE TABLE ledger_entries, ledger_transactions, payment_intents, accounts, merchants RESTART IDENTITY CASCADE",
        );

        await db.end();
    });

    it('should successfully post a balanced 2,500 ETB transaction (Debits === Credits)', async () => {
        const amount = 250000n;

        const result = await ledgerService.postTransaction({
            paymentIntentId,
            description: 'Custome order #1001 payment',
            entries: [
                { accountId: customerAccountId, entryType: 'DEBIT', amount },
                { accountId: merchantAccountId, entryType: 'CREDIT', amount },
            ],
        });
        expect(result.id).toBeDefined();
        expect(result.entriesCount).toBe(2);

        const merchantBalance = await ledgerService.getAccountBalance(merchantAccountId);
        expect(merchantBalance).toBe(250000n);

        const customerBalance = await ledgerService.getAccountBalance(customerAccountId);
        expect(customerBalance).toBe(-250000n);
    });

    it('should REJECT an unbalanced transaction and rollback cleanly (Zero-Sum invariant)', async () => {
        const promise = ledgerService.postTransaction({
            paymentIntentId,
            description: "Fraudlent or buggy unbalanced transaction",
            entries: [
                {
                    accountId: customerAccountId,
                    entryType: "DEBIT",
                    amount: 250000n,
                },
                {
                    accountId: merchantAccountId,
                    entryType: "CREDIT",
                    amount: 200000n,
                },
            ],
        });
        await expect(promise).rejects.toThrow(LedgerInvariantError);

        const checkRes = await db.query(
          `SELECT COUNT(*) FROM ledger_transactions WHERE description = 'Fraudlent or buggy unbalanced transaction'`,
        );
        expect(Number(checkRes.rows[0].count)).toBe(0);
    });

    it('should REJECT transactions with negative or zero amounts', async () => {
        const promise = ledgerService.postTransaction({
            paymentIntentId,
            description: "Negative amount exploit",
            entries: [
                {
                    accountId: customerAccountId,
                    entryType: "DEBIT",
                    amount: -5000n,
                },
                {
                    accountId: merchantAccountId,
                    entryType: "CREDIT",
                    amount: -5000n,
                },
            ],
        });
        await expect(promise).rejects.toThrow(LedgerInvariantError);
    });
})