import { randomInt } from "node:crypto";
import { SYSTEM, withContext } from "../src/db/context.js";

export const randomPhone = () => `+2519${randomInt(10_000_000, 99_999_999)}`;

// Bole and Piassa, Addis Ababa
export const BOLE = { lat: 8.9961, lng: 38.7894 };
export const PIASSA = { lat: 9.0349, lng: 38.7525 };

/** Create a user directly (bypassing OTP) for SQL-level tests. */
export async function makeUser(role: "customer" | "driver" | "admin") {
  return withContext(SYSTEM, async (db) => {
    const { rows: [u] } = await db.query(
      "INSERT INTO users (phone, role) VALUES ($1, $2) RETURNING id", [randomPhone(), role],
    );
    await db.query("INSERT INTO wallets (user_id) VALUES ($1)", [u.id]);
    if (role === "driver") {
      await db.query("INSERT INTO driver_profiles (user_id) VALUES ($1)", [u.id]);
    }
    return u.id as string;
  });
}
