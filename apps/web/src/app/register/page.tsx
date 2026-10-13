"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function RegisterPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (password !== confirm) return setError("The passwords don't match");
    setBusy(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fullName, phone, password, role: "customer" }),
      });
      const data = await res.json();
      if (!res.ok) return setError(data?.error?.message ?? "Something went wrong");
      router.push("/ride");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 420 }}>
      <h1>Create your account</h1>
      <form className="card" onSubmit={submit}>
        <label htmlFor="name">Full name</label>
        <input id="name" autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required minLength={2} />
        <label htmlFor="phone">Phone number</label>
        <input id="phone" inputMode="tel" autoComplete="username" placeholder="09 11 22 33 44"
          value={phone} onChange={(e) => setPhone(e.target.value)} required />
        <label htmlFor="pw">Password (at least 10 characters)</label>
        <input id="pw" type="password" autoComplete="new-password" minLength={10}
          value={password} onChange={(e) => setPassword(e.target.value)} required />
        <label htmlFor="pw2">Repeat password</label>
        <input id="pw2" type="password" autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ marginTop: 16 }}>
          <button disabled={busy}>Create account</button>
        </div>
        <p className="muted" style={{ fontSize: 13 }}>Already have an account? <Link href="/login">Log in</Link></p>
      </form>
    </main>
  );
}
