import { randomInt } from "node:crypto";
import { SYSTEM, withContext } from "../src/db/context.js";

export const randomPhone = () => `+2519${randomInt(10_000_000, 99_999_999)}`;

// Bole and Piassa, Addis Ababa
export const BOLE = { lat: 8.9961, lng: 38.7894 };
export const PIASSA = { lat: 9.0349, lng: 38.7525 };

/** Create a user directly (bypassing OTP) for SQL-level tests. */
export async function makeUser(role: "customer" | "driver" | "admin" | "staff") {
  return withContext(SYSTEM, async (db) => {
    const { rows: [u] } = await db.query(
      "INSERT INTO users (phone, role) VALUES ($1, $2) RETURNING id", [randomPhone(), role],
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
