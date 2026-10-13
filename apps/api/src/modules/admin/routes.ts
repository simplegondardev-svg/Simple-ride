import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../auth/middleware.js";
import { loadPermissions, PERMISSIONS, requirePermission } from "../../auth/permissions.js";
import { issueTemporaryPassword } from "../../auth/credentials.js";
import { SYSTEM, withContext } from "../../db/context.js";
import { AppError, notFound } from "../../lib/errors.js";
import { normalizeEthiopianPhone } from "../../lib/phone.js";
import { page, uuidParam } from "../../lib/schemas.js";
import { storage } from "../../lib/storage.js";
import { emitToUser } from "../../realtime/socket.js";
import { DOC_COLUMNS, requirements, reviewDocument } from "../drivers/documents.js";
import { balances, moneySettings, walletStatus } from "../drivers/money.js";
import { setUnavailable } from "../drivers/presence.js";
import { cancelTrip } from "../trips/service.js";
import { postLedger } from "../wallet/ledger.js";

/**
 * Back-office API for the Next.js dashboard, used by admins (everything) and
 * staff (only the permissions an admin switched on for them). Every route
 * names its permission; RLS enforces the same rules in the database. All
 * mutations write an audit_logs entry.
 */
export const adminRouter = Router();
adminRouter.use(requireRole("admin", "staff"));

const audit = (db: any, action: string, entity: string, entityId: string, data: unknown) =>
  db.query(
    "INSERT INTO audit_logs (actor_id, action, entity, entity_id, data) VALUES (app.uid(), $1, $2, $3, $4)",
    [action, entity, entityId, data],
  );

/** Who am I in the back office — the dashboard uses this to show/hide sections. */
adminRouter.get("/me", async (req, res) => {
  res.json({ role: req.ctx.role, permissions: [...(await loadPermissions(req))] });
});

adminRouter.get("/permissions", async (req, res) => {
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query("SELECT code, category, description FROM permissions ORDER BY sort_order")).rows,
  );
  res.json({ data: rows });
});

adminRouter.get("/stats", requirePermission("dashboard.view"), async (req, res) => {
  const stats = await withContext(req.ctx, async (db) =>
    (await db.query("SELECT app.dashboard_stats() AS s")).rows[0].s,
  );
  res.json(stats);
});

// ───────────────────────── Riders & drivers ─────────────────────────

adminRouter.get("/users", requirePermission("users.view", "users.suspend", "users.reset_password"), async (req, res) => {
  const q = adminUsersQuery.parse(req.query);
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT u.id, u.phone, u.role, u.status, u.full_name AS "fullName", u.created_at AS "createdAt",
              dp.approval_status AS "approvalStatus", dp.availability
         FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id
        WHERE ($1::user_role IS NULL OR u.role = $1)
          AND ($2::text IS NULL OR u.phone LIKE '%' || $2 || '%' OR u.full_name ILIKE '%' || $2 || '%')
          AND ($3::timestamptz IS NULL OR u.created_at < $3)
        ORDER BY u.created_at DESC LIMIT $4`,
      [q.role ?? null, q.search ?? null, q.before ?? null, q.limit],
    )).rows,
  );
  res.json({ data: rows });
});

adminRouter.patch("/users/:id/status", requirePermission("users.suspend"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { status } = userStatusBody.parse(req.body);
  if (id === req.ctx.userId) throw new AppError(422, "CANNOT_CHANGE_SELF", "You can't change your own status");
  const user = await withContext(req.ctx, async (db) => {
    // RLS: staff only reach riders and drivers; admins reach everyone.
    const { rows: [u] } = await db.query(
      "UPDATE users SET status = $2 WHERE id = $1 RETURNING id, status", [id, status],
    );
    if (!u) throw notFound("User");
    if (status === "suspended") {
      await db.query("UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [id]);
    }
    await audit(db, "user.status", "user", id, { status });
    return u;
  });
  res.json(user);
});

/**
 * Support: a rider or driver forgot their password. Issues a temporary one
 * to read out to them (shown once); they choose their own at next login.
 */
adminRouter.post("/users/:id/reset-password", requirePermission("users.reset_password"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  // Visibility check in the caller's own context: RLS only lets staff reach
  // riders and drivers. Admin and staff passwords are reset elsewhere.
  const target = await withContext(req.ctx, async (db) =>
    (await db.query("SELECT role FROM users WHERE id = $1", [id])).rows[0],
  );
  if (!target) throw notFound("User");
  if (target.role !== "customer" && target.role !== "driver") {
    throw new AppError(403, "FORBIDDEN", "Use staff management to reset staff passwords");
  }
  const temporaryPassword = await withContext(SYSTEM, (db) => issueTemporaryPassword(db, id));
  await withContext(req.ctx, (db) => audit(db, "user.reset_password", "user", id, {}));
  res.json({ temporaryPassword });
});

// ───────────────────────── Driver onboarding ─────────────────────────

adminRouter.get("/drivers/pending", requirePermission("drivers.view", "drivers.approve"), async (req, res) => {
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT u.id, u.phone, u.full_name AS "fullName", dp.license_number AS "licenseNumber",
              dp.license_expires_on AS "licenseExpiresOn", dp.created_at AS "appliedAt",
              coalesce(json_agg(json_build_object('id', v.id, 'plateNumber', v.plate_number,
                'make', v.make, 'model', v.model, 'color', v.color, 'categoryCode', v.category_code,
                'status', v.status)) FILTER (WHERE v.id IS NOT NULL), '[]') AS vehicles
         FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
         LEFT JOIN vehicles v ON v.driver_id = dp.user_id
        WHERE dp.approval_status = 'pending'
        GROUP BY u.id, dp.user_id ORDER BY dp.created_at`,
    )).rows,
  );
  res.json({ data: rows });
});

/** Approve/reject a driver and (optionally) one of their vehicles. */
adminRouter.post("/drivers/:id/review", requirePermission("drivers.approve"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const body = driverReviewBody.parse(req.body);
  const result = await withContext(req.ctx, async (db) => {
    if (body.decision === "approved") {
      // Personal documents, plus the vehicle's when approving a vehicle, must be approved and unexpired.
      const missing = (await requirements(db, id, body.vehicleId ?? null)).filter((r) => r.status !== "approved");
      if (missing.length > 0) {
        throw new AppError(422, "DOCUMENTS_INCOMPLETE", "Required documents are missing or not approved", { missing });
      }
    }
    const { rows: [p] } = await db.query(
      `UPDATE driver_profiles SET approval_status = $2::approval_status,
              approved_at = CASE WHEN $2::text = 'approved' THEN coalesce(approved_at, now()) END,
              approved_by = CASE WHEN $2::text = 'approved' THEN app.uid() END,
              suspended_reason = CASE WHEN $2::text = 'approved' THEN NULL ELSE $3 END,
              availability = CASE WHEN $2::text = 'approved' THEN availability ELSE 'offline' END
        WHERE user_id = $1 RETURNING approval_status AS "approvalStatus"`,
      [id, body.decision, body.note ?? null],
    );
    if (!p) throw notFound("Driver");
    if (body.vehicleId) {
      const vehicleStatus = body.decision === "approved" ? "approved" : "rejected";
      // Make the approved vehicle current if the driver has none yet.
      await db.query(
        `UPDATE vehicles SET status = $3::approval_status,
                is_current = ($3::text = 'approved' AND NOT EXISTS (
                  SELECT 1 FROM vehicles v2 WHERE v2.driver_id = $2 AND v2.is_current AND v2.id <> $1))
          WHERE id = $1 AND driver_id = $2`,
        [body.vehicleId, id, vehicleStatus],
      );
    }
    await audit(db, "driver.review", "driver", id, body);
    return p;
  });
  if (body.decision !== "approved") await setUnavailable(id);
  emitToUser(id, "driver:approval", result);
  res.json(result);
});

// ───────────────────────── Drivers: list, detail, documents ─────────────────────────

const DRIVER_STAFF = ["drivers.view", "drivers.approve", "drivers.commission",
  "finance.deposits.record", "finance.refunds.manage"] as const;

adminRouter.get("/drivers", requirePermission(...DRIVER_STAFF), async (req, res) => {
  const q = adminDriversQuery.parse(req.query);
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT u.id, u.phone, u.full_name AS "fullName", u.status, dp.approval_status AS "approvalStatus",
              dp.availability, dp.suspended_reason AS "suspendedReason", dp.commission_bps AS "customCommissionBps",
              w.balance, dp.created_at AS "appliedAt",
              (SELECT count(*)::int FROM driver_documents d WHERE d.driver_id = u.id AND d.status = 'pending') AS "documentsToReview"
         FROM driver_profiles dp JOIN users u ON u.id = dp.user_id LEFT JOIN wallets w ON w.user_id = u.id
        WHERE ($1::approval_status IS NULL OR dp.approval_status = $1)
          AND ($2::text IS NULL OR u.phone LIKE '%' || $2 || '%' OR u.full_name ILIKE '%' || $2 || '%')
        ORDER BY (SELECT count(*) FROM driver_documents d WHERE d.driver_id = u.id AND d.status = 'pending') DESC,
                 dp.created_at DESC
        LIMIT $3`,
      [q.status ?? null, q.search ?? null, q.limit],
    )).rows,
  );
  res.json({ data: rows });
});

adminRouter.get("/drivers/:id", requirePermission(...DRIVER_STAFF), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const data = await withContext(req.ctx, async (db) => {
    const { rows: [driver] } = await db.query(
      `SELECT u.id, u.phone, u.full_name AS "fullName", u.status, u.created_at AS "createdAt",
              dp.approval_status AS "approvalStatus", dp.availability, dp.suspended_reason AS "suspendedReason",
              dp.license_number AS "licenseNumber", dp.license_expires_on AS "licenseExpiresOn",
              dp.commission_bps AS "customCommissionBps", dp.approved_at AS "approvedAt",
              dp.rating_avg AS "ratingAvg", dp.rating_count AS "ratingCount"
         FROM driver_profiles dp JOIN users u ON u.id = dp.user_id WHERE u.id = $1`,
      [id],
    );
    if (!driver) throw notFound("Driver");
    const settings = await moneySettings(db);
    const { rows: vehicles } = await db.query(
      `SELECT id, category_code AS "categoryCode", plate_number AS "plateNumber", make, model, color, year,
              status, is_current AS "isCurrent" FROM vehicles WHERE driver_id = $1 ORDER BY created_at`,
      [id],
    );
    const { rows: documents } = await db.query(
      `SELECT ${DOC_COLUMNS} FROM driver_documents d WHERE d.driver_id = $1 AND d.status NOT IN ('uploading', 'replaced')
        ORDER BY d.uploaded_at DESC`,
      [id],
    );
    const vehicle = vehicles.find((v) => v.isCurrent) ?? vehicles.at(-1);
    const balance = (await balances(db, [id])).get(id);
    const { rows: refunds } = await db.query(
      `SELECT id, status, requested_at AS "requestedAt", note, amount, reference, reject_reason AS "rejectReason"
         FROM deposit_refunds WHERE driver_id = $1 ORDER BY requested_at DESC LIMIT 10`,
      [id],
    );
    return {
      ...driver,
      commissionBps: driver.customCommissionBps ?? settings.defaultCommissionBps,
      // null when the viewer may not see wallets
      wallet: balance === undefined ? null : walletStatus(balance, settings),
      refundEligibleFrom: driver.approvedAt
        ? new Date(new Date(driver.approvedAt).getTime() + settings.refundAfterDays * 86_400_000).toISOString() : null,
      vehicles,
      documents,
      required: await requirements(db, id, vehicle?.id ?? null),
      refunds,
    };
  });
  res.json(data);
});

/** Short-lived link to view a document file. */
adminRouter.get("/documents/:id/file", requirePermission("drivers.view", "drivers.approve"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const key = await withContext(req.ctx, async (db) =>
    (await db.query("SELECT storage_key FROM driver_documents WHERE id = $1", [id])).rows[0]?.storage_key,
  );
  if (!key) throw notFound("Document");
  res.json({ url: await storage.downloadUrl(key), expiresInSeconds: 300 });
});

adminRouter.post("/documents/:id/review", requirePermission("drivers.approve"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  res.json(await reviewDocument(req.ctx, id, documentReviewBody.parse(req.body)));
});

/** Approved documents expiring within N days (default 30), soonest first. */
adminRouter.get("/documents/expiring", requirePermission("drivers.view", "drivers.approve"), async (req, res) => {
  const { days } = expiringQuery.parse(req.query);
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT ${DOC_COLUMNS}, u.phone, u.full_name AS "fullName"
         FROM driver_documents d JOIN users u ON u.id = d.driver_id
        WHERE d.status = 'approved'
          AND d.expires_on < (now() AT TIME ZONE 'Africa/Addis_Ababa')::date + $1::int
        ORDER BY d.expires_on`,
      [days],
    )).rows,
  );
  res.json({ data: rows });
});

/** Custom commission for one driver; null returns them to the default. */
adminRouter.put("/drivers/:id/commission", requirePermission("drivers.commission"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { commissionBps } = driverCommissionBody.parse(req.body);
  const result = await withContext(req.ctx, async (db) => {
    const { rows: [p] } = await db.query(
      `UPDATE driver_profiles SET commission_bps = $2 WHERE user_id = $1
       RETURNING commission_bps AS "customCommissionBps"`,
      [id, commissionBps],
    );
    if (!p) throw notFound("Driver");
    await audit(db, "driver.commission", "driver", id, { commissionBps });
    return p;
  });
  res.json(result);
});

// ───────────────────────── Deposits and refunds ─────────────────────────

/** Record a deposit the driver paid at the office (cash, bank slip…). At least the minimum deposit. */
adminRouter.post("/drivers/:id/deposits", requirePermission("finance.deposits.record"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const body = depositBody.parse(req.body);
  // Visibility check as the staff member (RLS), then the ledger write as server code.
  const settings = await withContext(req.ctx, async (db) => {
    const { rowCount } = await db.query("SELECT 1 FROM users WHERE id = $1 AND role = 'driver'", [id]);
    if (!rowCount) throw notFound("Driver");
    return moneySettings(db);
  });
  if (body.amount < settings.minDeposit) {
    throw new AppError(422, "DEPOSIT_TOO_SMALL", "Deposit is below the minimum", { minDeposit: settings.minDeposit });
  }
  const balance = await withContext(SYSTEM, (db) =>
    postLedger(db, { userId: id, amount: body.amount, kind: "deposit", reference: body.reference, createdBy: req.ctx.userId }),
  );
  await withContext(req.ctx, (db) => audit(db, "driver.deposit", "driver", id, body));
  const wallet = walletStatus(balance, settings);
  emitToUser(id, "driver:wallet", wallet);
  res.status(201).json(wallet);
});

const REFUND_ADMIN_COLUMNS = `r.id, r.driver_id AS "driverId", r.status, r.requested_at AS "requestedAt", r.note,
  r.amount, r.reference, r.reject_reason AS "rejectReason", r.decided_at AS "decidedAt"`;

adminRouter.get("/refunds", requirePermission("finance.refunds.manage"), async (req, res) => {
  const { status } = refundsQuery.parse(req.query);
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT ${REFUND_ADMIN_COLUMNS}, u.phone, u.full_name AS "fullName", w.balance
         FROM deposit_refunds r JOIN users u ON u.id = r.driver_id LEFT JOIN wallets w ON w.user_id = r.driver_id
        WHERE ($1::refund_status IS NULL OR r.status = $1) ORDER BY r.requested_at DESC LIMIT 200`,
      [status ?? null],
    )).rows,
  );
  res.json({ data: rows });
});

/**
 * Pay out a refund: the driver's whole remaining balance leaves the wallet as
 * a 'payout' (shown in the day book); the driver goes offline.
 */
adminRouter.post("/refunds/:id/pay", requirePermission("finance.refunds.manage"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { reference } = refundPayBody.parse(req.body);
  const driverId = await withContext(req.ctx, async (db) =>
    (await db.query("SELECT driver_id FROM deposit_refunds WHERE id = $1 AND status = 'pending'", [id])).rows[0]?.driver_id,
  );
  if (!driverId) throw notFound("Pending refund request");
  const refund = await withContext(SYSTEM, async (db) => {
    const { rows: [w] } = await db.query("SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE", [driverId]);
    if (!w || w.balance <= 0) throw new AppError(422, "NOTHING_TO_REFUND", "The driver's balance is zero", { balance: w?.balance ?? 0 });
    await postLedger(db, { userId: driverId, amount: -w.balance, kind: "payout", reference, createdBy: req.ctx.userId });
    await db.query("UPDATE driver_profiles SET availability = 'offline' WHERE user_id = $1", [driverId]);
    const { rows: [r] } = await db.query(
      `UPDATE deposit_refunds r SET status = 'paid', amount = $2, reference = $3, decided_at = now(), decided_by = $4
        WHERE id = $1 RETURNING ${REFUND_ADMIN_COLUMNS}`,
      [id, w.balance, reference, req.ctx.userId],
    );
    return r;
  });
  await setUnavailable(driverId);
  await withContext(req.ctx, (db) => audit(db, "refund.pay", "refund", id, { amount: refund.amount, reference }));
  emitToUser(driverId, "driver:refund", refund);
  res.json(refund);
});

adminRouter.post("/refunds/:id/reject", requirePermission("finance.refunds.manage"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { reason } = refundRejectBody.parse(req.body);
  const refund = await withContext(req.ctx, async (db) => {
    const { rows: [r] } = await db.query(
      `UPDATE deposit_refunds r SET status = 'rejected', reject_reason = $2, decided_at = now(), decided_by = app.uid()
        WHERE id = $1 AND status = 'pending' RETURNING ${REFUND_ADMIN_COLUMNS}`,
      [id, reason],
    );
    if (!r) throw notFound("Pending refund request");
    await audit(db, "refund.reject", "refund", id, { reason });
    return r;
  });
  emitToUser(refund.driverId, "driver:refund", refund);
  res.json(refund);
});

// ───────────────────────── Trips ─────────────────────────

adminRouter.get("/trips", requirePermission("trips.view"), async (req, res) => {
  const q = adminTripsQuery.parse(req.query);
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT t.id, t.status, t.category_code AS "categoryCode", t.fare_estimate AS "fareEstimate",
              t.final_fare AS "finalFare", t.payment_method AS "paymentMethod",
              t.pickup_address AS "pickupAddress", t.dropoff_address AS "dropoffAddress",
              t.requested_at AS "requestedAt", c.phone AS "customerPhone", d.phone AS "driverPhone"
         FROM trips t LEFT JOIN users c ON c.id = t.customer_id LEFT JOIN users d ON d.id = t.driver_id
        WHERE ($1::text IS NULL OR t.status::text = $1)
          AND ($2::timestamptz IS NULL OR t.requested_at < $2)
        ORDER BY t.requested_at DESC LIMIT $3`,
      [q.status ?? null, q.before ?? null, q.limit],
    )).rows,
  );
  res.json({ data: rows });
});

adminRouter.post("/trips/:id/cancel", requirePermission("trips.cancel"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { reason } = adminCancelTripBody.parse(req.body);
  const trip = await cancelTrip(req.ctx, id, reason);
  await withContext(req.ctx, (db) => audit(db, "trip.cancel", "trip", id, { reason }));
  res.json(trip);
});

// ───────────────────────── Finance ─────────────────────────

/** Day book: every money movement on one Addis Ababa calendar day (default today). */
adminRouter.get("/finance/daybook", requirePermission("finance.daybook.view"), async (req, res) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Addis_Ababa" }).format(new Date());
  const date = daybookQuery.parse(req.query).date ?? today;
  const book = await withContext(req.ctx, async (db) =>
    (await db.query("SELECT app.daybook($1::date) AS b", [date])).rows[0].b,
  );
  res.json(book);
});

adminRouter.get("/wallets/:id", requirePermission("finance.wallets.view", "finance.wallets.adjust"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const wallet = await withContext(req.ctx, async (db) => {
    const { rows: [w] } = await db.query("SELECT user_id AS \"userId\", balance, currency FROM wallets WHERE user_id = $1", [id]);
    if (!w) throw notFound("Wallet");
    const { rows } = await db.query(
      `SELECT id, amount, balance_after AS "balanceAfter", kind, trip_id AS "tripId", reference,
              created_at AS "createdAt"
         FROM wallet_transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 50`,
      [id],
    );
    return { ...w, transactions: rows };
  });
  res.json(wallet);
});

/** Manual credit (+) or debit (−) in santim, with a mandatory reason. */
adminRouter.post("/wallets/:id/adjust", requirePermission("finance.wallets.adjust"), async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const body = walletAdjustBody.parse(req.body);
  const result = await withContext(req.ctx, async (db) => {
    const { rows: [w] } = await db.query(
      "UPDATE wallets SET balance = balance + $2, updated_at = now() WHERE user_id = $1 RETURNING balance",
      [id, body.amount],
    );
    if (!w) throw notFound("Wallet");
    await db.query(
      `INSERT INTO wallet_transactions (user_id, amount, balance_after, kind, reference, created_by)
       VALUES ($1, $2, $3, 'adjustment', $4, app.uid())`,
      [id, body.amount, w.balance, body.reason],
    );
    await audit(db, "wallet.adjust", "wallet", id, body);
    return { balance: w.balance };
  });
  res.json(result);
});

// ───────────────────────── Business settings ─────────────────────────
// Admin-adjustable rules. Each key is validated here; unknown keys are refused.
const SETTINGS = z.object({
  /** Commission for drivers without a custom rate (1000 = 10%). */
  defaultCommissionBps: z.number().int().min(0).max(10_000),
  /** Smallest deposit accepted, santim. */
  minDeposit: z.number().int().min(0),
  /** Below this balance (santim) a driver can't go online or get offers. */
  lowBalanceThreshold: z.number().int().min(0),
  /** Below this balance (santim) the driver is warned to top up. */
  lowBalanceWarning: z.number().int().min(0),
  /** Days after approval before a deposit can be refunded. */
  refundAfterDays: z.number().int().min(0).max(3650),
  /** Max extra for longer-than-estimated trips, in basis points of the quote (2500 = 25%). */
  overtimeCapBps: z.number().int().min(0).max(10_000),
}).partial();
const SETTING_KEYS: Record<string, string> = {
  overtimeCapBps: "overtime_cap_bps",
  defaultCommissionBps: "default_commission_bps",
  minDeposit: "min_deposit",
  lowBalanceThreshold: "low_balance_threshold",
  lowBalanceWarning: "low_balance_warning",
  refundAfterDays: "refund_after_days",
};

adminRouter.get("/settings", requirePermission("pricing.manage"), async (req, res) => {
  const rows = await withContext(req.ctx, async (db) => (await db.query("SELECT key, value FROM app_settings")).rows);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  res.json(Object.fromEntries(Object.entries(SETTING_KEYS).map(([api, db]) => [api, byKey[db] ?? null])));
});

adminRouter.patch("/settings", requirePermission("pricing.manage"), async (req, res) => {
  const body = settingsBody.parse(req.body);
  await withContext(req.ctx, async (db) => {
    for (const [api, value] of Object.entries(body)) {
      await db.query(
        "UPDATE app_settings SET value = $2, updated_by = app.uid() WHERE key = $1",
        [SETTING_KEYS[api], JSON.stringify(value)],
      );
    }
    await audit(db, "settings.update", "settings", "app", body);
  });
  res.json(body);
});

// ───────────────────────── Audit ─────────────────────────

adminRouter.get("/audit", requirePermission("audit.view"), async (req, res) => {
  const q = page.parse(req.query);
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT a.id, a.action, a.entity, a.entity_id AS "entityId", a.data, a.created_at AS "createdAt",
              a.actor_id AS "actorId"
         FROM audit_logs a
        WHERE ($1::timestamptz IS NULL OR a.created_at < $1)
        ORDER BY a.id DESC LIMIT $2`,
      [q.before ?? null, q.limit],
    )).rows,
  );
  res.json({ data: rows });
});

// ───────────────────────── Staff management (admins only) ─────────────────────────

export const staffRouter = Router();
export const STAFF_MOUNT = "/staff";
staffRouter.use(requireRole("admin"));
adminRouter.use(STAFF_MOUNT, staffRouter);

const permissionList = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).transform((l) => [...new Set(l)]);

async function replacePermissions(db: any, userId: string, permissions: string[]) {
  await db.query("DELETE FROM staff_permissions WHERE user_id = $1", [userId]);
  if (permissions.length > 0) {
    await db.query(
      `INSERT INTO staff_permissions (user_id, permission, granted_by)
       SELECT $1, p, app.uid() FROM unnest($2::text[]) AS p`,
      [userId, permissions],
    );
  }
}

staffRouter.get("/", async (req, res) => {
  const rows = await withContext(req.ctx, async (db) =>
    (await db.query(
      `SELECT u.id, u.phone, u.full_name AS "fullName", u.status, u.created_at AS "createdAt",
              coalesce(array_agg(sp.permission ORDER BY p.sort_order) FILTER (WHERE sp.permission IS NOT NULL), '{}') AS permissions
         FROM users u
         LEFT JOIN staff_permissions sp ON sp.user_id = u.id
         LEFT JOIN permissions p ON p.code = sp.permission
        WHERE u.role = 'staff'
        GROUP BY u.id ORDER BY u.created_at`,
    )).rows,
  );
  res.json({ data: rows });
});

/** Create a staff account. Returns a temporary password (shown once) for the admin to hand over. */
staffRouter.post("/", async (req, res) => {
  const body = createStaffBody.parse(req.body);
  const phone = normalizeEthiopianPhone(body.phone);
  if (!phone) throw new AppError(422, "VALIDATION_FAILED", "Not a valid Ethiopian mobile number");

  const staff = await withContext(req.ctx, async (db) => {
    let rows;
    try {
      ({ rows } = await db.query(
        `INSERT INTO users (phone, role, full_name) VALUES ($1, 'staff', $2)
         RETURNING id, phone, full_name AS "fullName", status`,
        [phone, body.fullName],
      ));
    } catch (err: any) {
      if (err.code === "23505") throw new AppError(409, "STAFF_EXISTS", "A staff account already uses this phone");
      throw err;
    }
    await replacePermissions(db, rows[0].id, body.permissions);
    await audit(db, "staff.create", "user", rows[0].id, { phone, permissions: body.permissions });
    return { ...rows[0], permissions: body.permissions };
  });
  // Shown once. They must replace it with their own at first login.
  const temporaryPassword = await withContext(SYSTEM, (db) => issueTemporaryPassword(db, staff.id));
  res.status(201).json({ ...staff, temporaryPassword });
});

staffRouter.post("/:id/reset-password", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const exists = await withContext(req.ctx, async (db) =>
    (await db.query("SELECT 1 FROM users WHERE id = $1 AND role = 'staff'", [id])).rowCount,
  );
  if (!exists) throw notFound("Staff member");
  const temporaryPassword = await withContext(SYSTEM, (db) => issueTemporaryPassword(db, id));
  await withContext(req.ctx, (db) => audit(db, "staff.reset_password", "user", id, {}));
  res.json({ temporaryPassword });
});

/** Replace a staff member's permission list (the toggles). Effective on their next request. */
staffRouter.put("/:id/permissions", async (req, res) => {
  const { id } = uuidParam.parse(req.params);
  const { permissions } = staffPermissionsBody.parse(req.body);
  await withContext(req.ctx, async (db) => {
    const { rowCount } = await db.query("SELECT 1 FROM users WHERE id = $1 AND role = 'staff'", [id]);
    if (!rowCount) throw notFound("Staff member");
    await replacePermissions(db, id, permissions);
    await audit(db, "staff.permissions", "user", id, { permissions });
  });
  res.json({ id, permissions });
});

// Request schemas (exported: the OpenAPI spec is built from them).
export const adminUsersQuery = page
  .extend({ role: z.enum(["customer", "driver", "admin", "staff"]).optional(), search: z.string().optional() });
export const userStatusBody = z.object({ status: z.enum(["active", "suspended"]) });
export const driverReviewBody = z
  .object({
    decision: z.enum(["approved", "rejected", "suspended"]),
    vehicleId: z.uuid().optional(),
    note: z.string().max(500).optional(),
  });
export const adminTripsQuery = page.extend({ status: z.string().optional() });
export const adminCancelTripBody = z.object({ reason: z.string().min(3).max(300) });
/** Day book date (YYYY-MM-DD, Addis Ababa calendar day); defaults to today. */
export const daybookQuery = z.object({ date: z.iso.date().optional() });
export const walletAdjustBody = z
  .object({
    amount: z.number().int().refine((v) => v !== 0, "amount must not be zero")
      .refine((v) => Math.abs(v) <= 10_000_000, "amount too large (max 100,000 ETB)"),
    reason: z.string().trim().min(5).max(300),
  });
export const settingsBody = SETTINGS.strict();
export const createStaffBody = z
  .object({
    phone: z.string(),
    fullName: z.string().trim().min(2).max(100),
    permissions: permissionList.default([]),
  });
export const staffPermissionsBody = z.object({ permissions: permissionList });
export const adminDriversQuery = z.object({
  status: z.enum(["pending", "approved", "rejected", "suspended"]).optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const documentReviewBody = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(300).optional().describe("Required when rejecting; shown to the driver"),
  expiresOn: z.iso.date().optional().describe("Set or correct the expiry printed on the document"),
});
export const expiringQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
export const driverCommissionBody = z.object({
  commissionBps: z.number().int().min(0).max(10_000).nullable().describe("e.g. 800 = 8%; null = use the default"),
});
export const depositBody = z.object({
  amount: z.number().int().positive().describe("Santim"),
  reference: z.string().trim().min(2).max(100).describe("Receipt or bank slip number"),
});
export const refundsQuery = z.object({ status: z.enum(["pending", "paid", "rejected", "cancelled"]).optional() });
export const refundPayBody = z.object({
  reference: z.string().trim().min(2).max(100).describe("How it was paid: receipt, bank or telebirr reference"),
});
export const refundRejectBody = z.object({ reason: z.string().trim().min(3).max(300) });
