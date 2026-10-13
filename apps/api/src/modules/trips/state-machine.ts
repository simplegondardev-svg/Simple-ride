export type TripStatus =
  | "searching" | "accepted" | "arrived" | "in_progress" | "completed" | "cancelled" | "expired";

export type TripAction = "accept" | "arrive" | "start" | "complete" | "cancel" | "expire";
export type Actor = "customer" | "driver" | "admin" | "system";

interface Transition {
  from: TripStatus[];
  to: TripStatus;
  by: Actor[];
  /** Column stamped with now() when this transition happens. */
  stamp: string;
}

/**
 * The single definition of the trip lifecycle. Endpoints, the dispatcher and
 * (later) the Flutter apps' UI state all follow this table.
 *
 *  searching ─accept─▶ accepted ─arrive─▶ arrived ─start─▶ in_progress ─complete─▶ completed
 *      │                  │                  │
 *      ├─expire─▶ expired └──────cancel──────┴──▶ cancelled   (no cancel once in_progress)
 */
export const TRANSITIONS: Record<TripAction, Transition> = {
  accept:   { from: ["searching"], to: "accepted", by: ["system"], stamp: "accepted_at" },
  arrive:   { from: ["accepted"], to: "arrived", by: ["driver", "admin"], stamp: "arrived_at" },
  start:    { from: ["arrived"], to: "in_progress", by: ["driver", "admin"], stamp: "started_at" },
  complete: { from: ["in_progress"], to: "completed", by: ["driver", "admin"], stamp: "completed_at" },
  cancel:   { from: ["searching", "accepted", "arrived"], to: "cancelled",
              by: ["customer", "driver", "admin", "system"], stamp: "cancelled_at" },
  expire:   { from: ["searching"], to: "expired", by: ["system"], stamp: "cancelled_at" },
};

export const ACTIVE_STATUSES: TripStatus[] = ["searching", "accepted", "arrived", "in_progress"];

export function canTransition(from: TripStatus, action: TripAction, actor: Actor): boolean {
  const t = TRANSITIONS[action];
  return t.from.includes(from) && t.by.includes(actor);
}
