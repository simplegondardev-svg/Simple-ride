import { randomInt } from "node:crypto";
import { getSmsSender, issueOtp, MockSmsSender, setSmsSender, type OtpScope } from "../src/auth/otp.js";
import { SYSTEM, withContext } from "../src/db/context.js";
import { assertTestDatabaseIsolation } from "../src/db/isolation.js";
import { normalizeEthiopianPhone } from "../src/lib/phone.js";

export const randomPhone = () => `+2519${randomInt(10_000_000, 99_999_999)}`;

/** Issue an OTP code via MockSmsSender for tests that register users or verify actions. */
export async function getOtpCode(
  scopeOrPhone: OtpScope | string,
  role: "customer" | "driver" = "customer",
): Promise<string> {
  const scope: OtpScope = typeof scopeOrPhone === "string"
    ? { purpose: "register", phone: normalizeEthiopianPhone(scopeOrPhone) ?? scopeOrPhone, role }
    : scopeOrPhone;
  const current = getSmsSender();
  let mock: MockSmsSender;
  if (current instanceof MockSmsSender) {
    mock = current;
  } else {
    mock = new MockSmsSender();
    setSmsSender(mock);
  }
  await issueOtp(scope);
  const msg = mock.sent.filter((s) => s.phone === scope.phone).pop()?.message;
  return msg?.replace("Simple Ride code: ", "") || "123456";
}

// Bole and Piassa, Addis Ababa
export const BOLE = { lat: 8.9961, lng: 38.7894 };
export const PIASSA = { lat: 9.0349, lng: 38.7525 };

/** Create a user directly (bypassing OTP) for SQL-level tests. */
export async function makeUser(role: "customer" | "driver" | "admin" | "staff") {
  assertTestDatabaseIsolation();
  return withContext(SYSTEM, async (db) => {
    const insertSql = role === "customer"
      ? "INSERT INTO users (phone, role, account_number) VALUES ($1, $2, 'SR-' || nextval('customer_account_number_seq')) RETURNING id"
      : "INSERT INTO users (phone, role) VALUES ($1, $2) RETURNING id";
    const { rows: [u] } = await db.query(
      insertSql, [randomPhone(), role],
    );
    if (role !== "staff") await db.query("INSERT INTO wallets (user_id) VALUES ($1)", [u.id]);
    if (role === "driver") {
      await db.query("INSERT INTO driver_profiles (user_id) VALUES ($1)", [u.id]);
    }
    return u.id as string;
  });
}

/** Replace a staff member's permissions directly (owner-level, for SQL tests). */
export async function grant(staffId: string, permissions: string[]) {
  assertTestDatabaseIsolation();
  await withContext(SYSTEM, async (db) => {
    await db.query("DELETE FROM staff_permissions WHERE user_id = $1", [staffId]);
    for (const p of permissions) {
      await db.query("INSERT INTO staff_permissions (user_id, permission) VALUES ($1, $2)", [staffId, p]);
    }
  });
}

export const PASSWORD = "Addis-Ride-2026!";

/** Admin or staff account with a known, already-changed password. */
export async function makeBackoffice(role: "admin" | "staff", phone = randomPhone()) {
  assertTestDatabaseIsolation();
  const { hashPassword } = await import("../src/auth/password.js");
  const hash = await hashPassword(PASSWORD);
  const id = await withContext(SYSTEM, async (db) => {
    const { rows: [u] } = await db.query(
      "INSERT INTO users (phone, role) VALUES ($1, $2) RETURNING id", [phone, role],
    );
    await db.query(
      "INSERT INTO user_credentials (user_id, password_hash, must_change_password) VALUES ($1, $2, false)",
      [u.id, hash],
    );
    return u.id as string;
  });
  return { id, phone };
}

/** Create an unverified legacy user with credentials for verification testing. */
export async function makeLegacyUser(role: "customer" | "driver", phone = randomPhone()) {
  assertTestDatabaseIsolation();
  const { hashPassword } = await import("../src/auth/password.js");
  const hash = await hashPassword(PASSWORD);
  return withContext(SYSTEM, async (db) => {
    const insertSql = role === "customer"
      ? "INSERT INTO users (phone, role, phone_verified_at, account_number) VALUES ($1, $2, NULL, 'SR-' || nextval('customer_account_number_seq')) RETURNING id"
      : "INSERT INTO users (phone, role, phone_verified_at) VALUES ($1, $2, NULL) RETURNING id";
    const { rows: [u] } = await db.query(
      insertSql,
      [phone, role],
    );
    await db.query(
      "INSERT INTO user_credentials (user_id, password_hash, must_change_password) VALUES ($1, $2, false)",
      [u.id, hash],
    );
    await db.query("INSERT INTO wallets (user_id) VALUES ($1)", [u.id]);
    if (role === "driver") {
      await db.query("INSERT INTO driver_profiles (user_id) VALUES ($1)", [u.id]);
    }
    return { id: u.id as string, phone };
  });
}

/** Credit a driver's prepaid deposit directly (default: the 10,000 ETB minimum). */
export async function fundDriver(driverId: string, amount = 1_000_000) {
  assertTestDatabaseIsolation();
  const { postLedger } = await import("../src/modules/wallet/ledger.js");
  return withContext(SYSTEM, (db) => postLedger(db, { userId: driverId, amount, kind: "deposit", reference: "test" }));
}

/** A tiny valid PNG (1×1 pixel) to stand in for a document photo. */
export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/**
 * Upload a document the way the driver app does: ask for a signed URL, PUT the
 * file there, submit. Uses the local storage driver (signed /api/v1/files URLs).
 */
export async function uploadDocument(
  app: any, token: string, docType: string, opts: { vehicleId?: string; expiresOn?: string } = {},
): Promise<string> {
  const { default: request } = await import("supertest");
  const start = await request(app).post("/api/v1/drivers/me/documents").set({ Authorization: `Bearer ${token}` })
    .send({ docType, vehicleId: opts.vehicleId, contentType: "image/png", sizeBytes: PNG.length });
  if (start.status !== 201) throw new Error(`start upload ${docType}: ${start.status} ${JSON.stringify(start.body)}`);
  const url = new URL(start.body.upload.url);
  await request(app).put(url.pathname + url.search).set("Content-Type", "image/png").send(PNG).expect(200);
  const expiresOn = opts.expiresOn ?? (["license", "vehicle_insurance", "vehicle_bolo"].includes(docType) ? "2030-12-31" : undefined);
  await request(app).post(`/api/v1/drivers/me/documents/${start.body.document.id}/submit`)
    .set({ Authorization: `Bearer ${token}` }).send({ expiresOn }).expect(200);
  return start.body.document.id;
}

/** All required documents for a driver and vehicle, uploaded and submitted. Returns their ids. */
export async function uploadRequiredDocuments(app: any, token: string, vehicleId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const t of ["license", "photo"]) ids.push(await uploadDocument(app, token, t));
  for (const t of ["vehicle_libre", "vehicle_insurance", "vehicle_bolo"]) ids.push(await uploadDocument(app, token, t, { vehicleId }));
  return ids;
}
