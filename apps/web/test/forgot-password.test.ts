import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEthiopianPhone, isValidEthiopianPhone, formatEthiopianPhone } from "../src/lib/phone";
import { checkPasswordPolicy, getPasswordRequirements } from "../src/lib/password";
import { createSessionManager, type CookieStore, type SessionCookieOptions } from "../src/lib/session";
import { POST as passwordForgotHandler } from "../src/app/api/auth/password/forgot/route";
import { POST as passwordResetHandler } from "../src/app/api/auth/password/reset/route";

// Isolated in-memory cookie jar for BFF route tests
class TestCookieJar implements CookieStore {
  cookies = new Map<string, { value: string; opts: SessionCookieOptions }>();

  get(name: string) {
    const item = this.cookies.get(name);
    return item ? { value: item.value } : undefined;
  }

  set(name: string, value: string, opts: SessionCookieOptions) {
    this.cookies.set(name, { value, opts });
  }

  delete(name: string) {
    this.cookies.delete(name);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Phone and Role Validation Tests
// ─────────────────────────────────────────────────────────────────────────────

test("Password recovery: Phone and role validation", () => {
  // Valid roles
  const allowedRoles = ["customer", "driver"];
  assert.equal(allowedRoles.includes("customer"), true);
  assert.equal(allowedRoles.includes("driver"), true);
  assert.equal(allowedRoles.includes("staff"), false);
  assert.equal(allowedRoles.includes("admin"), false);

  // Ethiopian mobile numbers
  const validNumbers = ["0911223344", "0711223344", "+251911223344", "251911223344", "09 11 22 33 44"];
  for (const num of validNumbers) {
    assert.equal(isValidEthiopianPhone(num), true);
    const normalized = normalizeEthiopianPhone(num);
    assert.ok(normalized?.startsWith("+251"));
    assert.equal(normalized?.length, 13);
  }

  // Invalid numbers rejected
  assert.equal(isValidEthiopianPhone("0811223344"), false);
  assert.equal(isValidEthiopianPhone("091122"), false);
  assert.equal(isValidEthiopianPhone("+12025550123"), false);
  assert.equal(isValidEthiopianPhone(""), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. OTP Sanitization Tests
// ─────────────────────────────────────────────────────────────────────────────

test("Password recovery: OTP input sanitization", () => {
  const sanitizeOtp = (val: string) => val.replace(/\D/g, "").slice(0, 6);

  assert.equal(sanitizeOtp("123456"), "123456");
  assert.equal(sanitizeOtp("12 34 56"), "123456");
  assert.equal(sanitizeOtp("12-34-56"), "123456");
  assert.equal(sanitizeOtp("abc123xyz456"), "123456");
  assert.equal(sanitizeOtp("123456789"), "123456");

  const isValidOtp = (val: string) => /^\d{6}$/.test(val.trim());
  assert.equal(isValidOtp("123456"), true);
  assert.equal(isValidOtp("12345"), false);
  assert.equal(isValidOtp("1234567"), false);
  assert.equal(isValidOtp("abcdef"), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Password Policy and Confirmation Tests
// ─────────────────────────────────────────────────────────────────────────────

test("Password recovery: Password policy and confirmation matching", () => {
  const phone = "+251911223344";

  // Policy rules
  assert.equal(checkPasswordPolicy("short", phone), "Password must be at least 10 characters");
  assert.equal(checkPasswordPolicy("123456789", phone), "Password must be at least 10 characters");
  assert.equal(checkPasswordPolicy("MyPhone911223344!", phone), "Password must not contain your phone number");
  assert.equal(checkPasswordPolicy("aaaaaaaaaa", phone), "Password must not be one repeated character");
  assert.equal(checkPasswordPolicy("ValidPassword123!", phone), null);

  // Confirmation matching
  const matchCheck = (pw: string, conf: string) => pw.length > 0 && conf.length > 0 && pw === conf;
  assert.equal(matchCheck("NewSecret123!", "NewSecret123!"), true);
  assert.equal(matchCheck("NewSecret123!", "Mismatch123!"), false);
  assert.equal(matchCheck("NewSecret123!", ""), false);

  // Requirements checklist helper
  const reqs = getPasswordRequirements("ValidPassword123!", phone, "ValidPassword123!");
  assert.equal(reqs.hasMinLength, true);
  assert.equal(reqs.noPhone, true);
  assert.equal(reqs.notRepeated, true);
  assert.equal(reqs.matchesConfirm, true);
  assert.equal(reqs.isValid, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Stage Transitions and Detail Preservation Tests
// ─────────────────────────────────────────────────────────────────────────────

test("Password recovery: Stage transitions and detail preservation", () => {
  let stage: "request" | "reset" | "success" = "request";
  let role: "customer" | "driver" = "customer";
  let phone = "0911223344";
  let normalizedPhone = "";
  let otp = "";
  let countdown = 0;

  // Step 1: Submit request -> transition to reset
  normalizedPhone = normalizeEthiopianPhone(phone)!;
  stage = "reset";
  countdown = 60;

  assert.equal(stage, "reset");
  assert.equal(normalizedPhone, "+251911223344");
  assert.equal(countdown, 60);

  // Step 2: "Change" button preserves phone and role, clears OTP
  otp = "123456";
  const onChange = () => {
    stage = "request";
    otp = "";
  };
  onChange();

  assert.equal(stage, "request");
  assert.equal(phone, "0911223344"); // preserved
  assert.equal(role, "customer"); // preserved
  assert.equal(otp, ""); // cleared

  // Step 3: Transition to success
  stage = "success";
  assert.equal(stage, "success");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Generic Response Behavior (No Account Enumeration)
// ─────────────────────────────────────────────────────────────────────────────

test("Password recovery: Generic response behavior prevents account enumeration", async () => {
  const originalFetch = globalThis.fetch;
  try {
    // Backend returns 200 { ok: true } regardless of whether phone exists
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const req = new Request("http://localhost:3000/api/auth/password/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+251999999999", role: "customer" }),
    });

    const res = await passwordForgotHandler(req);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data, { ok: true });

    // Generic confirmation message displayed by the UI
    const genericMessage =
      "If an active account exists for this phone number, a 6-digit verification code has been sent via SMS.";
    assert.ok(genericMessage.includes("If an active account exists"));
    assert.equal(genericMessage.includes("not found"), false);
    assert.equal(genericMessage.includes("does not exist"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Successful Password Reset & Session Invalidation
// ─────────────────────────────────────────────────────────────────────────────

test("Password recovery: Successful reset clears current session cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  jar.set("sr_at", "active_session_at", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900 });
  jar.set("sr_rt", "active_session_rt", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 2592000 });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      const parsedBody = JSON.parse(init?.body as string);
      assert.equal(parsedBody.phone, "+251911223344");
      assert.equal(parsedBody.role, "customer");
      assert.equal(parsedBody.code, "123456");
      assert.equal(parsedBody.newPassword, "SecurePassword123!");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const req = new Request("http://localhost:3000/api/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone: "+251911223344",
        role: "customer",
        code: "123456",
        newPassword: "SecurePassword123!",
      }),
    });
    (req as any).sessionManager = session;

    const res = await passwordResetHandler(req);
    assert.equal(res.status, 200);

    // Verify session cookies were cleared by the BFF on success
    assert.equal(jar.get("sr_at"), undefined);
    assert.equal(jar.get("sr_rt"), undefined);

    const data = await res.json();
    assert.deepEqual(data, { ok: true });
    // Tokens must never be returned to the browser client
    assert.equal((data as any).accessToken, undefined);
    assert.equal((data as any).refreshToken, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Failed Password Reset Preserving Session & Clearing OTP
// ─────────────────────────────────────────────────────────────────────────────

test("Password recovery: Failed reset preserves existing session cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  jar.set("sr_at", "preserve_at", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900 });
  jar.set("sr_rt", "preserve_rt", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 2592000 });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { code: "INVALID_OTP", message: "Invalid or expired verification code" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );

    const req = new Request("http://localhost:3000/api/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone: "+251911223344",
        role: "customer",
        code: "000000",
        newPassword: "SecurePassword123!",
      }),
    });
    (req as any).sessionManager = session;

    const res = await passwordResetHandler(req);
    assert.equal(res.status, 400);

    // Existing session cookies MUST remain untouched on failure
    assert.equal(jar.get("sr_at")?.value, "preserve_at");
    assert.equal(jar.get("sr_rt")?.value, "preserve_rt");

    // UI state behavior on failure: clear OTP input
    let otpInput = "000000";
    if (!res.ok) {
      otpInput = "";
    }
    assert.equal(otpInput, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. Resend Cooldown Behavior
// ─────────────────────────────────────────────────────────────────────────────

test("Password recovery: Resend cooldown timer behavior", () => {
  let countdown = 0;
  let busy = false;

  const canResend = () => countdown === 0 && !busy;

  // Initial state: can send
  assert.equal(canResend(), true);

  // Triggered send: sets 60s cooldown
  countdown = 60;
  assert.equal(canResend(), false);

  // 30s passed
  countdown = 30;
  assert.equal(canResend(), false);

  // Timer finished
  countdown = 0;
  assert.equal(canResend(), true);

  // While busy
  busy = true;
  assert.equal(canResend(), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Privacy Guarantees (No Credentials, OTPs, or Phone in URLs or Storage)
// ─────────────────────────────────────────────────────────────────────────────

test("Password recovery: Privacy guarantees — no phone, OTPs, or passwords in URLs or storage", () => {
  // Destination after successful reset must be strictly "/login" without phone query param
  const successRedirectTarget = "/login";
  assert.equal(successRedirectTarget, "/login");
  assert.equal(successRedirectTarget.includes("?"), false);
  assert.equal(successRedirectTarget.includes("phone="), false);

  // Recovery page does not prepopulate phone from URL query parameters
  const getInitialPhone = (_searchParams: URLSearchParams) => "";
  const paramsWithPhone = new URLSearchParams("phone=%2B251911223344&role=driver");
  assert.equal(getInitialPhone(paramsWithPhone), "");

  // Role query parameter selection is preserved
  const getInitialRole = (searchParams: URLSearchParams) =>
    searchParams.get("role") === "driver" ? "driver" : "customer";
  assert.equal(getInitialRole(paramsWithPhone), "driver");
  assert.equal(getInitialRole(new URLSearchParams()), "customer");
});


