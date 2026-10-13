"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, birr } from "@/lib/api";

interface DriverRow {
  id: string; phone: string; fullName: string | null; approvalStatus: string; availability: string;
  suspendedReason: string | null; balance: number | null; documentsToReview: number; appliedAt: string;
}

const STATUSES = ["", "pending", "approved", "suspended", "rejected"] as const;

export default function DriversPage() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("pending");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<DriverRow[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const q = new URLSearchParams({ ...(status && { status }), ...(search.length >= 3 && { search }) });
    api<{ data: DriverRow[] }>(`admin/drivers?${q}`).then((r) => setRows(r.data)).catch((e) => setError(e.message));
  }, [status, search]);

  return (
    <>
      <h1>Drivers</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} style={{ width: "auto" }}
          aria-label="Status">
          {STATUSES.map((s) => <option key={s} value={s}>{s ? s[0]!.toUpperCase() + s.slice(1) : "All"}</option>)}
        </select>
        <input placeholder="Search phone or name" value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 280 }} aria-label="Search" />
      </div>
      {error && <p className="error">{error}</p>}
      <div className="card" style={{ overflowX: "auto" }}>
        {rows.length === 0 ? <p className="muted">No drivers.</p> : (
          <table>
            <thead><tr><th>Driver</th><th>Status</th><th>Documents to review</th><th>Deposit</th><th>Online</th><th /></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>{d.fullName ?? "—"}<br /><span className="muted">{d.phone}</span></td>
                  <td>{d.approvalStatus}{d.suspendedReason && <><br /><span className="muted">{d.suspendedReason}</span></>}</td>
                  <td>{d.documentsToReview > 0 ? <b>{d.documentsToReview}</b> : <span className="muted">0</span>}</td>
                  <td>{d.balance == null ? "—" : birr(d.balance)}</td>
                  <td>{d.availability}</td>
                  <td><Link className="btn" href={`/admin/drivers/${d.id}`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
