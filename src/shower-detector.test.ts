import { describe, it, expect } from "vitest";
import { createShowerDetector } from "./shower-detector.js";

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

describe("shower detector", () => {
  it("names a shower when the humidity and the temperature climb together", () => {
    const d = createShowerDetector();
    const hits = feed(d, "sdb", [
      [0, 52, 20.5],
      [30, 52, 20.6], // a 30 min reporting cadence, room at rest
      [40, 68, 22.4], // someone showers
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].baseline).toBe(52);
    expect(hits[0].gain).toBeCloseTo(16, 5);
    expect(hits[0].tempGain).toBeCloseTo(1.9, 5);
  });

  it("ignores humidity climbing on its own — that is the weather", () => {
    // Both gîte bathrooms, 21:00 → 02:00, +10 points with the temperature flat.
    const d = createShowerDetector();
    const points: Array<[number, number, number | null]> = [];
    for (let i = 0; i <= 20; i++) points.push([i * 15, 55 + i * 0.5, 20.4]);
    expect(feed(d, "sdb", points)).toEqual([]);
  });

  it("ignores the room warming up — heating pushes the relative humidity down", () => {
    const d = createShowerDetector();
    expect(
      feed(d, "sdb", [
        [0, 60, 17],
        [20, 55, 19],
        [40, 51, 21],
      ]),
    ).toEqual([]);
  });

  it("says nothing about a room with no temperature probe", () => {
    const d = createShowerDetector();
    expect(
      feed(d, "sdb", [
        [0, 50, null],
        [20, 72, null],
      ]),
    ).toEqual([]);
  });

  it("announces a burst once, however often it is asked", () => {
    const d = createShowerDetector();
    d.sample("sdb", { at: 0, humidity: 50, temperature: 20 });
    let hits = 0;
    // A caller ticking every 30 s for half an hour on a room that stays wet.
    for (let s = 30; s <= 1800; s += 30) {
      if (d.sample("sdb", { at: 10 * MIN + s * 1000, humidity: 66, temperature: 21.5 })) hits++;
    }
    expect(hits).toBe(1);
  });

  it("counts a second shower on top of a room that has not dried yet", () => {
    const d = createShowerDetector();
    const hits = feed(d, "sdb", [
      [0, 50, 20],
      [10, 62, 21.2], // first shower
      [40, 60, 21.0], // barely dropped
      [50, 70, 22.0], // second shower
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
    for (let i = 0; i <= 25; i++) fastPoints.push([i, 52 + i * 0.2, 20 + i * 0.03]);
    const fastHits = feed(fast, "sdb", fastPoints);
    expect(fastHits).toHaveLength(1);
    expect(fastHits[0].baseline).toBe(52);

    const slow = createShowerDetector();
    const slowHits = feed(slow, "sdb", [
      [0, 52, 20],
      [20, 56, 20.6],
    ]);
    expect(slowHits).toHaveLength(1);
    expect(slowHits[0].baseline).toBe(52);
  });

  it("forgets a rise that took longer than the window", () => {
    const d = createShowerDetector();
    const points: Array<[number, number, number | null]> = [];
    // +12 points and +1.5 °C, but spread over three hours: a wet day, not a
    // shower. Every 45 min window only ever sees a third of it.
    for (let i = 0; i <= 36; i++) points.push([i * 5, 55 + i * 0.33, 20 + i * 0.04]);
    expect(feed(d, "sdb", points)).toEqual([]);
  });

  it("keeps one room's window out of another's", () => {
    const d = createShowerDetector();
    d.sample("a", { at: 0, humidity: 50, temperature: 20 });
    d.sample("b", { at: 0, humidity: 70, temperature: 20 });
    expect(d.sample("b", { at: 10 * MIN, humidity: 71, temperature: 21 })).toBeNull();
    expect(d.sample("a", { at: 10 * MIN, humidity: 60, temperature: 21 })).not.toBeNull();
  });

  it("takes its thresholds from the caller", () => {
    const d = createShowerDetector({ risePts: 10, tempRiseC: 2 });
    d.sample("sdb", { at: 0, humidity: 50, temperature: 20 });
    expect(d.sample("sdb", { at: 10 * MIN, humidity: 58, temperature: 23 })).toBeNull();
    expect(d.sample("sdb", { at: 20 * MIN, humidity: 62, temperature: 23 })).not.toBeNull();
  });

  it("drops a room on request", () => {
    const d = createShowerDetector();
    d.sample("sdb", { at: 0, humidity: 50, temperature: 20 });
    d.forget("sdb");
    // Nothing to compare against any more: the rise starts from scratch.
    expect(d.sample("sdb", { at: 10 * MIN, humidity: 66, temperature: 22 })).toBeNull();
  });
});
