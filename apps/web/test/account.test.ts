import test from "node:test";
import assert from "node:assert/strict";
import {
  formatSantimToBirr,
  formatTransactionAmount,
  formatDateTime,
  type UserProfile,
  type WalletData,
} from "../src/app/account/page";
import { checkPasswordPolicy, getPasswordRequirements } from "../src/lib/password";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Account Information & Account-Number Display Tests
// ─────────────────────────────────────────────────────────────────────────────

test("Account info: Customer account number format and display", () => {
  const customer: UserProfile = {
    id: "2eae0301-6ac8-4a12-906a-744f1342afca",
    phone: "+251939704129",
    role: "customer",
    status: "active",
    fullName: "Nepthalem Ayele",
    email: "nepthalem@example.com",
    locale: "am",
    phoneVerified: true,
    accountNumber: "SR-100580",
    createdAt: "2026-11-14T21:17:01.317Z",
  };

  assert.equal(customer.accountNumber, "SR-100580");
  assert.match(customer.accountNumber!, /^SR-[0-9]{6,}$/);
  assert.equal(customer.phone, "+251939704129");
  assert.equal(customer.phoneVerified, true);
  assert.equal(customer.role, "customer");
});

test("Account info: Non-customer accounts do not have customer account numbers", () => {
  const driver: UserProfile = {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    phone: "+251911223344",
    role: "driver",
    status: "active",
    fullName: "Driver User",
    email: null,
    locale: "am",
    phoneVerified: true,
    accountNumber: null,
  };

  const staff: UserProfile = {
    id: "4fa85f64-5717-4562-b3fc-2c963f66afa7",
    phone: "+251922334455",
    role: "staff",
    status: "active",
    fullName: "Staff User",
    email: "staff@simpleride.et",
    locale: "en",
    phoneVerified: true,
    accountNumber: null,
  };

  assert.equal(driver.accountNumber, null);
  assert.equal(staff.accountNumber, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Immutability of Phone & Account Number
// ─────────────────────────────────────────────────────────────────────────────

test("Account info: Phone and account number are never included in profile update payload", () => {
  // When a user updates profile details, only editable columns are sent to PATCH /users/me
  function prepareUpdatePayload(fullName: string, email: string, locale: "am" | "en" | "om" | "ti") {
    const trimmedEmail = email.trim();
    return {
      fullName: fullName.trim(),
      email: trimmedEmail.length > 0 ? trimmedEmail : undefined,
      locale,
    };
  }

  const payload = prepareUpdatePayload("Updated Name", "new@example.com", "om");

  assert.equal("accountNumber" in payload, false);
  assert.equal("account_number" in payload, false);
  assert.equal("phone" in payload, false);
  assert.equal(payload.fullName, "Updated Name");
  assert.equal(payload.email, "new@example.com");
  assert.equal(payload.locale, "om");
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Profile Update Validation
// ─────────────────────────────────────────────────────────────────────────────

test("Profile validation: Full name validation requirements", () => {
  const validateName = (name: string): string | null => {
    const trimmed = name.trim();
    if (trimmed.length < 2) return "Full name must be at least 2 characters.";
    if (trimmed.length > 100) return "Full name must not exceed 100 characters.";
    return null;
  };

  assert.equal(validateName(""), "Full name must be at least 2 characters.");
  assert.equal(validateName("   "), "Full name must be at least 2 characters.");
  assert.equal(validateName("A"), "Full name must be at least 2 characters.");
  assert.equal(validateName("Ab"), null);
  assert.equal(validateName("Abebe Bikila"), null);
  assert.equal(validateName("a".repeat(100)), null);
  assert.equal(validateName("a".repeat(101)), "Full name must not exceed 100 characters.");
});

test("Profile validation: Email format validation", () => {
  const validateEmail = (email: string): string | null => {
    const trimmed = email.trim();
    if (trimmed.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return "Please provide a valid email address.";
    }
    return null;
  };

  assert.equal(validateEmail(""), null); // Optional
  assert.equal(validateEmail("   "), null); // Optional
  assert.equal(validateEmail("test@example.com"), null);
  assert.equal(validateEmail("user.name+tag@sub.domain.et"), null);
  assert.equal(validateEmail("invalid-email"), "Please provide a valid email address.");
  assert.equal(validateEmail("missing@tld"), "Please provide a valid email address.");
  assert.equal(validateEmail("@nodomain.com"), "Please provide a valid email address.");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Wallet Balance & Transaction Formatting
// ─────────────────────────────────────────────────────────────────────────────

test("Wallet formatting: Santim to Birr conversion", () => {
  assert.equal(formatSantimToBirr(0), "0.00");
  assert.equal(formatSantimToBirr(100), "1.00");
  assert.equal(formatSantimToBirr(25000), "250.00");
  assert.equal(formatSantimToBirr(123456), "1,234.56");
  assert.equal(formatSantimToBirr(10000000), "100,000.00");
});

test("Wallet formatting: Transaction amount display with sign (+ / -)", () => {
  const credit = formatTransactionAmount(25000); // +250.00 ETB
  assert.equal(credit.text, "+250.00 ETB");
  assert.equal(credit.isCredit, true);

  const debit = formatTransactionAmount(-15000); // -150.00 ETB
  assert.equal(debit.text, "-150.00 ETB");
  assert.equal(debit.isCredit, false);

  const zero = formatTransactionAmount(0);
  assert.equal(zero.text, "0.00 ETB");
  assert.equal(zero.isCredit, false);
});

test("Wallet state: Empty transactions vs populated transaction history", () => {
  const emptyWallet: WalletData = {
    balance: 0,
    currency: "ETB",
    transactions: [],
  };

  assert.equal(emptyWallet.transactions.length, 0);

  const populatedWallet: WalletData = {
    balance: 35000,
    currency: "ETB",
    transactions: [
      {
        id: 1,
        amount: 50000,
        balanceAfter: 50000,
        kind: "topup",
        tripId: null,
        createdAt: "2026-11-14T10:00:00.000Z",
      },
      {
        id: 2,
        amount: -15000,
        balanceAfter: 35000,
        kind: "trip_payment",
        tripId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        createdAt: "2026-11-14T11:30:00.000Z",
      },
    ],
  };

  assert.equal(populatedWallet.transactions.length, 2);
  assert.equal(populatedWallet.transactions[0].kind, "topup");
  assert.equal(populatedWallet.transactions[1].kind, "trip_payment");
  assert.equal(populatedWallet.transactions[1].tripId?.slice(0, 8), "a1b2c3d4");
});

test("Date formatting: Gracefully formats ISO strings", () => {
  const dateStr = "2026-11-14T21:17:01.317Z";
  const formatted = formatDateTime(dateStr);
  assert.ok(typeof formatted === "string");
  assert.ok(formatted.length > 0);
  assert.notEqual(formatted, "Invalid Date");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Password Change Validation & Policy Enforcement
// ─────────────────────────────────────────────────────────────────────────────

test("Password change: Validation and confirmation matching", () => {
  const userPhone = "+251939704129";

  // Mismatched passwords
  const reqMismatch = getPasswordRequirements("SimpleRide2026!", userPhone, "Different2026!");
  assert.equal(reqMismatch.matchesConfirm, false);

  // Matching compliant passwords
  const reqMatch = getPasswordRequirements("SimpleRide2026!", userPhone, "SimpleRide2026!");
  assert.equal(reqMatch.matchesConfirm, true);
  assert.equal(reqMatch.isValid, true);

  // Too short (< 10)
  assert.equal(checkPasswordPolicy("Short1!", userPhone), "Password must be at least 10 characters");

  // Phone number leakage
  assert.equal(
    checkPasswordPolicy("Ride939704129Pass!", userPhone),
    "Password must not contain your phone number"
  );

  // Single repeated character
  assert.equal(checkPasswordPolicy("aaaaaaaaaa", userPhone), "Password must not be one repeated character");

  // Valid password
  assert.equal(checkPasswordPolicy("AddisAbaba2026!", userPhone), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Role & Access Restrictions
// ─────────────────────────────────────────────────────────────────────────────

test("Access restrictions: Identifies customer vs non-customer views", () => {
  function getAccountViewKind(role: string): "customer_view" | "driver_view" | "staff_admin_view" {
    if (role === "customer") return "customer_view";
    if (role === "driver") return "driver_view";
    return "staff_admin_view";
  }

  assert.equal(getAccountViewKind("customer"), "customer_view");
  assert.equal(getAccountViewKind("driver"), "driver_view");
  assert.equal(getAccountViewKind("staff"), "staff_admin_view");
  assert.equal(getAccountViewKind("admin"), "staff_admin_view");
});
