import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRecipe } from "./index.js";

// Minimal harness for a NATIVE `vmc` equipment (spec 153): the vmc slot holds a
// single equipment of type "vmc" driven through its `speed` order.
function makeBinding(alias: string, category: string, value: unknown) {
  let override: string | null = null;
  return {
    alias,
    category,
    value,
    get lastUpdated() {
      return override ?? new Date().toISOString();
    },
    set lastUpdated(v: string | null) {
      override = v;
    },
  };
}

function makeCtx() {
  const handlers: Array<(e: any) => void> = [];
  const orders: Array<{ equipmentId: string; alias: string; value: unknown }> = [];
  const stateMap = new Map<string, unknown>();

  const equipments: Record<string, any> = {
    "vmc-1": {
      name: "VMC",
      type: "vmc",
      // Native VMC exposes its two relay states; orders are the logical `speed`.
      dataBindings: [makeBinding("low", "light_state", "OFF"), makeBinding("high", "light_state", "OFF")],
      orderBindings: [{ alias: "low", category: "toggle_power", type: "boolean" }],
    },
    "room-1": {
      name: "SDB",
      dataBindings: [makeBinding("humidity", "humidity", 55), makeBinding("temperature", "temperature", 21)],
      orderBindings: [],
    },
  };

  const ctx = {
    eventBus: { onType: (_t: string, h: any) => { handlers.push(h); return () => {}; } },
    equipmentManager: { getByIdWithDetails: (id: string) => equipments[id] ?? null },
    zoneManager: { getById: (id: string) => (id === "zone-1" ? { id, name: "M" } : null) },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    state: {
      get: (k: string) => stateMap.get(k),
      set: (k: string, v: unknown) => stateMap.set(k, v),
      delete: (k: string) => stateMap.delete(k),
      clear: () => stateMap.clear(),
    },
    log: () => {},
    helpers: {
      parseDuration: (v: unknown) => {
        const m = /^(\d+)([smh])$/.exec(String(v));
        if (!m) return 0;
        const mult = { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
        return Number(m[1]) * mult;
      },
      formatDuration: (ms: number) => `${Math.round(ms / 60_000)}min`,
    },
    dispatchOrder: (equipmentId: string, alias: string, value: unknown) => {
      orders.push({ equipmentId, alias, value });
      return Promise.resolve({ success: true });
    },
  };

  const emit = (equipmentId: string, alias: string, value: unknown) => {
    const b = equipments[equipmentId]?.dataBindings.find((x: any) => x.alias === alias);
    if (b) { b.value = value; b.lastUpdated = null; }
    for (const h of [...handlers]) h({ type: "equipment.data.changed", equipmentId, alias, value });
  };

  return { ctx, orders, state: stateMap, emit };
}

const baseParams = {
  zone: "zone-1",
  sensors: ["room-1"],
  vmc: "vmc-1",
  humidityMax: 60,
  humidityMin: 50,
  boostDelta: 5,
  minRun: "15m",
  maxRun: "3h",
};

/** Speed orders sent to the native VMC. */
const speeds = (orders: Array<{ equipmentId: string; alias: string; value: unknown }>) =>
  orders.filter((o) => o.equipmentId === "vmc-1" && o.alias === "speed").map((o) => o.value);

describe("native vmc equipment (spec 153)", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date("2026-01-14T10:00:00") }));
  afterEach(() => vi.useRealTimers());

  it("validates a native vmc without a high-speed equipment", () => {
    const h = makeCtx();
    expect(() => createRecipe().validate(baseParams, h.ctx as never)).not.toThrow();
  });

  it("stays silent at startup when idle (never forces an OFF)", () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    expect(speeds(h.orders)).toEqual([]);
    inst.stop();
  });

  it("drives v1 above the max, v2 above the boost margin, off under the target", () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);

    h.emit("room-1", "humidity", 62); // > max (60), < boost (65)
    expect(speeds(h.orders)).toEqual(["v1"]);

    h.emit("room-1", "humidity", 70); // >= max + boostDelta -> high
    expect(speeds(h.orders)).toEqual(["v1", "v2"]);

    // Below the boost threshold the speed steps back down to v1 while min-run
    // still holds the cycle on, then off once it is under the target and the
    // minimum run has elapsed.
    h.emit("room-1", "humidity", 45);
    expect(speeds(h.orders)).toEqual(["v1", "v2", "v1"]);
    vi.advanceTimersByTime(16 * 60_000); // outlast minRun -> stop
    expect(speeds(h.orders)).toEqual(["v1", "v2", "v1", "off"]);

    // State reflects the speed.
    expect(h.state.get("vmcSpeed")).toBe("off");
    inst.stop();
  });

  it("ignores the two-speed / boost slots on a native unit", () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance(
      { ...baseParams, twoSpeed: "on", vmcBoost: "does-not-exist", alwaysOn: "on" },
      h.ctx as never,
    );
    h.emit("room-1", "humidity", 70);
    // Still one native equipment driven by a single speed order (no boost equipment).
    expect(h.orders.every((o) => o.equipmentId === "vmc-1" && o.alias === "speed")).toBe(true);
    expect(speeds(h.orders)).toEqual(["v2"]);
    inst.stop();
  });
});
