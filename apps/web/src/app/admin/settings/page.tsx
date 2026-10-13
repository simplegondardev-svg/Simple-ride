"use client";

import { useEffect, useState } from "react";
import { api, birr, pct } from "@/lib/api";

interface Settings {
  overtimeCapBps: number; defaultCommissionBps: number; minDeposit: number;
  lowBalanceThreshold: number; lowBalanceWarning: number; refundAfterDays: number;
}

type Field = { key: keyof Settings; label: string; unit: "%" | "ETB" | "days"; help: string };
const FIELDS: Field[] = [
  { key: "defaultCommissionBps", label: "Default commission", unit: "%", help: "For drivers without a custom rate." },
  { key: "minDeposit", label: "Minimum deposit", unit: "ETB", help: "Smallest deposit a driver can make." },
  { key: "lowBalanceThreshold", label: "Low-balance block", unit: "ETB", help: "Below this, drivers finish the current trip but can't take new ones." },
  { key: "lowBalanceWarning", label: "Low-balance warning", unit: "ETB", help: "Below this, drivers are told to top up soon." },
  { key: "refundAfterDays", label: "Refund waiting period", unit: "days", help: "Days after approval before a deposit can be refunded." },
  { key: "overtimeCapBps", label: "Overtime cap", unit: "%", help: "Most a longer-than-quoted trip can add to the quote." },
];

const toInput = (f: Field, v: number) => String(f.unit === "%" ? v / 100 : f.unit === "ETB" ? v / 100 : v);
const fromInput = (f: Field, v: string) => Math.round(f.unit === "days" ? Number(v) : Number(v) * 100);
const show = (f: Field, v: number) => (f.unit === "%" ? pct(v) : f.unit === "ETB" ? birr(v) : `${v} days`);

export default function SettingsPage() {
  const [saved, setSaved] = useState<Settings>();
  const [form, setForm] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  useEffect(() => {
    api<Settings>("admin/settings").then((s) => {
      setSaved(s);
      setForm(Object.fromEntries(FIELDS.map((f) => [f.key, toInput(f, s[f.key])])));
    }).catch((e) => setMsg({ ok: false, text: e.message }));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const changed = Object.fromEntries(FIELDS
      .map((f) => [f.key, fromInput(f, form[f.key] ?? "")] as const)
      .filter(([k, v]) => saved && v !== saved[k]));
    if (Object.keys(changed).length === 0) return setMsg({ ok: true, text: "Nothing changed." });
    try {
      await api("admin/settings", { method: "PATCH", body: changed });
      setSaved({ ...saved!, ...changed });
      setMsg({ ok: true, text: "Saved. Applies to new trips and deposits from now on." });
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  }

  if (!saved) return msg ? <p className="error">{msg.text}</p> : <p className="muted">Loading…</p>;
  return (
    <div style={{ maxWidth: 560 }}>
      <h1>Business settings</h1>
      <form className="card" onSubmit={save}>
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label htmlFor={f.key}>{f.label} ({f.unit}) — now {show(f, saved[f.key])}</label>
            <input id={f.key} inputMode="decimal" value={form[f.key] ?? ""} required
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
            <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>{f.help}</p>
          </div>
        ))}
        {msg && <p className={msg.ok ? "muted" : "error"} role="status">{msg.text}</p>}
        <div style={{ marginTop: 16 }}><button>Save settings</button></div>
      </form>
    </div>
  );
}
