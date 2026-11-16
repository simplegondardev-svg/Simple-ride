import { describe, expect, it } from "vitest";
import {
  assertTestDatabaseIsolation,
  assertTestRedisIsolation,
  getVerifiedDatabaseUrl,
  getVerifiedRedisUrl,
} from "../src/db/isolation.js";

describe("Test Database Isolation Guards (CP2.5)", () => {
  it("rejects undefined or empty TEST_DATABASE_URL", () => {
    expect(() => assertTestDatabaseIsolation("")).toThrow(/TEST_DATABASE_URL is required/);
    expect(() => assertTestDatabaseIsolation(undefined)).toThrow(/TEST_DATABASE_URL is required/);
    expect(() => assertTestDatabaseIsolation("   ")).toThrow(/TEST_DATABASE_URL is required/);
  });

  it("rejects non-postgres protocols", () => {
    expect(() =>
      assertTestDatabaseIsolation("mysql://simpleride_app:pass@localhost:5434/simpleride_test"),
    ).toThrow(/Protocol must be postgres:/);
    expect(() =>
      assertTestDatabaseIsolation("http://localhost:5434/simpleride_test"),
    ).toThrow(/Protocol must be postgres:/);
  });

  it("rejects remote database hosts", () => {
    expect(() =>
      assertTestDatabaseIsolation("postgres://simpleride_app:pass@remote-db.production.internal:5434/simpleride_test"),
    ).toThrow(/Remote database target rejected/);
    expect(() =>
      assertTestDatabaseIsolation("postgres://simpleride_app:pass@aws-rds.amazonaws.com:5434/simpleride_test"),
    ).toThrow(/Remote database target rejected/);
    expect(() =>
      assertTestDatabaseIsolation("postgres://simpleride_app:pass@192.168.1.100:5434/simpleride_test"),
    ).toThrow(/Remote database target rejected/);
  });

  it("rejects ports other than 5434", () => {
    expect(() =>
      assertTestDatabaseIsolation("postgres://simpleride_app:pass@localhost:5432/simpleride_test"),
    ).toThrow(/Expected local port 5434/);
    expect(() =>
      assertTestDatabaseIsolation("postgres://simpleride_app:pass@localhost:5433/simpleride_test"),
    ).toThrow(/Expected local port 5434/);
  });

  it("strictly rejects the development database (simpleride)", () => {
    expect(() =>
      assertTestDatabaseIsolation("postgres://simpleride_app:pass@localhost:5434/simpleride"),
    ).toThrow(/Target database name must be exactly 'simpleride_test'/);
  });

  it("rejects other database names like postgres or production", () => {
    expect(() =>
      assertTestDatabaseIsolation("postgres://simpleride_app:pass@localhost:5434/postgres"),
    ).toThrow(/Target database name must be exactly 'simpleride_test'/);
    expect(() =>
      assertTestDatabaseIsolation("postgres://simpleride_app:pass@localhost:5434/production"),
    ).toThrow(/Target database name must be exactly 'simpleride_test'/);
  });

  it("accepts valid local simpleride_test targets with localhost", () => {
    const valid = "postgres://simpleride_app:secret123@localhost:5434/simpleride_test";
    expect(assertTestDatabaseIsolation(valid)).toBe(valid);
  });

  it("accepts valid local simpleride_test targets with 127.0.0.1", () => {
    const valid = "postgres://simpleride_app:secret123@127.0.0.1:5434/simpleride_test";
    expect(assertTestDatabaseIsolation(valid)).toBe(valid);
  });
});

describe("Test Redis Isolation Guards (CP2.5)", () => {
  it("rejects non-DB15 Redis URLs", () => {
    expect(() => assertTestRedisIsolation("redis://localhost:6379/0")).toThrow(
      /Redis test operations must be confined to DB 15/,
    );
    expect(() => assertTestRedisIsolation("redis://localhost:6379/1")).toThrow(
      /Redis test operations must be confined to DB 15/,
    );
    expect(() => assertTestRedisIsolation("redis://localhost:6379")).toThrow(
      /Redis test operations must be confined to DB 15/,
    );
  });

  it("rejects remote Redis hosts", () => {
    expect(() => assertTestRedisIsolation("redis://redis.production.internal:6379/15")).toThrow(
      /Remote Redis target rejected/,
    );
  });

  it("accepts localhost Redis with DB 15", () => {
    const valid = "redis://localhost:6379/15";
    expect(assertTestRedisIsolation(valid)).toBe(valid);
  });

  it("accepts 127.0.0.1 Redis with DB 15", () => {
    const valid = "redis://127.0.0.1:6379/15";
    expect(assertTestRedisIsolation(valid)).toBe(valid);
  });
});
