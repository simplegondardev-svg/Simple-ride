"use client";

import { useState } from "react";

export default function AccountPage() {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) return setMessage({ ok: false, text: "The new passwords don't match" });
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json();
    if (!res.ok) return setMessage({ ok: false, text: data?.error?.message ?? "Something went wrong" });
    setCurrent(""); setNew(""); setConfirm("");
    setMessage({ ok: true, text: "Password changed. You've been signed out on every other device." });
  }

  return (
    <div style={{ maxWidth: 420 }}>
      <h1>Change password</h1>
      <form className="card" onSubmit={submit}>
        <label htmlFor="cur">Current password</label>
        <input id="cur" type="password" autoComplete="current-password" value={currentPassword}
          onChange={(e) => setCurrent(e.target.value)} required />
        <label htmlFor="new">New password (at least 10 characters)</label>
        <input id="new" type="password" autoComplete="new-password" minLength={10} value={newPassword}
          onChange={(e) => setNew(e.target.value)} required />
        <label htmlFor="rep">Repeat new password</label>
        <input id="rep" type="password" autoComplete="new-password" value={confirm}
          onChange={(e) => setConfirm(e.target.value)} required />
        {message && <p className={message.ok ? "muted" : "error"} role="status">{message.text}</p>}
        <div style={{ marginTop: 16 }}><button>Change password</button></div>
      </form>
    </div>
  );
}
