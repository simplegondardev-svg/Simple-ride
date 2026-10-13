import express, { Router } from "express";
import { readFile } from "node:fs/promises";
import { env } from "../../config/env.js";
import { AppError } from "../../lib/errors.js";
import { localPath, verifyLocal, writeLocal } from "../../lib/storage.js";

/**
 * Development stand-in for S3 presigned URLs (STORAGE_DRIVER=local). The URL
 * itself is the credential: an HMAC over key, operation, expiry and (for
 * uploads) content type and exact size. With STORAGE_DRIVER=s3 these routes
 * answer 404 — clients use the S3 URLs returned by the API instead.
 */
export const filesRouter = Router();

const MAX_BYTES = 10 * 1024 * 1024;

function check(req: express.Request, op: "put" | "get") {
  if (env.STORAGE_DRIVER !== "local") throw new AppError(404, "NOT_FOUND", "File not found");
  const key = (req.params.key as unknown as string[]).join("/");
  const q = req.query as Record<string, string>;
  const parts: Record<string, string> = { key, op, exp: q.exp ?? "" };
  if (op === "put") Object.assign(parts, { ct: q.ct ?? "", len: q.len ?? "" });
  if (q.op !== op || !q.sig || !verifyLocal(parts, q.sig)) {
    throw new AppError(403, "INVALID_SIGNATURE", "File link is invalid");
  }
  if (Number(q.exp) * 1000 < Date.now()) throw new AppError(403, "INVALID_SIGNATURE", "File link has expired");
  return { key, q };
}

filesRouter.put("/*key", express.raw({ type: () => true, limit: MAX_BYTES }), async (req, res) => {
  const { key, q } = check(req, "put");
  const body = req.body as Buffer;
  if (req.get("content-type") !== q.ct || !Buffer.isBuffer(body) || body.length !== Number(q.len)) {
    throw new AppError(422, "UPLOAD_MISMATCH", "Upload must match the declared content type and size");
  }
  await writeLocal(key, body, q.ct!);
  res.status(200).end();
});

filesRouter.get("/*key", async (req, res) => {
  const { key } = check(req, "get");
  try {
    const meta = JSON.parse(await readFile(`${localPath(key)}.meta.json`, "utf8"));
    res.type(meta.contentType).send(await readFile(localPath(key)));
  } catch {
    throw new AppError(404, "NOT_FOUND", "File not found");
  }
});
