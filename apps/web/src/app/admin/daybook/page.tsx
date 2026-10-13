"use client";

import { useEffect, useState } from "react";
import { useMe } from "@/components/AdminShell";
import { api, birr } from "@/lib/api";

interface DayBook {
  date: string;
  trips: { paymentMethod: string; trips: number; gross: number; commission: number }[];
  ledger: { kind: string; entries: number; credits: number; debits: number }[];
  entries: { id: number; createdAt: string; kind: string; amount: number; balanceAfter: number;
             reference: string | null; phone: string; fullName: string | null; role: string }[];
}

const todayInAddis = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Addis_Ababa" }).format(new Date());
const KIND: Record<string, string> = {
  topup: "Top-up", trip_payment: "Trip payment", trip_earning: "Driver earning", commission: "Commission",
  payout: "Payout", refund: "Refund", bonus: "Bonus", adjustment: "Manual adjustment",
};

export default function DayBookPage() {
  const { can } = useMe();
  const [date, setDate] = useState(todayInAddis());
  const [book, setBook] = useState<DayBook>();
  const [error, setError] = useState<string>();
  const allowed = can("finance.daybook.view");

  useEffect(() => {
    if (!allowed) return;
    setError(undefined);
    api<DayBook>(`admin/finance/daybook?date=${date}`).then(setBook).catch((e) => setError(e.message));
  }, [date, allowed]);

  if (!allowed) return <p className="muted">You don't have permission to view the day book.</p>;

  const totals = book?.trips.reduce((a, t) => ({ trips: a.trips + t.trips, gross: a.gross + t.gross,
    commission: a.commission + t.commission }), { trips: 0, gross: 0, commission: 0 });

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>Day book</h1>
        <div>
          <label htmlFor="d">Date (Addis Ababa)</label>
          <input id="d" type="date" value={date} max={todayInAddis()} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      {book && (
        <>
          <div className="grid">
            <div className="card stat"><b>{totals!.trips}</b><span>Completed trips</span></div>
            <div className="card stat"><b>{birr(totals!.gross)}</b><span>Gross fares</span></div>
            <div className="card stat"><b>{birr(totals!.commission)}</b><span>Commission earned</span></div>
            <div className="card stat"><b>{book.entries.length}</b><span>Wallet entries</span></div>
          </div>

          <h2>Trips by payment method</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            {book.trips.length === 0 ? <p className="muted">No completed trips.</p> : (
              <table>
                <thead><tr><th>Method</th><th>Trips</th><th>Gross</th><th>Commission</th></tr></thead>
                <tbody>{book.trips.map((t) => (
                  <tr key={t.paymentMethod}><td>{t.paymentMethod}</td><td>{t.trips}</td>
                    <td>{birr(t.gross)}</td><td>{birr(t.commission)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>

          <h2>Wallet movements by type</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            {book.ledger.length === 0 ? <p className="muted">No wallet movements.</p> : (
              <table>
                <thead><tr><th>Type</th><th>Entries</th><th>In</th><th>Out</th></tr></thead>
                <tbody>{book.ledger.map((l) => (
                  <tr key={l.kind}><td>{KIND[l.kind] ?? l.kind}</td><td>{l.entries}</td>
                    <td>{birr(l.credits)}</td><td>{birr(l.debits)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>

          <h2>All entries</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            {book.entries.length === 0 ? <p className="muted">Nothing recorded.</p> : (
              <table>
                <thead><tr><th>Time</th><th>Who</th><th>Type</th><th>Amount</th><th>Balance after</th><th>Note</th></tr></thead>
                <tbody>{book.entries.map((e) => (
                  <tr key={e.id}>
                    <td>{new Date(e.createdAt).toLocaleTimeString("en-GB", { timeZone: "Africa/Addis_Ababa" })}</td>
                    <td>{e.fullName ?? e.phone}<br /><span className="muted">{e.role}</span></td>
                    <td>{KIND[e.kind] ?? e.kind}</td>
                    <td style={{ color: e.amount < 0 ? "var(--danger)" : undefined }}>{e.amount < 0 ? "−" : "+"}{birr(Math.abs(e.amount))}</td>
                    <td>{birr(e.balanceAfter)}</td>
                    <td>{e.reference ?? ""}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>
      )}
    </>
  );
}
