import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { logger } from "./logger.js";

/**
 * Every error response has the same shape so web and Flutter clients can
 * handle them uniformly:
 *   { "error": { "code": "TRIP_NOT_FOUND", "message": "...", "details"?: ... } }
 * `code` is stable and machine-readable; `message` is for developers.
 */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") =>
  new AppError(404, "NOT_FOUND", `${what} not found`);
export const forbidden = (message = "Forbidden") => new AppError(403, "FORBIDDEN", message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);

export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: { code: "ROUTE_NOT_FOUND", message: "Route not found" } });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(422).json({
      error: { code: "VALIDATION_FAILED", message: "Invalid request", details: err.issues },
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }
  // Postgres insufficient_privilege: an RLS policy or column guard said no.
  if (err?.code === "42501") {
    res.status(403).json({ error: { code: "FORBIDDEN", message: "Not allowed" } });
    return;
  }
  // unique_violation that a route didn't translate into a specific code.
  if (err?.code === "23505") {
    res.status(409).json({ error: { code: "ALREADY_EXISTS", message: "Already exists" } });
    return;
  }
  logger.error({ err, path: req.path }, "unhandled error");
  res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
};
