"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, birr } from "@/lib/api";

interface Refund {
  id: string; driverId: string; status: string; requestedAt: string; note: string | null; amount: number | null;
  reference: string | null; rejectReason: string | null; phone: string; fullName: string | null; balance: number | null;
}

/** Deposit refund requests. Paying sends out the driver's whole remaining balance. */
export default function RefundsPage() {
  const [status, setStatus] = useState("pending");
  const [rows, setRows] = useState<Refund[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const load = useCallback(() =>
    api<{ data: Refund[] }>(`admin/refunds?${status ? `status=${status}` : ""}`).then((r) => setRows(r.data))
      .catch((e) => setMsg({ ok: false, text: e.message })), [status]);
  useEffect(() => { load(); }, [load]);

  async function pay(r: Refund) {
    const reference = prompt(`Pay ${birr(r.balance ?? 0)} to ${r.fullName ?? r.phone}.\nPayment reference (receipt, bank or telebirr):`);
    if (!reference) return;
    try {
      const done = await api<Refund>(`admin/refunds/${r.id}/pay`, { body: { reference } });
      setMsg({ ok: true, text: `Paid ${birr(done.amount ?? 0)}. The driver is offline until they deposit again.` });
      load();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }

  async function reject(r: Refund) {
    const reason = prompt("Why is the refund rejected? (the driver sees this)");
    if (!reason) return;
    try {
      await api(`admin/refunds/${r.id}/reject`, { body: { reason } });
      setMsg({ ok: true, text: "Refund rejected" });
      load();
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  }

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Deposit refunds</h1>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: "auto" }} aria-label="Status">
          <option value="pending">Pending</option><option value="paid">Paid</option>
          <option value="rejected">Rejected</option><option value="cancelled">Cancelled</option><option value="">All</option>
        </select>
      </div>
      {msg && <p className={msg.ok ? "muted" : "error"} role="status">{msg.text}</p>}
      <div className="card" style={{ overflowX: "auto" }}>
        {rows.length === 0 ? <p className="muted">No requests.</p> : (
          <table>
            <thead><tr><th>Requested</th><th>Driver</th><th>Note</th><th>Balance now</th><th>Status</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.requestedAt).toLocaleString()}</td>
                <td><Link href={`/admin/drivers/${r.driverId}`}>{r.fullName ?? r.phone}</Link><br /><span className="muted">{r.phone}</span></td>
                <td>{r.note ?? "—"}</td>
                <td>{r.balance == null ? "—" : birr(r.balance)}</td>
                <td>{r.status}{r.amount != null && <><br /><span className="muted">{birr(r.amount)} · {r.reference}</span></>}
                  {r.rejectReason && <><br /><span className="muted">{r.rejectReason}</span></>}</td>
                <td className="row">{r.status === "pending" && (
                  <><button onClick={() => pay(r)}>Pay out</button>
                    <button className="secondary" onClick={() => reject(r)}>Reject</button></>
                )}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </>
  );
}
