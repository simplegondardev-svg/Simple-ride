import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  DATABASE_URL: z.string().url(),
  DATABASE_OWNER_URL: z.string().url().optional(),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Admin/staff sessions are absolute: re-enter the password after this.
  BACKOFFICE_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),

  OTP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  OTP_DEV_ECHO: bool.default(false),

  GEBETA_API_KEY: z.string().default(""),
  GEBETA_BASE_URL: z.string().url().default("https://mapapi.gebeta.app"),

  SEED_ADMIN_PHONE: z.string().default("+251900000000"),

  // Public base URL of this API, used to build signed file URLs (local storage).
  PUBLIC_API_URL: z.string().url().optional(),
  // Document storage: "local" (dev, files under STORAGE_DIR) or "s3" (any S3-compatible service).
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_DIR: z.string().default(".storage"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("simple-ride-documents"),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(true),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment:", z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;

if (env.STORAGE_DRIVER === "s3" && (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) {
  throw new Error("STORAGE_DRIVER=s3 needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY");
}

if (env.NODE_ENV === "production" && env.OTP_DEV_ECHO) {
  throw new Error("OTP_DEV_ECHO must be false in production");
}
