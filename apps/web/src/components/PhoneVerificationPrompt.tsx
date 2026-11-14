"use client";

import { useEffect, useState } from "react";

export interface PhoneVerificationPromptProps {
  isOpen: boolean;
  onClose: () => void;
  onVerified: () => void;
  actionDescription?: string;
}

export function PhoneVerificationPrompt({
  isOpen,
  onClose,
  onVerified,
  actionDescription,
}: PhoneVerificationPromptProps) {
  const [stage, setStage] = useState<"request" | "otp">("request");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [infoMessage, setInfoMessage] = useState<string>();
  const [countdown, setCountdown] = useState(0);

  // 60-second cooldown timer for OTP resend
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setInterval(() => {
      setCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [countdown]);

  // Reset state when opened
  useEffect(() => {
    if (isOpen) {
      setStage("request");
      setOtp("");
      setError(undefined);
      setInfoMessage(undefined);
      setCountdown(0);
      setBusy(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  async function handleStartVerification(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (busy) return;
    setError(undefined);
    setInfoMessage(undefined);
    setBusy(true);

    try {
      const res = await fetch("/api/auth/phone/verify/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
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

      setStage("otp");
      setOtp("");
      setCountdown(60);
      setInfoMessage("Verification code sent via SMS to your registered phone number.");
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleResendCode() {
    if (countdown > 0 || busy) return;
    setError(undefined);
    setInfoMessage(undefined);
    setBusy(true);

    try {
      const res = await fetch("/api/auth/phone/verify/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
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
      setInfoMessage("A new verification code has been sent via SMS.");
    } catch {
      setError("Network error. Could not resend verification code.");
    } finally {
      setBusy(false);
    }
  }

  async function handleConfirmVerification(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    setInfoMessage(undefined);

    const cleanOtp = otp.trim();
    if (!/^\d{6}$/.test(cleanOtp)) {
      setError("Please enter the complete 6-digit verification code");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/auth/phone/verify/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: cleanOtp }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setOtp(""); // Clear OTP input on failed attempt
        const code = data?.error?.code;
        if (code === "INVALID_OTP") {
          setError("Invalid or expired verification code. Please check the code or request a new one.");
        } else if (res.status === 429) {
          setError("Too many attempts. Please wait a few minutes before trying again.");
        } else {
          setError(data?.error?.message ?? "Phone verification failed. Please try again.");
        }
        return;
      }

      // Successful verification: notify caller so user can retry protected action
      setOtp("");
      onVerified();
    } catch {
      setError("Network error. Please check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="phone-verify-title"
    >
      <div
        className="card"
        style={{
          maxWidth: 420,
          width: "100%",
          boxShadow: "0 8px 30px rgba(0,0,0,0.2)",
        }}
      >
        <h2 id="phone-verify-title" style={{ marginTop: 0, fontSize: 20 }}>
          Phone verification required
        </h2>

        <p className="muted" style={{ fontSize: 14, margin: "4px 0 16px" }}>
          To {actionDescription ?? "continue with this action"}, please verify the mobile number registered to your
          account.
        </p>

        {stage === "request" ? (
          <div>
            {error && (
              <p className="error" role="alert" style={{ marginBottom: 12 }}>
                {error}
              </p>
            )}

            <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
              <button type="button" className="secondary" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="button" onClick={() => handleStartVerification()} disabled={busy}>
                {busy ? "Sending code…" : "Send verification code"}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleConfirmVerification} noValidate>
            {infoMessage && (
              <p className="muted" role="status" style={{ fontSize: 13, margin: "4px 0 12px" }}>
                {infoMessage}
              </p>
            )}

            <label htmlFor="verify-otp" style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
              6-digit verification code
            </label>
            <input
              id="verify-otp"
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
                width: "100%",
                boxSizing: "border-box",
              }}
            />

            {error && (
              <p className="error" role="alert" style={{ marginTop: 8 }}>
                {error}
              </p>
            )}

            <div className="row" style={{ marginTop: 16, justifyContent: "space-between" }}>
              <button type="button" className="secondary" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button disabled={busy || otp.length !== 6}>
                {busy ? "Verifying…" : "Verify and proceed"}
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
                  onClick={handleResendCode}
                  disabled={busy}
                  style={{ fontSize: 12, padding: "4px 8px" }}
                >
                  Resend code
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
