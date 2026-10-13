import Link from "next/link";

export default function Home() {
  return (
    <main>
      <h1>Simple Ride</h1>
      <p className="muted">Book a ride anywhere in Addis Ababa. Pay with cash, telebirr or your wallet.</p>
      <div className="row">
        <Link className="btn" href="/ride">Book a ride</Link>
        <Link href="/admin">Admin dashboard</Link>
      </div>
    </main>
  );
}
