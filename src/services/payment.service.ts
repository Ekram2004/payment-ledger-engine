import { PoolClient } from "pg";
import { db } from "../db/index.js";
import { ledgerService, LedgerService } from "./ledger.service.js";

export type PaymentStatus = 'CREATED' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

export class InvalidStateTransitionError extends Error{
    constructor(from: PaymentStatus, to: PaymentStatus) {
        super(`Illegal state transition from ${from} to ${to}`);
        this.name = 'InvalidStateTransitionError';
    }
}

export interface CreatePaymentIntentInput {
    merchantId: string;
    amount: bigint;
    currency?: string;
}

export interface PaymentIntentRecord{
    id: string;
    merchantId: string;
    amount: bigint;
    currency: string;
    status: PaymentStatus;
    providerRef: string | null;
    createdAt: Date;
    updatedAt: Date;
}

export class PaymentService {
    private readonly permittedTransitions:
        Record<PaymentStatus, PaymentStatus[]> = {
            CREATED: ['PROCESSING', 'FAILED'],
            PROCESSING: ['SUCCEEDED', 'FAILED'],
            SUCCEEDED: [],
            FAILED: []
        };
    
    async createPaymentIntent(input: CreatePaymentIntentInput): Promise<PaymentIntentRecord>{
        const { merchantId, amount, currency = 'ETB' } = input;

        if (amount <= 0n) {
            throw new Error('Payment amount must be strictly greater than 0.');
        }
        const res = await db.query(
          `INSERT INTO payment_intents (merchant_id, amount, currency, status)
            VALUES($1, $2, $3, 'CREATED')
            RETURNING id, merchant_id, amount, currency, status, provider_ref, created_at, updated_at
            `,
            [merchantId, amount.toString(), currency]
        );
        const row = res.rows[0];
        return {
            id: row.id,
            merchantId: row.merchant_id,
            amount: BigInt(row.amount),
            currency: row.currency,
            status: row.status as PaymentStatus,
            providerRef: row.provider_ref,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }
    }

    async transitionStatus(
        paymentIntentId: string,
        targetStatus: PaymentStatus,
        providerRef?: string,
        customerAccountId?: string,
        merchantAccountId?: string
    ): Promise<PaymentIntentRecord>{
        const client: PoolClient = await db.connect();

        try {
            await client.query('BEGIN');

            const lockRes = await client.query(
                `SELECT id, merchant_id, amount, currency, status, provider_ref, created_at, updated_at FROM payment_intents WHERE id = $1 FOR UPDATE`,
                [paymentIntentId]
            );

            if (lockRes.rowCount === 0) {
                throw new Error(`PaymentIntent ${paymentIntentId} not found.`);
            }

            const current = lockRes.rows[0];
            const currentStatus = current.status as PaymentStatus;

            const allowed = this.permittedTransitions[currentStatus];
            if (!allowed.includes(targetStatus)) {
                throw new InvalidStateTransitionError(currentStatus, targetStatus);
            }

            const updateRes = await client.query(
                `UPDATE payment_intents
                SET status = $1, provider_ref = COALESCE($2, provider_ref), updated_at = NOW()
                WHERE id = $3
                RETURNING id, merchant_id, amount, currency, status, provider_ref, created_at, updated_at
                `,
                [targetStatus, providerRef || null, paymentIntentId]
            );
            const updated = updateRes.rows[0];

            if (targetStatus === 'SUCCEEDED') {
                if (!customerAccountId || !merchantAccountId) {
                    throw new Error('Both customerAccountId and merchantAccountId required to post ledger on SUCEEDED.');
                }

                const amount = BigInt(updated.amount);

                await ledgerService.postTransaction(
                    {
                        paymentIntentId: updated.id,
                        description: `Settlement for Payment Intent ${updated.id}`,
                        entries: [
                            { accountId: customerAccountId, entryType: 'DEBIT', amount },
                            { accountId: merchantAccountId, entryType: 'CREDIT', amount }
                        ]
                    },
                    client
                );
            }

            await client.query('COMMIT');

            return {
                id: updated.id,
                merchantId: updated.merchant_id,
                amount: BigInt(updated.amount),
                currency: updated.currency,
                status: updated.status as PaymentStatus,
                providerRef: updated.provider_ref,
                createdAt: updated.created_at,
                updatedAt: updated.updated_at
            };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
}

export const paymentService = new PaymentService();