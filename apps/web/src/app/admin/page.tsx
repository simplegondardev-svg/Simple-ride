"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useMe } from "@/components/AdminShell";
import { api, birr } from "@/lib/api";

interface Stats { customers: number; drivers: number; pendingDrivers: number; driversOnline: number;
  activeTrips: number; tripsToday: number; openSos: number;
  documentsToReview: number; documentsExpiring: number; pendingRefunds: number }
interface PendingDriver { id: string; phone: string; fullName: string | null; licenseNumber: string | null;
  vehicles: { id: string; plateNumber: string; make: string; model: string; categoryCode: string }[] }
interface TripRow { id: string; status: string; categoryCode: string; fareEstimate: number;
  pickupAddress: string | null; dropoffAddress: string | null; customerPhone: string | null; driverPhone: string | null;
  requestedAt: string }

export default function AdminOverview() {
  const { me, can } = useMe();
  const [stats, setStats] = useState<Stats>();
  const [pending, setPending] = useState<PendingDriver[]>([]);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [error, setError] = useState<string>();

  const showStats = can("dashboard.view");
  const showDrivers = can("drivers.view", "drivers.approve");
  const showTrips = can("trips.view");

  const load = useCallback(async () => {
    try {
      // Only request what this user may see; the API would refuse the rest.
      const [s, p, t] = await Promise.all([
        showStats ? api<Stats>("admin/stats") : undefined,
        showDrivers ? api<{ data: PendingDriver[] }>("admin/drivers/pending") : undefined,
        showTrips ? api<{ data: TripRow[] }>("admin/trips?limit=20") : undefined,
      ]);
      setStats(s); setPending(p?.data ?? []); setTrips(t?.data ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [showStats, showDrivers, showTrips]);

  useEffect(() => { load(); }, [load]);

  const tiles: [keyof Stats, string][] = [
    ["activeTrips", "Active trips"], ["tripsToday", "Completed (24h)"], ["driversOnline", "Drivers online"],
    ["pendingDrivers", "Pending drivers"], ["documentsToReview", "Documents to review"], ["documentsExpiring", "Documents expiring (30d)"],
    ["pendingRefunds", "Refund requests"], ["customers", "Riders"], ["drivers", "Drivers"], ["openSos", "Open SOS"],
  ];

  if (me && !showStats && !showDrivers && !showTrips) {
    return <p className="muted">Your account has no overview permissions. Use the menu above, or ask an admin for access.</p>;
  }

  return (
    <>
      {error && <p className="error">{error}</p>}
      {showStats && (
        <div className="grid">
          {tiles.map(([k, label]) => (
            <div key={k} className="card stat"><b>{stats?.[k] ?? "–"}</b><span>{label}</span></div>
          ))}
        </div>
      )}

      {showDrivers && (
        <>
          <h2>Driver approvals</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            {pending.length === 0 ? <p className="muted">No drivers waiting.</p> : (
              <table>
                <thead><tr><th>Driver</th><th>License</th><th>Vehicle</th><th /></tr></thead>
                <tbody>
                  {pending.map((d) => (
                    <tr key={d.id}>
                      <td>{d.fullName ?? "—"}<br /><span className="muted">{d.phone}</span></td>
                      <td>{d.licenseNumber ?? <span className="muted">not submitted</span>}</td>
                      <td>{d.vehicles[0] ? `${d.vehicles[0].plateNumber} · ${d.vehicles[0].make} ${d.vehicles[0].model} (${d.vehicles[0].categoryCode})`
                        : <span className="muted">none</span>}</td>
                      <td><Link className="btn" href={`/admin/drivers/${d.id}`}>Review</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}

      {showTrips && (
        <>
          <h2>Recent trips</h2>
          <div className="card" style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Requested</th><th>Status</th><th>Route</th><th>Rider</th><th>Driver</th><th>Fare</th></tr></thead>
              <tbody>
                {trips.map((t) => (
                  <tr key={t.id}>
                    <td>{new Date(t.requestedAt).toLocaleString()}</td>
                    <td>{t.status}</td>
                    <td>{t.pickupAddress ?? "pin"} → {t.dropoffAddress ?? "pin"}</td>
                    <td>{t.customerPhone ?? "—"}</td>
                    <td>{t.driverPhone ?? "—"}</td>
                    <td>{birr(t.fareEstimate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
