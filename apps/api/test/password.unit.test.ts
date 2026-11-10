import { describe, expect, it } from "vitest";
import { dummyHash, hashPassword, passwordProblem, temporaryPassword, verifyPassword } from "../src/auth/password.js";

describe("passwordProblem (offline unit tests)", () => {
  const phone = "+251911223344";

  it.each([
    ["", "Password must be at least 10 characters"],
    ["123456789", "Password must be at least 10 characters"],
    ["short", "Password must be at least 10 characters"],
  ])("rejects short password '%s'", (pw, expectedError) => {
    expect(passwordProblem(pw, phone)).toBe(expectedError);
  });

  it("rejects passwords longer than 128 characters", () => {
    const longPw = "A".repeat(129) + "9!";
    expect(passwordProblem(longPw, phone)).toBe("Password must be at most 128 characters");
  });

  it.each([
    ["My911223344Password", "Password must not contain your phone number"],
    ["Pass-911223344-word", "Password must not contain your phone number"],
    ["Pass+251911223344word", "Password must not contain your phone number"],
  ])("rejects password containing phone substring: %s", (pw, expectedError) => {
    expect(passwordProblem(pw, phone)).toBe(expectedError);
  });

  it.each([
    ["aaaaaaaaaaaa", "Password must not be one repeated character"],
    ["111111111111", "Password must not be one repeated character"],
    ["!!!!!!!!!!!!", "Password must not be one repeated character"],
  ])("rejects password with single repeated character: %s", (pw, expectedError) => {
    expect(passwordProblem(pw, phone)).toBe(expectedError);
  });

  it.each([
    ["Correct-Horse-Battery-9"],
    ["SuperSecretPass123!"],
    ["AdisAbeba#2026Secure"],
  ])("accepts strong valid password: %s", (pw) => {
    expect(passwordProblem(pw, phone)).toBeNull();
  });
});

describe("temporaryPassword (offline unit tests)", () => {
  it("generates a 14-character string in 4-4-4 format", () => {
    const temp = temporaryPassword();
    expect(temp).toMatch(/^[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}-[a-km-zA-HJ-NP-Z2-9]{4}$/);
    expect(temp.length).toBe(14);
  });

  it("excludes ambiguous characters (0, O, 1, l, I)", () => {
    for (let i = 0; i < 20; i++) {
      const temp = temporaryPassword();
      expect(temp).not.toMatch(/[0O1lI]/);
    }
  });

  it("generates distinct passwords on successive calls", () => {
    const set = new Set(Array.from({ length: 10 }, () => temporaryPassword()));
    expect(set.size).toBe(10);
  });
});

describe("hashPassword and verifyPassword (offline unit tests)", () => {
  it("hashes passwords with scrypt using salt and standard cost parameters", async () => {
    const raw = "SuperSecretPassword123!";
    const hash = await hashPassword(raw);
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);

    const hash2 = await hashPassword(raw);
    expect(hash).not.toBe(hash2); // unique salt
  });

  it("verifies matching passwords correctly", async () => {
    const raw = "SuperSecretPassword123!";
    const hash = await hashPassword(raw);
    expect(await verifyPassword(raw, hash)).toBe(true);
  });

  it("rejects non-matching passwords", async () => {
    const hash = await hashPassword("ValidPassword123!");
    expect(await verifyPassword("WrongPassword123!", hash)).toBe(false);
  });

  it.each([
    ["invalid-format"],
    ["bcrypt$10$salt$hash"],
    ["scrypt$32768$8$1$$"],
    ["scrypt$32768$8$1$salt"],
  ])("rejects malformed stored hash '%s'", async (malformed) => {
    expect(await verifyPassword("SomePassword123!", malformed)).toBe(false);
  });
});

describe("dummyHash (offline unit tests)", () => {
  it("returns a valid scrypt hash and caches the result", async () => {
    const h1 = await dummyHash();
    const h2 = await dummyHash();
    expect(h1).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(h1).toBe(h2);
  });
});

