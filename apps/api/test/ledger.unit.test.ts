import { describe, expect, it } from "vitest";
import { AppError } from "../src/lib/errors.js";
import {
  _resetIdempotencySupportCache,
  _setIdempotencySupportForTest,
  postLedger,
  validateLedgerEntry,
  VALID_WALLET_TXN_KINDS,
  type LedgerEntry,
  type WalletTxnKind,
} from "../src/modules/wallet/ledger.js";

describe("Financial Ledger Hardening - Unit Tests (CP3.2)", () => {
  const validUserId = "11111111-1111-1111-1111-111111111111";

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Monetary input validation
  // ───────────────────────────────────────────────────────────────────────────
  describe("Monetary input validation", () => {
    it("rejects zero amount", () => {
      expect(() =>
        validateLedgerEntry({ userId: validUserId, amount: 0, kind: "topup" }),
      ).toThrowError(AppError);

      try {
        validateLedgerEntry({ userId: validUserId, amount: 0, kind: "topup" });
      } catch (err: any) {
        expect(err.code).toBe("INVALID_AMOUNT");
        expect(err.status).toBe(400);
      }
    });

    it("rejects negative zero (-0) amount", () => {
      expect(() =>
        validateLedgerEntry({ userId: validUserId, amount: -0, kind: "topup" }),
      ).toThrowError(AppError);

      try {
        validateLedgerEntry({ userId: validUserId, amount: -0, kind: "topup" });
      } catch (err: any) {
        expect(err.code).toBe("INVALID_AMOUNT");
      }
    });

    it("rejects fractional santim values", () => {
      const fractionalAmounts = [10.5, -25.75, 0.1, -0.99, 1000.0001];
      for (const amount of fractionalAmounts) {
        expect(() =>
          validateLedgerEntry({ userId: validUserId, amount, kind: "topup" }),
        ).toThrowError(AppError);

        try {
          validateLedgerEntry({ userId: validUserId, amount, kind: "topup" });
        } catch (err: any) {
          expect(err.code).toBe("INVALID_AMOUNT");
        }
      }
    });

    it("rejects NaN and Infinity", () => {
      const nonFinite = [NaN, Infinity, -Infinity];
      for (const amount of nonFinite) {
        expect(() =>
          validateLedgerEntry({ userId: validUserId, amount, kind: "topup" }),
        ).toThrowError(AppError);

        try {
          validateLedgerEntry({ userId: validUserId, amount, kind: "topup" });
        } catch (err: any) {
          expect(err.code).toBe("INVALID_AMOUNT");
        }
      }
    });

    it("rejects unsafe integer values beyond Number.MAX_SAFE_INTEGER", () => {
      const unsafeValues = [
        Number.MAX_SAFE_INTEGER + 1,
        Number.MIN_SAFE_INTEGER - 1,
        1e20,
        -1e20,
      ];
      for (const amount of unsafeValues) {
        expect(() =>
          validateLedgerEntry({ userId: validUserId, amount, kind: "topup" }),
        ).toThrowError(AppError);
      }
    });

    it("rejects non-numeric values", () => {
      const nonNumbers = ["100", null, undefined, {}, []] as any[];
      for (const amount of nonNumbers) {
        expect(() =>
          validateLedgerEntry({ userId: validUserId, amount, kind: "topup" }),
        ).toThrowError(AppError);
      }
    });

    it("accepts valid positive and negative integer santim amounts", () => {
      const validAmounts = [1, -1, 100, -100, 10_000_000, -10_000_000, 9_007_199_254_740_991, -9_007_199_254_740_991];
      for (const amount of validAmounts) {
        expect(() =>
          validateLedgerEntry({ userId: validUserId, amount, kind: "adjustment" }),
        ).not.toThrow();
      }
    });

    it("validates all 9 recognized transaction kinds", () => {
      for (const kind of VALID_WALLET_TXN_KINDS) {
        expect(() =>
          validateLedgerEntry({ userId: validUserId, amount: 100, kind }),
        ).not.toThrow();
      }
    });

    it("rejects unknown or malformed transaction kinds", () => {
      const invalidKinds = ["stolen_funds", "crypto_mint", "", "unknown"] as any[];
      for (const kind of invalidKinds) {
        try {
          validateLedgerEntry({ userId: validUserId, amount: 100, kind });
          expect.fail("Should have thrown");
        } catch (err: any) {
          expect(err.code).toBe("INVALID_TRANSACTION_KIND");
          expect(err.status).toBe(400);
        }
      }
    });

    it("rejects missing or empty userId", () => {
      const invalidUserIds = ["", "   ", null, undefined] as any[];
      for (const userId of invalidUserIds) {
        try {
          validateLedgerEntry({ userId, amount: 100, kind: "topup" });
          expect.fail("Should have thrown");
        } catch (err: any) {
          expect(err.code).toBe("INVALID_USER_ID");
          expect(err.status).toBe(400);
        }
      }
    });

    it("rejects empty idempotency key when provided", () => {
      try {
        validateLedgerEntry({ userId: validUserId, amount: 100, kind: "topup", idempotencyKey: "   " });
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.code).toBe("INVALID_IDEMPOTENCY_KEY");
        expect(err.status).toBe(400);
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. postLedger mocked behavior (Balance Safety & Error Handling)
  // ───────────────────────────────────────────────────────────────────────────
  describe("postLedger state transitions & safety guarantees", () => {
    it("throws WALLET_NOT_FOUND when wallet row does not exist", async () => {
      const mockDb: any = {
        query: async (sql: string) => {
          if (sql.includes("information_schema")) return { rows: [] };
          // UPDATE returns no rows
          if (sql.startsWith("UPDATE wallets")) return { rows: [] };
          // Check query also returns no rows
          if (sql.includes("FROM wallets w JOIN users u")) return { rows: [] };
          return { rows: [] };
        },
      };

      await expect(
        postLedger(mockDb, { userId: validUserId, amount: -500, kind: "trip_payment" }),
      ).rejects.toMatchObject({
        code: "WALLET_NOT_FOUND",
        status: 404,
      });
    });

    it("throws INSUFFICIENT_FUNDS when customer debit exceeds available balance", async () => {
      const mockDb: any = {
        query: async (sql: string) => {
          if (sql.includes("information_schema")) return { rows: [] };
          // UPDATE returns 0 rows because of (u.role = 'driver' OR w.balance + $2 >= 0)
          if (sql.startsWith("UPDATE wallets")) return { rows: [] };
          // Check query finds a customer with balance 200 attempting debit of 500
          if (sql.includes("FROM wallets w") && sql.includes("JOIN users u")) {
            return { rows: [{ balance: "200", role: "customer" }] };
          }
          return { rows: [] };
        },
      };

      await expect(
        postLedger(mockDb, { userId: validUserId, amount: -500, kind: "trip_payment" }),
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_FUNDS",
        status: 402,
        details: {
          currentBalance: 200,
          requiredAmount: 500,
          deficit: 300,
        },
      });
    });

    it("allows driver debit to produce negative balance for cash trip commission", async () => {
      let insertedTx: any = null;
      const mockDb: any = {
        query: async (sql: string, params?: any[]) => {
          if (sql.includes("information_schema")) return { rows: [] };
          if (sql.startsWith("SAVEPOINT") || sql.startsWith("RELEASE")) return { rows: [] };
          if (sql.startsWith("UPDATE wallets")) {
            // Driver with 500 balance, debited 800 -> new balance -300
            return { rows: [{ balance: "-300", role: "driver" }] };
          }
          if (sql.startsWith("INSERT INTO wallet_transactions")) {
            insertedTx = params;
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      const result = await postLedger(mockDb, {
        userId: validUserId,
        amount: -800,
        kind: "commission",
        tripId: "22222222-2222-2222-2222-222222222222",
      });

      expect(result).toBe(-300);
      expect(insertedTx[1]).toBe(-800);
      expect(insertedTx[2]).toBe(-300);
      expect(insertedTx[3]).toBe("commission");
    });

    it("rejects driver manual adjustment exceeding available balance", async () => {
      const mockDb: any = {
        query: async (sql: string) => {
          if (sql.includes("information_schema")) return { rows: [] };
          if (sql.startsWith("SAVEPOINT") || sql.startsWith("RELEASE") || sql.startsWith("ROLLBACK")) return { rows: [] };
          // UPDATE returns 0 rows because adjustment cannot drive driver negative
          if (sql.startsWith("UPDATE wallets")) return { rows: [] };
          // Driver check query finds driver with 1000 balance attempting debit of 2500
          if (sql.includes("FROM wallets w") && sql.includes("JOIN users u")) {
            return { rows: [{ balance: "1000", role: "driver" }] };
          }
          return { rows: [] };
        },
      };

      await expect(
        postLedger(mockDb, {
          userId: validUserId,
          amount: -2500,
          kind: "adjustment",
          reference: "Penalty fee",
        }),
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_FUNDS",
        status: 402,
        details: {
          currentBalance: 1000,
          requiredAmount: 2500,
          deficit: 1500,
        },
      });
    });

    it("rejects driver trip payment exceeding available balance", async () => {
      const mockDb: any = {
        query: async (sql: string) => {
          if (sql.includes("information_schema")) return { rows: [] };
          if (sql.startsWith("SAVEPOINT") || sql.startsWith("RELEASE") || sql.startsWith("ROLLBACK")) return { rows: [] };
          if (sql.startsWith("UPDATE wallets")) return { rows: [] };
          if (sql.includes("FROM wallets w") && sql.includes("JOIN users u")) {
            return { rows: [{ balance: "200", role: "driver" }] };
          }
          return { rows: [] };
        },
      };

      await expect(
        postLedger(mockDb, {
          userId: validUserId,
          amount: -500,
          kind: "trip_payment",
          tripId: "33333333-3333-3333-3333-333333333333",
        }),
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_FUNDS",
        status: 402,
        details: {
          currentBalance: 200,
          requiredAmount: 500,
          deficit: 300,
        },
      });
    });

    it("successfully applies customer debit when balance is sufficient", async () => {
      let insertedTx: any = null;
      const mockDb: any = {
        query: async (sql: string, params?: any[]) => {
          if (sql.includes("information_schema")) return { rows: [] };
          if (sql.startsWith("SAVEPOINT") || sql.startsWith("RELEASE")) return { rows: [] };
          if (sql.startsWith("UPDATE wallets")) {
            // Customer with 1000 balance, debited 400 -> new balance 600
            return { rows: [{ balance: "600", role: "customer" }] };
          }
          if (sql.startsWith("INSERT INTO wallet_transactions")) {
            insertedTx = params;
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      const result = await postLedger(mockDb, {
        userId: validUserId,
        amount: -400,
        kind: "trip_payment",
      });

      expect(result).toBe(600);
      expect(insertedTx[1]).toBe(-400);
      expect(insertedTx[2]).toBe(600);
    });

    it("successfully reduces customer balance to exactly 0", async () => {
      const mockDb: any = {
        query: async (sql: string) => {
          if (sql.includes("information_schema")) return { rows: [] };
          if (sql.startsWith("SAVEPOINT") || sql.startsWith("RELEASE")) return { rows: [] };
          if (sql.startsWith("UPDATE wallets")) {
            return { rows: [{ balance: "0", role: "customer" }] };
          }
          return { rows: [] };
        },
      };

      const result = await postLedger(mockDb, {
        userId: validUserId,
        amount: -500,
        kind: "trip_payment",
      });

      expect(result).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. Idempotency guarantees & savepoint race handling
  // ───────────────────────────────────────────────────────────────────────────
  describe("postLedger idempotency guarantees & concurrency race handling", () => {
    it("returns existing balance on identical retry without updating balance", async () => {
      _setIdempotencySupportForTest(true);
      let updateExecuted = false;

      const mockDb: any = {
        query: async (sql: string) => {
          // Idempotency lookup finds previous identical transaction
          if (sql.includes("WHERE idempotency_key = $1")) {
            return {
              rows: [
                {
                  id: "99",
                  user_id: validUserId,
                  amount: "-1500",
                  balance_after: "3500",
                  kind: "trip_payment",
                  trip_id: "trip-1",
                  reference: null,
                  created_by: null,
                },
              ],
            };
          }
          if (sql.startsWith("UPDATE wallets")) {
            updateExecuted = true;
            return { rows: [{ balance: "2000", role: "customer" }] };
          }
          return { rows: [] };
        },
      };

      const result = await postLedger(mockDb, {
        userId: validUserId,
        amount: -1500,
        kind: "trip_payment",
        tripId: "trip-1",
        idempotencyKey: "trip:test-trip-1:payment",
      });

      // Returns the original balance_after
      expect(result).toBe(3500);
      // Confirms balance was NOT updated again
      expect(updateExecuted).toBe(false);

      _resetIdempotencySupportCache();
    });

    it("rejects same idempotency key reused with different amount", async () => {
      _setIdempotencySupportForTest(true);

      const mockDb: any = {
        query: async (sql: string) => {
          if (sql.includes("WHERE idempotency_key = $1")) {
            return {
              rows: [
                {
                  id: "99",
                  user_id: validUserId,
                  amount: "-1500", // Previously was -1500
                  balance_after: "3500",
                  kind: "trip_payment",
                  trip_id: null,
                  reference: null,
                  created_by: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      await expect(
        postLedger(mockDb, {
          userId: validUserId,
          amount: -2500, // Now attempting -2500 with same key
          kind: "trip_payment",
          idempotencyKey: "trip:test-trip-1:payment",
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
      });

      _resetIdempotencySupportCache();
    });

    it("rejects same idempotency key reused with different user or kind", async () => {
      _setIdempotencySupportForTest(true);

      const mockDb: any = {
        query: async (sql: string) => {
          if (sql.includes("WHERE idempotency_key = $1")) {
            return {
              rows: [
                {
                  id: "99",
                  user_id: validUserId,
                  amount: "5000",
                  balance_after: "5000",
                  kind: "deposit",
                  trip_id: null,
                  reference: "DEP-1",
                  created_by: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      await expect(
        postLedger(mockDb, {
          userId: "99999999-9999-9999-9999-999999999999", // Different user
          amount: 5000,
          kind: "deposit",
          reference: "DEP-1",
          idempotencyKey: "deposit:ref-123",
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
      });

      _resetIdempotencySupportCache();
    });

    it("rejects same idempotency key reused with different tripId", async () => {
      _setIdempotencySupportForTest(true);

      const mockDb: any = {
        query: async (sql: string) => {
          if (sql.includes("WHERE idempotency_key = $1")) {
            return {
              rows: [
                {
                  id: "99",
                  user_id: validUserId,
                  amount: "-1200",
                  balance_after: "4800",
                  kind: "trip_payment",
                  trip_id: "trip-original-id",
                  reference: null,
                  created_by: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      await expect(
        postLedger(mockDb, {
          userId: validUserId,
          amount: -1200,
          kind: "trip_payment",
          tripId: "trip-different-id",
          idempotencyKey: "trip-pay-key",
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
      });

      _resetIdempotencySupportCache();
    });

    it("rejects same idempotency key reused with different reference or createdBy", async () => {
      _setIdempotencySupportForTest(true);

      const mockDb: any = {
        query: async (sql: string) => {
          if (sql.includes("WHERE idempotency_key = $1")) {
            return {
              rows: [
                {
                  id: "99",
                  user_id: validUserId,
                  amount: "1000",
                  balance_after: "6000",
                  kind: "adjustment",
                  trip_id: null,
                  reference: "original-ref",
                  created_by: "staff-1",
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      // Mismatched reference
      await expect(
        postLedger(mockDb, {
          userId: validUserId,
          amount: 1000,
          kind: "adjustment",
          reference: "altered-ref",
          createdBy: "staff-1",
          idempotencyKey: "adj-key-1",
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
      });

      // Mismatched createdBy
      await expect(
        postLedger(mockDb, {
          userId: validUserId,
          amount: 1000,
          kind: "adjustment",
          reference: "original-ref",
          createdBy: "staff-2",
          idempotencyKey: "adj-key-1",
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
      });

      _resetIdempotencySupportCache();
    });

    it("handles concurrent insertion race condition using SAVEPOINT rollback", async () => {
      _setIdempotencySupportForTest(true);

      let insertAttempted = false;
      const executedSql: string[] = [];

      const mockDb: any = {
        query: async (sql: string) => {
          executedSql.push(sql);
          // First check returns no row (simulating two simultaneous requests)
          if (sql.includes("WHERE idempotency_key = $1") && !insertAttempted) {
            return { rows: [] };
          }
          if (sql.startsWith("SAVEPOINT")) {
            return { rows: [] };
          }
          if (sql.startsWith("UPDATE wallets")) {
            return { rows: [{ balance: "4000", role: "customer" }] };
          }
          if (sql.startsWith("INSERT INTO wallet_transactions")) {
            insertAttempted = true;
            // Simulate PostgreSQL unique violation 23505 on concurrent race
            const err: any = new Error("duplicate key value violates unique constraint \"wallet_transactions_idempotency_key_idx\"");
            err.code = "23505";
            err.constraint = "wallet_transactions_idempotency_key_idx";
            throw err;
          }
          if (sql.startsWith("ROLLBACK TO SAVEPOINT")) {
            return { rows: [] };
          }
          // Catch block re-queries existing transaction inserted by winning race request
          if (sql.includes("WHERE idempotency_key = $1") && insertAttempted) {
            return {
              rows: [
                {
                  id: "101",
                  user_id: validUserId,
                  amount: "-1000",
                  balance_after: "4000",
                  kind: "trip_payment",
                  trip_id: "trip-race",
                  reference: null,
                  created_by: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      const result = await postLedger(mockDb, {
        userId: validUserId,
        amount: -1000,
        kind: "trip_payment",
        tripId: "trip-race",
        idempotencyKey: "trip:race-key:payment",
      });

      expect(result).toBe(4000);
      // Verify SAVEPOINT and ROLLBACK TO SAVEPOINT were executed
      expect(executedSql.some((s) => s.startsWith("SAVEPOINT"))).toBe(true);
      expect(executedSql.some((s) => s.startsWith("ROLLBACK TO SAVEPOINT"))).toBe(true);

      _resetIdempotencySupportCache();
    });

    it("throws 409 IDEMPOTENCY_CONFLICT when race winner has different parameters", async () => {
      _setIdempotencySupportForTest(true);

      let insertAttempted = false;
      const mockDb: any = {
        query: async (sql: string) => {
          if (sql.includes("WHERE idempotency_key = $1") && !insertAttempted) {
            return { rows: [] };
          }
          if (sql.startsWith("SAVEPOINT") || sql.startsWith("ROLLBACK")) {
            return { rows: [] };
          }
          if (sql.startsWith("UPDATE wallets")) {
            return { rows: [{ balance: "3000", role: "customer" }] };
          }
          if (sql.startsWith("INSERT INTO wallet_transactions")) {
            insertAttempted = true;
            const err: any = new Error("duplicate key value violates unique constraint");
            err.code = "23505";
            err.constraint = "wallet_transactions_idempotency_key_idx";
            throw err;
          }
          if (sql.includes("WHERE idempotency_key = $1") && insertAttempted) {
            return {
              rows: [
                {
                  id: "102",
                  user_id: validUserId,
                  amount: "-500", // Winner inserted -500
                  balance_after: "4500",
                  kind: "trip_payment",
                  trip_id: "trip-winner",
                  reference: null,
                  created_by: null,
                },
              ],
            };
          }
          return { rows: [] };
        },
      };

      await expect(
        postLedger(mockDb, {
          userId: validUserId,
          amount: -2000, // Losing attempt was -2000
          kind: "trip_payment",
          tripId: "trip-winner",
          idempotencyKey: "trip:race-key:conflict",
        }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        status: 409,
      });

      _resetIdempotencySupportCache();
    });

    it("rethrows non-idempotency unique constraint violations without catching", async () => {
      _setIdempotencySupportForTest(true);

      const mockDb: any = {
        query: async (sql: string) => {
          if (sql.includes("WHERE idempotency_key = $1")) return { rows: [] };
          if (sql.startsWith("SAVEPOINT") || sql.startsWith("ROLLBACK")) return { rows: [] };
          if (sql.startsWith("UPDATE wallets")) {
            return { rows: [{ balance: "5000", role: "customer" }] };
          }
          if (sql.startsWith("INSERT INTO wallet_transactions")) {
            const err: any = new Error("duplicate key value violates unique constraint \"wallet_transactions_pkey\"");
            err.code = "23505";
            err.constraint = "wallet_transactions_pkey"; // Primary key collision, NOT idempotency
            throw err;
          }
          return { rows: [] };
        },
      };

      await expect(
        postLedger(mockDb, {
          userId: validUserId,
          amount: 1000,
          kind: "topup",
          idempotencyKey: "some-topup-key",
        }),
      ).rejects.toThrow("duplicate key value violates unique constraint \"wallet_transactions_pkey\"");

      _resetIdempotencySupportCache();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Schema compatibility (Pre-0012 migration behavior)
  // ───────────────────────────────────────────────────────────────────────────
  describe("Schema compatibility & pre-migration safety", () => {
    it("throws SCHEMA_MIGRATION_REQUIRED when idempotencyKey is passed but schema lacks column", async () => {
      _setIdempotencySupportForTest(false);

      const mockDb: any = {
        query: async () => ({ rows: [] }),
      };

      await expect(
        postLedger(mockDb, {
          userId: validUserId,
          amount: 1000,
          kind: "deposit",
          idempotencyKey: "my-dep-key",
        }),
      ).rejects.toMatchObject({
        code: "SCHEMA_MIGRATION_REQUIRED",
        status: 500,
      });

      _resetIdempotencySupportCache();
    });

    it("allows operations without idempotencyKey when schema lacks column", async () => {
      _setIdempotencySupportForTest(false);

      let insertColumns: string | null = null;
      const mockDb: any = {
        query: async (sql: string, params?: any[]) => {
          if (sql.startsWith("SAVEPOINT") || sql.startsWith("RELEASE")) return { rows: [] };
          if (sql.startsWith("UPDATE wallets")) {
            return { rows: [{ balance: "6000", role: "customer" }] };
          }
          if (sql.startsWith("INSERT INTO wallet_transactions")) {
            insertColumns = sql;
            return { rows: [] };
          }
          return { rows: [] };
        },
      };

      const result = await postLedger(mockDb, {
        userId: validUserId,
        amount: 1000,
        kind: "topup",
      });

      expect(result).toBe(6000);
      expect(insertColumns).not.toContain("idempotency_key");

      _resetIdempotencySupportCache();
    });
  });
});
