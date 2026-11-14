import test from "node:test";
import assert from "node:assert/strict";
import { checkPasswordPolicy, getPasswordRequirements } from "../src/lib/password";

test("checkPasswordPolicy validates minimum length", () => {
  assert.equal(checkPasswordPolicy("123456789"), "Password must be at least 10 characters");
  assert.equal(checkPasswordPolicy("short"), "Password must be at least 10 characters");
  assert.equal(checkPasswordPolicy("1234567890"), null);
});

test("checkPasswordPolicy validates maximum length", () => {
  const long128 = "a".repeat(127) + "b";
  assert.equal(checkPasswordPolicy(long128), null);

  const long129 = "a".repeat(128) + "b";
  assert.equal(checkPasswordPolicy(long129), "Password must be at most 128 characters");
});

test("checkPasswordPolicy rejects passwords containing the user's phone number", () => {
  const phone = "+251911223344";
  assert.equal(checkPasswordPolicy("MyPass911223344!", phone), "Password must not contain your phone number");
  assert.equal(checkPasswordPolicy("911223344Secret", "0911223344"), "Password must not contain your phone number");
  assert.equal(checkPasswordPolicy("SecretPass12345!", "0911223344"), null);
});

test("checkPasswordPolicy rejects single repeated character", () => {
  assert.equal(checkPasswordPolicy("aaaaaaaaaa"), "Password must not be one repeated character");
  assert.equal(checkPasswordPolicy("1111111111"), "Password must not be one repeated character");
  assert.equal(checkPasswordPolicy("!!!!!!!!!!"), "Password must not be one repeated character");
  assert.equal(checkPasswordPolicy("aaaaaaaaab"), null);
});

test("getPasswordRequirements provides accurate real-time feedback", () => {
  const reqs = getPasswordRequirements("TestPassword10!", "0911223344", "TestPassword10!");
  assert.equal(reqs.hasMinLength, true);
  assert.equal(reqs.noPhone, true);
  assert.equal(reqs.notRepeated, true);
  assert.equal(reqs.matchesConfirm, true);
  assert.equal(reqs.isValid, true);

  const fail = getPasswordRequirements("pass", "0911223344", "different");
  assert.equal(fail.hasMinLength, false);
  assert.equal(fail.matchesConfirm, false);
  assert.equal(fail.isValid, false);
});

