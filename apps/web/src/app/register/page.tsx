"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { formatEthiopianPhone, isValidEthiopianPhone, normalizeEthiopianPhone } from "@/lib/phone";
import { checkPasswordPolicy, getPasswordRequirements, resolveSafeRedirect } from "@/lib/password";

type Stage = "details" | "otp";

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = resolveSafeRedirect(searchParams.get("next"));

  const [stage, setStage] = useState<Stage>("details");
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [normalizedPhone, setNormalizedPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [otp, setOtp] = useState("");

  const [error, setError] = useState<string>();
  const [accountExists, setAccountExists] = useState(false);
  const [infoMessage, setInfoMessage] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // 60-second countdown timer for OTP resend
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  const passwordReqs = getPasswordRequirements(password, phone, confirm);

  // Stage A: Submit account details and request OTP
  async function handleDetailsSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setAccountExists(false);
    setInfoMessage(undefined);

    if (fullName.trim().length < 2) {
      setError("Please enter your full name (at least 2 characters)");
      return;
    }

    if (!isValidEthiopianPhone(phone)) {
      setError("Please enter a valid Ethiopian mobile number (e.g. 0911223344 or 0711223344)");
      return;
    }

    const norm = normalizeEthiopianPhone(phone);
    if (!norm) {
      setError("Please enter a valid Ethiopian mobile number");
      return;
    }

    const pwProblem = checkPasswordPolicy(password, norm);
    if (pwProblem) {
      setError(pwProblem);
      return;
    }

    if (password !== confirm) {
      setError("The passwords don't match");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/auth/register/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: norm, role: "customer" }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 429) {
          setError("Too many verification attempts. Please wait a few minutes before trying again.");
        } else {
          setError(data?.error?.message ?? "Failed to send verification code. Please try again.");
        }
        return;
      }

      setNormalizedPhone(norm);
      setOtp("");
      setStage("otp");
      setCountdown(60);
      setInfoMessage("Verification code sent via SMS.");
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
      const res = await fetch("/api/auth/register/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: normalizedPhone, role: "customer" }),
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
      setInfoMessage("A new 6-digit verification code has been sent.");
    } catch {
      setError("Network error. Could not resend verification code.");
    } finally {
      setBusy(false);
    }
  }

  // Stage B: Verify OTP and finalize registration
  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setAccountExists(false);
    setInfoMessage(undefined);

    const cleanOtp = otp.trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
      setError("Please enter the complete 6-digit verification code");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fullName: fullName.trim(),
          phone: normalizedPhone,
          password,
          role: "customer",
          code: cleanOtp,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setOtp(""); // Clear OTP input on failed attempt
        const code = data?.error?.code;
        if (code === "INVALID_OTP") {
          setError("Invalid or expired verification code. Please check the code or request a new one.");
        } else if (code === "ACCOUNT_EXISTS" || res.status === 409) {
          setAccountExists(true);
          setError("An account with this phone number already exists.");
        } else if (code === "WEAK_PASSWORD") {
          setError(data?.error?.message ?? "Password does not meet requirements.");
        } else if (res.status === 429) {
          setError("Too many attempts. Please wait a few minutes before trying again.");
        } else {
          setError(data?.error?.message ?? "Registration failed. Please try again.");
        }
        return;
      }

      // Successful registration: cookies are established by the BFF
      router.push(next);
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // Return to Stage A preserving entered details
  function handleChangePhone() {
    setStage("details");
    setOtp("");
    setError(undefined);
    setAccountExists(false);
    setInfoMessage(undefined);
  }

  return (
    <main style={{ maxWidth: 420 }}>
      <h1>{stage === "details" ? "Create your account" : "Verify your phone"}</h1>
      <p className="muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 16 }}>
        {stage === "details" ? "Step 1 of 2: Account details" : "Step 2 of 2: Phone verification"}
      </p>

      {stage === "details" ? (
        <form className="card" onSubmit={handleDetailsSubmit} noValidate>
          <label htmlFor="name">Full name</label>
          <input
            id="name"
            autoComplete="name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            minLength={2}
            disabled={busy}
            autoFocus
          />

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
          />

          <label htmlFor="pw">Password (at least 10 characters)</label>
          <input
            id="pw"
            type="password"
            autoComplete="new-password"
            minLength={10}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={busy}
          />

          <label htmlFor="pw2">Repeat password</label>
          <input
            id="pw2"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            disabled={busy}
          />

          {password.length > 0 && (
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

          <p className="muted" style={{ fontSize: 13, marginTop: 14 }}>
            Looking to drive? Driver onboarding is handled through the Simple Ride Driver app.
          </p>

          {error && (
            <p className="error" role="alert" style={{ marginTop: 12 }}>
              {error}
            </p>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            <button disabled={busy} style={{ width: "100%" }}>
              {busy ? "Sending code…" : "Continue to verification"}
            </button>
          </div>

          <p className="muted" style={{ fontSize: 13, marginTop: 16 }}>
            Already have an account? <Link href="/login">Log in</Link>
          </p>
        </form>
      ) : (
        <form className="card" onSubmit={handleOtpSubmit} noValidate>
          <div className="row" style={{ justifyContent: "space-between", margin: "4px 0 12px" }}>
            <span style={{ fontSize: 14 }}>
              Code sent to <b>{formatEthiopianPhone(normalizedPhone)}</b>
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

          {infoMessage && (
            <p className="muted" role="status" style={{ fontSize: 13, margin: "8px 0" }}>
              {infoMessage}
            </p>
          )}

          {error && (
            <p className="error" role="alert" style={{ marginTop: 8 }}>
              {error}
            </p>
          )}

          {accountExists && (
            <p style={{ fontSize: 13, marginTop: 4 }}>
              <Link href={`/login?phone=${encodeURIComponent(normalizedPhone)}`}>Click here to log in</Link>
            </p>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            <button disabled={busy || otp.length !== 6} style={{ width: "100%" }}>
              {busy ? "Verifying…" : "Verify and create account"}
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

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
