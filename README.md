# Production-Grade Payment Processing & Ledger Engine

A high-performance payment orchestration backend with an immutable double-entry ledger, atomic state transitions, and strict concurrency controls.

## Core Features Demonstrated
- **Immutable Double-Entry Ledger:** Guarantees zero-sum balance compliance (`Debits === Credits`) at the database constraint layer.
- **Atomic Concurrency Protection:** Utilizes PostgreSQL `SELECT FOR UPDATE` row-level locking to completely mitigate race conditions from duplicate network webhooks.
- **Strict State Machine Architecture:** Prevents illegal state transitions on payment flows (e.g., locking states once `SUCCEEDED` or `FAILED` are reached).

## Technology Stack
- **Language:** TypeScript
- **Framework:** Fastify
- **Database:** PostgreSQL (with raw pooling)
- **Testing Engine:** Vitest (Executed sequentially for data consistency)
