import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../src/db/index.js';
import { paymentService, InvalidStateTransitionError } from '../src/services/payment.service.js';
import { ledgerService } from '../src/services/ledger.service.js';

describe('Payment State Machine and Atomic Settlement', () => {
    let merchantId: string;
    let customerAccountId: string;
    let merchantAccountId: string;

    beforeAll(async () => {
        const merchantRes = await db.query(
            `INSERT INTO merchants (name, api_key_hash) VALUES ('State Machine Test Merchant', 'hash_sm_123') RETURNING id`
        );
        merchantId = merchantRes.rows[0].id;

        const custAcc = await db.query(
            `INSERT INTO accounts (merchant_id, type, currency) VALUES ($1, 'CUSTOMER_FUNDS', 'ETB')RETURNING id`, [merchantId]
        )
        customerAccountId = custAcc.rows[0].id;

        const merchAcc = await db.query(
            `INSERT INTO accounts (merchant_id, type, currency)
            VALUES($1, 'MERCHANT_CLEARING', 'ETB') RETURNING id
            `,
            [merchantId]
        );
        merchantAccountId = merchAcc.rows[0].id;
    });

    afterAll(async () => {
        await db.query(
          "TRUNCATE TABLE ledger_entries, ledger_transactions, payment_intents, accounts, merchants RESTART IDENTITY CASCADE",
        );
        await db.end();
    });
    it('should create a payment intent in CREATED status',
        async () => {
            const pi = await paymentService.createPaymentIntent({
                merchantId,
                amount: 150000n
            });
            expect(pi.id).toBeDefined();
            expect(pi.status).toBe('CREATED');
            expect(pi.amount).toBe(150000n);
        }
    );

    it('should follow permitted transitions: CREATED -> PROCESSING -> SUCCEEDED and post ledger entries', async () => {
        const pi = await paymentService.createPaymentIntent({
            merchantId,
            amount: 250000n
        });

        const processingPi = await paymentService.transitionStatus(pi.id, 'PROCESSING', 'chapa_txn_ref_001');
        expect(processingPi.status).toBe('PROCESSING');
        expect(processingPi.providerRef).toBe("chapa_txn_ref_001");

        const succeededPi = await paymentService.transitionStatus(
            pi.id,
            'SUCCEEDED',
            undefined,
            customerAccountId,
            merchantAccountId
        );
        expect(succeededPi.status).toBe('SUCCEEDED');

        const merchantBalance = await ledgerService.getAccountBalance(merchantAccountId);
        expect(merchantBalance).toBe(250000n);
    });

    it('should REJECT invalid state transitions (terminal states', async () => {
        const pi = await paymentService.createPaymentIntent({
            merchantId,
            amount: 100000n,
        });

        await expect(
            paymentService.transitionStatus(pi.id, 'SUCCEEDED', undefined, customerAccountId, merchantAccountId)
        ).rejects.toThrow(InvalidStateTransitionError);

        await paymentService.transitionStatus(pi.id, 'PROCESSING');
        const failedPi = await paymentService.transitionStatus(pi.id, 'FAILED');
        expect(failedPi.status).toBe('FAILED');

        await expect(
            paymentService.transitionStatus(failedPi.id, 'SUCCEEDED', undefined, customerAccountId, merchantAccountId)
        ).rejects.toThrow(InvalidStateTransitionError);
    });
});