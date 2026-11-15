"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function CustomerNav({ userName }: { userName?: string | null }) {
  const path = usePathname();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <header className="top">
      <nav className="row" aria-label="Customer Navigation">
        <Link href="/ride" style={{ textDecoration: "none", color: "inherit", marginRight: 8 }}>
          <b>Simple Ride</b>
        </Link>
        <Link href="/ride" aria-current={path === "/ride" ? "page" : undefined}>
          Book a ride
        </Link>
        <Link href="/account" aria-current={path === "/account" ? "page" : undefined}>
          My Account
        </Link>
      </nav>
      <div className="row">
        {userName && <span className="muted" style={{ fontSize: 13 }}>{userName}</span>}
        <button className="secondary" onClick={logout}>
          Log out
        </button>
      </div>
    </header>
  );
}
