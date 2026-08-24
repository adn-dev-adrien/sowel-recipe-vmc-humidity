// ============================================================
// Shower detector — a self-contained, dependency-free module
//
// Portable on purpose. It knows nothing about Sowel: no core types, no
// context, no equipment, no clock of its own. Feed it readings, it hands back
// showers. That makes it a file to COPY into any recipe that needs the same
// signal — `sowel-recipe-water-heater-smart` counts showers to bill the tank,
// this one dries the room afterwards — which is the same convention recipe
// packages already follow for the core types they mirror rather than import.
//
// Sharing it through the core (`ctx.helpers`) was the alternative and was not
// worth it: every consumer would still have to keep a local copy for older
// cores, so the code would be duplicated anyway, with a core release in the
// middle of the loop.
//
// ── What names a shower ─────────────────────────────────────
//
// The correlation. Relative humidity climbing on its own is weather: two gîte
// bathrooms gained ten points between 21:00 and 02:00 with the room
// temperature dead flat. Temperature climbing on its own is heating, and it
// pushes relative humidity DOWN as the air warms. Only running water moves
// both up at once, and it does it fast — measured showers climb 0.10–0.22
// points per minute against 0.036 for that overnight drift.
//
// ── Why a window, and not two consecutive readings ──────────
//
// Because sensors report on their own cadence. A jump of "2 points between two
// samples" means a shower on a probe reporting every 30 min and means nothing
// on one reporting every minute. Measuring the rise against the driest sample
// of a fixed window asks the same question of both. That sample is also the
// level the room stood at before anyone ran the water — which is exactly what
// a drying cycle has to come back to.
// ============================================================

export interface ShowerReading {
  /** Epoch ms. The caller owns the clock — tests pass a fake one. */
  at: number;
  /** Relative humidity, %. */
  humidity: number;
  /** Room temperature, °C. `null` disables detection for that room: humidity
   *  alone cannot tell a shower from the weather, and guessing is worse. */
  temperature: number | null;
}

export interface ShowerHit {
  /** Humidity the room sat at before the shower — the driest sample of the
   *  window, and the level a drying cycle should chase. */
  baseline: number;
  /** Points of relative humidity gained since that sample. */
  gain: number;
  /** Degrees gained over the same span — the half of the evidence that rules
   *  out the weather. */
  tempGain: number;
  /** How long ago the baseline was measured, ms. */
  sinceMs: number;
}

export interface ShowerDetectorOptions {
  /** Points of relative humidity over the window that make a rise a shower. */
  risePts?: number;
  /** Degrees the room must have gained over the same window. Deliberately low:
   *  probes report in 0.1 steps, and a shower moves a bathroom 1–2 °C. */
  tempRiseC?: number;
  /** How far back the rise is measured. Also the slowest climb that still
   *  counts: `risePts` over `windowMs`. */
  windowMs?: number;
  /** Minimum spacing between kept samples. One a minute is plenty — a shower
   *  lasts ten — and it bounds the window to ~45 entries per room. */
  sampleMs?: number;
}

export const SHOWER_RISE_PTS = 4;
export const SHOWER_TEMP_RISE_C = 0.5;
export const SHOWER_WINDOW_MS = 45 * 60_000;
export const SHOWER_SAMPLE_MS = 60_000;

interface Sample {
  at: number;
  h: number;
  t: number | null;
}

export interface ShowerDetector {
  /**
   * Feed one room's current reading. Returns a shower the moment the window
   * shows one, then nothing until a new rise builds: the burst is consumed on
   * the way out, so a caller ticking every 30 s is told once, not ninety
   * times. Call it on every evaluation — repeated identical readings are
   * cheap, and a gap in the calls only shortens the memory.
   */
  sample(id: string, reading: ShowerReading): ShowerHit | null;
  /** Drop a room's window (sensor removed, detection turned off). */
  forget(id: string): void;
}

export function createShowerDetector(options: ShowerDetectorOptions = {}): ShowerDetector {
  const risePts = options.risePts ?? SHOWER_RISE_PTS;
  const tempRiseC = options.tempRiseC ?? SHOWER_TEMP_RISE_C;
  const windowMs = options.windowMs ?? SHOWER_WINDOW_MS;
  const sampleMs = options.sampleMs ?? SHOWER_SAMPLE_MS;

  const windows = new Map<string, Sample[]>();

  return {
    sample(id: string, reading: ShowerReading): ShowerHit | null {
      const { at, humidity, temperature } = reading;
      if (!Number.isFinite(humidity)) return null;

      let samples = windows.get(id);
      if (!samples) {
        samples = [];
        windows.set(id, samples);
      }
      const last = samples[samples.length - 1];
      if (!last || at - last.at >= sampleMs) {
        samples.push({ at, h: humidity, t: temperature });
        // Keep one sample beyond the window: dropping to nothing would forget
        // the level the room came from at the very moment it starts to climb.
        while (samples.length > 1 && at - samples[0].at > windowMs) samples.shift();
      }
      if (temperature === null || !Number.isFinite(temperature)) return null;

      let anchor: Sample | null = null;
      for (const s of samples) {
        if (s.t === null) continue;
        if (anchor === null || s.h < anchor.h) anchor = s;
      }
      const anchorTemp = anchor === null ? null : anchor.t;
      if (anchor === null || anchorTemp === null) return null;

      const gain = humidity - anchor.h;
      const tempGain = temperature - anchorTemp;
      if (gain < risePts || tempGain < tempRiseC) return null;

      // Consume the burst: re-anchoring on the current reading is what stops
      // the same rise being announced again on every call for a whole window.
      windows.set(id, [{ at, h: humidity, t: temperature }]);
      return { baseline: anchor.h, gain, tempGain, sinceMs: at - anchor.at };
    },

    forget(id: string): void {
      windows.delete(id);
    },
  };
}
