"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { formatEthiopianPhone, isValidEthiopianPhone, normalizeEthiopianPhone } from "@/lib/phone";
import { checkPasswordPolicy, getPasswordRequirements } from "@/lib/password";

type Stage = "request" | "reset" | "success";
type RecoveryRole = "customer" | "driver";

function ForgotPasswordForm() {
  const searchParams = useSearchParams();
  const initialRole = searchParams.get("role") === "driver" ? "driver" : "customer";

  const [stage, setStage] = useState<Stage>("request");
  const [role, setRole] = useState<RecoveryRole>(initialRole);
  const [phone, setPhone] = useState("");
  const [normalizedPhone, setNormalizedPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const [error, setError] = useState<string>();
  const [infoMessage, setInfoMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // 60-second cooldown timer for OTP resend
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  const passwordReqs = getPasswordRequirements(newPassword, normalizedPhone || phone, confirm);

  // Stage A: Submit phone & role to request password reset OTP
  async function handleRequestSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setInfoMessage(undefined);

    if (!isValidEthiopianPhone(phone)) {
      setError("Please enter a valid Ethiopian mobile number (e.g. 0911223344 or 0711223344)");
      return;
    }

    const norm = normalizeEthiopianPhone(phone);
    if (!norm) {
      setError("Please enter a valid Ethiopian mobile number");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/auth/password/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: norm, role }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 429) {
          setError("Too many requests. Please wait a few minutes before trying again.");
        } else {
          setError(data?.error?.message ?? "Failed to request password reset. Please try again.");
        }
        return;
      }

      setNormalizedPhone(norm);
      setOtp("");
      setStage("reset");
      setCountdown(60);
      // Generic confirmation that does not disclose whether account exists
      setInfoMessage("If an active account exists for this phone number, a 6-digit verification code has been sent via SMS.");
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // Resend OTP in Stage B
  async function handleResendOtp() {
    if (countdown > 0 || busy || !normalizedPhone) return;
    setError(undefined);
    setInfoMessage(undefined);
    setBusy(true);

    try {
      const res = await fetch("/api/auth/password/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: normalizedPhone, role }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 429) {
          setError("Too many attempts. Please wait a few minutes before requesting another code.");
        } else {
          setError(data?.error?.message ?? "Failed to resend verification code.");
        }
        return;
      }

      setCountdown(60);
      setInfoMessage("If an active account exists, a new 6-digit verification code has been sent.");
    } catch {
      setError("Network error. Could not resend verification code.");
    } finally {
      setBusy(false);
    }
  }

  // Stage B: Verify OTP and set new password
  async function handleResetSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setInfoMessage(undefined);

    const cleanOtp = otp.trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
      setError("Please enter the complete 6-digit verification code");
      return;
    }

    const pwProblem = checkPasswordPolicy(newPassword, normalizedPhone);
    if (pwProblem) {
      setError(pwProblem);
      return;
    }

    if (newPassword !== confirm) {
      setError("The passwords don't match");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/auth/password/reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          phone: normalizedPhone,
          role,
          code: cleanOtp,
          newPassword,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setOtp(""); // Clear OTP input on failed attempt
        const code = data?.error?.code;
        if (code === "INVALID_OTP") {
          setError("Invalid or expired verification code. Please check the code or request a new one.");
        } else if (code === "WEAK_PASSWORD") {
          setError(data?.error?.message ?? "Password does not meet requirements.");
        } else if (res.status === 429) {
          setError("Too many attempts. Please wait a few minutes before trying again.");
        } else {
          setError(data?.error?.message ?? "Password reset failed. Please try again.");
        }
        return;
      }

      // Successful reset: clear sensitive fields from state and show confirmation
      setOtp("");
      setNewPassword("");
      setConfirm("");
      setStage("success");
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // Return to Stage A preserving entered phone and role
  function handleChangePhone() {
    setStage("request");
    setOtp("");
    setError(undefined);
    setInfoMessage(undefined);
  }

  if (stage === "success") {
    return (
      <main style={{ maxWidth: 420 }}>
        <h1>Password reset complete</h1>
        <div className="card">
          <p style={{ margin: "4px 0 16px" }}>
            Your password has been successfully reset. You can now log in with your new password.
          </p>
          <div className="row">
            <Link
              href="/login"
              className="btn"
              style={{
                display: "inline-block",
                textAlign: "center",
                width: "100%",
                padding: "10px 16px",
                textDecoration: "none",
              }}
            >
              Return to log in
            </Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 420 }}>
      <h1>{stage === "request" ? "Reset your password" : "Enter verification code"}</h1>
      <p className="muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 16 }}>
        {stage === "request"
          ? "Step 1 of 2: Account identification"
          : "Step 2 of 2: Set your new password"}
      </p>

      {stage === "request" ? (
        <form className="card" onSubmit={handleRequestSubmit} noValidate>
          <label htmlFor="role">Account type</label>
          <select
            id="role"
            value={role}
            onChange={(e) => setRole(e.target.value as RecoveryRole)}
            disabled={busy}
          >
            <option value="customer">Rider</option>
            <option value="driver">Driver</option>
          </select>

          <label htmlFor="phone">Phone number</label>
          <input
            id="phone"
            inputMode="tel"
            autoComplete="tel"
            placeholder="09 11 22 33 44"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            required
            disabled={busy}
            autoFocus
          />

          <p className="muted" style={{ fontSize: 13, marginTop: 12 }}>
            Staff and admin password recovery is managed by system administrators.
          </p>

          {error && (
            <p className="error" role="alert" style={{ marginTop: 12 }}>
              {error}
            </p>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            <button disabled={busy} style={{ width: "100%" }}>
              {busy ? "Sending code…" : "Send verification code"}
            </button>
          </div>

          <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
            Remembered your password? <Link href="/login">Back to log in</Link>
          </p>
        </form>
      ) : (
        <form className="card" onSubmit={handleResetSubmit} noValidate>
          <div className="row" style={{ justifyContent: "space-between", margin: "4px 0 12px" }}>
            <span style={{ fontSize: 14 }}>
              Code sent for <b>{formatEthiopianPhone(normalizedPhone)}</b> ({role === "driver" ? "Driver" : "Rider"})
            </span>
            <button
              type="button"
              className="secondary"
              onClick={handleChangePhone}
              disabled={busy}
              style={{ padding: "4px 8px", fontSize: 12 }}
            >
              Change
            </button>
          </div>

          {infoMessage && (
            <p className="muted" role="status" style={{ fontSize: 13, margin: "8px 0" }}>
              {infoMessage}
            </p>
          )}

          <label htmlFor="otp">6-digit verification code</label>
          <input
            id="otp"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            autoComplete="one-time-code"
            placeholder="123456"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
            required
            autoFocus
            disabled={busy}
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: 22,
              letterSpacing: "0.25em",
              textAlign: "center",
            }}
          />

          <label htmlFor="newPassword">New password (at least 10 characters)</label>
          <input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={128}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            disabled={busy}
          />

          <label htmlFor="confirm">Repeat new password</label>
          <input
            id="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            disabled={busy}
          />

          {newPassword.length > 0 && (
            <ul style={{ fontSize: 12, margin: "8px 0 0", paddingLeft: 18, color: "var(--muted)" }}>
              <li style={{ color: passwordReqs.hasMinLength ? "var(--brand)" : undefined }}>
                {passwordReqs.hasMinLength ? "✓" : "•"} At least 10 characters
              </li>
              <li style={{ color: passwordReqs.noPhone ? "var(--brand)" : "var(--danger)" }}>
                {passwordReqs.noPhone ? "✓" : "✕"} Must not contain your phone number
              </li>
              <li style={{ color: passwordReqs.notRepeated ? "var(--brand)" : "var(--danger)" }}>
                {passwordReqs.notRepeated ? "✓" : "✕"} Must not be one repeated character
              </li>
              {confirm.length > 0 && (
                <li style={{ color: passwordReqs.matchesConfirm ? "var(--brand)" : "var(--danger)" }}>
                  {passwordReqs.matchesConfirm ? "✓ Passwords match" : "✕ Passwords do not match"}
                </li>
              )}
            </ul>
          )}

          {error && (
            <p className="error" role="alert" style={{ marginTop: 12 }}>
              {error}
            </p>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            <button disabled={busy || otp.length !== 6} style={{ width: "100%" }}>
              {busy ? "Resetting password…" : "Reset password"}
            </button>
          </div>

          <div style={{ marginTop: 12, textAlign: "center" }}>
            {countdown > 0 ? (
              <span className="muted" style={{ fontSize: 13 }}>
                Resend code in {countdown}s
              </span>
            ) : (
              <button
                type="button"
                className="secondary"
                onClick={handleResendOtp}
                disabled={busy}
                style={{ width: "100%", fontSize: 13, padding: "8px 12px" }}
              >
                Resend verification code
              </button>
            )}
          </div>
        </form>
      )}
    </main>
  );
}

export default function ForgotPasswordPage() {
  return (
    <Suspense>
      <ForgotPasswordForm />
    </Suspense>
  );
}

