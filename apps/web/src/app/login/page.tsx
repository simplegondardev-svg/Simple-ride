"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

type Role = "customer" | "staff" | "admin";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next") ?? "/ride";
  const [role, setRole] = useState<Role>(next.startsWith("/admin") ? "staff" : "customer");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [mustChange, setMustChange] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (mustChange && newPassword !== confirm) {
      setError("The new passwords don't match");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone, password, role, ...(mustChange && { newPassword }) }),
      });
      const data = await res.json();
      if (res.ok) {
        router.push(role === "customer" ? next : "/admin");
        return;
      }
      if (data?.error?.code === "PASSWORD_CHANGE_REQUIRED") {
        setMustChange(true);
        return;
      }
      setError(data?.error?.message ?? "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 420 }}>
      <h1>{mustChange ? "Choose your password" : "Log in"}</h1>
      <form className="card" onSubmit={submit}>
        {!mustChange ? (
          <>
            <label htmlFor="role">I am</label>
            <select id="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              <option value="customer">A rider</option>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
            <label htmlFor="phone">Phone number</label>
            <input id="phone" inputMode="tel" autoComplete="username" placeholder="09 11 22 33 44"
              value={phone} onChange={(e) => setPhone(e.target.value)} required />
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password"
              value={password} onChange={(e) => setPassword(e.target.value)} required />
          </>
        ) : (
          <>
            <p className="muted">You signed in with a temporary password. Choose your own to continue — at least 10 characters.</p>
            <label htmlFor="np">New password</label>
            <input id="np" type="password" autoComplete="new-password" minLength={10}
              value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required autoFocus />
            <label htmlFor="cp">Repeat new password</label>
            <input id="cp" type="password" autoComplete="new-password"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ marginTop: 16 }}>
          <button disabled={busy}>{mustChange ? "Save and continue" : "Log in"}</button>
        </div>
        {!mustChange && role === "customer" && (
          <p className="muted" style={{ fontSize: 13 }}>New here? <Link href="/register">Create an account</Link></p>
        )}
        {!mustChange && (
          <p className="muted" style={{ fontSize: 13 }}>
            Forgot your password? {role === "customer" ? "Call support" : "Ask an admin"} for a temporary one.
            Drivers use the Simple Ride Driver app.
          </p>
        )}
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
