import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { SYSTEM, withContext, type DbContext } from "../../db/context.js";
import { AppError, notFound } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { redis } from "../../lib/redis.js";
import { storage } from "../../lib/storage.js";
import { emitToUser } from "../../realtime/socket.js";
import { setUnavailable } from "./presence.js";

/**
 * Driver documents. Flow (driver app):
 *   1. POST /drivers/me/documents        → document id + signed upload URL
 *   2. PUT the file to that URL          (straight to storage, not through the API)
 *   3. POST /drivers/me/documents/:id/submit {expiresOn?} → pending review
 * Back office: approve (optionally correcting the expiry) or reject with a reason.
 * A driver (and a vehicle) can only be approved when the required documents
 * are approved and unexpired. Expired documents suspend the driver.
 */

export const PERSONAL_DOCS = ["license", "photo"] as const;
export const VEHICLE_DOCS = ["vehicle_libre", "vehicle_insurance", "vehicle_bolo"] as const;
export const ALL_DOC_TYPES = ["license", "photo", "national_id", ...VEHICLE_DOCS] as const;
export type DocType = (typeof ALL_DOC_TYPES)[number];
/** Documents that carry an expiry date the reviewer must check. */
export const EXPIRING_DOCS: DocType[] = ["license", "vehicle_insurance", "vehicle_bolo"];
export const ALLOWED_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const MAX_DOC_BYTES = 10 * 1024 * 1024;

const ADDIS_TODAY = "(now() AT TIME ZONE 'Africa/Addis_Ababa')::date";

export const DOC_COLUMNS = `
  d.id, d.driver_id AS "driverId", d.vehicle_id AS "vehicleId", d.doc_type AS "docType", d.status,
  d.content_type AS "contentType", d.size_bytes AS "sizeBytes", d.expires_on AS "expiresOn",
  d.reject_reason AS "rejectReason", d.uploaded_at AS "uploadedAt", d.submitted_at AS "submittedAt",
  d.reviewed_at AS "reviewedAt"`;

export async function startUpload(
  ctx: DbContext,
  input: { docType: DocType; vehicleId?: string; contentType: string; sizeBytes: number },
) {
  const isVehicleDoc = input.docType.startsWith("vehicle_");
  if (isVehicleDoc !== Boolean(input.vehicleId)) {
    throw new AppError(422, "VALIDATION_FAILED",
      isVehicleDoc ? "vehicleId is required for vehicle documents" : "vehicleId only applies to vehicle documents");
  }
  const id = randomUUID();
  const key = `drivers/${ctx.userId}/${id}`;
  const document = await withContext(ctx, async (db) => {
    if (input.vehicleId) {
      const { rowCount } = await db.query("SELECT 1 FROM vehicles WHERE id = $1 AND driver_id = app.uid()", [input.vehicleId]);
      if (!rowCount) throw notFound("Vehicle");
    }
    const { rows: [d] } = await db.query(
      `INSERT INTO driver_documents AS d (id, driver_id, vehicle_id, doc_type, storage_key, content_type, size_bytes)
       VALUES ($1, app.uid(), $2, $3, $4, $5, $6) RETURNING ${DOC_COLUMNS}`,
      [id, input.vehicleId ?? null, input.docType, key, input.contentType, input.sizeBytes],
    );
    return d;
  });
  return { document, upload: await storage.uploadUrl(key, input.contentType, input.sizeBytes) };
}

export async function submitDocument(ctx: DbContext, id: string, expiresOn?: string) {
  return withContext(ctx, async (db) => {
    const { rows: [d] } = await db.query(
      "SELECT doc_type, status, storage_key, size_bytes FROM driver_documents WHERE id = $1 AND driver_id = app.uid()",
      [id],
    );
    if (!d) throw notFound("Document");
    if (d.status !== "uploading") throw new AppError(409, "INVALID_TRANSITION", `Document is already ${d.status}`);
    if (EXPIRING_DOCS.includes(d.doc_type) && !expiresOn) {
      throw new AppError(422, "VALIDATION_FAILED", "expiresOn is required for this document");
    }
    const stored = await storage.head(d.storage_key);
    if (!stored || stored.size !== d.size_bytes) {
      throw new AppError(409, "DOCUMENT_NOT_UPLOADED", "Upload the file first, then submit");
    }
    const { rows: [doc] } = await db.query(
      `UPDATE driver_documents AS d SET status = 'pending', submitted_at = now(), expires_on = $2
        WHERE id = $1 RETURNING ${DOC_COLUMNS}`,
      [id, expiresOn ?? null],
    );
    return doc;
  });
}

/** Reviewer decision (staff with drivers.approve). Approving retires older approved copies. */
export async function reviewDocument(
  ctx: DbContext, id: string,
  input: { decision: "approved" | "rejected"; reason?: string; expiresOn?: string },
) {
  return withContext(ctx, async (db) => {
    const { rows: [d] } = await db.query(
      `SELECT driver_id, vehicle_id, doc_type, status, expires_on,
              ($2::date IS NOT NULL AND $2::date < ${ADDIS_TODAY})
                OR ($2::date IS NULL AND expires_on < ${ADDIS_TODAY}) AS expired
         FROM driver_documents WHERE id = $1`,
      [id, input.expiresOn ?? null],
    );
    if (!d) throw notFound("Document");
    if (d.status !== "pending") throw new AppError(409, "INVALID_TRANSITION", `Document is ${d.status}, not pending`);
    if (input.decision === "rejected" && !input.reason) {
      throw new AppError(422, "VALIDATION_FAILED", "A reason is required when rejecting");
    }
    if (input.decision === "approved") {
      if (EXPIRING_DOCS.includes(d.doc_type) && !input.expiresOn && !d.expires_on) {
        throw new AppError(422, "VALIDATION_FAILED", "Set the expiry date before approving");
      }
      if (d.expired) throw new AppError(422, "DOCUMENT_EXPIRED", "This document has already expired");
      await db.query(
        `UPDATE driver_documents SET status = 'replaced'
          WHERE driver_id = $1 AND doc_type = $2 AND vehicle_id IS NOT DISTINCT FROM $3
            AND status IN ('approved', 'expired') AND id <> $4`,
        [d.driver_id, d.doc_type, d.vehicle_id, id],
      );
    }
    const { rows: [doc] } = await db.query(
      `UPDATE driver_documents AS d SET status = $2::document_status, reject_reason = $3,
              expires_on = coalesce($4::date, expires_on), reviewed_at = now(), reviewed_by = app.uid()
        WHERE id = $1 RETURNING ${DOC_COLUMNS}`,
      [id, input.decision, input.decision === "rejected" ? input.reason : null, input.expiresOn ?? null],
    );
    await db.query(
      "INSERT INTO audit_logs (actor_id, action, entity, entity_id, data) VALUES (app.uid(), 'document.review', 'document', $1, $2)",
      [id, input],
    );
    emitToUser(d.driver_id, "driver:document", doc);
    return doc;
  });
}

export interface RequirementStatus {
  docType: DocType;
  vehicleId: string | null;
  status: "missing" | "uploading" | "pending" | "approved" | "rejected" | "expired";
  expiresOn: string | null;
}

/** Latest state of each required document for a driver (and optionally a vehicle). */
export async function requirements(db: PoolClient, driverId: string, vehicleId?: string | null): Promise<RequirementStatus[]> {
  const wanted: [DocType, string | null][] = [
    ...PERSONAL_DOCS.map((t) => [t, null] as [DocType, null]),
    ...(vehicleId ? VEHICLE_DOCS.map((t) => [t, vehicleId] as [DocType, string]) : []),
  ];
  const { rows } = await db.query(
    `SELECT DISTINCT ON (doc_type, vehicle_id) doc_type, vehicle_id, status, expires_on
       FROM driver_documents
      WHERE driver_id = $1 AND status <> 'replaced'
      ORDER BY doc_type, vehicle_id,
               (status = 'approved') DESC, uploaded_at DESC`,
    [driverId],
  );
  return wanted.map(([docType, vid]) => {
    const r = rows.find((x) => x.doc_type === docType && x.vehicle_id === vid);
    return { docType, vehicleId: vid, status: r?.status ?? "missing", expiresOn: r?.expires_on ?? null };
  });
}

/**
 * Hourly (from the sweeper): approved documents past their expiry date become
 * 'expired'; drivers with an expired required document (personal, or for
 * their current vehicle) are suspended and taken offline.
 */
export async function expireDocuments(): Promise<number> {
  const due = await redis.set("docs:expiry-check", "1", "EX", 3600, "NX");
  if (!due) return 0;
  const suspended = await withContext(SYSTEM, async (db) => {
    const { rows: expired } = await db.query(
      `UPDATE driver_documents SET status = 'expired'
        WHERE status = 'approved' AND expires_on < ${ADDIS_TODAY}
        RETURNING driver_id, vehicle_id, doc_type`,
    );
    const affected = expired.filter((e) =>
      (PERSONAL_DOCS as readonly string[]).includes(e.doc_type) || e.vehicle_id !== null);
    const out: string[] = [];
    for (const e of affected) {
      const { rows: [p] } = await db.query(
        `UPDATE driver_profiles dp SET approval_status = 'suspended', availability = 'offline',
                suspended_reason = $2
          WHERE user_id = $1 AND approval_status = 'approved'
            AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM vehicles v WHERE v.id = $3 AND v.is_current))
          RETURNING user_id`,
        [e.driver_id, `DOCUMENT_EXPIRED:${e.doc_type}`, e.vehicle_id],
      );
      if (p) out.push(p.user_id);
    }
    return out;
  });
  for (const id of suspended) {
    await setUnavailable(id);
    emitToUser(id, "driver:availability", { availability: "offline", reason: "DOCUMENT_EXPIRED" });
    logger.info({ driverId: id }, "driver suspended: document expired");
  }
  return suspended.length;
}
