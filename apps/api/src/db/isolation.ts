/**
 * Test Database & Redis Isolation Guards (CP2.5)
 *
 * Enforces strict boundaries for integration tests:
 * - Requires explicit TEST_DATABASE_URL in test mode.
 * - Rejects development ('simpleride'), production, and remote database targets.
 * - Confines test database strictly to 'simpleride_test' on local port 5434.
 * - Confines Redis operations strictly to DB 15 (redis://.../15).
 * - Fails safely before any database connection or fixture mutation.
 */

const EXPECTED_TEST_DB_NAME = "simpleride_test";
const EXPECTED_TEST_PORT = "5434";
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function assertTestDatabaseIsolation(rawUrl?: string): string {
  const urlString = rawUrl ?? process.env.TEST_DATABASE_URL;

  if (!urlString || urlString.trim() === "") {
    throw new Error(
      "Test database isolation failure: TEST_DATABASE_URL is required for integration tests. " +
      "Tests cannot use the ordinary development DATABASE_URL."
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch (err: any) {
    throw new Error(`Test database isolation failure: Invalid TEST_DATABASE_URL format: ${err.message}`);
  }

  // 1. Verify protocol
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `Test database isolation failure: Protocol must be postgres:, received '${parsed.protocol}'`
    );
  }

  // 2. Verify local host only
  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(
      `Test database isolation failure: Remote database target rejected ('${hostname}'). ` +
      "Only local test database (localhost / 127.0.0.1) is permitted."
    );
  }

  // 3. Verify expected container port (5434)
  const port = parsed.port || "5432";
  if (port !== EXPECTED_TEST_PORT) {
    throw new Error(
      `Test database isolation failure: Expected local port ${EXPECTED_TEST_PORT} for test database container, ` +
      `received port '${port}'.`
    );
  }

  // 4. Verify database name is strictly simpleride_test
  const dbName = parsed.pathname.replace(/^\//, "");
  if (dbName !== EXPECTED_TEST_DB_NAME) {
    throw new Error(
      `Test database isolation failure: Target database name must be exactly '${EXPECTED_TEST_DB_NAME}', ` +
      `received '${dbName}'. Development ('simpleride') and production databases are strictly rejected.`
    );
  }

  return urlString;
}

export function assertTestRedisIsolation(rawUrl?: string): string {
  const urlString = rawUrl ?? process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379/15";

  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch (err: any) {
    throw new Error(`Test Redis isolation failure: Invalid Redis URL format: ${err.message}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) {
    throw new Error(
      `Test Redis isolation failure: Remote Redis target rejected ('${hostname}'). Only localhost / 127.0.0.1 is permitted.`
    );
  }

  const dbIndex = parsed.pathname.replace(/^\//, "");
  if (dbIndex !== "15") {
    throw new Error(
      `Test Redis isolation failure: Redis test operations must be confined to DB 15, received DB '${dbIndex}'.`
    );
  }

  return urlString;
}

/**
 * Returns the verified connection string for the runtime pg.Pool.
 * In test mode, strictly enforces TEST_DATABASE_URL isolation.
 */
export function getVerifiedDatabaseUrl(defaultUrl?: string): string {
  if (process.env.NODE_ENV === "test") {
    return assertTestDatabaseIsolation(process.env.TEST_DATABASE_URL);
  }
  if (!defaultUrl || defaultUrl.trim() === "") {
    throw new Error("DATABASE_URL must be specified.");
  }
  return defaultUrl;
}

/**
 * Returns the verified Redis connection string for ioredis.
 * In test mode, strictly enforces DB 15 isolation.
 */
export function getVerifiedRedisUrl(defaultUrl?: string): string {
  if (process.env.NODE_ENV === "test") {
    return assertTestRedisIsolation(process.env.TEST_REDIS_URL ?? defaultUrl);
  }
  return defaultUrl ?? "redis://localhost:6379";
}
