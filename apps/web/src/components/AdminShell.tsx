"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState } from "react";
import { api } from "@/lib/api";

export interface Me { role: "admin" | "staff"; permissions: string[] }

const MeContext = createContext<Me | null>(null);

/** Current back-office user. `can()` mirrors the API's permission check. */
export function useMe() {
  const me = useContext(MeContext);
  return {
    me,
    can: (...perms: string[]) => !!me && (me.role === "admin" || perms.some((p) => me.permissions.includes(p))),
  };
}

const NAV: { href: string; label: string; show: (me: Me) => boolean }[] = [
  { href: "/admin", label: "Overview", show: () => true },
  { href: "/admin/daybook", label: "Day book",
    show: (me) => me.role === "admin" || me.permissions.includes("finance.daybook.view") },
  { href: "/admin/staff", label: "Staff", show: (me) => me.role === "admin" },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string>();
  const path = usePathname();

  useEffect(() => {
    api<Me>("admin/me").then(setMe).catch((e) => setError(e.message));
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <MeContext.Provider value={me}>
      <header className="top">
        <nav className="row">
          <b>Simple Ride · {me?.role === "staff" ? "Staff" : "Admin"}</b>
          {me && NAV.filter((n) => n.show(me)).map((n) => (
            <Link key={n.href} href={n.href} aria-current={path === n.href ? "page" : undefined}>{n.label}</Link>
          ))}
        </nav>
        <button className="secondary" onClick={logout}>Log out</button>
      </header>
      <main>
        {error && <p className="error">{error}</p>}
        {me ? children : !error && <p className="muted">Loading…</p>}
      </main>
    </MeContext.Provider>
  );
}
