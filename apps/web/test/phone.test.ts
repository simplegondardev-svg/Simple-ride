import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEthiopianPhone, isValidEthiopianPhone, formatEthiopianPhone } from "../src/lib/phone";

test("normalizeEthiopianPhone accepts standard formats", () => {
  // Ethio Telecom (9)
  assert.equal(normalizeEthiopianPhone("0911223344"), "+251911223344");
  assert.equal(normalizeEthiopianPhone("911223344"), "+251911223344");
  assert.equal(normalizeEthiopianPhone("+251911223344"), "+251911223344");
  assert.equal(normalizeEthiopianPhone("251911223344"), "+251911223344");
  assert.equal(normalizeEthiopianPhone("09 11 22 33 44"), "+251911223344");
  assert.equal(normalizeEthiopianPhone("+251-91-122-3344"), "+251911223344");
  assert.equal(normalizeEthiopianPhone("(0911) 22-33-44"), "+251911223344");

  // Safaricom Ethiopia (7)
  assert.equal(normalizeEthiopianPhone("0711223344"), "+251711223344");
  assert.equal(normalizeEthiopianPhone("711223344"), "+251711223344");
  assert.equal(normalizeEthiopianPhone("+251711223344"), "+251711223344");
  assert.equal(normalizeEthiopianPhone("251711223344"), "+251711223344");
});

test("normalizeEthiopianPhone rejects invalid numbers", () => {
  assert.equal(normalizeEthiopianPhone(""), null);
  assert.equal(normalizeEthiopianPhone("0811223344"), null); // Invalid prefix (8)
  assert.equal(normalizeEthiopianPhone("091122334"), null);   // Too short (8 digits)
  assert.equal(normalizeEthiopianPhone("09112233445"), null); // Too long (10 digits)
  assert.equal(normalizeEthiopianPhone("abcdefghij"), null);  // Non-numeric
  assert.equal(normalizeEthiopianPhone("+12025550123"), null); // US number
  assert.equal(normalizeEthiopianPhone(null as any), null);
  assert.equal(normalizeEthiopianPhone(undefined as any), null);
});

test("isValidEthiopianPhone checks validity correctly", () => {
  assert.equal(isValidEthiopianPhone("0911223344"), true);
  assert.equal(isValidEthiopianPhone("0711223344"), true);
  assert.equal(isValidEthiopianPhone("0811223344"), false);
  assert.equal(isValidEthiopianPhone(""), false);
});

test("formatEthiopianPhone formats numbers cleanly", () => {
  assert.equal(formatEthiopianPhone("0911223344"), "+251 91 122 3344");
  assert.equal(formatEthiopianPhone("0911223344", "local"), "091 122 3344");
  assert.equal(formatEthiopianPhone("0711223344"), "+251 71 122 3344");
  assert.equal(formatEthiopianPhone("0711223344", "local"), "071 122 3344");
  assert.equal(formatEthiopianPhone("invalid"), "invalid");
  assert.equal(formatEthiopianPhone(""), "");
});
