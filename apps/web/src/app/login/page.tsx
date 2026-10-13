"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next") ?? "/ride";
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [role, setRole] = useState<"customer" | "admin" | "staff">(next.startsWith("/admin") ? "admin" : "customer");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [devCode, setDevCode] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function call(url: string, body: unknown) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message ?? "Something went wrong");
      return data;
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      if (step === "phone") {
        const data = await call("/api/auth/otp", { phone });
        setPhone(data.phone);
        setDevCode(data.devCode);
        setStep("code");
      } else {
        await call("/api/auth/verify", { phone, code, role });
        router.push(role === "customer" ? next : "/admin");
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <main style={{ maxWidth: 420 }}>
      <h1>Log in</h1>
      <form className="card" onSubmit={submit}>
        {step === "phone" ? (
          <>
            <label htmlFor="phone">Phone number</label>
            <input id="phone" inputMode="tel" placeholder="09 11 22 33 44" value={phone}
              onChange={(e) => setPhone(e.target.value)} required />
            <label htmlFor="role">Log in as</label>
            <select id="role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="customer">Rider</option>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
          </>
        ) : (
          <>
            <label htmlFor="code">Code sent to {phone}</label>
            <input id="code" inputMode="numeric" maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value)} required autoFocus />
            {devCode && <p className="muted">Dev mode code: <b>{devCode}</b></p>}
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row" style={{ marginTop: 16 }}>
          <button disabled={busy}>{step === "phone" ? "Send code" : "Verify"}</button>
          {step === "code" && (
            <button type="button" className="secondary" onClick={() => setStep("phone")}>Change number</button>
          )}
        </div>
        <p className="muted" style={{ fontSize: 13 }}>Drivers use the Simple Ride Driver mobile app.</p>
      </form>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
