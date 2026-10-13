import { describe, expect, it } from "vitest";
import { normalizeEthiopianPhone } from "../src/lib/phone.js";
import { estimateRoute, toLngLatPath } from "../src/modules/geo/gebeta.js";
import { calculateFare } from "../src/modules/pricing/fare.js";
import { canTransition } from "../src/modules/trips/state-machine.js";
import { BOLE, PIASSA } from "./helpers.js";

describe("normalizeEthiopianPhone", () => {
  it.each([
    ["0911223344", "+251911223344"],
    ["911223344", "+251911223344"],
    ["+251 911 22 33 44", "+251911223344"],
    ["251711223344", "+251711223344"],
    ["0711-22-33-44", "+251711223344"],
  ])("%s → %s", (input, out) => expect(normalizeEthiopianPhone(input)).toBe(out));

  it.each(["0811223344", "12345", "+254711223344", "09112233445"])("rejects %s", (input) =>
    expect(normalizeEthiopianPhone(input)).toBeNull(),
  );
});

describe("calculateFare", () => {
  const rules = { baseFare: 6000, perKm: 2200, perMinute: 200, minimumFare: 15000, bookingFee: 0, commissionBps: 1000 };

  it("meters distance and time, rounds up to a whole birr", () => {
    // 60 + 7.5km*22 + 20min*2 = 60 + 165 + 40 = 265 ETB
    const f = calculateFare(rules, 7500, 1200);
    expect(f.total).toBe(26500);
    expect(f.commission).toBe(2650);
  });

  it("applies the minimum fare", () => {
    expect(calculateFare(rules, 500, 60).total).toBe(15000);
  });

  it("applies zone multiplier before booking fee and rounds up", () => {
    const f = calculateFare({ ...rules, bookingFee: 1000 }, 7500, 1200, 1.5);
    expect(f.total).toBe(Math.ceil((26500 * 1.5 + 1000) / 100) * 100);
  });
});

describe("trip state machine", () => {
  it("only the dispatcher (system) accepts", () => {
    expect(canTransition("searching", "accept", "system")).toBe(true);
    expect(canTransition("searching", "accept", "driver")).toBe(false);
  });
  it("cannot cancel once the ride has started", () => {
    expect(canTransition("arrived", "cancel", "customer")).toBe(true);
    expect(canTransition("in_progress", "cancel", "customer")).toBe(false);
  });
  it("must arrive before starting", () => {
    expect(canTransition("accepted", "start", "driver")).toBe(false);
  });
});

describe("gebeta helpers", () => {
  it("detects [lat,lng] vs [lng,lat] path order inside Ethiopia", () => {
    expect(toLngLatPath([[8.99, 38.78], [9.03, 38.75]])).toEqual([[38.78, 8.99], [38.75, 9.03]]);
    expect(toLngLatPath([[38.78, 8.99]])).toEqual([[38.78, 8.99]]);
    expect(toLngLatPath("nope")).toEqual([]);
  });

  it("fallback estimate is plausible for Bole → Piassa (~5.7 km straight line)", () => {
    const r = estimateRoute(BOLE, PIASSA);
    expect(r.distanceM).toBeGreaterThan(7000);
    expect(r.distanceM).toBeLessThan(9000);
    expect(r.source).toBe("estimate");
  });
});
