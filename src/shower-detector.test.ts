import { describe, it, expect } from "vitest";
import { createShowerDetector, psat } from "./shower-detector.js";

// The module under test knows nothing about Sowel, so neither do these tests:
// they hand it readings and a clock, and ask what it names.

const MIN = 60_000;

/** Feed a room a series of `[minutesFromStart, humidity, temperature]` points. */
function feed(
  detector: ReturnType<typeof createShowerDetector>,
  id: string,
  points: Array<[number, number, number | null]>,
) {
  const hits = [];
  for (const [min, h, t] of points) {
    const hit = detector.sample(id, { at: min * MIN, humidity: h, temperature: t });
    if (hit) hits.push({ atMin: min, ...hit });
  }
  return hits;
}

/** What a room reads at `t` when it holds the water it held at `rh0`/`t0`. */
const sameWater = (rh0: number, t0: number, t: number) => (rh0 * psat(t0)) / psat(t);

describe("shower detector", () => {
  it("names the shower of 2026-08-24, which raised no temperature at all", () => {
    // The one this module was rewritten for. An August evening, the bathroom
    // already at a flat 24.7 °C, sensor reporting every 30 min. The first
    // version required the temperature to rise with the humidity and stayed
    // silent; the room held 60 % all night.
    const d = createShowerDetector();
    const hits = feed(d, "sdb", [
      [0, 53.9, 24.7],
      [30, 54.0, 24.7],
      [60, 54.4, 24.7],
      [90, 60.5, 24.7], // 22:33 — two showers
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].baseline).toBe(54.4);
    expect(hits[0].gain).toBeCloseTo(6.1, 5);
  });

  it("sees the water through a room that warmed up at the same time", () => {
    // The other bathroom, the same evening: +1.2 points of raw reading, but
    // the room warmed 20.85 → 22.32 °C, so the water really added up.
    const d = createShowerDetector();
    const hits = feed(d, "sdb", [
      [0, 58.94, 20.85],
      [16, 60.12, 22.32],
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].gain).toBeCloseTo(6.2, 1);
  });

  it("ignores a room that merely cools down, however high the reading climbs", () => {
    // Evening cooling at constant water: 50 % at 24 °C reads 56.4 % at 22 °C
    // without a drop being added. Raw relative humidity calls that +6.4.
    const d = createShowerDetector();
    const hits = feed(d, "sdb", [
      [0, 50, 24],
      [20, sameWater(50, 24, 23), 23],
      [40, sameWater(50, 24, 22), 22],
    ]);
    expect(hits).toEqual([]);
    expect(sameWater(50, 24, 22)).toBeGreaterThan(56); // the raw rise it ignored
  });

  it("ignores a room being heated at constant water", () => {
    const d = createShowerDetector();
    expect(
      feed(d, "sdb", [
        [0, 60, 17],
        [20, sameWater(60, 17, 19), 19],
        [40, sameWater(60, 17, 21), 21],
      ]),
    ).toEqual([]);
  });

  it("ignores water creeping in all evening — that is the weather", () => {
    // Both gîte bathrooms, 21:00 → 02:00, +10 points with the temperature
    // flat: 0.036 points a minute against 0.2 for the shower above.
    const d = createShowerDetector();
    const points: Array<[number, number, number | null]> = [];
    for (let i = 0; i <= 20; i++) points.push([i * 15, 55 + i * 0.5, 20.4]);
    expect(feed(d, "sdb", points)).toEqual([]);
  });

  it("falls back to the raw reading when the room has no temperature", () => {
    const d = createShowerDetector();
    const hits = feed(d, "sdb", [
      [0, 50, null],
      [20, 58, null],
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].gain).toBeCloseTo(8, 5);
  });

  it("announces a burst once, however often it is asked", () => {
    const d = createShowerDetector();
    d.sample("sdb", { at: 0, humidity: 50, temperature: 20 });
    let hits = 0;
    // A caller ticking every 30 s for half an hour on a room that stays wet.
    for (let s = 30; s <= 1800; s += 30) {
      if (d.sample("sdb", { at: 10 * MIN + s * 1000, humidity: 66, temperature: 20 })) hits++;
    }
    expect(hits).toBe(1);
  });

  it("counts a second shower on top of a room that has not dried yet", () => {
    const d = createShowerDetector();
    const hits = feed(d, "sdb", [
      [0, 50, 20],
      [10, 62, 20], // first shower
      [40, 60, 20], // barely dropped
      [50, 70, 20], // second shower
    ]);
    expect(hits.map((x) => x.atMin)).toEqual([10, 50]);
    // The second one is measured from where the room actually was, not from
    // the pre-first-shower level: the drying cycle keeps the first baseline.
    expect(hits[1].baseline).toBe(60);
  });

  it("measures against the window, not against the previous reading", () => {
    // The same rise, seen by a probe reporting every minute and by one
    // reporting every 20. A rule on consecutive samples answers these two
    // differently — 0.2 points a step against 4 — the window does not.
    const fast = createShowerDetector();
    const fastPoints: Array<[number, number, number | null]> = [];
    for (let i = 0; i <= 25; i++) fastPoints.push([i, 52 + i * 0.2, 20]);
    const fastHits = feed(fast, "sdb", fastPoints);
    expect(fastHits).toHaveLength(1);
    expect(fastHits[0].baseline).toBe(52);

    const slow = createShowerDetector();
    const slowHits = feed(slow, "sdb", [
      [0, 52, 20],
      [20, 56, 20],
    ]);
    expect(slowHits).toHaveLength(1);
    expect(slowHits[0].baseline).toBe(52);
  });

  it("forgets a rise that took longer than the window", () => {
    const d = createShowerDetector();
    const points: Array<[number, number, number | null]> = [];
    // +12 points over three hours: a wet day, not a shower. Every 45 min
    // window only ever sees a third of it.
    for (let i = 0; i <= 36; i++) points.push([i * 5, 55 + i * 0.33, 20]);
    expect(feed(d, "sdb", points)).toEqual([]);
  });

  it("keeps one room's window out of another's", () => {
    const d = createShowerDetector();
    d.sample("a", { at: 0, humidity: 50, temperature: 20 });
    d.sample("b", { at: 0, humidity: 70, temperature: 20 });
    expect(d.sample("b", { at: 10 * MIN, humidity: 71, temperature: 20 })).toBeNull();
    expect(d.sample("a", { at: 10 * MIN, humidity: 60, temperature: 20 })).not.toBeNull();
  });

  it("takes its bar from the caller, per room", () => {
    const d = createShowerDetector();
    d.sample("sdb", { at: 0, humidity: 50, temperature: 20 });
    // The same rise, judged against two different bars.
    expect(d.sample("sdb", { at: 10 * MIN, humidity: 58, temperature: 20 }, { risePts: 10 })).toBeNull();
    expect(d.sample("sdb", { at: 20 * MIN, humidity: 58, temperature: 20 }, { risePts: 4 })).not.toBeNull();
  });

  it("drops a room on request", () => {
    const d = createShowerDetector();
    d.sample("sdb", { at: 0, humidity: 50, temperature: 20 });
    d.forget("sdb");
    // Nothing to compare against any more: the rise starts from scratch.
    expect(d.sample("sdb", { at: 10 * MIN, humidity: 66, temperature: 20 })).toBeNull();
  });
});
