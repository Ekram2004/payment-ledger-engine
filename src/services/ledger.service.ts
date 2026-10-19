import { PoolClient } from "pg";
import { db } from '../db/index.js';

export type EntryType = "DEBIT" | 'CREDIT';

export interface LedgerEntryInput {
    accountId: string;
    entryType: EntryType;
    amount: bigint;
}

export interface PostTransactionInput {
    paymentIntentId: string;
    description: string;
    entries: LedgerEntryInput[];
}

export interface LedgerTransactionResult {
    id: string;
    paymentIntentId: string;
    description: string;
    createdAt: Date;
    entriesCount: number
}

export class LedgerInvariantError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "LedgerInvariantError ";
    }
}

export class LedgerService {
    async postTransaction(
        input: PostTransactionInput,
        existingClient?: PoolClient
    ): Promise<LedgerTransactionResult>{
        const { paymentIntentId, description, entries } = input;

        if (!entries || entries.length < 2) {
            throw new LedgerInvariantError('A double-entry transaction must have at least 2 entries.');
        }

        for (const entry of entries) {
            if (entry.amount <= 0n) {
                throw new LedgerInvariantError(`Entry amount must be greater than zero. Received: ${entry.amount}`);
            }
        }

        let totalDebit = 0n;
        let totalCredit = 0n;

        for (const entry of entries) {
            if (entry.entryType === 'DEBIT') {
                totalDebit += entry.amount
            } else if (entry.entryType === 'CREDIT') {
                totalCredit += entry.amount;
            } else {
                throw new LedgerInvariantError(`Invalid entry type: ${entry.entryType}`);
            }
        }

        if (totalDebit !== totalCredit) {
            throw new LedgerInvariantError(
                `Ledger entries do not balance! Total DEBITS (${totalDebit}) !== Total CREDITS (${totalCredit})`
            );
        }

        const client = existingClient || (await db.connect());
        const isExternalClient = Boolean(existingClient);

        try {
            if (!isExternalClient) {
                await client.query('BEGIN');
            }

            const txResult = await client.query(
                `INSERT INTO ledger_transactions (payment_intent_id, description)
                VALUES ($1, $2)
                RETURNING id, payment_intent_id, description,
                created_at
                `,
                [paymentIntentId, description]
            );
            const ledgerTx = txResult.rows[0]

            for (const entry of entries) {
                await client.query(
                    `INSERT INTO ledger_entries(ledger_transaction_id, account_id, entry_type, amount)
                    VALUES ($1, $2, $3, $4)
                    `,
                    [ledgerTx.id, entry.accountId, entry.entryType, entry.amount.toString()]
                );
            }

            if (!isExternalClient) {
                await client.query('COMMIT');
            }

            return {
                id: ledgerTx.id,
                paymentIntentId: ledgerTx.payment_intent_id,
                description: ledgerTx.description,
                createdAt: ledgerTx.created_at,
                entriesCount: entries.length
            };
        } catch (error) {
            if (!isExternalClient) {
                await client.query('ROLLBACK');
            }
            throw error;
        } finally {
            if (!isExternalClient) {
                client.release();
            }
        }
    }

    async getAccountBalance(accountId: string): Promise<bigint>{
        const res = await db.query(
          `SELECT
            COALESCE(SUM(CASE WHEN entry_type = 'CREDIT' THEN
            amount ELSE 0 END), 0) AS total_credits,
            COALESCE(SUM(CASE WHEN entry_type = 'DEBIT' THEN
            amount ELSE 0 END), 0) AS total_debits
            FROM ledger_entries
            WHERE account_id = $1
            `,
            [accountId]
        );
        const credits = BigInt(res.rows[0].total_credits);
        const debits = BigInt(res.rows[0].total_debits)

        return credits - debits
    }
}

export const ledgerService = new LedgerService();