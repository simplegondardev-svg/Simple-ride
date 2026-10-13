"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useMe } from "@/components/AdminShell";
import { api, birr, DOC_LABEL, pct, toSantim } from "@/lib/api";

interface Doc {
  id: string; docType: string; vehicleId: string | null; status: string; expiresOn: string | null;
  rejectReason: string | null; uploadedAt: string; submittedAt: string | null;
}
interface Requirement { docType: string; vehicleId: string | null; status: string; expiresOn: string | null }
interface Vehicle { id: string; plateNumber: string; make: string; model: string; color: string; categoryCode: string; status: string; isCurrent: boolean }
interface Refund { id: string; status: string; requestedAt: string; note: string | null; amount: number | null; reference: string | null; rejectReason: string | null }
interface Wallet { balance: number; threshold: number; minDeposit: number; canReceiveTrips: boolean; needsTopUp: boolean }
interface Driver {
  id: string; phone: string; fullName: string | null; approvalStatus: string; availability: string;
  suspendedReason: string | null; licenseNumber: string | null; commissionBps: number; customCommissionBps: number | null;
  approvedAt: string | null; refundEligibleFrom: string | null; ratingAvg: number; ratingCount: number;
  wallet: Wallet | null; vehicles: Vehicle[]; documents: Doc[]; required: Requirement[]; refunds: Refund[];
}

export default function DriverDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useMe();
  const [d, setD] = useState<Driver>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  const load = useCallback(() => api<Driver>(`admin/drivers/${id}`).then(setD).catch((e) => setMsg({ ok: false, text: e.message })), [id]);
  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(undefined);
    try {
      await fn();
      await load();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      const err = e as Error & { code?: string };
      setMsg({ ok: false, text: err.message });
    }
  }

  if (!d) return msg ? <p className="error">{msg.text}</p> : <p className="muted">Loading…</p>;
  const vehicle = d.vehicles.find((v) => v.isCurrent) ?? d.vehicles.at(-1);
  const missing = d.required.filter((r) => r.status !== "approved");

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1 style={{ marginBottom: 0 }}>{d.fullName ?? "Unnamed driver"}</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            {d.phone} · {d.approvalStatus}{d.suspendedReason && ` (${d.suspendedReason})`} · {d.availability}
            {d.ratingCount > 0 && ` · ★ ${Number(d.ratingAvg).toFixed(1)} (${d.ratingCount})`}
          </p>
        </div>
        {can("drivers.approve") && (
          <div className="row">
            <button disabled={missing.length > 0}
              title={missing.length ? "Approve the required documents first" : undefined}
              onClick={() => act(() => api(`admin/drivers/${d.id}/review`, { body: { decision: "approved", vehicleId: vehicle?.id } }),
                "Driver approved")}>
              {d.approvalStatus === "approved" ? "Re-approve" : "Approve driver"}
            </button>
            {d.approvalStatus === "approved" && (
              <button className="secondary" onClick={() => {
                const note = prompt("Reason for suspending?");
                if (note) act(() => api(`admin/drivers/${d.id}/review`, { body: { decision: "suspended", note } }), "Driver suspended");
              }}>Suspend</button>
            )}
          </div>
        )}
      </div>
      {msg && <p className={msg.ok ? "muted" : "error"} role="status">{msg.text}</p>}

      <h2>Required documents</h2>
      <div className="grid">
        {d.required.map((r) => (
          <div key={`${r.docType}${r.vehicleId}`} className="card stat">
            <span>{DOC_LABEL[r.docType] ?? r.docType}</span>
            <b className={r.status === "approved" ? undefined : "error"} style={{ fontSize: 18 }}>{r.status}</b>
            {r.expiresOn && <span>expires {r.expiresOn}</span>}
          </div>
        ))}
      </div>

      <h2>Documents</h2>
      <div className="card" style={{ overflowX: "auto" }}>
        {d.documents.length === 0 ? <p className="muted">Nothing uploaded yet.</p> : (
          <table>
            <thead><tr><th>Document</th><th>Status</th><th>Expires</th><th>Submitted</th><th /></tr></thead>
            <tbody>{d.documents.map((doc) => <DocRow key={doc.id} doc={doc} canReview={can("drivers.approve")} act={act} />)}</tbody>
          </table>
        )}
      </div>

      <h2>Vehicles</h2>
      <div className="card">
        {d.vehicles.length === 0 ? <p className="muted">No vehicle registered.</p> : d.vehicles.map((v) => (
          <p key={v.id} style={{ margin: "4px 0" }}>
            <b>{v.plateNumber}</b> · {v.color} {v.make} {v.model} · {v.categoryCode} · {v.status}{v.isCurrent && " · current"}
          </p>
        ))}
      </div>

      <div className="split-even" style={{ marginTop: 16 }}>
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Deposit</h2>
          {d.wallet ? (
            <>
              <p className="stat"><b>{birr(d.wallet.balance)}</b>
                <span>{d.wallet.canReceiveTrips ? "Can take trips" : `Blocked below ${birr(d.wallet.threshold)}`}
                  {d.wallet.needsTopUp && d.wallet.canReceiveTrips && " · running low"}</span></p>
              {can("finance.deposits.record") && <DepositForm driverId={d.id} minDeposit={d.wallet.minDeposit} act={act} />}
            </>
          ) : <p className="muted">You don't have permission to see wallets.</p>}
        </section>
        <section className="card">
          <h2 style={{ marginTop: 0 }}>Commission</h2>
          <p className="stat"><b>{pct(d.commissionBps)}</b>
            <span>{d.customCommissionBps == null ? "Default rate" : "Custom rate for this driver"}</span></p>
          {can("drivers.commission") && <CommissionForm driverId={d.id} current={d.customCommissionBps} act={act} />}
        </section>
      </div>

      <h2>Deposit refunds</h2>
      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          {d.refundEligibleFrom ? `Refundable from ${new Date(d.refundEligibleFrom).toLocaleDateString()}.` : "Not approved yet."}
        </p>
        {d.refunds.length === 0 ? <p className="muted">No requests.</p> : d.refunds.map((r) => (
          <p key={r.id} style={{ margin: "4px 0" }}>
            {new Date(r.requestedAt).toLocaleDateString()} · <b>{r.status}</b>
            {r.amount != null && ` · ${birr(r.amount)}`}{r.reference && ` · ${r.reference}`}
            {r.rejectReason && ` · ${r.rejectReason}`}{r.note && <span className="muted"> · “{r.note}”</span>}
          </p>
        ))}
      </div>
    </>
  );
}

type Act = (fn: () => Promise<unknown>, ok: string) => Promise<void>;

function DocRow({ doc, canReview, act }: { doc: Doc; canReview: boolean; act: Act }) {
  const [expiresOn, setExpiresOn] = useState(doc.expiresOn ?? "");
  const needsExpiry = ["license", "vehicle_insurance", "vehicle_bolo"].includes(doc.docType);

  async function view() {
    // Open the tab inside the click (browsers block window.open after an await), then point it at the signed URL.
    const tab = window.open("about:blank", "_blank");
    try {
      const { url } = await api<{ url: string }>(`admin/documents/${doc.id}/file`);
      if (tab) { tab.opener = null; tab.location.href = url; } else window.location.href = url;
    } catch (e) {
      tab?.close();
      alert((e as Error).message);
    }
  }

  return (
    <tr>
      <td>{DOC_LABEL[doc.docType] ?? doc.docType}</td>
      <td>{doc.status}{doc.rejectReason && <><br /><span className="muted">{doc.rejectReason}</span></>}</td>
      <td>
        {canReview && doc.status === "pending" && needsExpiry
          ? <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} aria-label="Expiry date" />
          : doc.expiresOn ?? "—"}
      </td>
      <td>{doc.submittedAt ? new Date(doc.submittedAt).toLocaleString() : "—"}</td>
      <td className="row">
        <button className="secondary" onClick={view}>View</button>
        {canReview && doc.status === "pending" && (
          <>
            <button onClick={() => act(() => api(`admin/documents/${doc.id}/review`,
              { body: { decision: "approved", ...(expiresOn && { expiresOn }) } }), "Document approved")}>Approve</button>
            <button className="secondary" onClick={() => {
              const reason = prompt("Why is it rejected? (the driver sees this)");
              if (reason) act(() => api(`admin/documents/${doc.id}/review`, { body: { decision: "rejected", reason } }), "Document rejected");
            }}>Reject</button>
          </>
        )}
      </td>
    </tr>
  );
}

function DepositForm({ driverId, minDeposit, act }: { driverId: string; minDeposit: number; act: Act }) {
  const [amount, setAmount] = useState(String(minDeposit / 100));
  const [reference, setReference] = useState("");
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      act(() => api(`admin/drivers/${driverId}/deposits`, { body: { amount: toSantim(amount), reference } }), "Deposit recorded");
      setReference("");
    }}>
      <label htmlFor="dep-amt">Amount received (ETB, minimum {birr(minDeposit)})</label>
      <input id="dep-amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      <label htmlFor="dep-ref">Receipt / slip number</label>
      <input id="dep-ref" value={reference} onChange={(e) => setReference(e.target.value)} required minLength={2} />
      <div style={{ marginTop: 12 }}><button>Record deposit</button></div>
    </form>
  );
}

function CommissionForm({ driverId, current, act }: { driverId: string; current: number | null; act: Act }) {
  const [value, setValue] = useState(current == null ? "" : String(current / 100));
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      const commissionBps = value.trim() === "" ? null : Math.round(Number(value) * 100);
      act(() => api(`admin/drivers/${driverId}/commission`, { method: "PUT", body: { commissionBps } }),
        commissionBps == null ? "Back to the default rate" : "Custom rate saved");
    }}>
      <label htmlFor="com">Custom commission % (empty = default)</label>
      <input id="com" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 8" />
      <div style={{ marginTop: 12 }}><button>Save rate</button></div>
    </form>
  );
}
