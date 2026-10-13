import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../src/config/env.js";
import { redis } from "../src/lib/redis.js";
import { createS3Storage } from "../src/lib/storage.js";
import { pool } from "../src/db/pool.js";
import { PNG } from "./helpers.js";

/**
 * The production storage driver against a real S3-compatible server.
 * Runs when TEST_S3_ENDPOINT is set (CI starts one; locally e.g. `moto_server -p 9000`).
 */
const endpoint = process.env.TEST_S3_ENDPOINT;

describe.skipIf(!endpoint)("S3 storage driver", () => {
  beforeAll(async () => {
    Object.assign(env, {
      S3_ENDPOINT: endpoint, S3_REGION: "us-east-1", S3_BUCKET: "simple-ride-test",
      S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test", S3_FORCE_PATH_STYLE: true,
    });
    const s3 = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" } });
    await s3.send(new CreateBucketCommand({ Bucket: "simple-ride-test" })).catch(() => {});
  });
  afterAll(async () => {
    await pool.end();
    redis.disconnect();
  });

  it("presigned upload → head → presigned download round-trips the file", async () => {
    const storage = createS3Storage();
    const key = `drivers/test/${Date.now()}`;
    expect(await storage.head(key)).toBeNull();

    const up = await storage.uploadUrl(key, "image/png", PNG.length);
    const put = await fetch(up.url, { method: "PUT", headers: up.headers, body: PNG });
    expect(put.status).toBe(200);

    expect(await storage.head(key)).toEqual({ size: PNG.length, contentType: "image/png" });

    const got = await fetch(await storage.downloadUrl(key));
    expect(got.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await got.arrayBuffer()), PNG)).toBe(0);
  });
});
