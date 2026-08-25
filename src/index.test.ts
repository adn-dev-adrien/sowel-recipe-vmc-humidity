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
  minutesUntil,
  median,
  showerBar,
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
      dataBindings: [makeBinding("state", "light_state", "OFF")],
      orderBindings: opts?.vmcOrders ?? [{ alias: "state", category: "toggle_power", type: "boolean" }],
    },
  };

  if (opts?.withBoost) {
    equipments["boost-1"] = {
      name: "VMC GV",
      dataBindings: [makeBinding("state", "light_state", "OFF")],
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
      // A well-behaved relay reports the state it was just set to. Tests that
      // need a silent or disobedient one write the binding themselves.
      const state = equipments[equipmentId]?.dataBindings.find((b) => b.alias === "state");
      if (state && typeof value === "boolean") {
        state.value = value ? "ON" : "OFF";
        state.lastUpdated = null;
      }
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
  it("counts the minutes to the next occurrence, past midnight", () => {
    expect(minutesUntil(21 * 60, 22 * 60)).toBe(60);
    expect(minutesUntil(23 * 60, 7 * 60)).toBe(480);
    expect(minutesUntil(22 * 60, 22 * 60)).toBe(0);
  });

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

  it("ignores flags left behind by a hidden field", () => {
    // The form hides a slot but keeps its value: turning the two-speed flag
    // back off leaves alwaysOn — and possibly a boost equipment — set. Neither
    // may block the save.
    const { ctx } = makeCtx({ withBoost: true });
    expect(() =>
      createRecipe().validate(
        { ...baseParams, twoSpeed: "off", alwaysOn: "on", vmcBoost: "boost-1" },
        ctx as never,
      ),
    ).not.toThrow();
  });

  it("drives nothing but the main ventilation once two-speed is turned off", () => {
    const h = makeCtx({
      withBoost: true,
      rooms: [{ id: "room-1", name: "SDB", humidity: 70, temperature: 21 }],
    });
    const inst = createRecipe().createInstance(
      { ...baseParams, twoSpeed: "off", alwaysOn: "on", vmcBoost: "boost-1" },
      h.ctx as never,
    );
    expect(vmcOrders(h.orders)).toEqual([true]);
    expect(boostOrders(h.orders)).toEqual([]); // the stale boost stays untouched
    inst.stop();
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

  it("cuts a cycle the moment the window opens, minimum run or not", () => {
    // The incident of 2026-08-11: a cycle started at 21:59:50 kept the
    // ventilation running fifteen minutes into the night, because the
    // anti short-cycling guard was checked first.
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 21 }] });
    const inst = createRecipe().createInstance(
      { ...baseParams, showerMode: "off", quietMode: "on", quietStart: "10:10", quietEnd: "07:00" },
      h.ctx as never,
    );
    expect(vmcOrders(h.orders)).toEqual([true]); // 10:00, outside the window

    vi.advanceTimersByTime(10 * 60_000 + 30_000); // 10:10 — 10 min into a 15 min floor
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    expect(h.state.get("status")).toBe("quiet");
    inst.stop();
  });

  // A one-jump step to 65 % or 70 % is what a shower looks like, and a shower
  // is deliberately exempt from the quiet window. These three guards are about
  // the humidity cycle, so they turn the detection off and keep asserting it.
  it("still starts a useful cycle right before the window, then ends it on time", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 45, temperature: 21 }] });
    const inst = createRecipe().createInstance(
      { ...baseParams, showerMode: "off", quietMode: "on", quietStart: "10:01", quietEnd: "07:00" },
      h.ctx as never,
    );
    h.emit("room-1", "humidity", 70); // 10:00 — a minute of extraction is still worth having
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(90_000); // 10:01:30
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    expect(h.state.get("status")).toBe("quiet");
    inst.stop();
  });

  it("refuses every restart for the whole window without stalling", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 45, temperature: 21 }] });
    const inst = createRecipe().createInstance(
      { ...baseParams, showerMode: "off", quietMode: "on", quietStart: "10:10", quietEnd: "07:00" },
      h.ctx as never,
    );
    vi.advanceTimersByTime(11 * 60_000); // inside the window

    // Humidity keeps climbing all night: not one order, and the recipe keeps
    // tracking — the readings it exposes stay current.
    for (let i = 0; i < 12; i++) {
      h.emit("room-1", "humidity", 70 + i);
      vi.advanceTimersByTime(30 * 60_000);
    }
    expect(vmcOrders(h.orders)).toEqual([]);
    expect(h.state.get("status")).toBe("quiet");
    expect(h.state.get("maxHumidity")).toBe(81);

    // 07:00 next morning — the window closes and the recipe acts at once.
    vi.advanceTimersByTime(15 * 60 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true]);
    inst.stop();
  });

  it("never starts during the quiet window and cuts a running cycle short", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 21 }] });
    // Quiet from 10:10 to 07:00 — the instance starts at 10:00, just before.
    const params = { ...baseParams, showerMode: "off", quietMode: "on", quietStart: "10:10", quietEnd: "07:00" };
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

  it("chases the outdoor floor rather than the configured target", () => {
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 22 }],
      outdoor: { humidity: 55, temperature: 22 }, // floor 55, gain 10
    });
    const inst = createRecipe().createInstance(
      { ...baseParams, outdoorSensor: "out-1", outdoorMargin: 3 },
      h.ctx as never,
    );
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(16 * 60_000);
    h.emit("room-1", "humidity", 57); // above the floor: there is still water to take out
    expect(vmcOrders(h.orders)).toEqual([true]);

    h.emit("room-1", "humidity", 54); // at the floor: the outdoor air can do no better
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });
});

describe("a bad reading must not remove the outdoor guard", () => {
  const params = { ...baseParams, outdoorSensor: "out-1", outdoorMargin: 3 };

  it("keeps the last good outdoor humidity when an event carries rubbish", () => {
    // 2026-08-21: a cycle started at 11:11 with a computed gain of +1.5, under
    // the 3-point margin. `outdoorHumidity = num(value)` turned a non-numeric
    // report into null, the floor became null, and a null floor reads as "no
    // outdoor constraint at all".
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 62, temperature: 22 }],
      outdoor: { humidity: 60, temperature: 22 }, // floor 60, gain 2 — too small
    });
    const inst = createRecipe().createInstance(params, h.ctx as never);
    expect(vmcOrders(h.orders)).toEqual([]);

    h.emit("out-1", "humidity", null);
    h.emit("out-1", "humidity", "n/a");
    vi.advanceTimersByTime(2 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([]); // still guarded
    expect(h.state.get("outdoorFloor")).toBe(60);
    inst.stop();
  });

  it("waits rather than starting unchecked when the outdoor sensor never reported", () => {
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 70, temperature: 22 }],
      outdoor: { humidity: null, temperature: 22 },
    });
    const inst = createRecipe().createInstance(params, h.ctx as never);
    vi.advanceTimersByTime(2 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([]);

    h.emit("out-1", "humidity", 50); // it finally speaks: gain 20
    expect(vmcOrders(h.orders)).toEqual([true]);
    inst.stop();
  });

  it("states the floor and the gain in the log", () => {
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 70, temperature: 22 }],
      outdoor: { humidity: 50, temperature: 22 },
    });
    const inst = createRecipe().createInstance(params, h.ctx as never);
    expect(h.logs.some((l) => l.includes("plancher 50 %") && l.includes("gain 20 pts"))).toBe(true);
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

describe("the relay can be flipped by someone else", () => {
  const quiet = { quietMode: "on", quietStart: "10:10", quietEnd: "07:00" };

  it("gives up its cycle when the ventilation is switched off elsewhere", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 21 }] });
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    expect(vmcOrders(h.orders)).toEqual([true]);
    h.emit("vmc-1", "state", "ON"); // the relay confirms
    vi.advanceTimersByTime(31_000); // ...and the recipe sees the confirmation

    h.emit("vmc-1", "state", "OFF"); // someone cuts it
    vi.advanceTimersByTime(60_000);
    expect(h.state.get("running")).toBe(true); // too soon to call it a human

    vi.advanceTimersByTime(90_000);
    expect(h.state.get("running")).toBe(false);
    expect(h.state.get("vmcOn")).toBe(false);
    expect(h.state.get("status")).toBe("cooldown");

    // And it stands down instead of arguing, even though the room is still wet.
    vi.advanceTimersByTime(50 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true]);
    vi.advanceTimersByTime(15 * 60_000); // an hour later it may act again
    expect(vmcOrders(h.orders)).toEqual([true, true]);
    inst.stop();
  });

  it("switches it off again when something starts it inside the quiet window", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 45, temperature: 21 }] });
    const inst = createRecipe().createInstance({ ...baseParams, ...quiet }, h.ctx as never);
    vi.advanceTimersByTime(20 * 60_000); // inside the quiet window, recipe idle

    h.emit("vmc-1", "state", "ON"); // something else turns it on
    vi.advanceTimersByTime(60_000);
    expect(vmcOrders(h.orders)).toEqual([false]);
    expect(h.logs.some((l) => l.includes("arrêt imposé"))).toBe(true);

    // Something insists. The rate limit holds for five minutes, then acts again.
    h.emit("vmc-1", "state", "ON");
    vi.advanceTimersByTime(2 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([false]);
    vi.advanceTimersByTime(4 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([false, false]);
    inst.stop();
  });

  it("does not accuse anyone when it switches itself off at the quiet boundary", () => {
    // 2026-08-17 22:00:15 logged "VMC allumée par autre chose, arrêt imposé"
    // while shutting down its own cycle: the relay had not yet reported the
    // OFF it had just been sent.
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 21 }] });
    const inst = createRecipe().createInstance(
      { ...baseParams, quietMode: "on", quietStart: "10:20", quietEnd: "07:00" },
      h.ctx as never,
    );
    h.emit("vmc-1", "state", "ON"); // the relay confirms the run
    vi.advanceTimersByTime(21 * 60_000); // the window opens, the recipe stops

    expect(vmcOrders(h.orders)).toEqual([true, false]);
    expect(h.logs.some((l) => l.includes("allumée par autre chose"))).toBe(false);
    inst.stop();
  });

  it("leaves it alone when someone starts it outside the quiet window", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 45, temperature: 21 }] });
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    h.emit("vmc-1", "state", "ON");
    vi.advanceTimersByTime(5 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([]);
    inst.stop();
  });

  it("still leaves it alone outside the quiet window after a prior cycle agreed", () => {
    // Regression: once the recipe and relay have agreed on a state, an external
    // ON while idle used to be adopted into `mainOn`, and the next applyOutputs
    // turned that into a true->false transition — an OFF nobody asked for.
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 45, temperature: 21 }] });
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);

    // Drive a real cycle so the recipe and relay agree (vmcAgreed = true).
    h.emit("room-1", "humidity", 70); // above max -> ON
    h.emit("vmc-1", "state", "ON"); // relay confirms
    vi.advanceTimersByTime(16 * 60_000); // outlast minRun
    h.emit("room-1", "humidity", 45); // below target -> OFF
    h.emit("vmc-1", "state", "OFF"); // relay confirms
    vi.advanceTimersByTime(60_000); // a tick reconciles the OFF -> agreed again
    expect(vmcOrders(h.orders)).toEqual([true, false]);

    // Now someone flips it on by hand. The recipe must NOT send an OFF.
    h.emit("vmc-1", "state", "ON");
    vi.advanceTimersByTime(5 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true, false]); // no extra order
    inst.stop();
  });

  it("never cuts a permanent low speed to enforce the silence", () => {
    const h = makeCtx({
      withBoost: true,
      rooms: [{ id: "room-1", name: "SDB", humidity: 45, temperature: 21 }],
    });
    const inst = createRecipe().createInstance(
      { ...baseParams, ...quiet, twoSpeed: "on", vmcBoost: "boost-1", alwaysOn: "on" },
      h.ctx as never,
    );
    expect(vmcOrders(h.orders)).toEqual([true]); // low speed asserted
    vi.advanceTimersByTime(20 * 60_000); // quiet window
    h.emit("vmc-1", "state", "ON");
    vi.advanceTimersByTime(2 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true]); // still only the initial ON
    inst.stop();
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

describe("showers", () => {
  // A shower is answered on its own terms: the room comes back to where it
  // was, not down to a threshold, and the quiet window does not hold it back.
  const showerParams = {
    ...baseParams,
    // Well above anything these tests reach, so only the shower cycle can move
    // the ventilation.
    humidityMax: 85,
    humidityMin: 50,
  };

  const bathroom = (humidity: number, temperature: number) =>
    makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity, temperature }] });

  /**
   * Run the water. The temperature stays where it was on purpose: that is the
   * August case that broke v0.7.1 — a bathroom already at 24.7 °C gains no
   * measurable degree, and only the added water names the shower.
   */
  const shower = (h: ReturnType<typeof makeCtx>, humidity: number, temperature = 20.5) => {
    h.emit("room-1", "temperature", temperature);
    h.emit("room-1", "humidity", humidity);
  };

  /** The room comes back down. */
  const dried = (h: ReturnType<typeof makeCtx>, humidity = 52.5, temperature = 20.5) => {
    h.emit("room-1", "temperature", temperature);
    h.emit("room-1", "humidity", humidity);
  };

  it("starts well under the maximum, and stops once the room is back where it was", () => {
    const h = bathroom(52, 20.5);
    const inst = createRecipe().createInstance(showerParams, h.ctx as never);
    expect(vmcOrders(h.orders)).toEqual([]);

    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 68); // 68 % is nowhere near the 85 % maximum
    expect(vmcOrders(h.orders)).toEqual([true]);
    expect(h.state.get("showerRunning")).toBe(true);
    expect(h.state.get("status")).toBe("shower");
    expect(h.logs.some((l) => l.includes("Douche détectée"))).toBe(true);

    // Halfway back down is not back: the pre-shower level was 52 %.
    vi.advanceTimersByTime(20 * 60_000);
    h.emit("room-1", "humidity", 58);
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(15 * 60_000);
    h.emit("room-1", "humidity", 53);
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    expect(h.state.get("showerRunning")).toBe(false);
    expect(h.logs.some((l) => l.includes("niveau d'avant la douche"))).toBe(true);
    inst.stop();
  });

  it("does not start on humidity alone — that is the weather", () => {
    const h = bathroom(52, 20.5);
    const inst = createRecipe().createInstance(showerParams, h.ctx as never);

    // +14 points over four hours with the temperature dead flat: the 21:00 →
    // 02:00 drift that fooled the first version of this detector.
    for (let i = 1; i <= 8; i++) {
      vi.advanceTimersByTime(30 * 60_000);
      h.emit("room-1", "humidity", 52 + i * 1.75);
    }
    expect(vmcOrders(h.orders)).toEqual([]);
    inst.stop();
  });

  it("starts inside the quiet window — a bathroom wet at 23:00 is still wet at 07:00", () => {
    const h = bathroom(52, 20.5);
    const inst = createRecipe().createInstance(
      { ...showerParams, quietMode: "on", quietStart: "10:10", quietEnd: "07:00" },
      h.ctx as never,
    );
    vi.advanceTimersByTime(20 * 60_000); // inside the window

    shower(h, 68);
    expect(vmcOrders(h.orders)).toEqual([true]);
    expect(h.state.get("status")).toBe("shower");

    // And the silence enforcement does not fight the cycle it just started.
    vi.advanceTimersByTime(10 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true]);

    // Back to its level: the ventilation goes quiet again without waiting for
    // the window to close.
    h.emit("room-1", "humidity", 52.5);
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });

  it("gives up after the cap rather than running all night", () => {
    const h = bathroom(52, 20.5);
    const inst = createRecipe().createInstance(
      { ...showerParams, showerMaxRun: "1h" },
      h.ctx as never,
    );
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 68);
    expect(vmcOrders(h.orders)).toEqual([true]);

    // The room barely moves — a window left open, a wet towel, a dead sensor
    // reading. One hour, then it stops arguing with the physics.
    vi.advanceTimersByTime(59 * 60_000);
    h.emit("room-1", "humidity", 66);
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(2 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    expect(h.logs.some((l) => l.includes("sans revenir à"))).toBe(true);
    inst.stop();
  });

  it("takes the high speed while the room is over the maximum, then the low one", () => {
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 52, temperature: 20.5 }],
      withBoost: true,
    });
    const inst = createRecipe().createInstance(
      { ...baseParams, twoSpeed: "on", vmcBoost: "boost-1", humidityMax: 60, boostDelta: 5 },
      h.ctx as never,
    );
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 72);
    expect(vmcOrders(h.orders)).toEqual([true]);
    expect(boostOrders(h.orders)).toEqual([true]);

    // Under the maximum the burst is gone; the last points come off quietly.
    vi.advanceTimersByTime(20 * 60_000);
    h.emit("room-1", "humidity", 57);
    expect(boostOrders(h.orders)).toEqual([true, false]);
    expect(vmcOrders(h.orders)).toEqual([true]);
    inst.stop();
  });

  it("does not pretend to extract when the outdoor air is wetter than the room", () => {
    // Muggy August: 78 %RH at 26 °C outside is ~90 %RH once at 21 °C indoors.
    const h = makeCtx({
      rooms: [{ id: "room-1", name: "SDB", humidity: 52, temperature: 21 }],
      outdoor: { humidity: 78, temperature: 26 },
    });
    const inst = createRecipe().createInstance(
      { ...showerParams, outdoorSensor: "out-1" },
      h.ctx as never,
    );
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 68);
    expect(vmcOrders(h.orders)).toEqual([]);
    expect(h.logs.some((l) => l.includes("rien à extraire"))).toBe(true);
    inst.stop();
  });

  it("resumes its drying cycle after a recipe update", () => {
    const h = bathroom(52, 20.5);
    const first = createRecipe().createInstance(showerParams, h.ctx as never);
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 68);
    expect(vmcOrders(h.orders)).toEqual([true]);
    first.stop();

    // Same persisted state, fresh instance — the room is still wet.
    const second = createRecipe().createInstance(showerParams, h.ctx as never);
    expect(h.state.get("showerRunning")).toBe(true);
    expect(vmcOrders(h.orders)).toEqual([true]); // already on, nothing re-sent

    h.emit("room-1", "humidity", 52.5);
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    second.stop();
  });

  it("stays out of the way when the detection is turned off", () => {
    const h = bathroom(52, 20.5);
    const inst = createRecipe().createInstance(
      { ...showerParams, showerMode: "off" },
      h.ctx as never,
    );
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 68);
    expect(vmcOrders(h.orders)).toEqual([]);
    expect(h.state.get("showerRunning")).toBe(false);
    inst.stop();
  });

  it("says what it skipped when the ventilation was cut by hand", () => {
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 65, temperature: 20.5 }] });
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);
    expect(vmcOrders(h.orders)).toEqual([true]);
    h.emit("vmc-1", "state", "ON");
    vi.advanceTimersByTime(31_000);
    h.emit("vmc-1", "state", "OFF"); // someone reaches for the switch
    vi.advanceTimersByTime(3 * 60_000);
    expect(h.state.get("status")).toBe("cooldown");

    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 78);
    expect(vmcOrders(h.orders)).toEqual([true]); // still standing down
    expect(h.logs.some((l) => l.includes("VMC au repos"))).toBe(true);
    inst.stop();
  });

  it("keeps the first baseline when a second shower follows", () => {
    const h = bathroom(52, 20.5);
    const inst = createRecipe().createInstance(showerParams, h.ctx as never);
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 64);
    expect(h.state.get("showerRunning")).toBe(true);

    vi.advanceTimersByTime(20 * 60_000);
    shower(h, 74); // someone else showers before the room is dry
    expect(h.logs.some((l) => l.includes("Nouvelle douche"))).toBe(true);

    // 55 % would be back under the second shower's floor, but not under the
    // level the room had before the first one.
    vi.advanceTimersByTime(30 * 60_000);
    h.emit("room-1", "humidity", 55);
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(15 * 60_000);
    h.emit("room-1", "humidity", 52.8);
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });

  it("fits its bar on what showers actually do to each room", () => {
    // Two bathrooms, the same shower: the probe over the door sees six points,
    // the one beside the shower sees twenty-four. One bar cannot serve both.
    expect(showerBar([], 4)).toBe(4); // nothing measured yet: the configured bar
    expect(showerBar([24], 4)).toBe(4); // one shower is an anecdote
    expect(showerBar([24, 22], 4)).toBe(8);
    expect(showerBar([6, 7], 4)).toBe(3); // floored: below that lies the weather
    expect(showerBar([60, 70], 4)).toBe(15); // capped
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  it("raises the bar in a room whose showers are violent", () => {
    const h = bathroom(52, 20.5);
    const inst = createRecipe().createInstance(showerParams, h.ctx as never);

    // Two showers, each taking the room 24 points up and back down again.
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(10 * 60_000);
      shower(h, 76);
      vi.advanceTimersByTime(30 * 60_000);
      dried(h);
    }
    expect(h.logs.some((l) => l.includes("seuil de détection"))).toBe(true);
    expect(h.state.get("showerAmplitudes")).toContain("room-1");

    // The bar now sits at ~8 points: a four-point rise no longer counts.
    const before = vmcOrders(h.orders).length;
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 57);
    expect(vmcOrders(h.orders)).toHaveLength(before);

    // A real one still does.
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 68);
    expect(vmcOrders(h.orders).length).toBeGreaterThan(before);
    inst.stop();
  });

  it("keeps each room's bar to itself", () => {
    const h = makeCtx({
      rooms: [
        { id: "room-1", name: "SDB haut", humidity: 52, temperature: 20.5 },
        { id: "room-2", name: "SDB bas", humidity: 52, temperature: 20.5 },
      ],
    });
    const inst = createRecipe().createInstance(
      { ...showerParams, sensors: ["room-1", "room-2"] },
      h.ctx as never,
    );

    // Only the upstairs bathroom ever shows big rises.
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(10 * 60_000);
      h.emit("room-1", "humidity", 76);
      vi.advanceTimersByTime(30 * 60_000);
      h.emit("room-1", "humidity", 52.5);
    }

    // Downstairs still answers a modest rise — its bar never moved.
    const before = vmcOrders(h.orders).length;
    vi.advanceTimersByTime(10 * 60_000);
    h.emit("room-2", "humidity", 57);
    expect(vmcOrders(h.orders).length).toBeGreaterThan(before);
    expect(h.logs.some((l) => l.includes("SDB bas"))).toBe(true);
    inst.stop();
  });

  it("remembers what it learned across a recipe update", () => {
    const h = bathroom(52, 20.5);
    const first = createRecipe().createInstance(showerParams, h.ctx as never);
    for (let i = 0; i < 2; i++) {
      vi.advanceTimersByTime(10 * 60_000);
      shower(h, 76);
      vi.advanceTimersByTime(30 * 60_000);
      dried(h);
    }
    first.stop();

    const second = createRecipe().createInstance(showerParams, h.ctx as never);
    // The learned bar survived: a six-point rise is not a shower here.
    const before = vmcOrders(h.orders).length;
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 58);
    expect(vmcOrders(h.orders)).toHaveLength(before);
    second.stop();
  });

  it("does not learn from a cycle that never came back", () => {
    const h = bathroom(52, 20.5);
    const inst = createRecipe().createInstance(
      { ...showerParams, showerMaxRun: "1h" },
      h.ctx as never,
    );
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 76);
    vi.advanceTimersByTime(62 * 60_000); // the room never dries: capped out
    expect(h.logs.some((l) => l.includes("sans revenir à"))).toBe(true);
    expect(h.state.get("showerAmplitudes")).toBeUndefined();
    inst.stop();
  });

  it("takes the configured starting bar", () => {
    const h = bathroom(52, 20.5);
    const inst = createRecipe().createInstance(
      { ...showerParams, showerRise: 10 },
      h.ctx as never,
    );
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 60); // +8, under the configured 10
    expect(vmcOrders(h.orders)).toEqual([]);

    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 64); // +12 from the same baseline
    expect(vmcOrders(h.orders)).toEqual([true]);
    inst.stop();
  });

  it("rejects a shower rise under two points", () => {
    const { ctx } = makeCtx();
    expect(() =>
      createRecipe().validate({ ...baseParams, showerRise: 1 }, ctx as never),
    ).toThrow(/rise/i);
  });

  it("answers the two showers of 2026-08-24, quiet window and all", () => {
    // The regression this whole rewrite exists for. Real readings from the
    // bathroom that evening: the room gained six points while the temperature
    // never left 24.7 °C, and v0.7.1 — which demanded half a degree — stayed
    // silent. The VMC never ran and the room held 60 % until morning.
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 53.9, temperature: 24.7 }] });
    const inst = createRecipe().createInstance(
      {
        ...baseParams,
        humidityMax: 56,
        humidityMin: 50,
        quietMode: "on",
        quietStart: "09:00",
        quietEnd: "08:00",
      },
      h.ctx as never,
    );
    expect(h.state.get("status")).toBe("quiet");

    // The sensor reports every 30 min, as it does at home.
    vi.advanceTimersByTime(30 * 60_000);
    h.emit("room-1", "humidity", 54.0);
    vi.advanceTimersByTime(30 * 60_000);
    h.emit("room-1", "humidity", 54.4);
    expect(vmcOrders(h.orders)).toEqual([]);

    vi.advanceTimersByTime(30 * 60_000);
    h.emit("room-1", "humidity", 60.5); // 22:33 — two showers, temperature flat
    expect(vmcOrders(h.orders)).toEqual([true]);
    expect(h.state.get("status")).toBe("shower");
    expect(h.logs.some((l) => l.includes("Douche détectée"))).toBe(true);
    inst.stop();
  });

  it("stops at the acceptable target when the room started drier than it", () => {
    // A bathroom that sat at 46 % has no business being chased back there once
    // it is under the 50 % its owner called acceptable.
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 46, temperature: 20.5 }] });
    const inst = createRecipe().createInstance(
      { ...baseParams, humidityMax: 85, humidityMin: 50 },
      h.ctx as never,
    );
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 58);
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(20 * 60_000);
    h.emit("room-1", "humidity", 49.5); // acceptable, still above the 46 it had
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    expect(h.logs.some((l) => l.includes("cible 50 %"))).toBe(true);
    inst.stop();
  });

  it("caps a drying cycle at 45 minutes by default", () => {
    const h = bathroom(52, 20.5);
    const inst = createRecipe().createInstance(showerParams, h.ctx as never);
    vi.advanceTimersByTime(10 * 60_000);
    shower(h, 68);
    expect(vmcOrders(h.orders)).toEqual([true]);

    vi.advanceTimersByTime(44 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true]);
    vi.advanceTimersByTime(2 * 60_000);
    expect(vmcOrders(h.orders)).toEqual([true, false]);
    inst.stop();
  });

  it("rejects a shower cap that is not a duration", () => {
    const { ctx } = makeCtx();
    expect(() =>
      createRecipe().validate({ ...baseParams, showerMaxRun: "later" }, ctx as never),
    ).toThrow(/shower/i);
  });
});

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
      { showerMode: "off" },
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

  it("asks for the ventilation before the rooms it watches", () => {
    const groups = createRecipe()
      .slots.filter((s) => s.group)
      .map((s) => s.group);
    expect(groups[0]).toBe("vmc");
    expect(groups.indexOf("vmc")).toBeLessThan(groups.indexOf("sensors"));
  });

  it("uses select rather than boolean — the grouped form has no checkbox", () => {
    expect(createRecipe().slots.filter((s) => s.type === "boolean")).toEqual([]);
  });

  it("keeps labels short enough not to wrap in a three-column row", () => {
    // A group of three renders in ~120 px cells: a label that wraps pushes its
    // field down and the row stops lining up. Groups that never exceed two
    // columns get twice the width.
    const THREE_COL_GROUPS = new Set(["thresholds", "motion", "limits", "shower"]);
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
    const THREE_COL_GROUPS = new Set(["thresholds", "motion", "limits", "shower"]);
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

describe("what a recipe update must not undo", () => {
  it("keeps its stand-down across a restart", () => {
    // A recipe update restarts every instance. An in-memory latch handed the
    // ventilation straight back — "the VMC comes on right after an update".
    const first = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 70, temperature: 21 }] });
    const a = createRecipe().createInstance(baseParams, first.ctx as never);
    expect(vmcOrders(first.orders)).toEqual([true]);
    vi.advanceTimersByTime(31_000); // the recipe sees the relay confirm the ON
    first.emit("vmc-1", "state", "OFF"); // someone cuts it
    vi.advanceTimersByTime(3 * 60_000); // ...confirmed: stand down for an hour
    expect(first.state.get("status")).toBe("cooldown");
    a.stop();

    // Same persisted state, fresh instance, room still wet.
    const second = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 70, temperature: 21 }] });
    for (const [k, v] of first.state) second.state.set(k, v);
    const b = createRecipe().createInstance(baseParams, second.ctx as never);
    vi.advanceTimersByTime(5 * 60_000);
    expect(vmcOrders(second.orders)).toEqual([]); // the hour is still owed

    vi.advanceTimersByTime(60 * 60_000);
    expect(vmcOrders(second.orders)).toEqual([true]); // and then it resumes
    b.stop();
  });

  it("sends no order when the ventilation is already in the wanted state", () => {
    // Spec 141 confirms an order by watching the mirror binding move. An order
    // that changes nothing is never confirmed, and the instance raises
    // "Order not confirmed: VMC state → true" for a ventilation that was
    // already running.
    const h = makeCtx({ rooms: [{ id: "room-1", name: "SDB", humidity: 70, temperature: 21 }] });
    h.emit("vmc-1", "state", "ON"); // it never stopped across the update
    const inst = createRecipe().createInstance(baseParams, h.ctx as never);

    expect(vmcOrders(h.orders)).toEqual([]); // nothing to send
    expect(h.state.get("running")).toBe(true); // but the cycle is owned
    expect(h.logs.some((l) => l.includes("déjà en marche"))).toBe(true);

    // And it still switches it off when the room is dry.
    vi.advanceTimersByTime(16 * 60_000);
    h.emit("room-1", "humidity", 45);
    expect(vmcOrders(h.orders)).toEqual([false]);
    inst.stop();
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
    h.emit("vmc-1", "state", "ON"); // the ventilation really is running
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
