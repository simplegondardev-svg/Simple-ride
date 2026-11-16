import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(".env");
} catch {
  // CI provides env vars directly
}

export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      OTP_DEV_ECHO: "true",
      // Separate Redis DB so tests can flush it freely, strictly confined to DB 15
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
      TEST_REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
      // Crucial: do NOT leak dev DATABASE_URL from .env into tests.
      // Forward TEST_DATABASE_URL if explicitly set; otherwise provide safe isolated placeholder.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://isolated_test_unconfigured:5434/simpleride_test",
      GEBETA_API_KEY: "", // never call the paid API from tests
    },
    // Tests share one database; run files serially to keep fixtures isolated.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
