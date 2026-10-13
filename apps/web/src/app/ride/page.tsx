"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { api, birr } from "@/lib/api";
import type { LatLng } from "@/components/Map";

const RideMap = dynamic(() => import("@/components/Map").then((m) => m.RideMap), { ssr: false });

interface Option { categoryCode: string; name: string; seats: number; fare: number; driversNearby: boolean }
interface Estimate { distanceM: number; durationS: number; path: [number, number][]; options: Option[] }
interface Trip {
  id: string; status: string; fareEstimate: number; ridePin?: string;
  driver?: { fullName: string | null; phone: string; rating: number;
             vehicle: { plateNumber: string; make: string; model: string; color: string } } | null;
}

const ACTIVE = ["searching", "accepted", "arrived", "in_progress"];
const LABEL: Record<string, string> = {
  searching: "Finding you a driver…", accepted: "Driver is on the way", arrived: "Your driver has arrived",
  in_progress: "On the way to your destination", completed: "Trip completed", cancelled: "Trip cancelled",
  expired: "No drivers available right now",
};

export default function RidePage() {
  const [pickup, setPickup] = useState<LatLng>();
  const [dropoff, setDropoff] = useState<LatLng>();
  const [estimate, setEstimate] = useState<Estimate>();
  const [choice, setChoice] = useState<string>();
  const [payment, setPayment] = useState<"cash" | "telebirr" | "wallet">("cash");
  const [trip, setTrip] = useState<Trip>();
  const [error, setError] = useState<string>();

  function pick(p: LatLng) {
    if (trip && ACTIVE.includes(trip.status)) return;
    if (!pickup || dropoff) {
      setPickup(p); setDropoff(undefined); setEstimate(undefined); setTrip(undefined);
    } else setDropoff(p);
  }

  useEffect(() => {
    if (!pickup || !dropoff) return;
    setError(undefined);
    api<Estimate>("trips/estimate", { body: { pickup, dropoff } })
      .then((e) => { setEstimate(e); setChoice(e.options[0]?.categoryCode); })
      .catch((e) => setError(e.message));
  }, [pickup, dropoff]);

  // Web riders poll; the Flutter apps use the socket + push for this.
  useEffect(() => {
    if (!trip || !ACTIVE.includes(trip.status)) return;
    const t = setInterval(() => api<Trip>(`trips/${trip.id}`).then(setTrip).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [trip?.id, trip?.status]);

  async function book() {
    if (!pickup || !dropoff || !choice) return;
    setError(undefined);
    try {
      const created = await api<Trip>("trips", {
        body: { clientRequestId: crypto.randomUUID(), categoryCode: choice, paymentMethod: payment, pickup, dropoff },
      });
      setTrip(created);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function cancel() {
    if (trip) setTrip(await api<Trip>(`trips/${trip.id}/cancel`, { body: { reason: "Changed my mind" } }));
  }

  return (
    <main>
      <h1>Book a ride</h1>
      <div className="split">
        <RideMap pickup={pickup} dropoff={dropoff} path={estimate?.path} onPick={pick} />
        <div className="card">
          {!pickup && <p>Tap the map to set your <b>pickup</b>.</p>}
          {pickup && !dropoff && <p>Now tap your <b>destination</b>.</p>}
          {estimate && !trip && (
            <>
              <p className="muted">
                {(estimate.distanceM / 1000).toFixed(1)} km · ~{Math.round(estimate.durationS / 60)} min
              </p>
              {estimate.options.map((o) => (
                <button key={o.categoryCode} className="option" aria-pressed={choice === o.categoryCode}
                  onClick={() => setChoice(o.categoryCode)}>
                  <span>{o.name} · {o.seats} seats{!o.driversNearby && <span className="muted"> · none nearby</span>}</span>
                  <b>{birr(o.fare)}</b>
                </button>
              ))}
              <label htmlFor="pay">Payment</label>
              <select id="pay" value={payment} onChange={(e) => setPayment(e.target.value as typeof payment)}>
                <option value="cash">Cash</option>
                <option value="wallet">Wallet</option>
                <option value="telebirr" disabled>telebirr (coming soon)</option>
              </select>
              <div style={{ marginTop: 16 }}><button onClick={book}>Request ride</button></div>
            </>
          )}
          {trip && (
            <>
              <h2>{LABEL[trip.status] ?? trip.status}</h2>
              <p>Fare: <b>{birr(trip.fareEstimate)}</b></p>
              {trip.ridePin && ACTIVE.includes(trip.status) && <p>Ride PIN: <b>{trip.ridePin}</b> — tell your driver</p>}
              {trip.driver && (
                <p>
                  {trip.driver.fullName ?? "Your driver"} · ★ {Number(trip.driver.rating).toFixed(1)}<br />
                  {trip.driver.vehicle.color} {trip.driver.vehicle.make} {trip.driver.vehicle.model} ·{" "}
                  <b>{trip.driver.vehicle.plateNumber}</b><br />
                  <a href={`tel:${trip.driver.phone}`}>Call driver</a>
                </p>
              )}
              {["searching", "accepted", "arrived"].includes(trip.status) && (
                <button className="secondary" onClick={cancel}>Cancel trip</button>
              )}
            </>
          )}
          {error && <p className="error">{error}</p>}
        </div>
      </div>
    </main>
  );
}
