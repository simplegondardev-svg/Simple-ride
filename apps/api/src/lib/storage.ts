import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { HeadObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env.js";

/**
 * Object storage for driver documents. The apps upload straight to a
 * short-lived signed URL, so files never pass through the API in production.
 *
 *   s3    — any S3-compatible service (AWS S3, Cloudflare R2, Wasabi…): presigned URLs.
 *   local — development: files under STORAGE_DIR, served by GET/PUT /api/v1/files/*
 *           with HMAC-signed URLs that mimic presigned S3 URLs.
 */

export interface UploadTarget {
  url: string;
  method: "PUT";
  /** Headers the client must send exactly as given (they're part of the signature). */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface StoredObject {
  size: number;
  contentType: string;
}

export interface Storage {
  uploadUrl(key: string, contentType: string, sizeBytes: number, ttlSeconds?: number): Promise<UploadTarget>;
  downloadUrl(key: string, ttlSeconds?: number): Promise<string>;
  head(key: string): Promise<StoredObject | null>;
}

// ───────────────────────── S3 ─────────────────────────

class S3Storage implements Storage {
  private client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID!, secretAccessKey: env.S3_SECRET_ACCESS_KEY! },
  });

  async uploadUrl(key: string, contentType: string, sizeBytes: number, ttl = 600): Promise<UploadTarget> {
    // Content-Type and Content-Length are signed: the upload must match what we validated.
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ContentType: contentType, ContentLength: sizeBytes }),
      { expiresIn: ttl, signableHeaders: new Set(["content-type", "content-length"]) },
    );
    return {
      url, method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(sizeBytes) },
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    };
  }

  downloadUrl(key: string, ttl = 300): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }), { expiresIn: ttl });
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
      return { size: Number(r.ContentLength ?? 0), contentType: r.ContentType ?? "application/octet-stream" };
    } catch (err: any) {
      if (err?.$metadata?.httpStatusCode === 404 || err?.name === "NotFound") return null;
      throw err;
    }
  }
}

// ───────────────────────── Local (development) ─────────────────────────

const signingKey = createHmac("sha256", env.JWT_ACCESS_SECRET).update("local-storage").digest();

export function signLocal(parts: Record<string, string>): string {
  const canonical = Object.keys(parts).sort().map((k) => `${k}=${parts[k]}`).join("&");
  return createHmac("sha256", signingKey).update(canonical).digest("base64url");
}

export function verifyLocal(parts: Record<string, string>, sig: string): boolean {
  const expected = Buffer.from(signLocal(parts));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const localPath = (key: string) => {
  const root = path.resolve(env.STORAGE_DIR);
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error("invalid storage key");
  return full;
};

class LocalStorage implements Storage {
  private base = `${env.PUBLIC_API_URL ?? `http://localhost:${env.PORT}`}/api/v1/files/`;

  private signed(key: string, parts: Record<string, string>) {
    const sig = signLocal({ key, ...parts });
    const q = new URLSearchParams({ ...parts, sig });
    return `${this.base}${key.split("/").map(encodeURIComponent).join("/")}?${q}`;
  }

  async uploadUrl(key: string, contentType: string, sizeBytes: number, ttl = 600): Promise<UploadTarget> {
    const exp = String(Math.floor(Date.now() / 1000) + ttl);
    return {
      url: this.signed(key, { op: "put", exp, ct: contentType, len: String(sizeBytes) }),
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(sizeBytes) },
      expiresAt: new Date(Number(exp) * 1000).toISOString(),
    };
  }

  async downloadUrl(key: string, ttl = 300): Promise<string> {
    return this.signed(key, { op: "get", exp: String(Math.floor(Date.now() / 1000) + ttl) });
  }

  async head(key: string): Promise<StoredObject | null> {
    try {
      const s = await stat(localPath(key));
      const meta = JSON.parse(await readFile(`${localPath(key)}.meta.json`, "utf8"));
      return { size: s.size, contentType: meta.contentType };
    } catch {
      return null;
    }
  }
}

export async function writeLocal(key: string, data: Buffer, contentType: string) {
  const file = localPath(key);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
  await writeFile(`${file}.meta.json`, JSON.stringify({ contentType }));
}

export const storage: Storage = env.STORAGE_DRIVER === "s3" ? new S3Storage() : new LocalStorage();
export const createS3Storage = () => new S3Storage();
