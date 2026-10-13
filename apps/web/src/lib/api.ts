"use client";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Browser → BFF → API. `path` is relative to /api/v1, e.g. "trips/estimate". */
export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/proxy/${path}`, {
    method: init?.method ?? (init?.body ? "POST" : "GET"),
    headers: { "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") window.location.href = "/login";
    throw new ApiError(res.status, data?.error?.code ?? "UNKNOWN", data?.error?.message ?? res.statusText);
  }
  return data as T;
}

/** santim → "265 ETB" */
export const birr = (santim: number) => `${(santim / 100).toLocaleString("en-US")} ETB`;
/** "265.5" (ETB typed by staff) → santim */
export const toSantim = (etb: string) => Math.round(Number(etb) * 100);
/** basis points → "10%" */
export const pct = (bps: number) => `${(bps / 100).toLocaleString("en-US")}%`;

export const DOC_LABEL: Record<string, string> = {
  license: "Driving licence", photo: "Photo", national_id: "National ID",
  vehicle_libre: "Ownership booklet (libre)", vehicle_insurance: "Insurance", vehicle_bolo: "Annual inspection (bolo)",
};
