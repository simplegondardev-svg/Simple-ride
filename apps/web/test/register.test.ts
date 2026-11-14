import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEthiopianPhone, isValidEthiopianPhone, formatEthiopianPhone } from "../src/lib/phone";
import { checkPasswordPolicy, getPasswordRequirements, resolveSafeRedirect } from "../src/lib/password";

test("Registration validation: Full name requirements", () => {
  const isNameValid = (name: string) => name.trim().length >= 2;
  assert.equal(isNameValid(""), false);
  assert.equal(isNameValid(" "), false);
  assert.equal(isNameValid("A"), false);
  assert.equal(isNameValid("Al"), true);
  assert.equal(isNameValid("Abebe Kebede"), true);
});

test("Registration validation: Ethiopian phone normalization for API submission", () => {
  const rawInputs = [
    "0911223344",
    "0711223344",
    "+251911223344",
    "251911223344",
    "09 11 22 33 44",
    "+251-91-122-3344",
  ];

  for (const input of rawInputs) {
    assert.equal(isValidEthiopianPhone(input), true);
    const normalized = normalizeEthiopianPhone(input);
    assert.ok(normalized?.startsWith("+251"));
    assert.equal(normalized?.length, 13);
  }

  // Invalid formats must be caught before submission
  assert.equal(isValidEthiopianPhone("0811223344"), false);
  assert.equal(isValidEthiopianPhone("123456"), false);
  assert.equal(isValidEthiopianPhone("+12025550123"), false);
});

test("Registration validation: Password policy enforcement", () => {
  const phone = "+251911223344";

  // Length checks
  assert.equal(checkPasswordPolicy("short", phone), "Password must be at least 10 characters");
  assert.equal(checkPasswordPolicy("123456789", phone), "Password must be at least 10 characters");
  assert.equal(checkPasswordPolicy("1234567890", phone), null);

  // Phone number leakage check
  assert.equal(checkPasswordPolicy("Secure911223344Pass", phone), "Password must not contain your phone number");
  assert.equal(checkPasswordPolicy("911223344Pass", phone), "Password must not contain your phone number");

  // Single repeated character check
  assert.equal(checkPasswordPolicy("xxxxxxxxxx", phone), "Password must not be one repeated character");

  // Compliant password
  assert.equal(checkPasswordPolicy("SimpleRide2026!", phone), null);
});

test("Registration validation: Password confirmation matching", () => {
  const checkMatch = (pw: string, confirm: string) => pw === confirm;
  assert.equal(checkMatch("Password1234!", "Password1234!"), true);
  assert.equal(checkMatch("Password1234!", "Different1234!"), false);
  assert.equal(checkMatch("Password1234!", ""), false);
});

test("Registration validation: 6-digit numeric OTP sanitization", () => {
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
});

test("Registration flow: Stage transition and resend cooldown states", () => {
  let stage: "details" | "otp" = "details";
  let countdown = 0;
  let normalizedPhone = "";

  // Advance to Stage B after successful start
  const onStartSuccess = (phone: string) => {
    normalizedPhone = phone;
    stage = "otp";
    countdown = 60;
  };

  onStartSuccess("+251911223344");
  assert.equal(stage, "otp");
  assert.equal(countdown, 60);
  assert.equal(normalizedPhone, "+251911223344");

  // Change phone returns to Stage A while preserving details
  const onChangePhone = () => {
    stage = "details";
  };

  onChangePhone();
  assert.equal(stage, "details");
  assert.equal(normalizedPhone, "+251911223344"); // preserved
});

test("Registration redirect: Safe internal-destination resolution", () => {
  // Missing next -> /ride
  assert.equal(resolveSafeRedirect(null), "/ride");
  assert.equal(resolveSafeRedirect(undefined), "/ride");
  assert.equal(resolveSafeRedirect(""), "/ride");

  // /ride -> accepted
  assert.equal(resolveSafeRedirect("/ride"), "/ride");

  // Another safe internal path -> accepted
  assert.equal(resolveSafeRedirect("/account"), "/account");
  assert.equal(resolveSafeRedirect("/admin/daybook"), "/admin/daybook");

  // Internal path with query string and fragment -> accepted
  assert.equal(
    resolveSafeRedirect("/ride?tab=history&filter=active#receipt"),
    "/ride?tab=history&filter=active#receipt"
  );

  // https://attacker.example -> rejected
  assert.equal(resolveSafeRedirect("https://attacker.example"), "/ride");
  assert.equal(resolveSafeRedirect("http://attacker.example"), "/ride");

  // //attacker.example -> rejected
  assert.equal(resolveSafeRedirect("//attacker.example"), "/ride");

  // javascript:alert(1) -> rejected
  assert.equal(resolveSafeRedirect("javascript:alert(1)"), "/ride");
  assert.equal(resolveSafeRedirect("data:text/html,evil"), "/ride");

  // Backslash-based external URL & path confusion -> rejected (single & double backslash)
  // Regression test: Single runtime backslash in raw input (fails if raw check uses two-backslash check)
  const singleBsPath = "/path\\attacker";
  assert.equal(singleBsPath.length, 14); // 13 letters/slashes + exactly 1 runtime backslash
  assert.equal(resolveSafeRedirect(singleBsPath), "/ride");

  // Regression test: Double runtime backslash in raw input
  const doubleBsPath = "/path\\\\attacker";
  assert.equal(doubleBsPath.length, 15); // 13 letters/slashes + 2 runtime backslashes
  assert.equal(resolveSafeRedirect(doubleBsPath), "/ride");

  const slashSingleBs = "/\\attacker.example";
  assert.equal(slashSingleBs.length, 18); // 17 letters/slashes + exactly 1 runtime backslash
  assert.equal(resolveSafeRedirect(slashSingleBs), "/ride");

  const leadingSingleBs = "\\attacker.example";
  assert.equal(leadingSingleBs.length, 17); // 16 letters + exactly 1 runtime backslash
  assert.equal(resolveSafeRedirect(leadingSingleBs), "/ride");

  const leadingDoubleBs = "\\\\attacker.example";
  assert.equal(leadingDoubleBs.length, 18); // 16 letters + 2 runtime backslashes
  assert.equal(resolveSafeRedirect(leadingDoubleBs), "/ride");

  // Regression test: Encoded single backslash (fails if decodedPath check uses two-backslash check)
  assert.equal(resolveSafeRedirect("/%5cfoo"), "/ride"); // encoded single backslash: /%5cfoo
  assert.equal(resolveSafeRedirect("/%5Cfoo"), "/ride"); // uppercase encoded single backslash: /%5Cfoo
  assert.equal(resolveSafeRedirect("/%5c%5cattacker.example"), "/ride"); // encoded double backslash

  // Malformed URL -> rejected
  assert.equal(resolveSafeRedirect("http://[::1"), "/ride");
  assert.equal(resolveSafeRedirect("/ride\u0000evil"), "/ride");
  assert.equal(resolveSafeRedirect("/ride\nevil"), "/ride");
  assert.equal(resolveSafeRedirect("/%zz"), "/ride");

  // Custom fallback support
  assert.equal(resolveSafeRedirect("https://attacker.example", "/admin"), "/admin");
});


