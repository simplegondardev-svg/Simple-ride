"use client";

import { useCallback, useEffect, useState } from "react";
import { api, birr } from "@/lib/api";

interface Stats { customers: number; drivers: number; pendingDrivers: number; driversOnline: number;
  activeTrips: number; tripsToday: number; openSos: number }
interface PendingDriver { id: string; phone: string; fullName: string | null; licenseNumber: string | null;
  vehicles: { id: string; plateNumber: string; make: string; model: string; categoryCode: string }[] }
interface TripRow { id: string; status: string; categoryCode: string; fareEstimate: number;
  pickupAddress: string | null; dropoffAddress: string | null; customerPhone: string; driverPhone: string | null;
  requestedAt: string }

export default function AdminPage() {
  const [stats, setStats] = useState<Stats>();
  const [pending, setPending] = useState<PendingDriver[]>([]);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [s, p, t] = await Promise.all([
        api<Stats>("admin/stats"),
        api<{ data: PendingDriver[] }>("admin/drivers/pending"),
        api<{ data: TripRow[] }>("admin/trips?limit=20"),
      ]);
      setStats(s); setPending(p.data); setTrips(t.data);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function review(driverId: string, decision: "approved" | "rejected", vehicleId?: string) {
    await api(`admin/drivers/${driverId}/review`, { body: { decision, vehicleId } });
    load();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const tiles: [keyof Stats, string][] = [
    ["activeTrips", "Active trips"], ["tripsToday", "Completed (24h)"], ["driversOnline", "Drivers online"],
    ["pendingDrivers", "Pending drivers"], ["customers", "Riders"], ["drivers", "Drivers"], ["openSos", "Open SOS"],
  ];

  return (
    <>
      <header className="top">
        <b>Simple Ride · Admin</b>
        <button className="secondary" onClick={logout}>Log out</button>
      </header>
      <main>
        {error && <p className="error">{error}</p>}
        <div className="grid">
          {tiles.map(([k, label]) => (
            <div key={k} className="card stat"><b>{stats?.[k] ?? "–"}</b><span>{label}</span></div>
          ))}
        </div>

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
                    <td className="row">
                      <button disabled={!d.vehicles[0] || !d.licenseNumber}
                        onClick={() => review(d.id, "approved", d.vehicles[0]?.id)}>Approve</button>
                      <button className="secondary" onClick={() => review(d.id, "rejected", d.vehicles[0]?.id)}>Reject</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

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
                  <td>{t.customerPhone}</td>
                  <td>{t.driverPhone ?? "—"}</td>
                  <td>{birr(t.fareEstimate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </>
  );
}
