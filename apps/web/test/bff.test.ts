import test from "node:test";
import assert from "node:assert/strict";
import { authCall } from "../src/lib/bff";
import { createSessionManager, type CookieStore, type SessionCookieOptions } from "../src/lib/session";
import { POST as registerStartHandler } from "../src/app/api/auth/register/start/route";
import { POST as passwordForgotHandler } from "../src/app/api/auth/password/forgot/route";
import { POST as passwordResetHandler } from "../src/app/api/auth/password/reset/route";

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
// 1. Cookie Transition Tests
// ─────────────────────────────────────────────────────────────────────────────

test("Valid login response containing both tokens sets both httpOnly session cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          accessToken: "valid_login_access_token",
          refreshToken: "valid_login_refresh_token",
          user: { id: "user_login_1", phone: "+251911223344", role: "customer" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const req = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "0911223344", password: "password123" }),
    });

    const res = await authCall(req, "login", { session });
    assert.equal(res.status, 200);

    // Verify access token cookie
    const at = jar.get("sr_at");
    assert.ok(at, "sr_at cookie should be set");
    assert.equal(at.value, "valid_login_access_token");
    const atOpts = jar.cookies.get("sr_at")?.opts;
    assert.equal(atOpts?.httpOnly, true);
    assert.equal(atOpts?.sameSite, "lax");
    assert.equal(atOpts?.path, "/");
    assert.equal(atOpts?.maxAge, 15 * 60);

    // Verify refresh token cookie
    const rt = jar.get("sr_rt");
    assert.ok(rt, "sr_rt cookie should be set");
    assert.equal(rt.value, "valid_login_refresh_token");
    const rtOpts = jar.cookies.get("sr_rt")?.opts;
    assert.equal(rtOpts?.httpOnly, true);
    assert.equal(rtOpts?.sameSite, "lax");
    assert.equal(rtOpts?.path, "/");
    assert.equal(rtOpts?.maxAge, 30 * 86400);

    // Verify response body does NOT leak tokens
    const data = await res.json();
    assert.equal((data as any).accessToken, undefined);
    assert.equal((data as any).refreshToken, undefined);
    assert.equal(data.user.id, "user_login_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Completed registration sets both httpOnly session cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          accessToken: "valid_reg_access_token",
          refreshToken: "valid_reg_refresh_token",
          user: { id: "user_reg_1", phone: "+251911223344", role: "customer", phoneVerified: true },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );

    const req = new Request("http://localhost:3000/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fullName: "Test User",
        phone: "+251911223344",
        code: "123456",
        password: "securePassword10!",
        role: "customer",
      }),
    });

    const res = await authCall(req, "register", { session });
    assert.equal(res.status, 201);

    assert.equal(jar.get("sr_at")?.value, "valid_reg_access_token");
    assert.equal(jar.get("sr_rt")?.value, "valid_reg_refresh_token");

    const data = await res.json();
    assert.equal((data as any).accessToken, undefined);
    assert.equal((data as any).refreshToken, undefined);
    assert.equal(data.user.phoneVerified, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Registration-start returning { ok: true } preserves existing cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  jar.set("sr_at", "existing_access_token", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900 });
  jar.set("sr_rt", "existing_refresh_token", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 2592000 });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const req = new Request("http://localhost:3000/api/auth/register/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+251911223344", role: "customer" }),
    });
    (req as any).sessionManager = session;

    const res = await registerStartHandler(req);
    assert.equal(res.status, 200);

    // Existing cookies must remain completely untouched
    assert.equal(jar.get("sr_at")?.value, "existing_access_token");
    assert.equal(jar.get("sr_rt")?.value, "existing_refresh_token");

    const data = await res.json();
    assert.deepEqual(data, { ok: true });
    assert.equal((data as any).accessToken, undefined);
    assert.equal((data as any).refreshToken, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Password-forgot returning { ok: true } preserves existing cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  jar.set("sr_at", "active_user_at", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900 });
  jar.set("sr_rt", "active_user_rt", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 2592000 });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const req = new Request("http://localhost:3000/api/auth/password/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+251911223344", role: "customer" }),
    });
    (req as any).sessionManager = session;

    const res = await passwordForgotHandler(req);
    assert.equal(res.status, 200);

    // Cookies preserved
    assert.equal(jar.get("sr_at")?.value, "active_user_at");
    assert.equal(jar.get("sr_rt")?.value, "active_user_rt");

    const data = await res.json();
    assert.deepEqual(data, { ok: true });
    assert.equal((data as any).accessToken, undefined);
    assert.equal((data as any).refreshToken, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Successful password-reset clears both session cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  jar.set("sr_at", "old_session_at", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900 });
  jar.set("sr_rt", "old_session_rt", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 2592000 });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const req = new Request("http://localhost:3000/api/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        phone: "+251911223344",
        code: "654321",
        newPassword: "BrandNewPassword123!",
        role: "customer",
      }),
    });
    (req as any).sessionManager = session;

    const res = await passwordResetHandler(req);
    assert.equal(res.status, 200);

    // Session cookies MUST be cleared on reset success
    assert.equal(jar.get("sr_at"), undefined);
    assert.equal(jar.get("sr_rt"), undefined);

    const data = await res.json();
    assert.deepEqual(data, { ok: true });
    assert.equal((data as any).accessToken, undefined);
    assert.equal((data as any).refreshToken, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Failed password-reset preserves existing cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  jar.set("sr_at", "preserve_at", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900 });
  jar.set("sr_rt", "preserve_rt", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 2592000 });

  const originalFetch = globalThis.fetch;
  try {
    // Scenario A: 400 INVALID_OTP
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { code: "INVALID_OTP", message: "Invalid code" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });

    const req1 = new Request("http://localhost:3000/api/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+251911223344", code: "000000", newPassword: "Password12345" }),
    });
    (req1 as any).sessionManager = session;

    const res1 = await passwordResetHandler(req1);
    assert.equal(res1.status, 400);
    assert.equal(jar.get("sr_at")?.value, "preserve_at");
    assert.equal(jar.get("sr_rt")?.value, "preserve_rt");

    // Scenario B: 422 WEAK_PASSWORD
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { code: "WEAK_PASSWORD", message: "Password too short" } }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });

    const req2 = new Request("http://localhost:3000/api/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+251911223344", code: "123456", newPassword: "short" }),
    });
    (req2 as any).sessionManager = session;

    const res2 = await passwordResetHandler(req2);
    assert.equal(res2.status, 422);
    assert.equal(jar.get("sr_at")?.value, "preserve_at");
    assert.equal(jar.get("sr_rt")?.value, "preserve_rt");

    // Scenario C: 429 RATE_LIMITED
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "Too many attempts" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });

    const req3 = new Request("http://localhost:3000/api/auth/password/reset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+251911223344", code: "123456", newPassword: "Password12345" }),
    });
    (req3 as any).sessionManager = session;

    const res3 = await passwordResetHandler(req3);
    assert.equal(res3.status, 429);
    assert.equal(jar.get("sr_at")?.value, "preserve_at");
    assert.equal(jar.get("sr_rt")?.value, "preserve_rt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Partial or missing token responses never overwrite existing cookies", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  jar.set("sr_at", "original_at", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900 });
  jar.set("sr_rt", "original_rt", { httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 2592000 });

  const originalFetch = globalThis.fetch;
  try {
    // Case 1: accessToken present, refreshToken missing
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ accessToken: "partial_at" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    let req = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      body: JSON.stringify({}),
    });
    let res = await authCall(req, "login", { session });
    assert.equal(res.status, 200);
    assert.equal(jar.get("sr_at")?.value, "original_at");
    assert.equal(jar.get("sr_rt")?.value, "original_rt");

    // Case 2: refreshToken present, accessToken missing
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ refreshToken: "partial_rt" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    req = new Request("http://localhost:3000/api/auth/login", { method: "POST", body: JSON.stringify({}) });
    res = await authCall(req, "login", { session });
    assert.equal(res.status, 200);
    assert.equal(jar.get("sr_at")?.value, "original_at");
    assert.equal(jar.get("sr_rt")?.value, "original_rt");

    // Case 3: Empty string tokens
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ accessToken: "   ", refreshToken: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    req = new Request("http://localhost:3000/api/auth/login", { method: "POST", body: JSON.stringify({}) });
    res = await authCall(req, "login", { session });
    assert.equal(res.status, 200);
    assert.equal(jar.get("sr_at")?.value, "original_at");
    assert.equal(jar.get("sr_rt")?.value, "original_rt");

    // Case 4: Non-string tokens
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ accessToken: 12345, refreshToken: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    req = new Request("http://localhost:3000/api/auth/login", { method: "POST", body: JSON.stringify({}) });
    res = await authCall(req, "login", { session });
    assert.equal(res.status, 200);
    assert.equal(jar.get("sr_at")?.value, "original_at");
    assert.equal(jar.get("sr_rt")?.value, "original_rt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. BFF Route Forwarding Tests
// ─────────────────────────────────────────────────────────────────────────────

test("Register start route forwards HTTP method, endpoint, body, and status", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  const originalFetch = globalThis.fetch;
  let interceptedUrl = "";
  let interceptedMethod = "";
  let interceptedBody: any = null;

  try {
    globalThis.fetch = async (url: any, init: any) => {
      interceptedUrl = String(url);
      interceptedMethod = init?.method;
      interceptedBody = JSON.parse(init?.body);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const req = new Request("http://localhost:3000/api/auth/register/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+251911223344", role: "customer" }),
    });
    (req as any).sessionManager = session;

    const res = await registerStartHandler(req);
    assert.equal(res.status, 200);
    assert.ok(interceptedUrl.endsWith("/api/v1/auth/register/start"));
    assert.equal(interceptedMethod, "POST");
    assert.equal(interceptedBody.phone, "+251911223344");
    assert.equal(interceptedBody.role, "customer");
    assert.equal(interceptedBody.platform, "web");

    const data = await res.json();
    assert.deepEqual(data, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Password forgot route forwards HTTP method, endpoint, body, and status", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  const originalFetch = globalThis.fetch;
  let interceptedUrl = "";
  let interceptedMethod = "";
  let interceptedBody: any = null;

  try {
    globalThis.fetch = async (url: any, init: any) => {
      interceptedUrl = String(url);
      interceptedMethod = init?.method;
      interceptedBody = JSON.parse(init?.body);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const req = new Request("http://localhost:3000/api/auth/password/forgot", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: "+251711223344", role: "driver" }),
    });
    (req as any).sessionManager = session;

    const res = await passwordForgotHandler(req);
    assert.equal(res.status, 200);
    assert.ok(interceptedUrl.endsWith("/api/v1/auth/password/forgot"));
    assert.equal(interceptedMethod, "POST");
    assert.equal(interceptedBody.phone, "+251711223344");
    assert.equal(interceptedBody.role, "driver");
    assert.equal(interceptedBody.platform, "web");

    const data = await res.json();
    assert.deepEqual(data, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Password reset route forwards HTTP method, endpoint, body, and status", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  const originalFetch = globalThis.fetch;
  let interceptedUrl = "";
  let interceptedMethod = "";
  let interceptedBody: any = null;

  try {
    globalThis.fetch = async (url: any, init: any) => {
      interceptedUrl = String(url);
      interceptedMethod = init?.method;
      interceptedBody = JSON.parse(init?.body);
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
        code: "987654",
        newPassword: "BrandNewPassword123!",
      }),
    });
    (req as any).sessionManager = session;

    const res = await passwordResetHandler(req);
    assert.equal(res.status, 200);
    assert.ok(interceptedUrl.endsWith("/api/v1/auth/password/reset"));
    assert.equal(interceptedMethod, "POST");
    assert.equal(interceptedBody.phone, "+251911223344");
    assert.equal(interceptedBody.role, "customer");
    assert.equal(interceptedBody.code, "987654");
    assert.equal(interceptedBody.newPassword, "BrandNewPassword123!");
    assert.equal(interceptedBody.platform, "web");

    const data = await res.json();
    assert.deepEqual(data, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Sensitive credentials, OTPs, and phone numbers are never logged to console", async () => {
  const jar = new TestCookieJar();
  const session = createSessionManager(jar);
  const originalFetch = globalThis.fetch;
  const loggedMessages: string[] = [];
  const capture = (...args: any[]) => {
    loggedMessages.push(args.map(String).join(" "));
  };

  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origError = console.error;

  console.log = capture;
  console.info = capture;
  console.warn = capture;
  console.error = capture;

  try {
    const sensitivePhone = "+251999887766";
    const sensitiveCode = "582910";
    const sensitivePw = "SuperSecretPassword123!";
    const sensitiveToken = "leak_test_secret_jwt_token";

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          accessToken: sensitiveToken,
          refreshToken: "refresh_leak_test",
          ok: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const req1 = new Request("http://localhost:3000/api/auth/register/start", {
      method: "POST",
      body: JSON.stringify({ phone: sensitivePhone }),
    });
    (req1 as any).sessionManager = session;
    await registerStartHandler(req1);

    const req2 = new Request("http://localhost:3000/api/auth/password/forgot", {
      method: "POST",
      body: JSON.stringify({ phone: sensitivePhone }),
    });
    (req2 as any).sessionManager = session;
    await passwordForgotHandler(req2);

    const req3 = new Request("http://localhost:3000/api/auth/password/reset", {
      method: "POST",
      body: JSON.stringify({ phone: sensitivePhone, code: sensitiveCode, newPassword: sensitivePw }),
    });
    (req3 as any).sessionManager = session;
    await passwordResetHandler(req3);

    const req4 = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ phone: sensitivePhone, password: sensitivePw }),
    });
    await authCall(req4, "login", { session });

    const fullLog = loggedMessages.join("\n");
    assert.equal(fullLog.includes(sensitivePhone), false, "Phone number should not be logged");
    assert.equal(fullLog.includes(sensitiveCode), false, "OTP code should not be logged");
    assert.equal(fullLog.includes(sensitivePw), false, "Password should not be logged");
    assert.equal(fullLog.includes(sensitiveToken), false, "Access token should not be logged");
  } finally {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origError;
    globalThis.fetch = originalFetch;
  }
});
