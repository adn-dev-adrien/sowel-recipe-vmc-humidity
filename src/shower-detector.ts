// ============================================================
// Shower detector — a self-contained, dependency-free module
//
// Portable on purpose. It knows nothing about Sowel: no core types, no
// context, no equipment, no clock of its own. Feed it readings, it hands back
// showers. That makes it a file to COPY into any recipe that needs the same
// signal — `sowel-recipe-water-heater-smart` counts showers to bill the tank,
// `sowel-recipe-vmc-humidity` dries the room afterwards — which is the same
// convention recipe packages already follow for the core types they mirror
// rather than import.
//
// ── What names a shower: water, not humidity ────────────────
//
// Relative humidity is not a quantity of water. The same air reads 50 % at
// 24 °C and 56 % at 22 °C without a drop being added or removed, so a room
// cooling down all evening looks exactly like a room getting wetter — and a
// room being heated looks like one drying out.
//
// So the rise is measured on the water itself: each reading is converted to
// its vapour pressure (Magnus), and the window's driest sample is expressed at
// the CURRENT temperature before being compared. Same trick as the
// psychrometric floor the recipe already uses on outdoor air, applied to the
// room's own past:
//
//     anchor expressed here = RH_anchor × Psat(T_anchor) / Psat(T_now)
//
// A shower is then the one thing that moves it: water added, fast.
//
// Measured on 2026-08-24 at 22:33, an August evening with the room at a flat
// 24.7 °C: two bathrooms went +6.1 and +6.2 points of added water in half an
// hour, while a third drifted +3.3 then +1.6 over the same period and was
// rightly left alone.
//
// An earlier version of this module required the room temperature to rise with
// the humidity. It cost a real shower that same evening: in summer a bathroom
// already sitting at 24.7 °C does not warm up half a degree, and the detector
// stayed silent while the room held 60 % all night. Temperature belongs in the
// conversion, not in a gate.
//
// ── Why a window, and not two consecutive readings ──────────
//
// Because sensors report on their own cadence. A jump of "2 points between two
// samples" means a shower on a probe reporting every 30 min and means nothing
// on one reporting every minute. Measuring the rise against the driest sample
// of a fixed window asks the same question of both — and sets a floor on the
// rate as a side effect: `risePts` over `windowMs`, which is 0.09 points a
// minute at the defaults, against 0.2 for the shower above and 0.036 for the
// overnight drift that fooled the first version.
// ============================================================

/** Saturation vapour pressure in hPa (Magnus, over water). */
export function psat(tempC: number): number {
  return 6.112 * Math.exp((17.62 * tempC) / (243.12 + tempC));
}

export interface ShowerReading {
  /** Epoch ms. The caller owns the clock — tests pass a fake one. */
  at: number;
  /** Relative humidity, %. */
  humidity: number;
  /** Room temperature, °C. Without it the comparison falls back to raw
   *  relative humidity, which cannot tell added water from a cooling room —
   *  workable, but the weaker signal. */
  temperature: number | null;
}

/** Per-room overrides of the thresholds, for a caller that learns them. */
export interface ShowerThresholds {
  risePts?: number;
}

export interface ShowerHit {
  /** What the room actually read before the shower — the driest sample of the
   *  window, as the sensor reported it. This is the level a drying cycle
   *  should chase, and the one a human will recognise in the history. */
  baseline: number;
  /** Water gained since that sample, in points of relative humidity AT THE
   *  CURRENT TEMPERATURE. Equal to the raw difference when the room has not
   *  moved in temperature, which is the common case. */
  gain: number;
  /** How long ago the baseline was measured, ms. */
  sinceMs: number;
  /** The bar this rise had to clear, in points. Worth logging: it is what a
   *  caller that tunes per room has to be able to explain afterwards. */
  risePts: number;
}

export interface ShowerDetectorOptions {
  /** Points of added water over the window that make a rise a shower. */
  risePts?: number;
  /** How far back the rise is measured. Also the slowest climb that still
   *  counts: `risePts` over `windowMs`. */
  windowMs?: number;
  /** Minimum spacing between kept samples. One a minute is plenty — a shower
   *  lasts ten — and it bounds the window to ~45 entries per room. */
  sampleMs?: number;
}

export const SHOWER_RISE_PTS = 4;
export const SHOWER_WINDOW_MS = 45 * 60_000;
export const SHOWER_SAMPLE_MS = 60_000;

interface Sample {
  at: number;
  h: number;
  t: number | null;
  /** Vapour pressure, hPa — null when the room reports no temperature. */
  e: number | null;
}

export interface ShowerDetector {
  /**
   * Feed one room's current reading. Returns a shower the moment the window
   * shows one, then nothing until a new rise builds: the burst is consumed on
   * the way out, so a caller ticking every 30 s is told once, not ninety
   * times. Call it on every evaluation — repeated identical readings are
   * cheap, and a gap in the calls only shortens the memory.
   *
   * `thresholds` overrides the detector's defaults for THIS room. Bathrooms
   * are not comparable: volume, extraction and above all where the probe hangs
   * decide whether a shower shows up as four points or twenty-five. A caller
   * that has watched a room can say so here, and a caller that has not simply
   * leaves it out.
   */
  sample(id: string, reading: ShowerReading, thresholds?: ShowerThresholds): ShowerHit | null;
  /** Drop a room's window (sensor removed, detection turned off). */
  forget(id: string): void;
}

export function createShowerDetector(options: ShowerDetectorOptions = {}): ShowerDetector {
  const defaultRise = options.risePts ?? SHOWER_RISE_PTS;
  const windowMs = options.windowMs ?? SHOWER_WINDOW_MS;
  const sampleMs = options.sampleMs ?? SHOWER_SAMPLE_MS;

  const windows = new Map<string, Sample[]>();

  return {
    sample(id: string, reading: ShowerReading, thresholds?: ShowerThresholds): ShowerHit | null {
      const { at, humidity, temperature } = reading;
      if (!Number.isFinite(humidity)) return null;
      const roomRise = thresholds?.risePts ?? defaultRise;
      const temp = temperature !== null && Number.isFinite(temperature) ? temperature : null;
      const vapour = temp === null ? null : (humidity / 100) * psat(temp);

      let samples = windows.get(id);
      if (!samples) {
        samples = [];
        windows.set(id, samples);
      }
      const last = samples[samples.length - 1];
      if (!last || at - last.at >= sampleMs) {
        samples.push({ at, h: humidity, t: temp, e: vapour });
        // Keep one sample beyond the window: dropping to nothing would forget
        // the level the room came from at the very moment it starts to climb.
        while (samples.length > 1 && at - samples[0].at > windowMs) samples.shift();
      }

      // The driest sample of the window — by water when the room reports its
      // temperature, by raw reading when it does not.
      let anchor: Sample | null = null;
      for (const s of samples) {
        if (vapour !== null && s.e === null) continue; // not comparable
        const better =
          anchor === null ||
          (vapour !== null ? (s.e as number) < (anchor.e as number) : s.h < anchor.h);
        if (better) anchor = s;
      }
      if (anchor === null) return null;

      // Express the anchor at today's temperature before comparing: a room
      // that merely cooled holds exactly as much water as it did.
      const anchorHere =
        vapour !== null && anchor.t !== null
          ? (anchor.h * psat(anchor.t)) / psat(temp as number)
          : anchor.h;
      const gain = humidity - anchorHere;
      if (gain < roomRise) return null;

      // Consume the burst: re-anchoring on the current reading is what stops
      // the same rise being announced again on every call for a whole window.
      windows.set(id, [{ at, h: humidity, t: temp, e: vapour }]);
      return { baseline: anchor.h, gain, sinceMs: at - anchor.at, risePts: roomRise };
    },

    forget(id: string): void {
      windows.delete(id);
    },
  };
}
