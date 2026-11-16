import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { signAccessToken } from "../src/auth/tokens.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";
import { makeUser } from "./helpers.js";

const app = createApp();
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("HTTP-level Account & Ownership Integration Tests (CP2.5)", () => {
  let customerAId: string;
  let customerBId: string;
  let driverId: string;

  let customerAToken: string;
  let customerBToken: string;
  let driverToken: string;

  beforeAll(async () => {
    // Isolated test fixtures
    [customerAId, customerBId, driverId] = await Promise.all([
      makeUser("customer"),
      makeUser("customer"),
      makeUser("driver"),
    ]);

    customerAToken = signAccessToken({ sub: customerAId, role: "customer" });
    customerBToken = signAccessToken({ sub: customerBId, role: "customer" });
    driverToken = signAccessToken({ sub: driverId, role: "driver" });
  });

  afterAll(async () => {
    await pool.end();
    redis.disconnect();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 1. Unauthenticated requests
  // ───────────────────────────────────────────────────────────────────────────
  describe("Unauthenticated requests", () => {
    it("rejects GET /api/v1/users/me without token", async () => {
      const res = await request(app).get("/api/v1/users/me").expect(401);
      expect(res.body.error?.code).toBe("UNAUTHENTICATED");
    });

    it("rejects PATCH /api/v1/users/me without token", async () => {
      const res = await request(app)
        .patch("/api/v1/users/me")
        .send({ fullName: "Anonymous Attacker" })
        .expect(401);
      expect(res.body.error?.code).toBe("UNAUTHENTICATED");
    });

    it("rejects GET /api/v1/users/me/wallet without token", async () => {
      const res = await request(app).get("/api/v1/users/me/wallet").expect(401);
      expect(res.body.error?.code).toBe("UNAUTHENTICATED");
    });

    it("rejects invalid or malformed bearer token", async () => {
      const res = await request(app)
        .get("/api/v1/users/me")
        .set({ Authorization: "Bearer malformed.invalid.token" })
        .expect(401);
      expect(res.body.error?.code).toBe("INVALID_TOKEN");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 2. GET /api/v1/users/me authentication & accountNumber response
  // ───────────────────────────────────────────────────────────────────────────
  describe("GET /api/v1/users/me", () => {
    it("returns profile with valid customer accountNumber for customer", async () => {
      const res = await request(app)
        .get("/api/v1/users/me")
        .set(bearer(customerAToken))
        .expect(200);

      expect(res.body.id).toBe(customerAId);
      expect(res.body.role).toBe("customer");
      expect(res.body.status).toBe("active");
      expect(typeof res.body.phone).toBe("string");
      expect(typeof res.body.accountNumber).toBe("string");
      expect(res.body.accountNumber).toMatch(/^SR-[0-9]{6,}$/);
    });

    it("returns profile with null accountNumber for driver", async () => {
      const res = await request(app)
        .get("/api/v1/users/me")
        .set(bearer(driverToken))
        .expect(200);

      expect(res.body.id).toBe(driverId);
      expect(res.body.role).toBe("driver");
      expect(res.body.accountNumber).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 3. PATCH /api/v1/users/me profile updates
  // ───────────────────────────────────────────────────────────────────────────
  describe("PATCH /api/v1/users/me", () => {
    it("updates fullName, email, and locale successfully", async () => {
      const updatePayload = {
        fullName: "Abebe Bikila",
        email: "abebe@example.com",
        locale: "am" as const,
      };

      const res = await request(app)
        .patch("/api/v1/users/me")
        .set(bearer(customerAToken))
        .send(updatePayload)
        .expect(200);

      expect(res.body.fullName).toBe("Abebe Bikila");
      expect(res.body.email).toBe("abebe@example.com");
      expect(res.body.locale).toBe("am");

      // Verify persistence via subsequent GET
      const verifyRes = await request(app)
        .get("/api/v1/users/me")
        .set(bearer(customerAToken))
        .expect(200);

      expect(verifyRes.body.fullName).toBe("Abebe Bikila");
      expect(verifyRes.body.email).toBe("abebe@example.com");
      expect(verifyRes.body.locale).toBe("am");
    });

    it("rejects or safely discards attempts to modify protected columns", async () => {
      // Get baseline state before update attempt
      const baseline = await request(app)
        .get("/api/v1/users/me")
        .set(bearer(customerAToken))
        .expect(200);

      const originalAccountNumber = baseline.body.accountNumber;
      const originalPhone = baseline.body.phone;
      const originalRole = baseline.body.role;

      // Attacker attempts to forge account_number, phone, role, status
      const maliciousPayload = {
        fullName: "Abebe Bikila Updated",
        accountNumber: "SR-999999",
        account_number: "SR-999999",
        phone: "+251911999999",
        role: "admin",
        status: "suspended",
      };

      const res = await request(app)
        .patch("/api/v1/users/me")
        .set(bearer(customerAToken))
        .send(maliciousPayload)
        .expect(200);

      // Permitted field updated
      expect(res.body.fullName).toBe("Abebe Bikila Updated");

      // Protected fields strictly unchanged
      expect(res.body.accountNumber).toBe(originalAccountNumber);
      expect(res.body.phone).toBe(originalPhone);
      expect(res.body.role).toBe(originalRole);
      expect(res.body.status).toBe("active");

      // Re-verify in database via GET /me
      const verify = await request(app)
        .get("/api/v1/users/me")
        .set(bearer(customerAToken))
        .expect(200);

      expect(verify.body.accountNumber).toBe(originalAccountNumber);
      expect(verify.body.phone).toBe(originalPhone);
      expect(verify.body.role).toBe("customer");
      expect(verify.body.status).toBe("active");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 4. GET /api/v1/users/me/wallet balance and transaction structure
  // ───────────────────────────────────────────────────────────────────────────
  describe("GET /api/v1/users/me/wallet", () => {
    it("returns wallet balance and transaction list structure", async () => {
      const res = await request(app)
        .get("/api/v1/users/me/wallet")
        .set(bearer(customerAToken))
        .expect(200);

      expect(res.body).toHaveProperty("balance");
      expect(typeof res.body.balance).toBe("number");
      expect(res.body.currency).toBe("ETB");
      expect(Array.isArray(res.body.transactions)).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 5. Cross-account ownership isolation
  // ───────────────────────────────────────────────────────────────────────────
  describe("Cross-account ownership isolation", () => {
    it("ensures Customer A and Customer B cannot read each other's data", async () => {
      const resA = await request(app)
        .get("/api/v1/users/me")
        .set(bearer(customerAToken))
        .expect(200);

      const resB = await request(app)
        .get("/api/v1/users/me")
        .set(bearer(customerBToken))
        .expect(200);

      expect(resA.body.id).toBe(customerAId);
      expect(resB.body.id).toBe(customerBId);
      expect(resA.body.id).not.toBe(resB.body.id);

      expect(resA.body.accountNumber).not.toBe(resB.body.accountNumber);
      expect(resA.body.phone).not.toBe(resB.body.phone);
    });

    it("ensures Customer A's updates do not affect Customer B", async () => {
      await request(app)
        .patch("/api/v1/users/me")
        .set(bearer(customerAToken))
        .send({ fullName: "Customer A Name", email: "customera@example.com" })
        .expect(200);

      const resB = await request(app)
        .get("/api/v1/users/me")
        .set(bearer(customerBToken))
        .expect(200);

      expect(resB.body.fullName).not.toBe("Customer A Name");
      expect(resB.body.email).not.toBe("customera@example.com");
    });
  });
});
