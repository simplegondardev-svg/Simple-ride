"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMe } from "@/components/AdminShell";
import { api } from "@/lib/api";

interface Permission { code: string; category: string; description: string }
interface Staff { id: string; phone: string; fullName: string; status: string; permissions: string[] }

/** Admin-only: create staff and switch their permissions on and off. */
export default function StaffPage() {
  const { me } = useMe();
  const [catalog, setCatalog] = useState<Permission[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([
        api<{ data: Permission[] }>("admin/permissions"),
        api<{ data: Staff[] }>("admin/staff"),
      ]);
      setCatalog(c.data); setStaff(s.data);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => { if (me?.role === "admin") load(); }, [me, load]);

  const groups = useMemo(() => {
    const m = new Map<string, Permission[]>();
    for (const p of catalog) m.set(p.category, [...(m.get(p.category) ?? []), p]);
    return [...m.entries()];
  }, [catalog]);

  if (me?.role !== "admin") return <p className="muted">Only admins manage staff.</p>;

  return (
    <>
      <h1>Staff</h1>
      {error && <p className="error">{error}</p>}
      <NewStaff groups={groups} onCreated={load} />
      {staff.length === 0 && <p className="muted">No staff yet.</p>}
      {staff.map((s) => <StaffCard key={s.id} staff={s} groups={groups} onChanged={load} />)}
    </>
  );
}

function PermissionToggles(props: {
  groups: [string, Permission[]][];
  value: Set<string>;
  onToggle: (code: string) => void;
}) {
  return (
    <div className="perm-grid">
      {props.groups.map(([category, perms]) => (
        <fieldset key={category}>
          <legend>{category}</legend>
          {perms.map((p) => (
            <label key={p.code} className="toggle">
              <input type="checkbox" checked={props.value.has(p.code)} onChange={() => props.onToggle(p.code)} />
              <span>{p.description}</span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

const toggle = (set: Set<string>, code: string) => {
  const next = new Set(set);
  if (next.has(code)) next.delete(code); else next.add(code);
  return next;
};

function StaffCard({ staff, groups, onChanged }: { staff: Staff; groups: [string, Permission[]][]; onChanged: () => void }) {
  const [perms, setPerms] = useState(new Set(staff.permissions));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const dirty = perms.size !== staff.permissions.length || staff.permissions.some((p) => !perms.has(p));

  async function save() {
    setSaving(true); setMessage(undefined);
    try {
      await api(`admin/staff/${staff.id}/permissions`, { method: "PUT", body: { permissions: [...perms] } });
      setMessage("Saved. Applies on their next action.");
      onChanged();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(status: "active" | "suspended") {
    await api(`admin/users/${staff.id}/status`, { method: "PATCH", body: { status } });
    onChanged();
  }

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <b>{staff.fullName}</b> <span className="muted">{staff.phone}</span>
          {staff.status !== "active" && <span className="error"> · {staff.status}</span>}
        </div>
        <div className="row">
          <button className="secondary" onClick={() => setPerms(new Set(groups.flatMap(([, p]) => p.map((x) => x.code))))}>All</button>
          <button className="secondary" onClick={() => setPerms(new Set())}>None</button>
          {staff.status === "active"
            ? <button className="secondary" onClick={() => setStatus("suspended")}>Suspend</button>
            : <button className="secondary" onClick={() => setStatus("active")}>Reactivate</button>}
        </div>
      </div>
      <PermissionToggles groups={groups} value={perms} onToggle={(c) => setPerms(toggle(perms, c))} />
      <div className="row">
        <button disabled={!dirty || saving} onClick={save}>{saving ? "Saving…" : "Save permissions"}</button>
        {message && <span className="muted">{message}</span>}
      </div>
    </section>
  );
}

function NewStaff({ groups, onCreated }: { groups: [string, Permission[]][]; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [fullName, setFullName] = useState("");
  const [perms, setPerms] = useState(new Set<string>());
  const [error, setError] = useState<string>();

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await api("admin/staff", { body: { phone, fullName, permissions: [...perms] } });
      setOpen(false); setPhone(""); setFullName(""); setPerms(new Set());
      onCreated();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!open) return <button onClick={() => setOpen(true)}>Add staff member</button>;
  return (
    <form className="card" onSubmit={create}>
      <h2 style={{ marginTop: 0 }}>New staff member</h2>
      <div className="split-even">
        <div>
          <label htmlFor="sfn">Full name</label>
          <input id="sfn" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="sph">Phone</label>
          <input id="sph" inputMode="tel" placeholder="09 11 22 33 44" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        </div>
      </div>
      <p className="muted">They log in with this phone number and choose “Staff”. They can only do what you switch on.</p>
      <PermissionToggles groups={groups} value={perms} onToggle={(c) => setPerms(toggle(perms, c))} />
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button>Create</button>
        <button type="button" className="secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}
