import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createRecipe,
  flagOn,
  isTwoSpeed,
  psat,
  ventilationFloor,
  hmToMinutes,
  inWindow,
  findPowerOrderAlias,
  isMotionDetected,
} from "./index.js";

// ============================================================
// Test harness — fake RecipeContext
// ============================================================

type Handler = (event: Record<string, unknown>) => void;

interface RoomSpec {
  id: string;
  name: string;
  humidity: number | null;
  temperature?: number | null;
  lastUpdated?: string;
}

function makeCtx(opts?: {
  rooms?: RoomSpec[];
  outdoor?: { humidity: number | null; temperature?: number | null };
  withBoost?: boolean;
  motion?: Array<{ id: string; name: string }>;
  vmcOrders?: Array<{ alias: string; category?: string; type?: string }>;
}) {
  const handlers: Handler[] = [];
  const stateMap = new Map<string, unknown>();
  const orders: Array<{ equipmentId: string; alias: string; value: unknown }> = [];
  const logs: string[] = [];

  const rooms = opts?.rooms ?? [
    { id: "room-1", name: "Salle de bain", humidity: 55, temperature: 21 },
  ];

  /**
   * A data binding whose `lastUpdated` follows the (fake) clock, like a sensor
   * that keeps reporting. `lastUpdated` can be frozen to an old timestamp to
   * simulate a dead sensor; writing to it (as `emit` does) un-freezes it.
   */
  function makeBinding(
    alias: string,
    category: string,
    value: unknown,
    frozenAt?: string,
  ): { alias: string; category: string; value: unknown; lastUpdated: string | null } {
    let override = frozenAt ?? null;
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

  const equipments: Record<string, {
    name: string;
    dataBindings: Array<{ alias: string; category?: string; value?: unknown; lastUpdated?: string | null }>;
    orderBindings: Array<{ alias: string; category?: string; type?: string }>;
  }> = {
    "vmc-1": {
      name: "VMC",
      dataBindings: [],
      orderBindings: opts?.vmcOrders ?? [{ alias: "state", category: "toggle_power", type: "boolean" }],
    },
  };

  if (opts?.withBoost) {
    equipments["boost-1"] = {
      name: "VMC GV",
      dataBindings: [],
      orderBindings: [{ alias: "state", category: "toggle_power", type: "boolean" }],
    };
  }

  for (const r of rooms) {
    equipments[r.id] = {
      name: r.name,
      dataBindings: [
        makeBinding("humidity", "humidity", r.humidity, r.lastUpdated),
        ...(r.temperature === undefined
          ? []
          : [makeBinding("temperature", "temperature", r.temperature)]),
      ],
      orderBindings: [],
    };
  }

  for (const m of opts?.motion ?? []) {
    equipments[m.id] = {
      name: m.name,
      dataBindings: [makeBinding("motion", "motion", false)],
      orderBindings: [],
    };
  }

  if (opts?.outdoor) {
    equipments["out-1"] = {
      name: "Station météo",
      dataBindings: [
        makeBinding("humidity", "humidity_outdoor", opts.outdoor.humidity),
        ...(opts.outdoor.temperature === undefined
          ? []
          : [makeBinding("temperature", "temperature_outdoor", opts.outdoor.temperature)]),
      ],
      orderBindings: [],
    };
  }

  const ctx = {
    eventBus: {
      onType: (_type: string, h: Handler) => {
        handlers.push(h);
        return () => {
          const i = handlers.indexOf(h);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
    },
    equipmentManager: {
      getByIdWithDetails: (id: string) => equipments[id] ?? null,
    },
    zoneManager: { getById: (id: string) => (id === "zone-1" ? { id, name: "Maison" } : null) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    state: {
      get: (k: string) => stateMap.get(k),
      set: (k: string, v: unknown) => stateMap.set(k, v),
      delete: (k: string) => stateMap.delete(k),
      clear: () => stateMap.clear(),
    },
    log: (m: string) => logs.push(m),
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

  // Core persists the new value before emitting the event — the harness does
  // the same, otherwise the recipe's re-read would undo every emitted change.
  const emit = (equipmentId: string, alias: string, value: unknown) => {
    const binding = equipments[equipmentId]?.dataBindings.find((b) => b.alias === alias);
    if (binding) {
      binding.value = value;
      binding.lastUpdated = null; // follow the clock again
    }
    for (const h of [...handlers]) {
      h({ type: "equipment.data.changed", equipmentId, alias, value, previous: undefined });
    }
  };

  return { ctx, orders, logs, state: stateMap, emit, handlers };
}

const baseParams = {
  zone: "zone-1",
  sensors: ["room-1"],
  vmc: "vmc-1",
  humidityMax: 60,
  humidityMin: 50,
  minRun: "15m",
  maxRun: "3h",
};

/** Orders sent to the main VMC equipment. */
const vmcOrders = (orders: Array<{ equipmentId: string; value: unknown }>) =>
  orders.filter((o) => o.equipmentId === "vmc-1").map((o) => o.value);
const boostOrders = (orders: Array<{ equipmentId: string; value: unknown }>) =>
  orders.filter((o) => o.equipmentId === "boost-1").map((o) => o.value);

beforeEach(() => {
  vi.useFakeTimers();
  // A Wednesday at 10:00 — outside any default quiet window.
  vi.setSystemTime(new Date("2026-01-14T10:00:00"));
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// Pure helpers
// ============================================================

describe("psychrometry", () => {
  it("psat grows with temperature and matches known values", () => {
    expect(psat(0)).toBeCloseTo(6.11, 1);
    expect(psat(20)).toBeCloseTo(23.4, 0);
    expect(psat(20)).toBeGreaterThan(psat(5));
  });

  it("cold humid outdoor air is dry once warmed indoors", () => {
    // 90 %RH at 5 °C, heated to 20 °C → ~34 %RH
    const floor = ventilationFloor(90, 5, 20);
    expect(floor).not.toBeNull();
    expect(floor as number).toBeGreaterThan(30);
    expect(floor as number).toBeLessThan(40);
  });

  it("warm humid outdoor air is wetter than the room", () => {
    // 70 %RH at 25 °C, cooled to 22 °C → ~84 %RH
    const floor = ventilationFloor(70, 25, 22) as number;
    expect(floor).toBeGreaterThan(80);
  });

  it("falls back to the raw outdoor RH without temperatures", () => {
    expect(ventilationFloor(72, null, 21)).toBe(72);
    expect(ventilationFloor(72, 10, null)).toBe(72);
  });

  it("returns null when the outdoor humidity is unknown", () => {
    expect(ventilationFloor(null, 10, 20)).toBeNull();
  });

  it("clamps to 0–100", () => {
    expect(ventilationFloor(95, 30, 5) as number).toBe(100);
  });
});

describe("time helpers", () => {
  it("parses HH:MM and rejects garbage", () => {
    expect(hmToMinutes("22:00")).toBe(1320);
    expect(hmToMinutes("07:30")).toBe(450);
    expect(Number.isNaN(hmToMinutes("25:00"))).toBe(true);
    expect(Number.isNaN(hmToMinutes("abc"))).toBe(true);
  });

  it("handles windows wrapping past midnight", () => {
    expect(inWindow(23 * 60, 1320, 420)).toBe(true); // 23:00 in 22:00→07:00
    expect(inWindow(3 * 60, 1320, 420)).toBe(true); // 03:00
    expect(inWindow(10 * 60, 1320, 420)).toBe(false); // 10:00
    expect(inWindow(10 * 60, 540, 720)).toBe(true); // 10:00 in 09:00→12:00
  });
});

describe("findPowerOrderAlias", () => {
  it("prefers the toggle_power category, then known aliases", () => {
    expect(
      findPowerOrderAlias({
        name: "x",
        dataBindings: [],
        orderBindings: [{ alias: "relay", category: "toggle_power" }],
      }),
    ).toBe("relay");
    expect(
      findPowerOrderAlias({ name: "x", dataBindings: [], orderBindings: [{ alias: "state" }] }),
    ).toBe("state");
    expect(findPowerOrderAlias({ name: "x", dataBindings: [], orderBindings: [] })).toBeNull();
  });
});

// ============================================================
// validate()
// ============================================================

describe("validate", () => {
  it("accepts a complete configuration", () => {
    const { ctx } = makeCtx({ outdoor: { humidity: 80, temperature: 5 } });
    expect(() =>
      createRecipe().validate({ ...baseParams, outdoorSensor: "out-1" }, ctx as never),
    ).not.toThrow();
  });

  it("rejects a sensor without humidity", () => {
    const { ctx } = makeCtx({ rooms: [{ id: "room-1", name: "Salon", humidity: null }] });
    // Strip the humidity binding by pointing at the VMC (no humidity at all).
    expect(() =>
      createRecipe().validate({ ...baseParams, sensors: ["vmc-1"] }, ctx as never),
    ).toThrow(/humidity/i);
  });

  it("rejects an empty sensor list", () => {
    const { ctx } = makeCtx();
    expect(() => createRecipe().validate({ ...baseParams, sensors: [] }, ctx as never)).toThrow(
      /at least one/i,
    );
  });

  it("rejects a ventilation without on/off order", () => {
    const { ctx } = makeCtx({ vmcOrders: [] });
    expect(() => createRecipe().validate(baseParams, ctx as never)).toThrow(/on\/off/i);
  });

  it("rejects target ≥ maximum", () => {
    const { ctx } = makeCtx();
    expect(() =>
      createRecipe().validate({ ...baseParams, humidityMin: 60 }, ctx as never),
    ).toThrow(/lower than/i);
  });

  it("rejects minRun ≥ maxRun", () => {
    const { ctx } = makeCtx();
    expect(() =>
      createRecipe().validate({ ...baseParams, minRun: "3h", maxRun: "1h" }, ctx as never),
    ).toThrow(/shorter/i);
  });

  it("rejects permanent low speed on a single-speed unit", () => {
    const { ctx } = makeCtx();
    expect(() =>
      createRecipe().validate({ ...baseParams, alwaysOn: "on" }, ctx as never),
    ).toThrow(/two-speed/i);
  });

  it("rejects a two-speed unit with no high-speed equipment", () => {
    const { ctx } = makeCtx();
    expect(() =>
      createRecipe().validate({ ...baseParams, twoSpeed: "on" }, ctx as never),
    ).toThrow(/high-speed/i);
  });

  it("rejects an unknown zone", () => {
    const { ctx } = makeCtx();
    expect(() => createRecipe().validate({ ...baseParams, zone: "nope" }, ctx as never)).toThrow(
      /Zone not found/,
    );
  });

  it("rejects a bad quiet window", () => {
    const { ctx } = makeCtx();
    expect(() =>
      createRecipe().validate(
        { ...baseParams, quietMode: "on", quietStart: "99:99" },
        ctx as never,
      ),
    ).toThrow(/HH:MM/);
  });
});

// ============================================================
// Core behaviour
// ============================================================

describe("start / stop hysteresis", () => {
  it("starts when a room exceeds the maximum and stops when it is back under the target", () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);

    expect(vmcOrders(h.orders)).toEqual([]); // 55 % → idle

    h.emit("room-1", "humidity", 65);
    expect(vmcOrders(h.orders)).toEqual([true]);

    // Below the max but above the target: keep running (past minRun).
    vi.advanceTimersByTime(16 * 60_000);
    h.emit("room-1", "humidity", 55);
    expect(vmcOrders(h.orders)).toEqual([true]);

    h.emit("room-1", "humidity", 48);
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });

  it("keeps running while ANY room is still above the target", () => {
    const h = makeCtx({
      rooms: [
        { id: "room-1", name: "SDB", humidity: 65, temperature: 21 },
        { id: "room-2", name: "Cuisine", humidity: 58, temperature: 21 },
      ],
    });
    const inst = createRecipe().createInstance(
      { ...baseParams, sensors: ["room-1", "room-2"] },
      h.ctx as never,
    );
    expect(vmcOrders(h.orders)).toEqual([true]); // seeded above the max

    vi.advanceTimersByTime(16 * 60_000);
    h.emit("room-1", "humidity", 45); // SDB done, cuisine still at 58
    expect(vmcOrders(h.orders)).toEqual([true]);

    h.emit("room-2", "humidity", 49);
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });

  it("does not re-send an order when the value is unchanged", () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    h.emit("room-1", "humidity", 65);
    h.emit("room-1", "humidity", 65); // edge guard
    vi.advanceTimersByTime(5 * 60_000); // clock ticks
    expect(vmcOrders(h.orders)).toEqual([true]);
    inst.stop();
  });
});

describe("run-time guards", () => {
  it("honours the minimum run time", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 21 }] });
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(5 * 60_000);
    h.emit("room-1", "humidity", 40); // target reached far too early
    expect(vmcOrders(h.orders)).toEqual([true]); // still running

    vi.advanceTimersByTime(11 * 60_000); // past minRun → the clock stops it
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });

  it("forces a stop after the maximum run time and blocks the restart during the cooldown", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 75, temperature: 21 }] });
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(3 * 3_600_000 + 60_000); // > maxRun, humidity never drops
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    expect(h.state.get("status")).toBe("cooldown");

    vi.advanceTimersByTime(30 * 60_000); // still in cooldown
    expect(vmcOrders(h.orders)).toEqual([true, false]);

    vi.advanceTimersByTime(31 * 60_000); // cooldown over → restart
    expect(vmcOrders(h.orders)).toEqual([true, false, true]);
    inst.stop();
  });

  it("never starts during the quiet window and cuts a running cycle short", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 21 }] });
    // Quiet from 10:10 to 07:00 — the instance starts at 10:00, just before.
    const params = { ...baseParams, quietMode: "on", quietStart: "10:10", quietEnd: "07:00" };
    const inst = createRecipe().createInstance(params, h.ctx as never);
    expect(vmcOrders(h.orders)).toEqual([true]); // 10:00, not quiet yet

    vi.advanceTimersByTime(20 * 60_000); // 10:20 — quiet, and past minRun
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    expect(h.state.get("status")).toBe("quiet");

    h.emit("room-1", "humidity", 80); // still quiet → no restart
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });
});

describe("outdoor compensation", () => {
  it("ventilates in winter even at 90 %RH outdoors (cold air is dry once warmed)", () => {
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 20 }],
      outdoor: { humidity: 90, temperature: 5 },
    });
    const inst = createRecipe().createInstance(
      { ...baseParams, outdoorSensor: "out-1" },
      h.ctx as never,
    );
    expect(vmcOrders(h.orders)).toEqual([true]);
    expect(h.state.get("outdoorFloor")).toBeLessThan(40);
    inst.stop();
  });

  it("refuses to ventilate when the outdoor air is wetter than the room", () => {
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 22 }],
      outdoor: { humidity: 70, temperature: 25 }, // floor ≈ 84 %
    });
    const inst = createRecipe().createInstance(
      { ...baseParams, outdoorSensor: "out-1" },
      h.ctx as never,
    );
    expect(vmcOrders(h.orders)).toEqual([]);
    expect(h.state.get("status")).toBe("blocked_outdoor");
    inst.stop();
  });

  it("stops a running cycle when the outdoor air becomes too wet", () => {
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 22 }],
      outdoor: { humidity: 40, temperature: 22 },
    });
    const inst = createRecipe().createInstance(
      { ...baseParams, outdoorSensor: "out-1" },
      h.ctx as never,
    );
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(16 * 60_000);
    h.emit("out-1", "humidity", 95); // floor ≈ 95 % at equal temperatures
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });

  it("raises the effective target to the outdoor floor instead of chasing the configured minimum", () => {
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 22 }],
      outdoor: { humidity: 55, temperature: 22 }, // floor 55 → effective target 58
    });
    const inst = createRecipe().createInstance(
      { ...baseParams, outdoorSensor: "out-1", outdoorMargin: 3 },
      h.ctx as never,
    );
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(16 * 60_000);
    h.emit("room-1", "humidity", 57); // above the 50 % target but under 58 → done
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });
});

describe("two-speed ventilation", () => {
  it("uses the high speed above max + margin and releases it under the maximum", () => {
    const h = makeCtx({
      withBoost: true,
      rooms: [{ id: "room-1", name: "SDB", humidity: 70, temperature: 21 }],
    });
    const inst = createRecipe().createInstance(
      { ...baseParams, twoSpeed: "on", vmcBoost: "boost-1", boostDelta: 5 },
      h.ctx as never,
    );
    expect(vmcOrders(h.orders)).toEqual([true]);
    expect(boostOrders(h.orders)).toEqual([true]); // 70 ≥ 60 + 5

    vi.advanceTimersByTime(16 * 60_000);
    h.emit("room-1", "humidity", 58); // under the max → low speed only
    expect(boostOrders(h.orders)).toEqual([true, false]);
    expect(vmcOrders(h.orders)).toEqual([true]); // still running

    h.emit("room-1", "humidity", 48);
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });

  it("with a permanent low speed, only the high speed is driven", () => {
    const h = makeCtx({
      withBoost: true,
      rooms: [{ id: "room-1", name: "SDB", humidity: 55, temperature: 21 }],
    });
    // Default boostDelta (5): with a permanent low speed, extraction MUST mean
    // the high speed — otherwise a room at 62 % would trigger nothing at all.
    const inst = createRecipe().createInstance(
      { ...baseParams, twoSpeed: "on", vmcBoost: "boost-1", alwaysOn: "on" },
      h.ctx as never,
    );
    expect(vmcOrders(h.orders)).toEqual([true]); // asserted once at start

    h.emit("room-1", "humidity", 65);
    expect(boostOrders(h.orders)).toEqual([true]);
    expect(vmcOrders(h.orders)).toEqual([true]); // never switched off

    vi.advanceTimersByTime(16 * 60_000);
    h.emit("room-1", "humidity", 45);
    expect(boostOrders(h.orders)).toEqual([true, false]);
    expect(vmcOrders(h.orders)).toEqual([true]);
    inst.stop();
  });
});

describe("occupancy (toilets)", () => {
  const motionParams = {
    ...baseParams,
    rooms: undefined,
    motionSensors: ["wc-1"],
    motionConfirm: "1m",
    motionRunAfter: "15m",
    motionMaxRun: "45m",
  };

  /** A dry room, so only the occupancy cycle can move the VMC. */
  const dryCtx = (extra?: Parameters<typeof makeCtx>[0]) =>
    makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 45, temperature: 21 }],
      motion: [{ id: "wc-1", name: "WC" }],
      ...extra,
    });

  it("classifies motion values from any integration", () => {
    for (const v of [true, 1, "ON", "true", "detected", "occupied"]) {
      expect(isMotionDetected(v)).toBe(true);
    }
    for (const v of [false, 0, "OFF", "false", null, undefined, {}]) {
      expect(isMotionDetected(v)).toBe(false);
    }
  });

  it("runs for the whole visit and 15 minutes after the last detection", () => {
    const h = dryCtx();
    const inst = createRecipe().createInstance(motionParams, h.ctx as never);
    expect(vmcOrders(h.orders)).toEqual([]);

    h.emit("wc-1", "motion", true);
    expect(vmcOrders(h.orders)).toEqual([]); // not confirmed yet

    vi.advanceTimersByTime(90_000); // presence held → burst passes the 1 min confirmation
    expect(vmcOrders(h.orders)).toEqual([true]);

    h.emit("wc-1", "motion", false); // the visitor leaves
    vi.advanceTimersByTime(14 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true]); // still extracting

    vi.advanceTimersByTime(2 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });

  it("ignores an isolated detection — an open door catching a passer-by", () => {
    const h = dryCtx();
    const inst = createRecipe().createInstance(motionParams, h.ctx as never);

    h.emit("wc-1", "motion", true);
    h.emit("wc-1", "motion", false); // one brief burst
    vi.advanceTimersByTime(10 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([]);
    inst.stop();
  });

  it("does not accumulate two distant bursts into a fake occupancy", () => {
    const h = dryCtx();
    const inst = createRecipe().createInstance(motionParams, h.ctx as never);

    h.emit("wc-1", "motion", true);
    h.emit("wc-1", "motion", false);
    vi.advanceTimersByTime(5 * 60_000); // > burst gap
    h.emit("wc-1", "motion", true);
    h.emit("wc-1", "motion", false);
    vi.advanceTimersByTime(5 * 60_000);

    expect(vmcOrders(h.orders)).toEqual([]);
    inst.stop();
  });

  it("caps a run of endless detections and pauses 30 minutes", () => {
    const h = dryCtx();
    const inst = createRecipe().createInstance(motionParams, h.ctx as never);

    h.emit("wc-1", "motion", true); // door left open: presence never clears
    vi.advanceTimersByTime(2 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(45 * 60_000); // past the occupancy maximum
    expect(vmcOrders(h.orders)).toEqual([true, false]);

    vi.advanceTimersByTime(20 * 60_000); // still paused despite motion
    expect(vmcOrders(h.orders)).toEqual([true, false]);

    vi.advanceTimersByTime(15 * 60_000); // pause over → a new run is allowed
    expect(vmcOrders(h.orders)).toEqual([true, false, true]);
    inst.stop();
  });

  it("drives the high speed when the low speed is permanent", () => {
    const h = dryCtx({ withBoost: true });
    const inst = createRecipe().createInstance(
      { ...motionParams, twoSpeed: "on", vmcBoost: "boost-1", alwaysOn: "on" },
      h.ctx as never,
    );
    h.emit("wc-1", "motion", true);
    vi.advanceTimersByTime(90_000);
    expect(boostOrders(h.orders)).toEqual([true]);
    expect(vmcOrders(h.orders)).toEqual([true]); // low speed asserted, never cut
    inst.stop();
  });

  it("keeps the VMC on when the humidity cycle ends but the visit continues", () => {
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 21 }],
      motion: [{ id: "wc-1", name: "WC" }],
    });
    const inst = createRecipe().createInstance(motionParams, h.ctx as never);
    expect(vmcOrders(h.orders)).toEqual([true]); // humidity run

    h.emit("wc-1", "motion", true);
    vi.advanceTimersByTime(16 * 60_000); // confirmed occupancy, past minRun
    h.emit("room-1", "humidity", 45); // humidity satisfied
    expect(vmcOrders(h.orders)).toEqual([true]); // occupancy holds it on

    h.emit("wc-1", "motion", false);
    vi.advanceTimersByTime(16 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });

  it("respects the quiet window by default and exempts visits on demand", () => {
    const quiet = { quietMode: "on", quietStart: "10:10", quietEnd: "07:00" };

    const blocked = dryCtx();
    const a = createRecipe().createInstance({ ...motionParams, ...quiet }, blocked.ctx as never);
    vi.advanceTimersByTime(20 * 60_000); // now inside the quiet window
    blocked.emit("wc-1", "motion", true);
    vi.advanceTimersByTime(2 * 60_000);
    expect(vmcOrders(blocked.orders)).toEqual([]);
    a.stop();

    const exempt = dryCtx();
    const b = createRecipe().createInstance(
      { ...motionParams, ...quiet, quietScope: "humidity" },
      exempt.ctx as never,
    );
    vi.advanceTimersByTime(20 * 60_000);
    exempt.emit("wc-1", "motion", true);
    vi.advanceTimersByTime(2 * 60_000);
    expect(vmcOrders(exempt.orders)).toEqual([true]);
    b.stop();
  });

  it("rejects a motion sensor that reports no motion", () => {
    const h = dryCtx();
    expect(() =>
      createRecipe().validate({ ...motionParams, motionSensors: ["room-1"] }, h.ctx as never),
    ).toThrow(/no motion/i);
  });
});

describe("sensor robustness", () => {
  it("ignores a stale reading and stops rather than running blind", () => {
    const stale = new Date("2026-01-14T06:00:00").toISOString(); // 4 h old
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 21, lastUpdated: stale }],
    });
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    expect(vmcOrders(h.orders)).toEqual([]);
    expect(h.state.get("status")).toBe("no_data");

    h.emit("room-1", "humidity", 66); // fresh again
    expect(vmcOrders(h.orders)).toEqual([true]);
    inst.stop();
  });

  it("survives a sensor that disappears from the equipment manager", () => {
    const h = makeCtx();
    expect(() =>
      createRecipe().createInstance({ ...baseParams, sensors: ["room-1", "ghost"] }, h.ctx as never),
    ).not.toThrow();
  });

  it("never throws out of the event handler", () => {
    const h = makeCtx();
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    expect(() => h.emit("room-1", "humidity", "not-a-number")).not.toThrow();
    inst.stop();
  });
});

// ============================================================
// Form shape — what the recipe promises the UI
// ============================================================

/** Mirror of the core rule: a slot is hidden when the referenced sibling matches. */
function isHidden(slot: any, params: Record<string, unknown>, all: any[]): boolean {
  if (!slot.hiddenWhen) return false;
  const ref = all.find((s) => s.id === slot.hiddenWhen.slot);
  const value = params[slot.hiddenWhen.slot] ?? ref?.defaultValue;
  const expected = Array.isArray(slot.hiddenWhen.equals)
    ? slot.hiddenWhen.equals
    : [slot.hiddenWhen.equals];
  return expected.includes(value as string);
}

/** Compact fields the form lays out in a grid, per group. */
function compactGroups(params: Record<string, unknown>): Record<string, string[]> {
  const slots = createRecipe().slots;
  const out: Record<string, string[]> = {};
  for (const slot of slots) {
    if (!slot.group) continue; // the zone slot is not a form field
    if (slot.list) continue; // list slots render full width
    if (isHidden(slot, params, slots)) continue;
    (out[slot.group] ??= []).push(slot.id);
  }
  return out;
}

describe("form shape", () => {
  it("hides every second-speed field on a single-speed unit", () => {
    const shown = Object.values(compactGroups({})).flat();
    expect(shown).not.toContain("vmcBoost");
    expect(shown).not.toContain("alwaysOn");
    expect(shown).not.toContain("boostDelta");
    expect(shown).toContain("twoSpeed");
  });

  it("reveals them once the two-speed flag is set", () => {
    const shown = Object.values(compactGroups({ twoSpeed: "on" })).flat();
    expect(shown).toContain("vmcBoost");
    expect(shown).toContain("alwaysOn");
    expect(shown).toContain("boostDelta");
  });

  it("hides the quiet window until quiet hours are enabled", () => {
    expect(Object.values(compactGroups({})).flat()).not.toContain("quietStart");
    const on = Object.values(compactGroups({ quietMode: "on" })).flat();
    expect(on).toEqual(expect.arrayContaining(["quietStart", "quietEnd", "quietScope"]));
  });

  it("keeps every group on a full grid row in every state", () => {
    // The form lays a group out as `n <= 3 ? n : 2` columns, so 2, 3, 4 or 6
    // visible fields fill their rows — 5 would leave a hole.
    const states = [
      {},
      { twoSpeed: "on" },
      { quietMode: "on" },
      { twoSpeed: "on", quietMode: "on" },
    ];
    for (const params of states) {
      for (const [group, ids] of Object.entries(compactGroups(params))) {
        expect([2, 3, 4, 6], `${group} in ${JSON.stringify(params)} has ${ids.length}`).toContain(
          ids.length,
        );
      }
    }
  });

  it("uses select rather than boolean — the grouped form has no checkbox", () => {
    expect(createRecipe().slots.filter((s) => s.type === "boolean")).toEqual([]);
  });

  it("keeps labels short enough not to wrap in a three-column row", () => {
    // A group of three renders in ~120 px cells: a label that wraps pushes its
    // field down and the row stops lining up. Groups that never exceed two
    // columns get twice the width.
    const THREE_COL_GROUPS = new Set(["thresholds", "motion", "limits"]);
    const r = createRecipe();
    for (const slot of r.slots) {
      if (!slot.group || slot.list) continue;
      const budget = THREE_COL_GROUPS.has(slot.group) ? 14 : 20;
      expect(slot.name.length, `${slot.id} EN "${slot.name}"`).toBeLessThanOrEqual(budget);
      const fr = r.i18n?.fr.slots?.[slot.id];
      expect(fr!.name.length, `${slot.id} FR "${fr!.name}"`).toBeLessThanOrEqual(budget);
    }
  });

  it("keeps the help under a field on one line", () => {
    // The help sits under its field in the same cell: ~20 characters fit on a
    // line in a three-column row, ~30 in a two-column one. Beyond that it
    // wraps and the group turns into a wall of grey text.
    const THREE_COL_GROUPS = new Set(["thresholds", "motion", "limits"]);
    const r = createRecipe();
    for (const slot of r.slots) {
      if (!slot.group) continue;
      const budget = slot.list ? 40 : THREE_COL_GROUPS.has(slot.group) ? 20 : 30;
      expect(slot.description.length, `${slot.id} EN "${slot.description}"`).toBeLessThanOrEqual(
        budget,
      );
      const fr = r.i18n?.fr.slots?.[slot.id];
      expect(fr!.description.length, `${slot.id} FR "${fr!.description}"`).toBeLessThanOrEqual(
        budget,
      );
    }
  });
});

describe("flags", () => {
  it("reads the select values and the booleans written before 0.3.0", () => {
    expect(flagOn("on")).toBe(true);
    expect(flagOn(true)).toBe(true);
    expect(flagOn("off")).toBe(false);
    expect(flagOn(false)).toBe(false);
    expect(flagOn(undefined)).toBe(false);
  });

  it("infers two-speed from an instance created before the flag existed", () => {
    expect(isTwoSpeed({ vmcBoost: "boost-1" })).toBe(true);
    expect(isTwoSpeed({})).toBe(false);
    expect(isTwoSpeed({ twoSpeed: "off", vmcBoost: "boost-1" })).toBe(false);
  });
});

describe("lifecycle", () => {
  it("stop() clears the clock and unsubscribes, and is idempotent", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 21 }] });
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    const before = h.orders.length;

    inst.stop();
    inst.stop();

    expect(h.handlers.length).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(h.orders.length).toBe(before); // no clock activity after stop
  });

  it("does not touch a VMC it never switched on", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 45, temperature: 21 }] });
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    expect(h.orders).toEqual([]); // no forced OFF at startup
    inst.stop();
  });

  it("turns off a VMC it had switched on before a restart", () => {
    // A previous run persisted its ownership; humidity has dropped since.
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 45, temperature: 21 }] });
    h.state.set("vmcOn", true);
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    expect(vmcOrders(h.orders)).toEqual([false]);
    inst.stop();
  });

  it("exposes the recipe metadata expected by the loader", () => {
    const r = createRecipe();
    expect(r.id).toBe("vmc-humidity");
    expect(r.slots.map((s) => s.id)).toContain("sensors");
    expect(r.i18n?.fr.slots?.sensors.name).toBeTruthy();
    // Every slot must be translated in French.
    for (const slot of r.slots) {
      expect(r.i18n?.fr.slots?.[slot.id], `missing fr i18n for ${slot.id}`).toBeTruthy();
    }
  });
});
