import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as R from "../src/contract/responses.js";

/**
 * Unit tests for customer account numbers (CP2.2).
 * These tests are strictly offline and do not connect to PostgreSQL or Redis.
 */

describe("Customer Account Number Format", () => {
  const ACCOUNT_NUMBER_REGEX = /^SR-[0-9]{6,}$/;

  it("accepts valid customer account numbers", () => {
    expect(ACCOUNT_NUMBER_REGEX.test("SR-100001")).toBe(true);
    expect(ACCOUNT_NUMBER_REGEX.test("SR-100002")).toBe(true);
    expect(ACCOUNT_NUMBER_REGEX.test("SR-999999")).toBe(true);
    expect(ACCOUNT_NUMBER_REGEX.test("SR-1000000")).toBe(true);
    expect(ACCOUNT_NUMBER_REGEX.test("SR-1234567890")).toBe(true);
  });

  it("rejects malformed account numbers", () => {
    // Missing prefix
    expect(ACCOUNT_NUMBER_REGEX.test("100001")).toBe(false);
    // Wrong prefix
    expect(ACCOUNT_NUMBER_REGEX.test("CR-100001")).toBe(false);
    expect(ACCOUNT_NUMBER_REGEX.test("DR-100001")).toBe(false);
    expect(ACCOUNT_NUMBER_REGEX.test("sr-100001")).toBe(false);
    // Too short (< 6 digits)
    expect(ACCOUNT_NUMBER_REGEX.test("SR-1")).toBe(false);
    expect(ACCOUNT_NUMBER_REGEX.test("SR-1000")).toBe(false);
    expect(ACCOUNT_NUMBER_REGEX.test("SR-10000")).toBe(false);
    // Non-numeric suffix
    expect(ACCOUNT_NUMBER_REGEX.test("SR-10000A")).toBe(false);
    expect(ACCOUNT_NUMBER_REGEX.test("SR-ABCDEF")).toBe(false);
    // Spaces or punctuation
    expect(ACCOUNT_NUMBER_REGEX.test("SR- 100001")).toBe(false);
    expect(ACCOUNT_NUMBER_REGEX.test("SR-100001 ")).toBe(false);
    expect(ACCOUNT_NUMBER_REGEX.test("SR_100001")).toBe(false);
    expect(ACCOUNT_NUMBER_REGEX.test("")).toBe(false);
  });
});

describe("Role Scoping & Constraint Simulation", () => {
  const ACCOUNT_NUMBER_REGEX = /^SR-[0-9]{6,}$/;

  /**
   * Simulates the PostgreSQL CHECK constraint:
   * (role = 'customer' AND account_number IS NOT NULL AND account_number ~ '^SR-[0-9]{6,}$')
   * OR
   * (role <> 'customer' AND account_number IS NULL)
   */
  function satisfiesAccountConstraint(role: string, accountNumber: string | null): boolean {
    if (role === "customer") {
      return accountNumber !== null && ACCOUNT_NUMBER_REGEX.test(accountNumber);
    }
    return accountNumber === null;
  }

  it("permits valid customer with properly formatted account number", () => {
    expect(satisfiesAccountConstraint("customer", "SR-100001")).toBe(true);
    expect(satisfiesAccountConstraint("customer", "SR-100002")).toBe(true);
  });

  it("rejects customer without an account number", () => {
    expect(satisfiesAccountConstraint("customer", null)).toBe(false);
  });

  it("rejects customer with invalid account number format", () => {
    expect(satisfiesAccountConstraint("customer", "invalid")).toBe(false);
    expect(satisfiesAccountConstraint("customer", "SR-123")).toBe(false);
  });

  it("permits driver, staff, and admin with NULL account number", () => {
    expect(satisfiesAccountConstraint("driver", null)).toBe(true);
    expect(satisfiesAccountConstraint("staff", null)).toBe(true);
    expect(satisfiesAccountConstraint("admin", null)).toBe(true);
  });

  it("strictly rejects non-customers having an account number", () => {
    expect(satisfiesAccountConstraint("driver", "SR-100001")).toBe(false);
    expect(satisfiesAccountConstraint("staff", "SR-100001")).toBe(false);
    expect(satisfiesAccountConstraint("admin", "SR-100001")).toBe(false);
  });
});

describe("Deterministic Backfill Simulation", () => {
  interface UserRecord {
    id: string;
    role: "customer" | "driver" | "staff" | "admin";
    created_at: string;
    account_number: string | null;
  }

  function simulateBackfill(records: UserRecord[]) {
    // Emulates the CTE:
    // SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) - 1 AS row_offset
    // FROM users WHERE role = 'customer'
    const customers = records
      .filter((r) => r.role === "customer")
      .slice()
      .sort((a, b) => {
        const timeDiff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        if (timeDiff !== 0) return timeDiff;
        return a.id.localeCompare(b.id);
      });

    const allocations = new Map<string, string>();
    customers.forEach((c, index) => {
      allocations.set(c.id, `SR-${100001 + index}`);
    });

    const updated = records.map((r) => {
      if (r.role === "customer") {
        return { ...r, account_number: allocations.get(r.id) ?? null };
      }
      return { ...r, account_number: null };
    });

    // Emulates sequence sync:
    // COALESCE((SELECT MAX(SUBSTRING(account_number FROM 4)::bigint) FROM users WHERE account_number IS NOT NULL), 100000)
    let maxAllocated = 100000;
    for (const r of updated) {
      if (r.account_number && r.account_number.startsWith("SR-")) {
        const num = parseInt(r.account_number.slice(3), 10);
        if (num > maxAllocated) maxAllocated = num;
      }
    }

    return { updated, nextval: maxAllocated + 1 };
  }

  it("handles empty database (0 customers)", () => {
    const { updated, nextval } = simulateBackfill([]);
    expect(updated).toEqual([]);
    expect(nextval).toBe(100001); // Next customer gets SR-100001
  });

  it("leaves non-customers with null account_number", () => {
    const input: UserRecord[] = [
      { id: "d1", role: "driver", created_at: "2026-01-01T00:00:00Z", account_number: null },
      { id: "s1", role: "staff", created_at: "2026-01-02T00:00:00Z", account_number: null },
      { id: "a1", role: "admin", created_at: "2026-01-03T00:00:00Z", account_number: null },
    ];
    const { updated, nextval } = simulateBackfill(input);
    expect(updated.every((u) => u.account_number === null)).toBe(true);
    expect(nextval).toBe(100001);
  });

  it("deterministically backfills customers in created_at ASC order", () => {
    // Unordered input
    const input: UserRecord[] = [
      { id: "c3", role: "customer", created_at: "2026-01-03T10:00:00Z", account_number: null },
      { id: "c1", role: "customer", created_at: "2026-01-01T10:00:00Z", account_number: null },
      { id: "d1", role: "driver", created_at: "2026-01-01T08:00:00Z", account_number: null },
      { id: "c2", role: "customer", created_at: "2026-01-02T10:00:00Z", account_number: null },
    ];
    const { updated, nextval } = simulateBackfill(input);

    const c1 = updated.find((u) => u.id === "c1");
    const c2 = updated.find((u) => u.id === "c2");
    const c3 = updated.find((u) => u.id === "c3");
    const d1 = updated.find((u) => u.id === "d1");

    expect(c1?.account_number).toBe("SR-100001");
    expect(c2?.account_number).toBe("SR-100002");
    expect(c3?.account_number).toBe("SR-100003");
    expect(d1?.account_number).toBeNull();
    expect(nextval).toBe(100004);
  });

  it("uses id ASC as tie-breaker for identical created_at timestamps", () => {
    const ts = "2026-01-01T12:00:00Z";
    const input: UserRecord[] = [
      { id: "uuid-z", role: "customer", created_at: ts, account_number: null },
      { id: "uuid-a", role: "customer", created_at: ts, account_number: null },
      { id: "uuid-m", role: "customer", created_at: ts, account_number: null },
    ];
    const { updated, nextval } = simulateBackfill(input);

    expect(updated.find((u) => u.id === "uuid-a")?.account_number).toBe("SR-100001");
    expect(updated.find((u) => u.id === "uuid-m")?.account_number).toBe("SR-100002");
    expect(updated.find((u) => u.id === "uuid-z")?.account_number).toBe("SR-100003");
    expect(nextval).toBe(100004);
  });
});

describe("Contract & Zod Schema Conformance", () => {
  it("validates User schema with customer account number", () => {
    const raw = {
      id: randomUUID(),
      phone: "+251911223344",
      role: "customer",
      status: "active",
      fullName: "Abebe Bikila",
      email: null,
      locale: "am",
      phoneVerified: true,
      accountNumber: "SR-100001",
      createdAt: new Date().toISOString(),
    };
    const parsed = R.User.parse(raw);
    expect(parsed.accountNumber).toBe("SR-100001");
  });

  it("validates User schema with null account number for driver", () => {
    const raw = {
      id: randomUUID(),
      phone: "+251922334455",
      role: "driver",
      status: "active",
      fullName: "Kebede Michael",
      email: null,
      locale: "am",
      phoneVerified: true,
      accountNumber: null,
      createdAt: new Date().toISOString(),
    };
    const parsed = R.User.parse(raw);
    expect(parsed.accountNumber).toBeNull();
  });

  it("passes strictObject validation (as in contract.test.ts)", () => {
    const strict = (s: any): any => {
      const def = s?._zod?.def;
      if (!def) return s;
      switch (def.type) {
        case "object": return z.strictObject(Object.fromEntries(Object.entries(def.shape).map(([k, v]) => [k, strict(v)])));
        case "array": return z.array(strict(def.element));
        case "nullable": return strict(def.innerType).nullable();
        case "optional": return strict(def.innerType).optional();
        default: return s;
      }
    };

    const customerObj = {
      id: randomUUID(),
      phone: "+251911223344",
      role: "customer",
      status: "active",
      fullName: "Abebe Bikila",
      email: null,
      locale: "am",
      phoneVerified: true,
      accountNumber: "SR-100001",
    };

    const result = strict(R.User).safeParse(customerObj);
    expect(result.success).toBe(true);
  });
});

describe("Migration Script Audit", () => {
  it("contains valid migration SQL complying with checkpoint requirements", () => {
    const migrationPath = path.resolve(__dirname, "../src/db/migrations/0011_customer_account_numbers.sql");
    const sql = readFileSync(migrationPath, "utf-8");

    // Must create sequence starting at 100001
    expect(sql).toMatch(/CREATE SEQUENCE\s+customer_account_number_seq\s+START WITH\s+100001/i);

    // Must add account_number column
    expect(sql).toMatch(/ALTER TABLE\s+users\s+ADD COLUMN\s+account_number\s+text/i);

    // Must NOT use invalid PostgreSQL 'UPDATE ... ORDER BY'
    expect(sql).not.toMatch(/UPDATE\s+users\s+SET[\s\S]*?ORDER BY/i);

    // Must use CTE with ROW_NUMBER() and created_at ASC, id ASC
    expect(sql).toMatch(/WITH numbered_customers AS/i);
    expect(sql).toMatch(/ROW_NUMBER\(\)\s+OVER\s*\(\s*ORDER BY\s+created_at\s+ASC,\s+id\s+ASC\s*\)/i);

    // Must synchronize sequence with setval
    expect(sql).toMatch(/SELECT\s+setval\s*\(\s*'customer_account_number_seq'/i);

    // Must create unique index
    expect(sql).toMatch(/CREATE UNIQUE INDEX\s+users_customer_account_number_idx\s+ON\s+users\s*\(account_number\)\s+WHERE\s+account_number\s+IS NOT NULL/i);

    // Must add CHECK constraint enforcing role scoping and regex
    expect(sql).toMatch(/ALTER TABLE\s+users\s+ADD CONSTRAINT\s+users_customer_account_number_check/i);
    expect(sql).toMatch(/\^SR-\[0-9\]\{6,\}\$/);

    // Must grant usage and select to simpleride_app
    expect(sql).toMatch(/GRANT USAGE,\s*SELECT\s+ON SEQUENCE\s+customer_account_number_seq\s+TO\s+simpleride_app/i);
  });
});
