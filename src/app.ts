import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import dotenv from 'dotenv';
import { db } from './db/index.js';
import { paymentService, PaymentService } from './services/payment.service.js';
import { IdempotencyConflictError, idempotencyService } from './services/idempotency.service.js';


dotenv.config();

export function buildApp() {
    const app = Fastify({
      logger: {
        level: "info",
        transport:
          process.env.NODE_ENV === "development"
            ? { target: "pino-pretty" }
            : undefined,
      },
      genReqId: (req) => req.headers["x-request-id"] as string || crypto.randomUUID(),
    });

    app.get('/health', async () => {
        return {
            status: 'healthy', timeStamp: new Date().
            toISOString()
        };
    });

    app.post('/api/merchants', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { name?: string; apiKeyHash?: string };
        if (!body.name || !body.apiKeyHash) {
            return reply.status(400).send({ error: 'name and apiKeyHash are required.' });
        }

        const client = await db.connect();
        try {
            await client.query('BEGIN')
            const mRes = await client.query(
                `INSERT INTO merchants (name, api_key_hash) VALUES ($1, $2) RETURNING id , name, created_at`, [body.name, body.apiKeyHash]
            );
            const merchant = mRes.rows[0];

            const custAcc = await client.query(
                `INSERT INTO accounts (merchant_id, type, currency) VALUES ($1, 'CUSTOMER_FUNDS', 'ETB') RETURNING id`, [merchant.id]
            );
            const merchAcc = await client.query(
                `INSERT INTO accounts (merchant_id, type, currency) VALUES ($1, 'MERCHANT_CLEARING', 'ETB')RETURNING id`,
                [merchant.id]
            );
            await client.query('COMMIT');

            return reply.status(201).send({
                merchant,
                account: {
                    customerFundsAccountId: custAcc.rows[0].id,
                    merchantClearingAccountId: merchAcc.rows[0].id
                }
            });
        } catch (err: any) {
            await client.query('ROLLBACK');
            return reply.status(500).send({ error: err.message });
        } finally {
            client.release();
        }
    });

    app.post('/api/payment-intents', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as { merchantId?: string; amount?: number; currency?: string };
        const idempotencyKey = request.headers["idempotency-key"] as string | undefined;

        if (!body.merchantId || !body.amount) {
            return reply.status(400).send({ error: 'merchantId and amount (in minor units) are required.' });
        }

        if (idempotencyKey) {
            const requestHash = idempotencyService.generateRequestHash(request.url, body);

            try {
                const lockResult = await idempotencyService.lockKey(body.merchantId, idempotencyKey, requestHash);

                if (!lockResult.isNew && lockResult.existingRecord) {
                    const cached = lockResult.existingRecord;
                    return reply.status(cached.responseCode || 200).send(cached.responseBody);
                }
                const intent = await paymentService.createPaymentIntent({
                    merchantId: body.merchantId,
                    amount: BigInt(body.amount),
                    currency: body.currency || 'ETB'
                });
                const responsePayload = {
                    ...intent,
                    amount: intent.amount.toString(),
                };

                await idempotencyService.saveResponse(body.merchantId, idempotencyKey, 201, responsePayload);

                return reply.status(201).send(responsePayload);
            } catch (err: any) {
                if (err instanceof IdempotencyConflictError) {
                    return reply.status(err.statusCode).send({ error: err.message });
                }
                return reply.status(500).send({ error: err.message });
            }
        }
        try {
            const intent = await paymentService.createPaymentIntent({
                merchantId: body.merchantId,
                amount: BigInt(body.amount),
                currency: body.currency || 'ETB',
            });

            return reply.status(201).send({
                ...intent,
                amount: intent.amount.toString(),
            });
        } catch (err: any) {
            return reply.status(400).send({ error: err.message })
        }
    });

    app.post('/api/payment-intents/:id/transition', async (request: FastifyRequest, reply: FastifyReply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
            targetStatus: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
            providerRef?: string;
            customerAccountId?: string;
            merchantAccountId?: string;
        };
        if (!body.targetStatus) {
            return reply.status(400).send({ error: 'targetStatus is required' });
        }

        try {
            const updated = await paymentService.transitionStatus(
                id,
                body.targetStatus,
                body.providerRef,
                body.customerAccountId,
                body.merchantAccountId
            );

            return reply.status(200).send({
                ...updated,
                amount: updated.amount.toString(),
            });
        } catch (err: any) {
            return reply.status(400).send({ error: err.message });
        }
    });
    return app;
}