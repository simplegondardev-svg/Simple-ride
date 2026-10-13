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
      // Separate Redis DB so tests can flush it freely
      REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15",
      GEBETA_API_KEY: "", // never call the paid API from tests
    },
    // Tests share one database; run files serially to keep fixtures isolated.
    fileParallelism: false,
    testTimeout: 15000,
  },
});
