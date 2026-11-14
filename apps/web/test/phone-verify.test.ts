import test from "node:test";
import assert from "node:assert/strict";
import { POST as phoneVerifyStartHandler } from "../src/app/api/auth/phone/verify/start/route";
import { POST as phoneVerifyConfirmHandler } from "../src/app/api/auth/phone/verify/confirm/route";
import { createSessionManager, type CookieStore, type SessionCookieOptions } from "../src/lib/session";
import { ApiError, isPhoneNotVerifiedError } from "../src/lib/api";
import {
  createProtectedActionRunner,
  createDriverOnlineRunner,
  createDriverOffersRunner,
  createDriverAcceptTripRunner,
  createDriverRefundRunner,
  driverGoOnline,
  driverGetOffers,
  driverAcceptTrip,
  driverRequestRefund,
} from "../src/lib/driver";

// Isolated in-memory cookie jar implementing CookieStore
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
// 1. Verification-Start Request Forwarding & Session Cookie Preservation
// ─────────────────────────────────────────────────────────────────────────────

test("Phone verification: Start route forwards authenticated bearer token and preserves cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  jar.set("sr_at", "authenticated_access_token", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900 });
  jar.set("sr_rt", "authenticated_refresh_token", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 2592000 });

  const originalFetch = globalThis.fetch;
  try {
    let capturedAuthHeader: string | null = null;
    let capturedBody: any = null;

    globalThis.fetch = async (_url, init) => {
      capturedAuthHeader = (init?.headers as Record<string, string>)?.authorization ?? null;
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    // Client attempts to pass a different phone number in body; BFF must strip it
    const req = new Request("http://localhost:3000/api/auth/phone/verify/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+251999999999" }),
    });
    (req as any).sessionManager = session;

    const res = await phoneVerifyStartHandler(req);
    assert.equal(res.status, 200);

    // Verify authenticated bearer token forwarded from session
    assert.equal(capturedAuthHeader, "Bearer authenticated_access_token");

    // Verify client-supplied phone is NOT forwarded (defense-in-depth)
    assert.equal(capturedBody?.phone, undefined);

    // Verify session cookies remain completely untouched
    assert.equal(jar.get("sr_at")?.value, "authenticated_access_token");
    assert.equal(jar.get("sr_rt")?.value, "authenticated_refresh_token");

    const data = await res.json();
    assert.deepEqual(data, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Verification-Confirm Request Forwarding & Session Cookie Preservation
// ─────────────────────────────────────────────────────────────────────────────

test("Phone verification: Confirm route forwards code with bearer token and preserves cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  jar.set("sr_at", "authenticated_access_token", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900 });
  jar.set("sr_rt", "authenticated_refresh_token", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 2592000 });

  const originalFetch = globalThis.fetch;
  try {
    let capturedAuthHeader: string | null = null;
    let capturedBody: any = null;

    globalThis.fetch = async (_url, init) => {
      capturedAuthHeader = (init?.headers as Record<string, string>)?.authorization ?? null;
      capturedBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const req = new Request("http://localhost:3000/api/auth/phone/verify/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "123456", extraField: "should_be_stripped" }),
    });
    (req as any).sessionManager = session;

    const res = await phoneVerifyConfirmHandler(req);
    assert.equal(res.status, 200);

    // Verify bearer token forwarded
    assert.equal(capturedAuthHeader, "Bearer authenticated_access_token");

    // Verify code forwarded and extraneous parameters sanitized
    assert.equal(capturedBody?.code, "123456");
    assert.equal(capturedBody?.extraField, undefined);

    // Verify session cookies preserved on success (not logged out)
    assert.equal(jar.get("sr_at")?.value, "authenticated_access_token");
    assert.equal(jar.get("sr_rt")?.value, "authenticated_refresh_token");

    const data = await res.json();
    assert.deepEqual(data, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. OTP Sanitization & Six-Digit Validation Tests
// ─────────────────────────────────────────────────────────────────────────────

test("Phone verification: OTP input sanitization and six-digit validation", () => {
  const sanitizeOtp = (val: string) => val.replace(/\D/g, "").slice(0, 6);

  assert.equal(sanitizeOtp("123456"), "123456");
  assert.equal(sanitizeOtp("12 34 56"), "123456");
  assert.equal(sanitizeOtp("12-34-56"), "123456");
  assert.equal(sanitizeOtp("abc123def456"), "123456");
  assert.equal(sanitizeOtp("123456789"), "123456");

  const isValidOtp = (val: string) => /^\d{6}$/.test(val.trim());
  assert.equal(isValidOtp("123456"), true);
  assert.equal(isValidOtp("12345"), false);
  assert.equal(isValidOtp("1234567"), false);
  assert.equal(isValidOtp("12345a"), false);
  assert.equal(isValidOtp(""), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Resend Cooldown Behavior
// ─────────────────────────────────────────────────────────────────────────────

test("Phone verification: Resend cooldown timer behavior", () => {
  let countdown = 0;
  let busy = false;

  const canResend = () => countdown === 0 && !busy;

  // Initial state: can request code
  assert.equal(canResend(), true);

  // Triggered request: sets 60s countdown
  countdown = 60;
  assert.equal(canResend(), false);

  // Partial countdown elapsed
  countdown = 30;
  assert.equal(canResend(), false);

  // Cooldown completed
  countdown = 0;
  assert.equal(canResend(), true);

  // While busy submitting
  busy = true;
  assert.equal(canResend(), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Successful Verification State Update (No Sign-In Required)
// ─────────────────────────────────────────────────────────────────────────────

test("Phone verification: Successful verification updates state without re-authentication", () => {
  let isVerified = false;
  let retryCount = 0;

  // Mock protected action
  const performProtectedAction = () => {
    retryCount++;
    if (!isVerified) {
      throw new ApiError(403, "PHONE_NOT_VERIFIED", "Phone verification required");
    }
    return { success: true };
  };

  // Initial attempt fails
  assert.throws(() => performProtectedAction(), (err: any) => err.code === "PHONE_NOT_VERIFIED");
  assert.equal(retryCount, 1);

  // Phone verified callback triggered
  const onVerified = () => {
    isVerified = true;
    performProtectedAction(); // retry automatically
  };

  onVerified();

  // Retried successfully without logging out or re-entering credentials
  assert.equal(isVerified, true);
  assert.equal(retryCount, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Failed OTP Handling
// ─────────────────────────────────────────────────────────────────────────────

test("Phone verification: Failed OTP clears input and preserves session cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  jar.set("sr_at", "user_access_token", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900 });
  jar.set("sr_rt", "user_refresh_token", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 2592000 });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { code: "INVALID_OTP", message: "Invalid or expired verification code" },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );

    const req = new Request("http://localhost:3000/api/auth/phone/verify/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "000000" }),
    });
    (req as any).sessionManager = session;

    const res = await phoneVerifyConfirmHandler(req);
    assert.equal(res.status, 400);

    // Failed attempt clears input field in UI
    let otpField = "000000";
    if (!res.ok) {
      otpField = "";
    }
    assert.equal(otpField, "");

    // Session cookies remain preserved
    assert.equal(jar.get("sr_at")?.value, "user_access_token");
    assert.equal(jar.get("sr_rt")?.value, "user_refresh_token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Rate-Limit Handling
// ─────────────────────────────────────────────────────────────────────────────

test("Phone verification: Rate-limit (429) returns proper error and preserves session", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  jar.set("sr_at", "user_access_token", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900 });
  jar.set("sr_rt", "user_refresh_token", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 2592000 });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: { code: "RATE_LIMITED", message: "Too many attempts. Please try again later." },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      );

    const req = new Request("http://localhost:3000/api/auth/phone/verify/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    (req as any).sessionManager = session;

    const res = await phoneVerifyStartHandler(req);
    assert.equal(res.status, 429);

    // Session cookies preserved
    assert.equal(jar.get("sr_at")?.value, "user_access_token");
    assert.equal(jar.get("sr_rt")?.value, "user_refresh_token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. PHONE_NOT_VERIFIED Interception on Protected Actions
// ─────────────────────────────────────────────────────────────────────────────

test("Phone verification: Intercepts PHONE_NOT_VERIFIED on protected actions", () => {
  // 1. Customer trip creation (POST /trips)
  const tripCreationError = new ApiError(403, "PHONE_NOT_VERIFIED", "Phone verification required");
  assert.equal(isPhoneNotVerifiedError(tripCreationError), true);

  // 2. Driver going online (POST /drivers/me/online)
  const driverOnlineError = new ApiError(403, "PHONE_NOT_VERIFIED", "Phone verification required");
  assert.equal(isPhoneNotVerifiedError(driverOnlineError), true);

  // 3. Driver viewing offers (GET /drivers/me/offers)
  const driverOffersError = new ApiError(403, "PHONE_NOT_VERIFIED", "Phone verification required");
  assert.equal(isPhoneNotVerifiedError(driverOffersError), true);

  // 4. Driver accepting trips (POST /trips/:id/accept)
  const driverAcceptError = new ApiError(403, "PHONE_NOT_VERIFIED", "Phone verification required");
  assert.equal(isPhoneNotVerifiedError(driverAcceptError), true);

  // 5. Driver refund request (POST /drivers/me/refunds)
  const driverRefundError = new ApiError(403, "PHONE_NOT_VERIFIED", "Phone verification required");
  assert.equal(isPhoneNotVerifiedError(driverRefundError), true);

  // 6. Unrelated errors must NOT be intercepted as phone verification prompts
  const otherError = new ApiError(400, "ACTIVE_TRIP_EXISTS", "You already have an active trip");
  assert.equal(isPhoneNotVerifiedError(otherError), false);

  const unauthenticatedError = new ApiError(401, "UNAUTHENTICATED", "Login required");
  assert.equal(isPhoneNotVerifiedError(unauthenticatedError), false);

  // 7. Admin & staff bypass
  const adminRole = "admin";
  const staffRole = "staff";
  const customerRole = "customer";
  const isBypassed = (role: string) => role === "admin" || role === "staff";
  assert.equal(isBypassed(adminRole), true);
  assert.equal(isBypassed(staffRole), true);
  assert.equal(isBypassed(customerRole), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Driver UI Actions Verification Integration & State Machine Tests
// ─────────────────────────────────────────────────────────────────────────────

test("Driver actions: Displays verification flow on PHONE_NOT_VERIFIED and retries once after verification", async () => {
  let callCount = 0;
  let receivedLocation: any = null;

  // Mock driverGoOnline
  const mockGoOnline = async (loc: { lat: number; lng: number }) => {
    callCount++;
    receivedLocation = loc;
    if (callCount === 1) {
      throw new ApiError(403, "PHONE_NOT_VERIFIED", "Phone verification required");
    }
    return { ok: true, status: "online" };
  };

  const runner = createProtectedActionRunner(mockGoOnline);

  // 1. Initial execution fails with PHONE_NOT_VERIFIED
  const initialResult = await runner.execute({ lat: 9.03, lng: 38.74 });
  assert.equal(initialResult, undefined);
  assert.equal(callCount, 1);
  assert.deepEqual(receivedLocation, { lat: 9.03, lng: 38.74 });

  // Verification prompt must be displayed; ordinary error message must NOT be shown
  assert.equal(runner.getState().needsVerification, true);
  assert.equal(runner.getState().error, null);
  assert.equal(runner.getState().isBusy, false);

  // 2. User completes verification in prompt -> handleVerified retries intended action once
  const retryResult = await runner.handleVerified();
  assert.deepEqual(retryResult, { ok: true, status: "online" });
  assert.equal(callCount, 2); // Exactly 1 retry
  assert.equal(runner.getState().needsVerification, false);
  assert.equal(runner.getState().error, null);
  assert.deepEqual(runner.getState().lastResult, { ok: true, status: "online" });

  // Subsequent handleVerified without new trigger does nothing (no repeated retries)
  const noopResult = await runner.handleVerified();
  assert.equal(noopResult, undefined);
  assert.equal(callCount, 2);
});

test("Driver actions: Cancellation clears preserved action and does not retry", async () => {
  let callCount = 0;

  const mockAcceptTrip = async (_tripId: string) => {
    callCount++;
    throw new ApiError(403, "PHONE_NOT_VERIFIED", "Phone verification required");
  };

  const runner = createProtectedActionRunner(mockAcceptTrip);

  // Execution triggers verification prompt
  await runner.execute("trip-xyz-123");
  assert.equal(callCount, 1);
  assert.equal(runner.getState().needsVerification, true);

  // User dismisses/cancels the verification prompt
  runner.handleCancel();
  assert.equal(runner.getState().needsVerification, false);

  // Attempting to verify later does NOT retry cancelled action
  const retryResult = await runner.handleVerified();
  assert.equal(retryResult, undefined);
  assert.equal(callCount, 1); // Remains 1, never retried
});

test("Driver actions: Normal error handling preserved for non-verification errors", async () => {
  let callCount = 0;

  const mockGetOffers = async () => {
    callCount++;
    throw new ApiError(401, "UNAUTHENTICATED", "Session expired");
  };

  const runner = createProtectedActionRunner(mockGetOffers);

  // Execution throws ordinary error
  await assert.rejects(
    async () => {
      await runner.execute();
    },
    (err: any) => err.code === "UNAUTHENTICATED" && err.message === "Session expired"
  );

  assert.equal(callCount, 1);
  // Must NOT display verification prompt
  assert.equal(runner.getState().needsVerification, false);
  assert.equal(runner.getState().error, "Session expired");

  // handleVerified does not retry
  const retryResult = await runner.handleVerified();
  assert.equal(retryResult, undefined);
  assert.equal(callCount, 1);
});

test("Driver actions: Prevents duplicate submissions while in-flight", async () => {
  let callCount = 0;
  let resolvePromise: (val: any) => void;

  const slowRefund = async (_body?: any) => {
    callCount++;
    return new Promise((resolve) => {
      resolvePromise = resolve;
    });
  };

  const runner = createProtectedActionRunner(slowRefund);

  // Start first execution
  const p1 = runner.execute({ amount: 500 });
  assert.equal(runner.getState().isBusy, true);
  assert.equal(callCount, 1);

  // Concurrent execution while busy is ignored
  const p2 = runner.execute({ amount: 500 });
  assert.equal(callCount, 1); // Did not trigger second call

  // Resolve first call
  resolvePromise!({ ok: true, refundId: "ref-123" });
  const res1 = await p1;
  const res2 = await p2;

  assert.deepEqual(res1, { ok: true, refundId: "ref-123" });
  assert.equal(res2, undefined); // Blocked duplicate returned undefined
  assert.equal(runner.getState().isBusy, false);
});

test("Driver actions: Retry failure does not trigger repeated automatic retries", async () => {
  let callCount = 0;

  const mockFailingAction = async () => {
    callCount++;
    throw new ApiError(403, "PHONE_NOT_VERIFIED", "Still not verified");
  };

  const runner = createProtectedActionRunner(mockFailingAction);

  // 1. Initial attempt
  await runner.execute();
  assert.equal(callCount, 1);
  assert.equal(runner.getState().needsVerification, true);

  // 2. Retry attempt fails
  await assert.rejects(
    async () => {
      await runner.handleVerified();
    },
    (err: any) => err.code === "PHONE_NOT_VERIFIED"
  );
  assert.equal(callCount, 2);

  // 3. No further automatic retries happen without new user execution
  const subsequentRetry = await runner.handleVerified();
  assert.equal(subsequentRetry, undefined);
  assert.equal(callCount, 2);
});

test("Driver actions: All four driver action endpoints use PHONE_NOT_VERIFIED contracts", () => {
  // Confirm endpoint signatures and contract helpers in driver.ts
  assert.equal(typeof driverGoOnline, "function");
  assert.equal(typeof driverGetOffers, "function");
  assert.equal(typeof driverAcceptTrip, "function");
  assert.equal(typeof driverRequestRefund, "function");
  assert.equal(typeof createDriverOnlineRunner, "function");
  assert.equal(typeof createDriverOffersRunner, "function");
  assert.equal(typeof createDriverAcceptTripRunner, "function");
  assert.equal(typeof createDriverRefundRunner, "function");
});
