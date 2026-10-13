import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { SYSTEM, withContext } from "../src/db/context.js";
import { pool } from "../src/db/pool.js";
import { redis } from "../src/lib/redis.js";
import { sweepTrips } from "../src/modules/trips/service.js";
import {
  BOLE, fundDriver, grant, makeBackoffice, PASSWORD, PIASSA, PNG, randomPhone, uploadDocument, uploadRequiredDocuments,
} from "./helpers.js";

const app = createApp();
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (path: string) => `/api/v1${path}`;

async function register(role: "customer" | "driver") {
  return (await request(app).post(api("/auth/register"))
    .send({ phone: randomPhone(), password: PASSWORD, role, platform: "android" }).expect(201)).body;
}
async function staffWith(permissions: string[]) {
  const s = await makeBackoffice("staff");
  await grant(s.id, permissions);
  const token = (await request(app).post(api("/auth/login"))
    .send({ phone: s.phone, password: PASSWORD, role: "staff", platform: "web" }).expect(200)).body.accessToken;
  return { ...s, token };
}

let admin: string;

/** Driver with a vehicle, all documents approved and the driver approved (no deposit yet). */
async function approvedDriver() {
  const d = await register("driver");
  const v = (await request(app).post(api("/drivers/me/vehicles")).set(bearer(d.accessToken))
    .send({ categoryCode: "economy", plateNumber: `P-${randomUUID().slice(0, 6)}`, make: "Toyota", model: "Vitz", color: "White" })
    .expect(201)).body;
  for (const id of await uploadRequiredDocuments(app, d.accessToken, v.id)) {
    await request(app).post(api(`/admin/documents/${id}/review`)).set(bearer(admin)).send({ decision: "approved" }).expect(200);
  }
  await request(app).post(api(`/admin/drivers/${d.user.id}/review`)).set(bearer(admin))
    .send({ decision: "approved", vehicleId: v.id }).expect(200);
  return { ...d, vehicleId: v.id };
}

beforeAll(async () => {
  const a = await makeBackoffice("admin");
  admin = (await request(app).post(api("/auth/login"))
    .send({ phone: a.phone, password: PASSWORD, role: "admin", platform: "web" }).expect(200)).body.accessToken;
});
beforeEach(async () => {
  await redis.flushdb();
  await withContext(SYSTEM, (db) =>
    db.query("UPDATE trips SET status = 'cancelled' WHERE status IN ('searching','accepted','arrived','in_progress')"));
});
afterAll(async () => {
  await pool.end();
  redis.disconnect();
});

describe("signed upload links (local storage)", () => {
  it("a tampered, expired or mismatched upload is refused", async () => {
    const d = await register("driver");
    const start = await request(app).post(api("/drivers/me/documents")).set(bearer(d.accessToken))
      .send({ docType: "photo", contentType: "image/png", sizeBytes: PNG.length }).expect(201);
    const url = new URL(start.body.upload.url);

    const tampered = new URL(url); tampered.searchParams.set("len", "99999999");
    expect((await request(app).put(tampered.pathname + tampered.search).set("Content-Type", "image/png").send(PNG)).body.error.code)
      .toBe("INVALID_SIGNATURE");
    const expired = new URL(url); expired.searchParams.set("exp", "1");
    expect((await request(app).put(expired.pathname + expired.search).set("Content-Type", "image/png").send(PNG)).status).toBe(403);
    const wrongType = await request(app).put(url.pathname + url.search).set("Content-Type", "image/jpeg").send(PNG);
    expect(wrongType.body.error.code).toBe("UPLOAD_MISMATCH");

    // Submitting before a successful upload fails.
    const early = await request(app).post(api(`/drivers/me/documents/${start.body.document.id}/submit`))
      .set(bearer(d.accessToken)).send({}).expect(409);
    expect(early.body.error.code).toBe("DOCUMENT_NOT_UPLOADED");
  });

  it("only allowed file types and sizes can even start", async () => {
    const d = await register("driver");
    await request(app).post(api("/drivers/me/documents")).set(bearer(d.accessToken))
      .send({ docType: "photo", contentType: "application/x-msdownload", sizeBytes: 100 }).expect(422);
    await request(app).post(api("/drivers/me/documents")).set(bearer(d.accessToken))
      .send({ docType: "photo", contentType: "image/png", sizeBytes: 20 * 1024 * 1024 }).expect(422);
    // Vehicle documents need a vehicle of the driver's own.
    await request(app).post(api("/drivers/me/documents")).set(bearer(d.accessToken))
      .send({ docType: "vehicle_bolo", vehicleId: randomUUID(), contentType: "image/png", sizeBytes: 10 }).expect(404);
  });
});

describe("documents and approval", () => {
  it("licence, insurance and bolo need an expiry date; reviewers see the file", async () => {
    const d = await register("driver");
    const start = await request(app).post(api("/drivers/me/documents")).set(bearer(d.accessToken))
      .send({ docType: "license", contentType: "image/png", sizeBytes: PNG.length }).expect(201);
    const url = new URL(start.body.upload.url);
    await request(app).put(url.pathname + url.search).set("Content-Type", "image/png").send(PNG).expect(200);
    await request(app).post(api(`/drivers/me/documents/${start.body.document.id}/submit`))
      .set(bearer(d.accessToken)).send({}).expect(422);
    await request(app).post(api(`/drivers/me/documents/${start.body.document.id}/submit`))
      .set(bearer(d.accessToken)).send({ expiresOn: "2031-05-01" }).expect(200);

    const link = await request(app).get(api(`/admin/documents/${start.body.document.id}/file`)).set(bearer(admin)).expect(200);
    const file = new URL(link.body.url);
    const got = await request(app).get(file.pathname + file.search).expect(200);
    expect(Buffer.compare(got.body, PNG)).toBe(0);
  });

  it("rejection needs a reason and is shown to the driver; a re-upload can be approved", async () => {
    const d = await register("driver");
    const first = await uploadDocument(app, d.accessToken, "photo");
    await request(app).post(api(`/admin/documents/${first}/review`)).set(bearer(admin)).send({ decision: "rejected" }).expect(422);
    await request(app).post(api(`/admin/documents/${first}/review`)).set(bearer(admin))
      .send({ decision: "rejected", reason: "Face not visible" }).expect(200);
    const mine = await request(app).get(api("/drivers/me/documents")).set(bearer(d.accessToken)).expect(200);
    expect(mine.body.documents[0]).toMatchObject({ status: "rejected", rejectReason: "Face not visible" });
    expect(mine.body.required.find((r: any) => r.docType === "photo").status).toBe("rejected");

    const second = await uploadDocument(app, d.accessToken, "photo");
    await request(app).post(api(`/admin/documents/${second}/review`)).set(bearer(admin)).send({ decision: "approved" }).expect(200);
    const after = await request(app).get(api("/drivers/me/documents")).set(bearer(d.accessToken)).expect(200);
    expect(after.body.required.find((r: any) => r.docType === "photo").status).toBe("approved");
  });

  it("a driver can't approve their own document, and other drivers can't see it", async () => {
    const d = await register("driver");
    const other = await register("driver");
    const docId = await uploadDocument(app, d.accessToken, "photo");
    await expect(withContext({ userId: d.user.id, role: "driver" }, (db) =>
      db.query("UPDATE driver_documents SET status = 'approved' WHERE id = $1", [docId])))
      .rejects.toMatchObject({ code: "42501" });
    const { rowCount } = await withContext({ userId: other.user.id, role: "driver" }, (db) =>
      db.query("SELECT 1 FROM driver_documents WHERE id = $1", [docId]));
    expect(rowCount).toBe(0);
    const finance = await staffWith(["finance.daybook.view"]);
    await request(app).get(api(`/admin/documents/${docId}/file`)).set(bearer(finance.token)).expect(403);
  });

  it("expired documents can't be approved", async () => {
    const d = await register("driver");
    const id = await uploadDocument(app, d.accessToken, "license", { expiresOn: "2020-01-01" });
    const res = await request(app).post(api(`/admin/documents/${id}/review`)).set(bearer(admin)).send({ decision: "approved" }).expect(422);
    expect(res.body.error.code).toBe("DOCUMENT_EXPIRED");
  });
});

describe("prepaid deposit", () => {
  it("the minimum deposit is enforced, and only finance staff with the permission can record one", async () => {
    const d = await approvedDriver();
    const small = await request(app).post(api(`/admin/drivers/${d.user.id}/deposits`)).set(bearer(admin))
      .send({ amount: 500_000, reference: "R-1" }).expect(422);
    expect(small.body.error).toMatchObject({ code: "DEPOSIT_TOO_SMALL", details: { minDeposit: 1_000_000 } });

    const viewer = await staffWith(["finance.daybook.view"]);
    await request(app).post(api(`/admin/drivers/${d.user.id}/deposits`)).set(bearer(viewer.token))
      .send({ amount: 1_000_000, reference: "R-2" }).expect(403);

    const cashier = await staffWith(["finance.deposits.record"]);
    const ok = await request(app).post(api(`/admin/drivers/${d.user.id}/deposits`)).set(bearer(cashier.token))
      .send({ amount: 1_000_000, reference: "R-3" }).expect(201);
    expect(ok.body).toMatchObject({ balance: 1_000_000, canReceiveTrips: true });

    const book = await request(app).get(api("/admin/finance/daybook")).set(bearer(admin)).expect(200);
    expect(book.body.entries.some((e: any) => e.kind === "deposit" && e.reference === "R-3")).toBe(true);
  });

  it("drivers can't credit their own wallet", async () => {
    const d = await approvedDriver();
    await expect(withContext({ userId: d.user.id, role: "driver" }, (db) =>
      db.query("UPDATE wallets SET balance = 99999999 WHERE user_id = $1", [d.user.id])))
      .resolves.toMatchObject({ rowCount: 0 });
  });

  it("below the threshold after a trip: finish it, then offline and no more offers until a deposit", async () => {
    const d = await approvedDriver();
    // Just above the 200 ETB threshold: one trip's commission takes it below.
    await fundDriver(d.user.id, 20_500);
    await request(app).post(api("/drivers/me/online")).set(bearer(d.accessToken))
      .send({ location: { lat: BOLE.lat + 0.002, lng: BOLE.lng } }).expect(200);
    const rider = await register("customer");
    const trip = (await request(app).post(api("/trips")).set(bearer(rider.accessToken)).send({
      clientRequestId: randomUUID(), categoryCode: "economy", pickup: BOLE, dropoff: PIASSA,
    }).expect(201)).body;
    for (const [step, body] of [["accept"], ["arrive"], ["start", { ridePin: trip.ridePin }], ["complete"]] as [string, any][]) {
      await request(app).post(api(`/trips/${trip.id}/${step}`)).set(bearer(d.accessToken)).send(body ?? {}).expect(200);
    }
    const me = await request(app).get(api("/drivers/me")).set(bearer(d.accessToken)).expect(200);
    expect(me.body.availability).toBe("offline");
    expect(me.body.wallet).toMatchObject({ canReceiveTrips: false, needsTopUp: true });

    const back = await request(app).post(api("/drivers/me/online")).set(bearer(d.accessToken))
      .send({ location: BOLE }).expect(402);
    expect(back.body.error.code).toBe("DEPOSIT_REQUIRED");
    const next = (await request(app).post(api("/trips")).set(bearer(rider.accessToken)).send({
      clientRequestId: randomUUID(), categoryCode: "economy", pickup: BOLE, dropoff: PIASSA,
    }).expect(201)).body;
    const offers = await request(app).get(api("/drivers/me/offers")).set(bearer(d.accessToken)).expect(200);
    expect(offers.body.data.map((o: any) => o.tripId)).not.toContain(next.id);
  });
});

describe("custom commission", () => {
  it("applies at completion; only staff with drivers.commission can set it", async () => {
    const d = await approvedDriver();
    await fundDriver(d.user.id);
    await expect(withContext({ userId: d.user.id, role: "driver" }, (db) =>
      db.query("UPDATE driver_profiles SET commission_bps = 0 WHERE user_id = $1", [d.user.id])))
      .rejects.toMatchObject({ code: "42501" });
    const approver = await staffWith(["drivers.approve"]);
    await request(app).put(api(`/admin/drivers/${d.user.id}/commission`)).set(bearer(approver.token))
      .send({ commissionBps: 0 }).expect(403);

    const manager = await staffWith(["drivers.commission"]);
    await request(app).put(api(`/admin/drivers/${d.user.id}/commission`)).set(bearer(manager.token))
      .send({ commissionBps: 500 }).expect(200);

    await request(app).post(api("/drivers/me/online")).set(bearer(d.accessToken))
      .send({ location: { lat: BOLE.lat + 0.002, lng: BOLE.lng } }).expect(200);
    const rider = await register("customer");
    const trip = (await request(app).post(api("/trips")).set(bearer(rider.accessToken)).send({
      clientRequestId: randomUUID(), categoryCode: "economy", pickup: BOLE, dropoff: PIASSA,
    }).expect(201)).body;
    for (const [step, body] of [["accept"], ["arrive"], ["start", { ridePin: trip.ridePin }], ["complete"]] as [string, any][]) {
      await request(app).post(api(`/trips/${trip.id}/${step}`)).set(bearer(d.accessToken)).send(body ?? {}).expect(200);
    }
    const { rows: [t] } = await withContext(SYSTEM, (db) =>
      db.query("SELECT final_fare, commission_amount FROM trips WHERE id = $1", [trip.id]));
    expect(t.commission_amount).toBe(Math.round(t.final_fare * 0.05));
  });
});

describe("deposit refunds", () => {
  it("not before 3 months; then request → finance pays the whole balance → day book payout, driver offline", async () => {
    const d = await approvedDriver();
    await fundDriver(d.user.id, 1_500_000);
    const early = await request(app).post(api("/drivers/me/refunds")).set(bearer(d.accessToken)).send({}).expect(422);
    expect(early.body.error.code).toBe("REFUND_NOT_ELIGIBLE");
    expect(early.body.error.details.refundAfterDays).toBe(90);

    await withContext(SYSTEM, (db) =>
      db.query("UPDATE driver_profiles SET approved_at = now() - interval '91 days' WHERE user_id = $1", [d.user.id]));
    const req = await request(app).post(api("/drivers/me/refunds")).set(bearer(d.accessToken))
      .send({ note: "telebirr 0911223344" }).expect(201);
    const dup = await request(app).post(api("/drivers/me/refunds")).set(bearer(d.accessToken)).send({}).expect(409);
    expect(dup.body.error.code).toBe("REFUND_ALREADY_REQUESTED");

    // Drivers can only cancel their own request, not mark it paid.
    await expect(withContext({ userId: d.user.id, role: "driver" }, (db) =>
      db.query("UPDATE deposit_refunds SET status = 'paid', amount = 1 WHERE id = $1", [req.body.id])))
      .rejects.toMatchObject({ code: "42501" });

    const finance = await staffWith(["finance.refunds.manage"]);
    const paid = await request(app).post(api(`/admin/refunds/${req.body.id}/pay`)).set(bearer(finance.token))
      .send({ reference: "TB-998877" }).expect(200);
    expect(paid.body).toMatchObject({ status: "paid", amount: 1_500_000, reference: "TB-998877" });

    const me = await request(app).get(api("/drivers/me")).set(bearer(d.accessToken)).expect(200);
    expect(me.body).toMatchObject({ availability: "offline", wallet: { balance: 0, canReceiveTrips: false } });
    const book = await request(app).get(api("/admin/finance/daybook")).set(bearer(admin)).expect(200);
    expect(book.body.entries.some((e: any) => e.kind === "payout" && e.amount === -1_500_000 && e.reference === "TB-998877")).toBe(true);
  });

  it("rejecting needs a reason; a driver with nothing left gets NOTHING_TO_REFUND", async () => {
    const d = await approvedDriver();
    await withContext(SYSTEM, (db) =>
      db.query("UPDATE driver_profiles SET approved_at = now() - interval '91 days' WHERE user_id = $1", [d.user.id]));
    const none = await request(app).post(api("/drivers/me/refunds")).set(bearer(d.accessToken)).send({}).expect(422);
    expect(none.body.error.code).toBe("NOTHING_TO_REFUND");

    await fundDriver(d.user.id);
    const req = await request(app).post(api("/drivers/me/refunds")).set(bearer(d.accessToken)).send({}).expect(201);
    await request(app).post(api(`/admin/refunds/${req.body.id}/reject`)).set(bearer(admin)).send({}).expect(422);
    const rej = await request(app).post(api(`/admin/refunds/${req.body.id}/reject`)).set(bearer(admin))
      .send({ reason: "Open dispute on trip 123" }).expect(200);
    expect(rej.body.status).toBe("rejected");
  });
});

describe("earnings", () => {
  it("match the trips and the day book", async () => {
    const d = await approvedDriver();
    await fundDriver(d.user.id);
    await request(app).post(api("/drivers/me/online")).set(bearer(d.accessToken))
      .send({ location: { lat: BOLE.lat + 0.002, lng: BOLE.lng } }).expect(200);
    const rider = await register("customer");
    const fares: number[] = [];
    for (let i = 0; i < 2; i++) {
      const trip = (await request(app).post(api("/trips")).set(bearer(rider.accessToken)).send({
        clientRequestId: randomUUID(), categoryCode: "economy", pickup: BOLE, dropoff: PIASSA,
      }).expect(201)).body;
      for (const [step, body] of [["accept"], ["arrive"], ["start", { ridePin: trip.ridePin }], ["complete"]] as [string, any][]) {
        const r = await request(app).post(api(`/trips/${trip.id}/${step}`)).set(bearer(d.accessToken)).send(body ?? {}).expect(200);
        if (step === "complete") fares.push(r.body.finalFare);
      }
    }
    const e = (await request(app).get(api("/drivers/me/earnings?period=today")).set(bearer(d.accessToken)).expect(200)).body;
    const gross = fares.reduce((a, b) => a + b, 0);
    expect(e).toMatchObject({ period: "today", trips: 2, gross, cashCollected: gross });
    expect(e.commission).toBe(fares.reduce((a, f) => a + Math.round(f * 0.1), 0));
    expect(e.net).toBe(gross - e.commission);
    expect(e.wallet.balance).toBe(1_000_000 - e.commission);

    // The day book's commission entries for this driver add up to the same.
    const book = (await request(app).get(api("/admin/finance/daybook")).set(bearer(admin)).expect(200)).body;
    const fromBook = book.entries.filter((x: any) => x.kind === "commission" && x.phone === d.user.phone)
      .reduce((a: number, x: any) => a - x.amount, 0);
    expect(fromBook).toBe(e.commission);
  });
});

describe("document expiry", () => {
  it("an expired licence suspends the driver and takes them offline", async () => {
    const d = await approvedDriver();
    await fundDriver(d.user.id);
    await request(app).post(api("/drivers/me/online")).set(bearer(d.accessToken)).send({ location: BOLE }).expect(200);
    await withContext(SYSTEM, (db) => db.query(
      "UPDATE driver_documents SET expires_on = current_date - 2 WHERE driver_id = $1 AND doc_type = 'license' AND status = 'approved'",
      [d.user.id]));
    await sweepTrips();
    const me = await request(app).get(api("/drivers/me")).set(bearer(d.accessToken)).expect(200);
    expect(me.body).toMatchObject({ approvalStatus: "suspended", availability: "offline", suspendedReason: "DOCUMENT_EXPIRED:license" });
    const docs = await request(app).get(api("/drivers/me/documents")).set(bearer(d.accessToken)).expect(200);
    expect(docs.body.required.find((r: any) => r.docType === "license").status).toBe("expired");

    // Back office sees it in the expiring list before it happens (for another driver).
    const d2 = await approvedDriver();
    await withContext(SYSTEM, (db) => db.query(
      "UPDATE driver_documents SET expires_on = current_date + 10 WHERE driver_id = $1 AND doc_type = 'vehicle_bolo' AND status = 'approved'",
      [d2.user.id]));
    const soon = await request(app).get(api("/admin/documents/expiring?days=30")).set(bearer(admin)).expect(200);
    expect(soon.body.data.some((x: any) => x.driverId === d2.user.id && x.docType === "vehicle_bolo")).toBe(true);
  });
});
