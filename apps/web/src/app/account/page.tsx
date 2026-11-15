"use client";

import { useEffect, useState } from "react";
import { api, isPhoneNotVerifiedError } from "@/lib/api";
import { checkPasswordPolicy, getPasswordRequirements } from "@/lib/password";
import { CustomerNav } from "@/components/CustomerNav";
import { PhoneVerificationPrompt } from "@/components/PhoneVerificationPrompt";

export interface UserProfile {
  id: string;
  phone: string;
  role: "customer" | "driver" | "admin" | "staff";
  status: "active" | "suspended" | "deleted";
  fullName: string | null;
  email?: string | null;
  locale: "am" | "en" | "om" | "ti";
  phoneVerified: boolean;
  accountNumber?: string | null;
  createdAt?: string;
}

export interface WalletTransaction {
  id: number;
  amount: number; // in santim
  balanceAfter: number; // in santim
  kind: "topup" | "trip_payment" | "trip_earning" | "commission" | "payout" | "refund" | "bonus" | "adjustment";
  tripId?: string | null;
  createdAt: string;
}

export interface WalletData {
  balance: number; // in santim
  currency: string;
  transactions: WalletTransaction[];
}

const LANGUAGE_LABELS: Record<string, string> = {
  am: "አማርኛ (Amharic)",
  en: "English",
  om: "Afaan Oromoo",
  ti: "ትግርኛ (Tigrinya)",
};

const KIND_LABELS: Record<string, string> = {
  topup: "Wallet Top-up",
  trip_payment: "Trip Payment",
  trip_earning: "Trip Earning",
  commission: "Platform Commission",
  payout: "Payout",
  refund: "Refund",
  bonus: "Bonus",
  adjustment: "Adjustment",
};

/** Convert santim to Birr string with 2 decimal places */
export function formatSantimToBirr(santim: number): string {
  const birr = santim / 100;
  return birr.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Format transaction amount with sign (+ / -) in ETB */
export function formatTransactionAmount(amountSantim: number): { text: string; isCredit: boolean } {
  const birr = Math.abs(amountSantim) / 100;
  const formatted = birr.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (amountSantim > 0) return { text: `+${formatted} ETB`, isCredit: true };
  if (amountSantim < 0) return { text: `-${formatted} ETB`, isCredit: false };
  return { text: `0.00 ETB`, isCredit: false };
}

/** Format timestamp for display */
export function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoString;
  }
}

export default function AccountPage() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);

  // Profile editing state
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [locale, setLocale] = useState<"am" | "en" | "om" | "ti">("am");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Password change state
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Phone verification modal state
  const [showVerifyModal, setShowVerifyModal] = useState(false);

  async function loadData() {
    setLoading(true);
    setPageError(null);
    try {
      const userData = await api<UserProfile>("users/me");
      setUser(userData);
      setFullName(userData.fullName ?? "");
      setEmail(userData.email ?? "");
      setLocale(userData.locale ?? "am");

      if (userData.role === "customer") {
        try {
          const walletData = await api<WalletData>("users/me/wallet");
          setWallet(walletData);
        } catch (wErr) {
          // Wallet loading failure shouldn't block the profile from rendering
          console.error("Failed to load wallet data", wErr);
        }
      }
    } catch (err: any) {
      setPageError(err.message ?? "Failed to load account information");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleProfileSubmit(e: React.FormEvent) {
    e.preventDefault();
    setProfileMessage(null);

    const trimmedName = fullName.trim();
    if (trimmedName.length < 2) {
      setProfileMessage({ ok: false, text: "Full name must be at least 2 characters." });
      return;
    }
    if (trimmedName.length > 100) {
      setProfileMessage({ ok: false, text: "Full name must not exceed 100 characters." });
      return;
    }

    const trimmedEmail = email.trim();
    if (trimmedEmail.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      setProfileMessage({ ok: false, text: "Please provide a valid email address." });
      return;
    }

    setProfileSaving(true);
    try {
      const updated = await api<UserProfile>("users/me", {
        method: "PATCH",
        body: {
          fullName: trimmedName,
          email: trimmedEmail.length > 0 ? trimmedEmail : undefined,
          locale,
        },
      });
      setUser(updated);
      setFullName(updated.fullName ?? "");
      setEmail(updated.email ?? "");
      setLocale(updated.locale ?? "am");
      setProfileMessage({ ok: true, text: "Profile details updated successfully." });
    } catch (err: any) {
      setProfileMessage({ ok: false, text: err.message ?? "Failed to update profile." });
    } finally {
      setProfileSaving(false);
    }
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPasswordMessage(null);

    if (!currentPassword) {
      setPasswordMessage({ ok: false, text: "Please enter your current password." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordMessage({ ok: false, text: "The new passwords do not match." });
      return;
    }

    const policyError = checkPasswordPolicy(newPassword, user?.phone ?? "");
    if (policyError) {
      setPasswordMessage({ ok: false, text: policyError });
      return;
    }

    setPasswordSaving(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setPasswordMessage({ ok: false, text: data?.error?.message ?? "Failed to change password." });
        return;
      }

      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setPasswordMessage({
        ok: true,
        text: "Password changed successfully. You have been signed out on all other devices.",
      });
    } catch (err: any) {
      setPasswordMessage({ ok: false, text: err.message ?? "An unexpected error occurred." });
    } finally {
      setPasswordSaving(false);
    }
  }

  const pwReqs = getPasswordRequirements(newPassword, user?.phone ?? "", confirmPassword);

  if (loading) {
    return (
      <>
        <CustomerNav />
        <main>
          <div className="card" style={{ textAlign: "center", padding: "48px 16px" }}>
            <p className="muted">Loading your account details…</p>
          </div>
        </main>
      </>
    );
  }

  if (pageError || !user) {
    return (
      <>
        <CustomerNav />
        <main>
          <div className="card">
            <h1>Account Error</h1>
            <p className="error" role="alert">{pageError ?? "Account information unavailable."}</p>
            <button onClick={loadData}>Retry</button>
          </div>
        </main>
      </>
    );
  }

  // Handle non-customer access cleanly
  if (user.role !== "customer") {
    return (
      <>
        <CustomerNav userName={user.fullName} />
        <main>
          <div className="card">
            <h1>Simple Ride Account</h1>
            <p>
              Signed in as <b>{user.phone}</b> ({user.role}).
            </p>
            {user.role === "driver" ? (
              <p className="muted">
                Driver accounts and vehicle onboarding are managed via the Simple Ride Driver app.
              </p>
            ) : (
              <p className="muted">
                Back-office staff and administrator management is located in the{" "}
                <a href="/admin">Admin Dashboard</a>.
              </p>
            )}
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <CustomerNav userName={user.fullName} />
      <main>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ margin: "0 0 4px" }}>My Account</h1>
          <p className="muted" style={{ margin: 0 }}>
            Manage your customer profile, view your account number, and check your wallet balance.
          </p>
        </div>

        {/* ────────────────── Account Overview Banner ────────────────── */}
        <div className="card" style={{ marginBottom: 24 }}>
          <div className="split-even" style={{ alignItems: "center" }}>
            <div>
              <span className="muted" style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                Customer Account Number
              </span>
              <div
                data-testid="account-number-display"
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  fontFamily: "ui-monospace, monospace",
                  color: "var(--brand)",
                  marginTop: 4,
                  letterSpacing: "0.04em",
                }}
              >
                {user.accountNumber ?? "Not assigned"}
              </div>
              <span className="muted" style={{ fontSize: 12 }}>
                Permanent read-only customer account identifier
              </span>
            </div>

            <div style={{ textAlign: "right" }}>
              <div className="row" style={{ justifyContent: "flex-end", marginBottom: 4 }}>
                <span className="muted" style={{ fontSize: 13 }}>Phone: </span>
                <b data-testid="account-phone">{user.phone}</b>
                {user.phoneVerified ? (
                  <span
                    data-testid="phone-verified-badge"
                    style={{
                      background: "rgba(15, 122, 74, 0.12)",
                      color: "var(--brand)",
                      padding: "2px 8px",
                      borderRadius: 12,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    ✓ Verified
                  </span>
                ) : (
                  <span
                    data-testid="phone-unverified-badge"
                    style={{
                      background: "rgba(180, 35, 24, 0.12)",
                      color: "var(--danger)",
                      padding: "2px 8px",
                      borderRadius: 12,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    ⚠ Unverified
                  </span>
                )}
              </div>
              {!user.phoneVerified && (
                <button
                  className="secondary"
                  style={{ fontSize: 13, padding: "4px 10px", marginTop: 4 }}
                  onClick={() => setShowVerifyModal(true)}
                >
                  Verify phone number
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ────────────────── Main Sections Grid ────────────────── */}
        <div className="split-even" style={{ gap: 24, alignItems: "start" }}>
          {/* Left Column: Profile Editing */}
          <section aria-labelledby="profile-heading">
            <div className="card">
              <h2 id="profile-heading" style={{ fontSize: 18, marginTop: 0 }}>
                Profile Details
              </h2>

              <form onSubmit={handleProfileSubmit}>
                {/* Read-Only Account Number field */}
                <label htmlFor="account-num-input">Account number (read-only)</label>
                <input
                  id="account-num-input"
                  type="text"
                  value={user.accountNumber ?? "Not assigned"}
                  disabled
                  readOnly
                  aria-readonly="true"
                  style={{ background: "var(--bg)", cursor: "not-allowed" }}
                />

                {/* Read-Only Phone field */}
                <label htmlFor="phone-input">Phone number (read-only)</label>
                <input
                  id="phone-input"
                  type="text"
                  value={user.phone}
                  disabled
                  readOnly
                  aria-readonly="true"
                  style={{ background: "var(--bg)", cursor: "not-allowed" }}
                />

                {/* Editable Full Name */}
                <label htmlFor="full-name-input">Full name</label>
                <input
                  id="full-name-input"
                  type="text"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Abebe Bikila"
                  required
                  minLength={2}
                  maxLength={100}
                />

                {/* Editable Email */}
                <label htmlFor="email-input">Email address (optional)</label>
                <input
                  id="email-input"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                />

                {/* Editable Language Preference */}
                <label htmlFor="locale-select">Language preference</label>
                <select
                  id="locale-select"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as typeof locale)}
                >
                  <option value="am">{LANGUAGE_LABELS.am}</option>
                  <option value="en">{LANGUAGE_LABELS.en}</option>
                  <option value="om">{LANGUAGE_LABELS.om}</option>
                  <option value="ti">{LANGUAGE_LABELS.ti}</option>
                </select>

                {profileMessage && (
                  <p
                    className={profileMessage.ok ? "muted" : "error"}
                    role="status"
                    style={{ marginTop: 12, fontWeight: 500 }}
                  >
                    {profileMessage.text}
                  </p>
                )}

                <div style={{ marginTop: 20 }}>
                  <button type="submit" disabled={profileSaving}>
                    {profileSaving ? "Saving changes…" : "Save profile"}
                  </button>
                </div>
              </form>
            </div>
          </section>

          {/* Right Column: Security / Change Password */}
          <section aria-labelledby="password-heading">
            <div className="card">
              <h2 id="password-heading" style={{ fontSize: 18, marginTop: 0 }}>
                Change Password
              </h2>
              <p className="muted" style={{ fontSize: 13, marginTop: -4 }}>
                Password must be at least 10 characters and cannot contain your phone number.
              </p>

              <form onSubmit={handlePasswordSubmit}>
                <label htmlFor="current-pw-input">Current password</label>
                <input
                  id="current-pw-input"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />

                <label htmlFor="new-pw-input">New password</label>
                <input
                  id="new-pw-input"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={10}
                />

                <label htmlFor="confirm-pw-input">Confirm new password</label>
                <input
                  id="confirm-pw-input"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />

                {/* Password Policy Real-time Feedback */}
                {newPassword.length > 0 && (
                  <div
                    style={{
                      fontSize: 12,
                      marginTop: 10,
                      padding: 10,
                      borderRadius: 8,
                      background: "var(--bg)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    <div style={{ color: pwReqs.hasMinLength ? "var(--brand)" : "var(--muted)" }}>
                      {pwReqs.hasMinLength ? "✓" : "○"} At least 10 characters
                    </div>
                    <div style={{ color: pwReqs.noPhone ? "var(--brand)" : "var(--danger)" }}>
                      {pwReqs.noPhone ? "✓" : "×"} Does not contain your phone number
                    </div>
                    <div style={{ color: pwReqs.notRepeated ? "var(--brand)" : "var(--danger)" }}>
                      {pwReqs.notRepeated ? "✓" : "×"} Not a single repeated character
                    </div>
                    {confirmPassword.length > 0 && (
                      <div style={{ color: pwReqs.matchesConfirm ? "var(--brand)" : "var(--danger)" }}>
                        {pwReqs.matchesConfirm ? "✓" : "×"} Passwords match
                      </div>
                    )}
                  </div>
                )}

                {passwordMessage && (
                  <p
                    className={passwordMessage.ok ? "muted" : "error"}
                    role="status"
                    style={{ marginTop: 12, fontWeight: 500 }}
                  >
                    {passwordMessage.text}
                  </p>
                )}

                <div style={{ marginTop: 20 }}>
                  <button type="submit" disabled={passwordSaving}>
                    {passwordSaving ? "Updating password…" : "Update password"}
                  </button>
                </div>
              </form>
            </div>
          </section>
        </div>

        {/* ────────────────── Wallet & Balance Section ────────────────── */}
        <section aria-labelledby="wallet-heading" style={{ marginTop: 32 }}>
          <div className="card">
            <div
              className="row"
              style={{ justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}
            >
              <div>
                <h2 id="wallet-heading" style={{ fontSize: 20, margin: 0 }}>
                  Customer Wallet
                </h2>
                <span className="muted" style={{ fontSize: 13 }}>
                  Simple Ride balance for cashless ride payments
                </span>
              </div>
              <div style={{ textAlign: "right" }}>
                <span className="muted" style={{ fontSize: 12, textTransform: "uppercase" }}>
                  Available Balance
                </span>
                <div
                  data-testid="wallet-balance"
                  style={{ fontSize: 28, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}
                >
                  {wallet ? `${formatSantimToBirr(wallet.balance)} ${wallet.currency}` : "0.00 ETB"}
                </div>
              </div>
            </div>

            {/* Transaction History */}
            <h3 style={{ fontSize: 15, margin: "20px 0 10px" }}>Recent Activity</h3>

            {!wallet || wallet.transactions.length === 0 ? (
              <div
                data-testid="wallet-empty-state"
                style={{
                  padding: "32px 16px",
                  textAlign: "center",
                  background: "var(--bg)",
                  borderRadius: 8,
                  border: "1px dashed var(--border)",
                }}
              >
                <p className="muted" style={{ margin: 0, fontSize: 14 }}>
                  No transactions yet. Your recent top-ups and trip receipts will appear here.
                </p>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table data-testid="wallet-transactions-table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Description</th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Amount
                      </th>
                      <th scope="col" style={{ textAlign: "right" }}>
                        Balance After
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallet.transactions.map((tx) => {
                      const formattedAmt = formatTransactionAmount(tx.amount);
                      return (
                        <tr key={tx.id}>
                          <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(tx.createdAt)}</td>
                          <td>
                            <b>{KIND_LABELS[tx.kind] ?? tx.kind}</b>
                            {tx.tripId && (
                              <span className="muted" style={{ fontSize: 12, display: "block" }}>
                                Trip #{tx.tripId.slice(0, 8)}
                              </span>
                            )}
                          </td>
                          <td
                            style={{
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              fontWeight: 600,
                              color: formattedAmt.isCredit ? "var(--brand)" : "inherit",
                            }}
                          >
                            {formattedAmt.text}
                          </td>
                          <td
                            style={{
                              textAlign: "right",
                              fontVariantNumeric: "tabular-nums",
                              color: "var(--muted)",
                            }}
                          >
                            {formatSantimToBirr(tx.balanceAfter)} ETB
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* Phone Verification Modal */}
        <PhoneVerificationPrompt
          isOpen={showVerifyModal}
          actionDescription="updating your account profile"
          onClose={() => setShowVerifyModal(false)}
          onVerified={() => {
            setShowVerifyModal(false);
            loadData();
          }}
        />
      </main>
    </>
  );
}
