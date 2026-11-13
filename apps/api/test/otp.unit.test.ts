import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// In-memory Redis simulation with accurate TTL and expiration modeling
const { mockRedis, storage } = vi.hoisted(() => {
  const storage = new Map<string, { val: string; expiresAt?: number }>();
  const timeState = { offsetMs: 0 };

  const now = () => Date.now() + timeState.offsetMs;

  const isExpired = (key: string): boolean => {
    const item = storage.get(key);
    if (!item) return false;
    if (item.expiresAt !== undefined && now() >= item.expiresAt) {
      storage.delete(key);
      return true;
    }
    return false;
  };

  const mockRedis = {
    now,
    fastForward: (seconds: number) => {
      timeState.offsetMs += seconds * 1000;
    },
    resetTime: () => {
      timeState.offsetMs = 0;
    },
    rawStorage: storage,
    get: vi.fn(async (key: string) => {
      if (isExpired(key)) return null;
      return storage.get(key)?.val ?? null;
    }),
    set: vi.fn(async (key: string, val: string, opt?: string, ttl?: number) => {
      let expiresAt: number | undefined;
      if (opt?.toUpperCase() === "EX" && typeof ttl === "number") {
        expiresAt = now() + ttl * 1000;
      }
      storage.set(key, { val, expiresAt });
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const k of keys) {
        if (storage.delete(k)) count++;
      }
      return count;
    }),
    incr: vi.fn(async (key: string) => {
      isExpired(key);
      const item = storage.get(key);
      const curr = parseInt(item?.val || "0", 10);
      const next = curr + 1;
      storage.set(key, { val: String(next), expiresAt: item?.expiresAt });
      return next;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      if (isExpired(key)) return 0;
      const item = storage.get(key);
      if (!item) return 0;
      item.expiresAt = now() + seconds * 1000;
      return 1;
    }),
    ttl: vi.fn(async (key: string) => {
      if (isExpired(key)) return -2;
      const item = storage.get(key);
      if (!item) return -2;
      if (item.expiresAt === undefined) return -1;
      return Math.max(0, Math.ceil((item.expiresAt - now()) / 1000));
    }),
    eval: vi.fn(
      async (
        _script: string,
        _numKeys: number,
        key1: string,
        key2: string,
        expectedHash: string,
        ttl: string | number,
        maxAttempts: string | number,
      ) => {
        if (isExpired(key1)) return 0;
        const storedItem = storage.get(key1);
        if (!storedItem) return 0;

        isExpired(key2);
        const attemptItem = storage.get(key2);
        const curr = parseInt(attemptItem?.val || "0", 10);
        const next = curr + 1;
        const ttlSec = typeof ttl === "number" ? ttl : parseInt(String(ttl), 10);
        const expiresAt = now() + ttlSec * 1000;
        storage.set(key2, { val: String(next), expiresAt });

        const max = typeof maxAttempts === "number" ? maxAttempts : parseInt(String(maxAttempts), 10);
        if (next > max) {
          storage.delete(key1);
          return 0;
        }

        let diff = 0;
        const s = typeof storedItem.val === "string" ? storedItem.val : "";
        const e = typeof expectedHash === "string" ? expectedHash : "";
        if (s.length !== 64 || e.length !== 64) {
          diff++;
        }
        for (let i = 0; i < 64; i++) {
          const a = i < s.length ? s.charCodeAt(i) : 0;
          const b = i < e.length ? e.charCodeAt(i) : 0;
          const delta = a - b;
          diff += delta * delta;
        }

        if (diff === 0) {
          storage.delete(key1);
          storage.delete(key2);
          return 1;
        }
        return 0;
      },
    ),
    multi: vi.fn(() => {
      const queue: (() => void)[] = [];
      const chain = {
        set(key: string, val: string, opt?: string, ttl?: number) {
          queue.push(() => {
            let expiresAt: number | undefined;
            if (opt?.toUpperCase() === "EX" && typeof ttl === "number") {
              expiresAt = now() + ttl * 1000;
            }
            storage.set(key, { val, expiresAt });
          });
          return chain;
        },
        del(...keys: string[]) {
          queue.push(() => {
            for (const k of keys) storage.delete(k);
          });
          return chain;
        },
        async exec() {
          for (const op of queue) op();
          return [];
        },
      };
      return chain;
    }),
  };

  return { mockRedis, storage };
});

vi.mock("../src/lib/redis.js", () => ({
  redis: mockRedis,
}));

import {
  attemptsKey,
  clearOtp,
  consoleSms,
  getOtpIdentity,
  getSmsSender,
  issueOtp,
  MockSmsSender,
  otpKey,
  setSmsSender,
  verifyOtp,
  type OtpScope,
} from "../src/auth/otp.js";
import { env } from "../src/config/env.js";

describe("OTP and SMS Abstraction (offline unit tests)", () => {
  const phone = "+251911223344";
  const defaultScope: OtpScope = { purpose: "register", phone, role: "customer" };
  let mockSender: MockSmsSender;

  beforeEach(() => {
    storage.clear();
    mockRedis.resetTime();
    vi.clearAllMocks();
    mockSender = new MockSmsSender();
    setSmsSender(mockSender);
  });

  afterEach(() => {
    // Confirm test cleanup: restores active SMS sender and resets mock state
    setSmsSender(consoleSms);
    mockRedis.resetTime();
    storage.clear();
  });

  describe("SmsSender Abstraction", () => {
    it("allows replacing and inspecting the active SMS sender", () => {
      expect(getSmsSender()).toBe(mockSender);
      setSmsSender(consoleSms);
      expect(getSmsSender()).toBe(consoleSms);
    });

    it("MockSmsSender records sent messages and clears them", async () => {
      await mockSender.send(phone, "Test message 1");
      await mockSender.send(phone, "Test message 2");
      expect(mockSender.sent.length).toBe(2);
      expect(mockSender.sent[0]).toEqual({ phone, message: "Test message 1" });

      mockSender.clear();
      expect(mockSender.sent.length).toBe(0);
    });
  });

  describe("issueOtp", () => {
    it("generates a 6-digit code, stores hash in Redis with 5-minute TTL, and sends SMS", async () => {
      const code = await issueOtp(defaultScope);
      expect(mockSender.sent.length).toBe(1);
      const sentMsg = mockSender.sent[0]!.message;
      expect(sentMsg).toMatch(/^Simple Ride code: \d{6}$/);

      const parsedCode = sentMsg.replace("Simple Ride code: ", "");
      expect(parsedCode.length).toBe(6);

      // Verify that Redis key `otp:<purpose>:<phone>:<identity>` was populated with a hash and 5-min TTL
      const storedItem = storage.get(otpKey(defaultScope));
      expect(storedItem).toBeDefined();
      expect(storedItem!.val).not.toBe(parsedCode); // stored as SHA-256 hash
      expect(storedItem!.expiresAt).toBeDefined();
      expect(await mockRedis.ttl(otpKey(defaultScope))).toBe(env.OTP_TTL_SECONDS);

      if (env.OTP_DEV_ECHO) {
        expect(code).toBe(parsedCode);
      } else {
        expect(code).toBeUndefined();
      }
    });

    it("clears previous failed attempts when issuing a new code", async () => {
      storage.set(attemptsKey(defaultScope), { val: "3" });
      await issueOtp(defaultScope);
      expect(storage.has(attemptsKey(defaultScope))).toBe(false);
    });

    it("clears OTP and attempt keys if SMS delivery fails", async () => {
      const failingSender = {
        async send() {
          throw new Error("SMS network failure");
        },
      };
      setSmsSender(failingSender);
      await expect(issueOtp(defaultScope)).rejects.toThrow("SMS network failure");
      expect(storage.has(otpKey(defaultScope))).toBe(false);
      expect(storage.has(attemptsKey(defaultScope))).toBe(false);
    });
  });

  describe("verifyOtp: correctness, single-use, and attempt limits", () => {
    it("returns false if no OTP was issued for phone", async () => {
      expect(await verifyOtp({ purpose: "register", phone: "+251999999999", role: "customer" }, "123456")).toBe(false);
    });

    it("returns true for the correct code and deletes the OTP (preventing replay)", async () => {
      await issueOtp(defaultScope);
      const code = mockSender.sent[0]!.message.replace("Simple Ride code: ", "");

      // First verification succeeds
      const result = await verifyOtp(defaultScope, code);
      expect(result).toBe(true);

      // OTP key and attempts must be deleted upon successful verification
      expect(storage.has(otpKey(defaultScope))).toBe(false);
      expect(storage.has(attemptsKey(defaultScope))).toBe(false);

      // Replay attack: second verification of same code must fail
      const replay = await verifyOtp(defaultScope, code);
      expect(replay).toBe(false);
    });

    it("returns false for wrong code and increments attempt counter", async () => {
      await issueOtp(defaultScope);
      const result = await verifyOtp(defaultScope, "000000");
      expect(result).toBe(false);
      expect(storage.get(attemptsKey(defaultScope))?.val).toBe("1");
    });

    it("allows successful verification on the 5th attempt after 4 failed guesses", async () => {
      await issueOtp(defaultScope);
      const correctCode = mockSender.sent[0]!.message.replace("Simple Ride code: ", "");

      // 4 wrong attempts (attempts 1 to 4)
      for (let i = 1; i <= 4; i++) {
        expect(await verifyOtp(defaultScope, `00000${i}`)).toBe(false);
        expect(storage.get(attemptsKey(defaultScope))?.val).toBe(String(i));
      }

      // 5th attempt with correct code succeeds
      expect(await verifyOtp(defaultScope, correctCode)).toBe(true);
      expect(storage.has(otpKey(defaultScope))).toBe(false);
    });

    it("invalidates and burns the OTP after exceeding maximum allowed attempts (attempt 6)", async () => {
      await issueOtp(defaultScope);
      const correctCode = mockSender.sent[0]!.message.replace("Simple Ride code: ", "");

      // 5 wrong attempts
      for (let i = 1; i <= 5; i++) {
        expect(await verifyOtp(defaultScope, `00000${i}`)).toBe(false);
        expect(storage.get(attemptsKey(defaultScope))?.val).toBe(String(i));
      }

      // 6th attempt triggers invalidation (attempts > MAX_ATTEMPTS)
      const sixthAttempt = await verifyOtp(defaultScope, "999999");
      expect(sixthAttempt).toBe(false);
      expect(storage.has(otpKey(defaultScope))).toBe(false); // burned!

      // Now even the correct code is rejected because the OTP was burned
      const subsequentAttempt = await verifyOtp(defaultScope, correctCode);
      expect(subsequentAttempt).toBe(false);
    });

    it("handles malformed stored hashes safely without throwing", async () => {
      // Stored value is shorter than 64 characters
      storage.set(otpKey(defaultScope), { val: "short-corrupted-hash" });
      expect(await verifyOtp(defaultScope, "123456")).toBe(false);
      expect(storage.get(attemptsKey(defaultScope))?.val).toBe("1");
    });

    it("requires all 64 characters of the SHA-256 digest to match (arithmetic scan)", async () => {
      await issueOtp(defaultScope);
      const correctCode = mockSender.sent[0]!.message.replace("Simple Ride code: ", "");
      const realStored = storage.get(otpKey(defaultScope))!.val;

      // Tamper with first character of stored hash (index 0)
      const tamperedFirst = (realStored[0] === "a" ? "b" : "a") + realStored.slice(1);
      storage.set(otpKey(defaultScope), { val: tamperedFirst });
      expect(await verifyOtp(defaultScope, correctCode)).toBe(false);

      // Tamper with middle character of stored hash (index 32)
      const tamperedMiddle = realStored.slice(0, 32) + (realStored[32] === "a" ? "b" : "a") + realStored.slice(33);
      storage.set(otpKey(defaultScope), { val: tamperedMiddle });
      expect(await verifyOtp(defaultScope, correctCode)).toBe(false);

      // Tamper with last character of stored hash (index 63)
      const tamperedLast = realStored.slice(0, 63) + (realStored[63] === "a" ? "b" : "a");
      storage.set(otpKey(defaultScope), { val: tamperedLast });
      expect(await verifyOtp(defaultScope, correctCode)).toBe(false);

      // Restore untampered hash and verify it succeeds
      storage.set(otpKey(defaultScope), { val: realStored });
      expect(await verifyOtp(defaultScope, correctCode)).toBe(true);
    });
  });

  describe("verifyOtp: expiration after five-minute TTL", () => {
    it("remains valid before expiration (within the 5-minute TTL)", async () => {
      await issueOtp(defaultScope);
      const code = mockSender.sent[0]!.message.replace("Simple Ride code: ", "");

      // Advance 4 minutes (240 seconds) — still valid
      mockRedis.fastForward(240);
      expect(await mockRedis.ttl(otpKey(defaultScope))).toBe(60);

      const result = await verifyOtp(defaultScope, code);
      expect(result).toBe(true);
    });

    it("expires after 5 minutes (300 seconds) and rejects verification", async () => {
      await issueOtp(defaultScope);
      const code = mockSender.sent[0]!.message.replace("Simple Ride code: ", "");

      // Advance 301 seconds (past the 300-second TTL)
      mockRedis.fastForward(env.OTP_TTL_SECONDS + 1);

      // Verify that Redis considers key expired
      expect(await mockRedis.get(otpKey(defaultScope))).toBeNull();

      // verifyOtp must reject expired code
      const result = await verifyOtp(defaultScope, code);
      expect(result).toBe(false);
    });

    it("expires the attempt counter along with the TTL", async () => {
      await issueOtp(defaultScope);
      // Generate 2 failed attempts
      await verifyOtp(defaultScope, "000001");
      await verifyOtp(defaultScope, "000002");
      expect(storage.has(attemptsKey(defaultScope))).toBe(true);

      // Advance past TTL
      mockRedis.fastForward(env.OTP_TTL_SECONDS + 1);

      // Attempt counter must expire
      expect(await mockRedis.get(attemptsKey(defaultScope))).toBeNull();
    });
  });

  describe("Purpose and account identity isolation (unit tests)", () => {
    const userId1 = "11111111-1111-1111-1111-111111111111";
    const userId2 = "22222222-2222-2222-2222-222222222222";

    it("rejects cross-purpose OTP verification even on the same phone", async () => {
      const regScope: OtpScope = { purpose: "register", phone, role: "customer" };
      await issueOtp(regScope);
      const code = mockSender.sent[0]!.message.replace("Simple Ride code: ", "");

      // Attempting to verify registration code for password reset fails
      const pwScope: OtpScope = { purpose: "password_reset", phone, userId: userId1 };
      expect(await verifyOtp(pwScope, code)).toBe(false);

      // Attempting to verify registration code for verify_phone fails
      const vpScope: OtpScope = { purpose: "verify_phone", phone, userId: userId1 };
      expect(await verifyOtp(vpScope, code)).toBe(false);

      // Verifying with original scope succeeds
      expect(await verifyOtp(regScope, code)).toBe(true);
    });

    it("rejects cross-role registration OTP verification on the same phone", async () => {
      const custReg: OtpScope = { purpose: "register", phone, role: "customer" };
      const drvReg: OtpScope = { purpose: "register", phone, role: "driver" };

      await issueOtp(custReg);
      const code = mockSender.sent[0]!.message.replace("Simple Ride code: ", "");

      // Customer registration code cannot be verified for driver registration
      expect(await verifyOtp(drvReg, code)).toBe(false);
      // Customer registration code works for customer
      expect(await verifyOtp(custReg, code)).toBe(true);
    });

    it("rejects cross-account password reset verification on the same phone", async () => {
      const custPw: OtpScope = { purpose: "password_reset", phone, userId: userId1 };
      const drvPw: OtpScope = { purpose: "password_reset", phone, userId: userId2 };

      await issueOtp(custPw);
      const code = mockSender.sent[0]!.message.replace("Simple Ride code: ", "");

      // Customer password reset code cannot reset driver account
      expect(await verifyOtp(drvPw, code)).toBe(false);
      // Works for customer account
      expect(await verifyOtp(custPw, code)).toBe(true);
    });

    it("isolates attempt counters across purposes and accounts on the same phone", async () => {
      const regScope: OtpScope = { purpose: "register", phone, role: "customer" };
      const pwScope: OtpScope = { purpose: "password_reset", phone, userId: userId1 };

      await issueOtp(regScope);
      await issueOtp(pwScope);

      // Fail 3 attempts on register
      await verifyOtp(regScope, "000001");
      await verifyOtp(regScope, "000002");
      await verifyOtp(regScope, "000003");

      expect(storage.get(attemptsKey(regScope))?.val).toBe("3");
      // Password reset attempts counter must be unpolluted
      expect(storage.has(attemptsKey(pwScope))).toBe(false);
    });

    it("clearOtp removes OTP and attempt keys", async () => {
      const pwScope: OtpScope = { purpose: "password_reset", phone, userId: userId1 };
      await issueOtp(pwScope);
      expect(storage.has(otpKey(pwScope))).toBe(true);

      await clearOtp(pwScope);
      expect(storage.has(otpKey(pwScope))).toBe(false);
      expect(storage.has(attemptsKey(pwScope))).toBe(false);
    });
  });
});
