import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { withContext } from "../../db/context.js";
import { notFound } from "../../lib/errors.js";

export const usersRouter = Router();
usersRouter.use(requireAuth);

const ME = `id, phone, role, status, full_name AS "fullName", email, locale, created_at AS "createdAt"`;


// Request schemas (exported: the OpenAPI spec is built from them).
export const updateMeBody = z
  .object({
    fullName: z.string().trim().min(2).max(100).optional(),
    email: z.email().optional(),
    locale: z.enum(["am", "en", "om", "ti"]).optional(),
  });
export const pushTokenBody = z
  .object({ token: z.string().min(10).max(4096), platform: z.enum(["web", "android", "ios"]) });

usersRouter.get("/me", async (req, res) => {
  const user = await withContext(req.ctx, async (db) => {
    const { rows } = await db.query(`SELECT ${ME} FROM users WHERE id = app.uid()`);
    return rows[0];
  });
  if (!user) throw notFound("User");
  res.json(user);
});

usersRouter.patch("/me", async (req, res) => {
  const body = updateMeBody.parse(req.body);
  const user = await withContext(req.ctx, async (db) => {
    const { rows } = await db.query(
      `UPDATE users SET full_name = coalesce($1, full_name), email = coalesce($2, email),
              locale = coalesce($3, locale)
        WHERE id = app.uid() RETURNING ${ME}`,
      [body.fullName ?? null, body.email ?? null, body.locale ?? null],
    );
    return rows[0];
  });
  res.json(user);
});

usersRouter.put("/me/push-token", async (req, res) => {
  const body = pushTokenBody.parse(req.body);
  await withContext(req.ctx, (db) =>
    db.query(
      `INSERT INTO push_tokens (token, user_id, platform) VALUES ($1, app.uid(), $2)
       ON CONFLICT (token) DO UPDATE SET user_id = app.uid(), platform = $2, updated_at = now()`,
      [body.token, body.platform],
    ),
  );
  res.status(204).end();
});

usersRouter.get("/me/wallet", async (req, res) => {
  const wallet = await withContext(req.ctx, async (db) => {
    const w = await db.query("SELECT balance, currency FROM wallets WHERE user_id = app.uid()");
    const t = await db.query(
      `SELECT id, amount, balance_after AS "balanceAfter", kind, trip_id AS "tripId", created_at AS "createdAt"
         FROM wallet_transactions
        WHERE user_id = app.uid() ORDER BY id DESC LIMIT 20`,
    );
    return { ...(w.rows[0] ?? { balance: 0, currency: "ETB" }), transactions: t.rows };
  });
  res.json(wallet);
});
