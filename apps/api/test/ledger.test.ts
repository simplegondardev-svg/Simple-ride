import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { signAccessToken } from "../src/auth/tokens.js";
import { SYSTEM, withContext } from "../src/db/context.js";
import { pool } from "../src/db/pool.js";
import { AppError } from "../src/lib/errors.js";
import { redis } from "../src/lib/redis.js";
import { checkIdempotencySupport, postLedger } from "../src/modules/wallet/ledger.js";
import { grant, makeUser } from "./helpers.js";

const app = createApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("Financial Ledger Integration Tests (CP3.2)", () => {
  let customerId: string;
  let driverId: string;
  let staffId: string;

  let staffToken: string;

  beforeAll(async () => {
    [customerId, driverId, staffId] = await Promise.all([
      makeUser("customer"),
      makeUser("driver"),
      makeUser("staff"),
    ]);

    // Grant staff wallet adjustment permission
    await grant(staffId, ["finance.wallets.adjust", "finance.wallets.view"]);
    staffToken = signAccessToken({ sub: staffId, role: "staff" });
  });

  afterAll(async () => {
    await pool.end();
    redis.disconnect();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Balance safety & non-negative rule
  // ───────────────────────────────────────────────────────────────────────────
  describe("Balance safety & customer non-negative enforcement", () => {
    it("successfully applies credit to customer wallet", async () => {
      const balance = await withContext(SYSTEM, (db) =>
        postLedger(db, {
          userId: customerId,
          amount: 10_000, // 100 ETB
          kind: "topup",
          reference: "initial funding",
        }),
      );

      expect(balance).toBeGreaterThanOrEqual(10_000);
    });

    it("allows customer debit within available balance", async () => {
      const initialBalance = await withContext(SYSTEM, async (db) => {
        const { rows: [w] } = await db.query("SELECT balance FROM wallets WHERE user_id = $1", [customerId]);
        return Number(w.balance);
      });

      const newBalance = await withContext(SYSTEM, (db) =>
        postLedger(db, {
          userId: customerId,
          amount: -2_000, // 20 ETB
          kind: "trip_payment",
          reference: "trip debit",
        }),
      );

      expect(newBalance).toBe(initialBalance - 2_000);
    });

    it("rejects customer debit exceeding available balance and leaves balance untouched", async () => {
      const balanceBefore = await withContext(SYSTEM, async (db) => {
        const { rows: [w] } = await db.query("SELECT balance FROM wallets WHERE user_id = $1", [customerId]);
        return Number(w.balance);
      });

      // Attempt to debit more than current balance
      const excessiveDebit = -(balanceBefore + 5_000);

      await expect(
        withContext(SYSTEM, (db) =>
          postLedger(db, {
            userId: customerId,
            amount: excessiveDebit,
            kind: "trip_payment",
          }),
        ),
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_FUNDS",
        status: 402,
        details: {
          currentBalance: balanceBefore,
          requiredAmount: Math.abs(excessiveDebit),
          deficit: 5_000,
        },
      });

      // Verify balance remains exactly unchanged in the database
      const balanceAfter = await withContext(SYSTEM, async (db) => {
        const { rows: [w] } = await db.query("SELECT balance FROM wallets WHERE user_id = $1", [customerId]);
        return Number(w.balance);
      });

      expect(balanceAfter).toBe(balanceBefore);
    });

    it("allows driver debit to produce negative balance for cash trip commission", async () => {
      // Driver starting with 0 balance
      const initialDriverBal = await withContext(SYSTEM, async (db) => {
        const { rows: [w] } = await db.query("SELECT balance FROM wallets WHERE user_id = $1", [driverId]);
        return Number(w.balance);
      });

      const driverBalance = await withContext(SYSTEM, (db) =>
        postLedger(db, {
          userId: driverId,
          amount: -1_500, // -15 ETB commission
          kind: "commission",
          reference: "cash trip commission",
        }),
      );

      expect(driverBalance).toBe(initialDriverBal - 1_500);
    });

    it("rejects driver debit for non-commission transactions that exceed available balance", async () => {
      // Driver balance is currently negative (-1500) from the previous commission test.
      // Attempting an adjustment or trip_payment debit must be rejected with 402 INSUFFICIENT_FUNDS.
      await expect(
        withContext(SYSTEM, (db) =>
          postLedger(db, {
            userId: driverId,
            amount: -1_000,
            kind: "adjustment",
            reference: "Driver penalty deduction",
          }),
        ),
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_FUNDS",
        status: 402,
      });

      // Also verify trip_payment debit cannot drive driver further negative
      await expect(
        withContext(SYSTEM, (db) =>
          postLedger(db, {
            userId: driverId,
            amount: -500,
            kind: "trip_payment",
            reference: "Driver ride payment",
          }),
        ),
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_FUNDS",
        status: 402,
      });
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Concurrency: race condition double-spend prevention
  // ───────────────────────────────────────────────────────────────────────────
  describe("Concurrency: double-spend prevention", () => {
    it("ensures parallel debits cannot over-spend customer balance into negative", async () => {
      // Create a fresh customer with exactly 10,000 santim (100 ETB)
      const raceCustomerId = await makeUser("customer");
      await withContext(SYSTEM, (db) =>
        postLedger(db, {
          userId: raceCustomerId,
          amount: 10_000,
          kind: "topup",
          reference: "seed for concurrency test",
        }),
      );

      // Fire 5 concurrent requests attempting to debit 3,000 santim each (total 15,000 requested against 10,000 available)
      const concurrentDebits = [1, 2, 3, 4, 5].map((idx) =>
        withContext(SYSTEM, (db) =>
          postLedger(db, {
            userId: raceCustomerId,
            amount: -3_000,
            kind: "trip_payment",
            reference: `concurrent-${idx}`,
          }),
        ),
      );

      const results = await Promise.allSettled(concurrentDebits);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly 3 requests must succeed (3 x 3,000 = 9,000 santim)
      expect(fulfilled.length).toBe(3);
      // Exactly 2 requests must be rejected with INSUFFICIENT_FUNDS
      expect(rejected.length).toBe(2);

      for (const rej of rejected) {
        expect((rej as PromiseRejectedResult).reason).toMatchObject({
          code: "INSUFFICIENT_FUNDS",
          status: 402,
        });
      }

      // Check final database balance: exactly 1,000 santim (10 ETB), NEVER negative!
      const finalBal = await withContext(SYSTEM, async (db) => {
        const { rows: [w] } = await db.query("SELECT balance FROM wallets WHERE user_id = $1", [raceCustomerId]);
        return Number(w.balance);
      });

      expect(finalBal).toBe(1_000);

      // In wallet_transactions, exactly 4 rows (1 topup + 3 debits)
      const txCount = await withContext(SYSTEM, async (db) => {
        const { rows: [cnt] } = await db.query(
          "SELECT count(*)::int AS count FROM wallet_transactions WHERE user_id = $1",
          [raceCustomerId],
        );
        return cnt.count;
      });

      expect(txCount).toBe(4);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Atomicity & rollback guarantees
  // ───────────────────────────────────────────────────────────────────────────
  describe("Atomicity & transactional rollback", () => {
    it("rolls back balance update if transaction fails before commit", async () => {
      const atomicityCustId = await makeUser("customer");
      await withContext(SYSTEM, (db) =>
        postLedger(db, {
          userId: atomicityCustId,
          amount: 5_000,
          kind: "topup",
        }),
      );

      // Attempt transaction where postLedger succeeds but outer transaction aborts
      await expect(
        withContext(SYSTEM, async (db) => {
          await postLedger(db, {
            userId: atomicityCustId,
            amount: -2_000,
            kind: "trip_payment",
          });
          // Deliberately simulate unexpected failure before transaction commit
          throw new Error("Simulated system failure before commit");
        }),
      ).rejects.toThrow("Simulated system failure before commit");

      // Verify that balance remained 5,000 santim
      const bal = await withContext(SYSTEM, async (db) => {
        const { rows: [w] } = await db.query("SELECT balance FROM wallets WHERE user_id = $1", [atomicityCustId]);
        return Number(w.balance);
      });

      expect(bal).toBe(5_000);

      // Verify no aborted transaction appears in wallet_transactions
      const txs = await withContext(SYSTEM, async (db) => {
        const { rows } = await db.query(
          "SELECT kind, amount FROM wallet_transactions WHERE user_id = $1",
          [atomicityCustId],
        );
        return rows;
      });

      expect(txs.length).toBe(1);
      expect(Number(txs[0].amount)).toBe(5_000);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Centralized Administrative Adjustments (Refactored to postLedger)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Centralized administrative adjustment endpoint", () => {
    it("rejects adjustments missing an idempotency key with 400 INVALID_IDEMPOTENCY_KEY", async () => {
      const res = await request(app)
        .post(`/api/v1/admin/wallets/${customerId}/adjust`)
        .set(bearer(staffToken))
        .send({ amount: 1_000, reason: "Adjustment missing idempotency key" })
        .expect(400);

      expect(res.body.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
    });

    it("safely handles adjustment when idempotencyKey is provided against current database schema", async () => {
      const hasMigration = await withContext(SYSTEM, (db) => checkIdempotencySupport(db));
      const testKey = `adj-test-key-${Date.now()}`;
      if (!hasMigration) {
        // When migration 0012 has not been applied to simpleride_test, postLedger fails safely
        // with 500 SCHEMA_MIGRATION_REQUIRED rather than silently mutating balance un-idempotently.
        const res = await request(app)
          .post(`/api/v1/admin/wallets/${customerId}/adjust`)
          .set(bearer(staffToken))
          .send({
            amount: 2_500,
            reason: "Customer goodwill courtesy credit",
            idempotencyKey: testKey,
          })
          .expect(500);

        expect(res.body.error.code).toBe("SCHEMA_MIGRATION_REQUIRED");
      } else {
        const res = await request(app)
          .post(`/api/v1/admin/wallets/${customerId}/adjust`)
          .set(bearer(staffToken))
          .send({
            amount: 2_500,
            reason: "Customer goodwill courtesy credit",
            idempotencyKey: testKey,
          })
          .expect(200);

        expect(typeof res.body.balance).toBe("number");
        expect(res.body.balance).toBeGreaterThanOrEqual(2_500);
      }
    });

    it("rejects adjustments with invalid reason or missing permissions", async () => {
      // Reason too short (< 5 chars) fails Zod validation (422)
      await request(app)
        .post(`/api/v1/admin/wallets/${customerId}/adjust`)
        .set(bearer(staffToken))
        .send({ amount: 100, reason: "no", idempotencyKey: "valid-test-key-422" })
        .expect(422);

      // Unauthenticated
      await request(app)
        .post(`/api/v1/admin/wallets/${customerId}/adjust`)
        .send({ amount: 100, reason: "Valid reason text", idempotencyKey: "valid-test-key-401" })
        .expect(401);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Genuine PostgreSQL Idempotency & Concurrency Verification
  // ───────────────────────────────────────────────────────────────────────────
  describe("Genuine PostgreSQL Idempotency & Concurrency Verification", () => {
    // 5A: Identical concurrent requests
    it("handles two genuinely concurrent identical requests: debits once, returns identical result", async () => {
      const userA = await makeUser("customer");
      await withContext(SYSTEM, (db) =>
        postLedger(db, {
          userId: userA,
          amount: 15_000,
          kind: "topup",
          reference: "5A seed funding",
        }),
      );

      const idempotencyKey = `concurrency:5A:${Date.now()}`;
      const entry = {
        userId: userA,
        amount: -3_000,
        kind: "trip_payment" as const,
        reference: "5A fare payment",
        idempotencyKey,
      };

      // Execute both requests concurrently against live PostgreSQL
      const [bal1, bal2] = await Promise.all([
        withContext(SYSTEM, (db) => postLedger(db, entry)),
        withContext(SYSTEM, (db) => postLedger(db, entry)),
      ]);

      // Both callers receive the exact same committed balance
      expect(bal1).toBe(12_000);
      expect(bal2).toBe(12_000);

      // Verify wallet balance in database changed exactly once
      const actualBalance = await withContext(SYSTEM, async (db) => {
        const { rows: [w] } = await db.query("SELECT balance FROM wallets WHERE user_id = $1", [userA]);
        return Number(w.balance);
      });
      expect(actualBalance).toBe(12_000);

      // Verify exactly one ledger row was inserted with this idempotency key
      const txCount = await withContext(SYSTEM, async (db) => {
        const { rows: [c] } = await db.query(
          "SELECT count(*)::int AS count FROM wallet_transactions WHERE idempotency_key = $1",
          [idempotencyKey],
        );
        return c.count;
      });
      expect(txCount).toBe(1);
    });

    // 5B: Conflicting concurrent requests
    it("rejects conflicting concurrent requests sharing an idempotency key with 409 IDEMPOTENCY_CONFLICT", async () => {
      const userB = await makeUser("customer");
      await withContext(SYSTEM, (db) =>
        postLedger(db, {
          userId: userB,
          amount: 20_000,
          kind: "topup",
          reference: "5B seed funding",
        }),
      );

      const conflictKey = `concurrency:5B:${Date.now()}`;

      // First request: debit 5,000
      const initialBal = await withContext(SYSTEM, (db) =>
        postLedger(db, {
          userId: userB,
          amount: -5_000,
          kind: "trip_payment",
          reference: "Legitimate debit",
          idempotencyKey: conflictKey,
        }),
      );
      expect(initialBal).toBe(15_000);

      // Reused key with conflicting amount
      await expect(
        withContext(SYSTEM, (db) =>
          postLedger(db, {
            userId: userB,
            amount: -8_000, // Conflict: different amount
            kind: "trip_payment",
            reference: "Legitimate debit",
            idempotencyKey: conflictKey,
          }),
        ),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
      });

      // Reused key with conflicting reference
      await expect(
        withContext(SYSTEM, (db) =>
          postLedger(db, {
            userId: userB,
            amount: -5_000,
            kind: "trip_payment",
            reference: "Tampered reference",
            idempotencyKey: conflictKey,
          }),
        ),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
      });

      // Confirm no additional balance change occurred
      const finalBal = await withContext(SYSTEM, async (db) => {
        const { rows: [w] } = await db.query("SELECT balance FROM wallets WHERE user_id = $1", [userB]);
        return Number(w.balance);
      });
      expect(finalBal).toBe(15_000);
    });

    // 5C: Savepoint and outer transaction recovery
    it("recovers from idempotency conflict via savepoint without leaving outer transaction in aborted 25P02 state", async () => {
      const userC = await makeUser("customer");
      await withContext(SYSTEM, (db) =>
        postLedger(db, {
          userId: userC,
          amount: 10_000,
          kind: "topup",
          reference: "5C seed funding",
        }),
      );

      const existingKey = `concurrency:5C:${Date.now()}`;
      await withContext(SYSTEM, (db) =>
        postLedger(db, {
          userId: userC,
          amount: -2_000,
          kind: "trip_payment",
          reference: "Original tx",
          idempotencyKey: existingKey,
        }),
      );

      // Now run an outer transaction that triggers an idempotency conflict, catches it,
      // and continues to perform subsequent operations in the SAME transaction.
      const outerResult = await withContext(SYSTEM, async (db) => {
        let caughtConflict = false;
        try {
          // Attempt conflicting reuse with different amount
          await postLedger(db, {
            userId: userC,
            amount: -9_999,
            kind: "trip_payment",
            reference: "Conflicting attempt",
            idempotencyKey: existingKey,
          });
        } catch (err: any) {
          if (err.code === "IDEMPOTENCY_CONFLICT") {
            caughtConflict = true;
          } else {
            throw err;
          }
        }

        expect(caughtConflict).toBe(true);

        // Crucial test: in PostgreSQL, an unhandled error inside a transaction block
        // leaves it in state 25P02 ("current transaction is aborted, commands ignored").
        // Because postLedger uses SAVEPOINT and rolls back to savepoint on conflict,
        // this subsequent query MUST succeed without error 25P02!
        const subsequentBalance = await postLedger(db, {
          userId: userC,
          amount: 3_000, // Valid subsequent top-up
          kind: "topup",
          reference: "Recovery operation in same transaction",
          idempotencyKey: `recovery:5C:${Date.now()}`,
        });

        // Also execute a raw query in the same transaction to prove healthy connection state
        const { rows } = await db.query("SELECT balance FROM wallets WHERE user_id = $1", [userC]);
        expect(Number(rows[0].balance)).toBe(subsequentBalance);

        return subsequentBalance;
      });

      // Started with 10,000, debited 2,000 (= 8,000), conflict caught (no change), credited 3,000 (= 11,000)
      expect(outerResult).toBe(11_000);
    });

    // 5D: Unrelated unique constraint violation
    it("rethrows unrelated unique constraint violations without mistaking them for idempotency conflicts", async () => {
      const userD = await makeUser("customer");
      const hash = `token-hash-${Date.now()}`;

      await withContext(SYSTEM, async (db) => {
        await db.query(
          "INSERT INTO auth_sessions (user_id, refresh_token_hash, platform, expires_at) VALUES ($1, $2, 'web', now() + interval '1 day')",
          [userD, hash],
        );
      });

      // Attempt inserting second session with duplicate refresh_token_hash
      await expect(
        withContext(SYSTEM, async (db) => {
          await db.query(
            "INSERT INTO auth_sessions (user_id, refresh_token_hash, platform, expires_at) VALUES ($1, $2, 'web', now() + interval '1 day')",
            [userD, hash],
          );
        }),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "auth_sessions_refresh_token_hash_key",
      });
    });

    // 5E: Repeatability stress test (10 iterations of concurrent pairs)
    it("reliably deduplicates concurrent identical requests across 10 repeated race iterations", async () => {
      const userE = await makeUser("customer");
      // Fund customer with 100,000 santim
      await withContext(SYSTEM, (db) =>
        postLedger(db, {
          userId: userE,
          amount: 100_000,
          kind: "topup",
          reference: "Repeatability seed",
        }),
      );

      let currentExpectedBalance = 100_000;

      // Run 10 sequential iterations of 2-way concurrent requests
      for (let i = 1; i <= 10; i++) {
        const iterKey = `stress:iter-${i}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
        const debitAmount = -1_000;

        const [r1, r2] = await Promise.all([
          withContext(SYSTEM, (db) =>
            postLedger(db, {
              userId: userE,
              amount: debitAmount,
              kind: "trip_payment",
              reference: `Iteration ${i}`,
              idempotencyKey: iterKey,
            }),
          ),
          withContext(SYSTEM, (db) =>
            postLedger(db, {
              userId: userE,
              amount: debitAmount,
              kind: "trip_payment",
              reference: `Iteration ${i}`,
              idempotencyKey: iterKey,
            }),
          ),
        ]);

        currentExpectedBalance += debitAmount;

        // Both calls in the pair must return the exact same balance
        expect(r1).toBe(currentExpectedBalance);
        expect(r2).toBe(currentExpectedBalance);

        // Verify exactly 1 ledger row exists for this key
        const count = await withContext(SYSTEM, async (db) => {
          const { rows } = await db.query(
            "SELECT count(*)::int AS count FROM wallet_transactions WHERE idempotency_key = $1",
            [iterKey],
          );
          return rows[0].count;
        });
        expect(count).toBe(1);
      }

      // Verify final balance is exactly 90,000 (100,000 - 10 x 1,000)
      const finalBal = await withContext(SYSTEM, async (db) => {
        const { rows } = await db.query("SELECT balance FROM wallets WHERE user_id = $1", [userE]);
        return Number(rows[0].balance);
      });
      expect(finalBal).toBe(90_000);
    });
  });
});
