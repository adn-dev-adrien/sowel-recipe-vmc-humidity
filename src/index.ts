// ============================================================
// VMC Humidity Control — external Sowel recipe
//
// Extracts humidity from the rooms the ventilation actually serves.
//
//   Start the VMC when ANY supervised room rises above `humidityMax`,
//   run until EVERY room is back under its effective minimum,
//   unless the outdoor air is too wet for ventilation to help.
//
// The outdoor guard is the interesting part. Relative humidity is not
// comparable between two air masses at different temperatures: 90 %RH at
// 5 °C outdoors becomes ~34 %RH once that air is warmed to 20 °C indoors —
// it dries the house hard. Conversely 70 %RH at 25 °C outdoors becomes
// ~85 %RH at 22 °C indoors — ventilating would ADD moisture.
//
// So the recipe converts the outdoor reading to the humidity it would have
// at the indoor temperature (Magnus formula) and treats that as the floor
// no amount of ventilation can beat:
//
//     floor = RH_ext × Psat(T_ext) / Psat(T_int)
//
// The margin is a start condition, not a stop one: a cycle begins only when
// the room sits at least `outdoorMargin` points above the floor, then runs
// until it reaches the floor (or the configured target, whichever is higher).
// Without that hysteresis the floor's own drift — a couple of points as the
// evening cools — starts and stops the ventilation on a fraction of a point,
// less than the sensors can measure. Without an outdoor temperature the
// recipe falls back to the raw RH comparison; without an outdoor sensor at
// all it is a plain max/min hysteresis.
//
// A shower is the one event those thresholds answer too late: by the time
// the room crosses `humidityMax` the vapour has been on the walls for a
// quarter of an hour. It is named by the correlation — humidity climbing
// WITH the room's own temperature — and then answered on its own terms: the
// ventilation runs until the room is back to the humidity it had before the
// shower, and the quiet window does not hold that one back.
//
// Orders are sent on TRANSITIONS only — a manual change in between is never
// overridden until the next transition.
// ============================================================

import {
  createShowerDetector,
  SHOWER_RISE_PTS,
  SHOWER_TEMP_RISE_C,
  type ShowerHit,
} from "./shower-detector.js";

// ============================================================
// Types (mirrored from Sowel core — recipe packages don't import core)
// ============================================================

interface DataBindingLite {
  alias: string;
  category?: string;
  value?: unknown;
  lastUpdated?: string | null;
}

interface OrderBindingLite {
  alias: string;
  category?: string;
  type?: string;
}

interface EquipmentLite {
  name: string;
  type?: string;
  dataBindings: DataBindingLite[];
  orderBindings: OrderBindingLite[];
}

interface RecipeContext {
  eventBus: {
    onType(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  };
  equipmentManager: {
    getByIdWithDetails(id: string): EquipmentLite | null;
  };
  zoneManager: {
    getById(id: string): { id: string; name: string } | null;
  };
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    debug(obj: Record<string, unknown>, msg?: string): void;
  };
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    clear(): void;
  };
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    parseDuration(value: unknown): number;
    formatDuration(ms: number): string;
  };
  dispatchOrder(
    equipmentId: string,
    alias: string,
    value: unknown,
  ): Promise<{ success: boolean; error?: string }>;
}

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type:
    | "zone"
    | "equipment"
    | "number"
    | "duration"
    | "time"
    | "boolean"
    | "text"
    | "data-key"
    | "select";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  options?: { value: string; label: string }[];
  hiddenWhen?: { slot: string; equals: string | string[] };
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
    crossZone?: boolean;
    includeDescendants?: boolean;
  };
  group?: string;
}

interface RecipeSlotI18n {
  name: string;
  description: string;
  options?: Record<string, string>;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, RecipeSlotI18n>;
  groups?: Record<string, string>;
}

interface RecipeInstanceHandle {
  stop(): void;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(params: Record<string, unknown>, ctx: RecipeContext): RecipeInstanceHandle;
}

// ============================================================
// Constants
// ============================================================

/** Re-evaluate on a clock too: min/max run times and quiet hours are time-driven. */
const CLOCK_MS = 30_000;
/** After a max-run cut, stay off this long before considering a new cycle. */
const COOLDOWN_AFTER_MAX_RUN_MS = 60 * 60_000;
/** A humidity reading older than this is ignored (dead sensor must not pin the VMC on). */
const STALE_READING_MS = 60 * 60_000;
/** Fallback indoor temperature when no probe reports one (only used for the floor). */
const ASSUMED_INDOOR_TEMP = 20;
/** Detections further apart than this belong to two different bursts (PIR blind time). */
const MOTION_BURST_GAP_MS = 3 * 60_000;
/** Pause after an occupancy run hit its cap — stray detections must not loop. */
const MOTION_BLOCK_MS = 30 * 60_000;
/** A relay state that disagrees with our last order is only believed after this
 *  long — a Zigbee round trip and a slow report are not a human. */
const MANUAL_CONFIRM_MS = 60_000;
/** Never re-send the silence order more often than this, whatever fights back. */
const QUIET_ENFORCE_GAP_MS = 5 * 60_000;
/** Someone cutting the ventilation by hand is an instruction: stand down. */
const MANUAL_OVERRIDE_BLOCK_MS = 60 * 60_000;

/** How close to its pre-shower level a room must come back before the drying
 *  cycle ends. Exactly is asymptotic: the last point costs longer than the
 *  first three. */
const SHOWER_RECOVERY_PTS = 1;

const SENSOR_TYPES = ["sensor", "weather", "thermostat", "heater", "camera"];
const VMC_TYPES = ["switch", "appliance", "vmc"];
const MOTION_TYPES = ["sensor", "camera"];

// ============================================================
// Pure helpers (exported for tests)
// ============================================================

/** Saturation vapour pressure in hPa (Magnus, over water). */
export function psat(tempC: number): number {
  return 6.112 * Math.exp((17.62 * tempC) / (243.12 + tempC));
}

/**
 * Outdoor relative humidity expressed at the indoor temperature — the lowest
 * indoor RH ventilation can possibly reach. Returns null when the outdoor
 * humidity is unknown; falls back to the raw outdoor RH when either
 * temperature is missing (no conversion possible).
 */
export function ventilationFloor(
  rhOutdoor: number | null,
  tempOutdoor: number | null,
  tempIndoor: number | null,
): number | null {
  if (rhOutdoor === null || !Number.isFinite(rhOutdoor)) return null;
  if (
    tempOutdoor === null ||
    tempIndoor === null ||
    !Number.isFinite(tempOutdoor) ||
    !Number.isFinite(tempIndoor)
  ) {
    return clampRh(rhOutdoor);
  }
  return clampRh((rhOutdoor * psat(tempOutdoor)) / psat(tempIndoor));
}

function clampRh(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** Minutes-of-day for an "HH:MM" string. NaN when malformed. */
export function hmToMinutes(timeStr: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!m) return NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return NaN;
  return h * 60 + min;
}

/** Whether `nowMin` falls in the [start, end) window, wrapping past midnight. */
export function inWindow(nowMin: number, startMin: number, endMin: number): boolean {
  if (Number.isNaN(startMin) || Number.isNaN(endMin)) return false;
  if (startMin === endMin) return false;
  return startMin < endMin
    ? nowMin >= startMin && nowMin < endMin
    : nowMin >= startMin || nowMin < endMin;
}

/** Minutes from `fromMin` to the next `targetMin`, wrapping past midnight. */
export function minutesUntil(fromMin: number, targetMin: number): number {
  return (targetMin - fromMin + 1440) % 1440;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Whether a relay/switch reading means "closed". Integrations report
 *  booleans, "ON"/"OFF" strings or 0/1 depending on the device. */
export function isSwitchOn(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "on" || v === "true" || v === "1") return true;
    if (v === "off" || v === "false" || v === "0") return false;
  }
  return null;
}

/**
 * Whether a motion/occupancy reading means "someone is there". Integrations
 * report booleans, strings ("ON", "true", "detected") or 0/1 depending on the
 * device, and a momentary detector may re-send the same truthy value.
 */
export function isMotionDetected(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    return s === "true" || s === "on" || s === "1" || s === "detected" || s === "occupied";
  }
  return false;
}

/**
 * Whether a flag param is on. Flags moved from `boolean` to `select` in 0.3.0
 * (the grouped recipe form has no checkbox renderer and showed a raw "false"),
 * so instances written before that still carry real booleans.
 */
export function flagOn(value: unknown): boolean {
  return value === true || value === "on" || value === "true";
}

/**
 * Shower detection is on unless it is explicitly turned off: instances written
 * before it existed carry no flag at all and get the behaviour.
 */
export function isShowerEnabled(params: Record<string, unknown>): boolean {
  return params.showerMode === undefined || flagOn(params.showerMode);
}

/**
 * Two-speed mode. Instances predating the explicit flag are recognised by
 * their high-speed equipment, so an existing configuration keeps working.
 */
export function isTwoSpeed(params: Record<string, unknown>): boolean {
  if (params.twoSpeed !== undefined) return flagOn(params.twoSpeed);
  return typeof params.vmcBoost === "string" && params.vmcBoost !== "";
}

// ============================================================
// Slots
// ============================================================

function buildSlots(): RecipeSlotDef[] {
  return [
    { id: "zone", name: "Zone", description: "Zone of the ventilation", type: "zone", required: true },
    // ── Ventilation ───────────────────────────────────────────
    // Slot counts per group are deliberate: the recipe form lays a group out
    // as `n <= 3 ? n : 2` columns, so a group must show 2, 3, 4 or 6 fields to
    // fill its rows. Booleans are `select`s because the grouped layout has no
    // checkbox renderer — it falls back to a text input showing "false".
    {
      id: "vmc",
      name: "Ventilation",
      description: "On/off equipment to drive",
      type: "equipment",
      required: true,
      constraints: { equipmentType: VMC_TYPES, crossZone: true },
      group: "vmc",
    },
    {
      id: "twoSpeed",
      name: "Two speeds",
      description: "Adds a high speed",
      type: "select",
      required: false,
      defaultValue: "off",
      options: [
        { value: "off", label: "No" },
        { value: "on", label: "Yes" },
      ],
      group: "vmc",
    },
    {
      id: "vmcBoost",
      name: "High speed",
      description: "Equipment of the second speed",
      type: "equipment",
      required: false,
      constraints: { equipmentType: VMC_TYPES, crossZone: true },
      hiddenWhen: { slot: "twoSpeed", equals: "off" },
      group: "vmc",
    },
    {
      id: "alwaysOn",
      name: "Low speed on",
      description: "Only the high speed is driven",
      type: "select",
      required: false,
      defaultValue: "off",
      options: [
        { value: "off", label: "No" },
        { value: "on", label: "Yes" },
      ],
      hiddenWhen: { slot: "twoSpeed", equals: "off" },
      group: "vmc",
    },

    {
      id: "sensors",
      name: "Humidity sensors",
      description: "Rooms the ventilation serves",
      type: "equipment",
      required: true,
      list: true,
      constraints: { equipmentType: SENSOR_TYPES, crossZone: true, includeDescendants: true },
      group: "sensors",
    },

    // ── Thresholds ────────────────────────────────────────────
    {
      id: "humidityMax",
      name: "Max humidity",
      description: "Starts above (%)",
      type: "number",
      required: false,
      defaultValue: 60,
      constraints: { min: 40, max: 90 },
      group: "thresholds",
    },
    {
      id: "humidityMin",
      name: "Target",
      description: "Stops below (%)",
      type: "number",
      required: false,
      defaultValue: 50,
      constraints: { min: 30, max: 80 },
      group: "thresholds",
    },
    {
      id: "boostDelta",
      name: "Boost margin",
      description: "Points over the max",
      type: "number",
      required: false,
      defaultValue: 5,
      constraints: { min: 0, max: 30 },
      hiddenWhen: { slot: "twoSpeed", equals: "off" },
      group: "thresholds",
    },

    // ── Outdoor air ───────────────────────────────────────────
    {
      id: "outdoorSensor",
      name: "Outdoor sensor",
      description: "Humidity, ideally temperature",
      type: "equipment",
      required: false,
      constraints: { equipmentType: ["weather", "sensor", "weather_forecast"], crossZone: true },
      group: "outdoor",
    },
    {
      id: "outdoorMargin",
      name: "Drying margin",
      description: "Minimum gain (points)",
      type: "number",
      required: false,
      defaultValue: 3,
      constraints: { min: 0, max: 15 },
      group: "outdoor",
    },

    // ── Occupancy ─────────────────────────────────────────────
    {
      id: "motionSensors",
      name: "Motion sensors",
      description: "Ventilate the toilets on use",
      type: "equipment",
      required: false,
      list: true,
      constraints: { equipmentType: MOTION_TYPES, crossZone: true, includeDescendants: true },
      group: "motion",
    },
    {
      id: "motionConfirm",
      name: "Confirmation",
      description: "Sustained motion",
      type: "duration",
      required: false,
      defaultValue: "1m",
      group: "motion",
    },
    {
      id: "motionRunAfter",
      name: "Extra run",
      description: "After last detection",
      type: "duration",
      required: false,
      defaultValue: "15m",
      group: "motion",
    },
    {
      id: "motionMaxRun",
      name: "Presence max",
      description: "Then a 30 min pause",
      type: "duration",
      required: false,
      defaultValue: "45m",
      group: "motion",
    },

    // ── Shower ────────────────────────────────────────────────
    {
      id: "showerMode",
      name: "Shower",
      description: "Extract on a detected shower",
      type: "select",
      required: false,
      defaultValue: "on",
      options: [
        { value: "on", label: "Yes" },
        { value: "off", label: "No" },
      ],
      group: "shower",
    },
    {
      id: "showerMaxRun",
      name: "Shower max",
      description: "Cap of a drying cycle",
      type: "duration",
      required: false,
      defaultValue: "1h",
      // Deliberately not hidden when the detection is off: the group would
      // drop to a single field and leave a hole in the grid row.
      group: "shower",
    },

    // ── Guards ────────────────────────────────────────────────
    {
      id: "minRun",
      name: "Minimum run",
      description: "Anti short-cycling",
      type: "duration",
      required: false,
      defaultValue: "15m",
      group: "limits",
    },
    {
      id: "maxRun",
      name: "Maximum run",
      description: "Forced stop, 1 h off",
      type: "duration",
      required: false,
      defaultValue: "3h",
      group: "limits",
    },
    {
      id: "quietMode",
      name: "Quiet hours",
      description: "Nightly block",
      type: "select",
      required: false,
      defaultValue: "off",
      options: [
        { value: "off", label: "No" },
        { value: "on", label: "Yes" },
      ],
      group: "limits",
    },
    {
      id: "quietStart",
      name: "Quiet from",
      description: "Start of the window",
      type: "time",
      required: false,
      defaultValue: "22:00",
      hiddenWhen: { slot: "quietMode", equals: "off" },
      group: "limits",
    },
    {
      id: "quietEnd",
      name: "Quiet until",
      description: "End of the window",
      type: "time",
      required: false,
      defaultValue: "07:00",
      hiddenWhen: { slot: "quietMode", equals: "off" },
      group: "limits",
    },
    {
      id: "quietScope",
      name: "Quiet scope",
      description: "All or humidity",
      type: "select",
      required: false,
      defaultValue: "all",
      options: [
        { value: "all", label: "Everything" },
        { value: "humidity", label: "Humidity only" },
      ],
      hiddenWhen: { slot: "quietMode", equals: "off" },
      group: "limits",
    },
  ];
}

// ============================================================
// i18n
// ============================================================

const I18N_FR: RecipeLangPack = {
  name: "VMC hygro-pilotée",
  description:
    "Démarre la VMC quand une pièce dépasse l'humidité maximale et la maintient jusqu'à ce que toutes soient sous la cible. Tient compte de l'air extérieur : ventiler n'assèche que si l'air du dehors, réchauffé à la température intérieure, est plus sec. Détecte les douches — l'humidité qui monte en même temps que la température — et ventile jusqu'à ce que la pièce retrouve son taux d'avant la douche, même en plage silencieuse. Peut aussi extraire sur détection de présence (WC). À utiliser seule sur une VMC — une autre recette sur le même équipement entrerait en conflit.",
  slots: {
    zone: { name: "Zone", description: "Zone de la VMC" },
    sensors: { name: "Sondes d'humidité", description: "Pièces desservies par la VMC" },

    vmc: { name: "VMC", description: "Équipement on/off à piloter" },
    twoSpeed: {
      name: "2 vitesses",
      description: "Ajoute une grande vitesse",
      options: { off: "Non", on: "Oui" },
    },
    vmcBoost: { name: "Grande vitesse", description: "Équipement de la 2ᵉ vitesse" },
    alwaysOn: {
      name: "PV permanente",
      description: "Seule la grande vitesse tourne",
      options: { off: "Non", on: "Oui" },
    },

    humidityMax: { name: "Humidité maxi", description: "Démarrage (%)" },
    humidityMin: { name: "Cible", description: "Arrêt (%)" },
    boostDelta: { name: "Marge boost", description: "Points au-dessus" },

    outdoorSensor: { name: "Capteur extérieur", description: "Humidité + température" },
    outdoorMargin: { name: "Marge d'assèchement", description: "Gain minimal utile (points)" },

    motionSensors: { name: "Détecteurs", description: "Extraction sur passage aux WC" },
    motionConfirm: { name: "Confirmation", description: "Mouvement soutenu" },
    motionRunAfter: { name: "Prolongation", description: "Après la détection" },
    motionMaxRun: { name: "Maxi présence", description: "Puis 30 min de pause" },

    showerMode: {
      name: "Douche",
      description: "Extraction sur douche détectée",
      options: { on: "Oui", off: "Non" },
    },
    showerMaxRun: { name: "Maxi séchage", description: "Plafond d'un cycle douche" },

    minRun: { name: "Marche mini", description: "Anti court-cycle" },
    maxRun: { name: "Marche maxi", description: "Arrêt forcé + repos" },
    quietMode: {
      name: "Silence",
      description: "Interdit la nuit",
      options: { off: "Non", on: "Oui" },
    },
    quietStart: { name: "Silence de", description: "Début de la plage" },
    quietEnd: { name: "Silence à", description: "Fin de la plage" },
    quietScope: {
      name: "Portée",
      description: "Tout ou humidité",
      options: { all: "Tout", humidity: "Humidité seulement" },
    },
  },
  groups: {
    sensors: "Pièces supervisées",
    vmc: "VMC",
    thresholds: "Seuils d'humidité",
    outdoor: "Air extérieur",
    motion: "Présence (WC)",
    shower: "Douche",
    limits: "Garde-fous",
  },
};

// ============================================================
// Binding resolution
// ============================================================

function findAlias(
  eq: EquipmentLite | null,
  categories: string[],
  aliasHints: string[],
): string | null {
  if (!eq) return null;
  for (const c of categories) {
    const b = eq.dataBindings.find((d) => d.category === c);
    if (b) return b.alias;
  }
  for (const a of aliasHints) {
    const b = eq.dataBindings.find((d) => d.alias === a);
    if (b) return b.alias;
  }
  return null;
}

/** Power order alias of an on/off equipment, or null when it exposes none. */
export function findPowerOrderAlias(eq: EquipmentLite | null): string | null {
  if (!eq) return null;
  const byCategory = eq.orderBindings.find((o) => o.category === "toggle_power");
  if (byCategory) return byCategory.alias;
  const byAlias = eq.orderBindings.find(
    (o) => o.alias === "state" || o.alias === "power" || o.alias === "switch",
  );
  if (byAlias) return byAlias.alias;
  const boolean = eq.orderBindings.find((o) => o.type === "boolean");
  return boolean ? boolean.alias : null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function bindingValue(eq: EquipmentLite | null, alias: string | null): number | null {
  if (!eq || !alias) return null;
  return num(eq.dataBindings.find((b) => b.alias === alias)?.value);
}

function bindingUpdatedAt(eq: EquipmentLite | null, alias: string | null): number {
  if (!eq || !alias) return 0;
  const raw = eq.dataBindings.find((b) => b.alias === alias)?.lastUpdated;
  if (typeof raw !== "string") return 0;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

// ============================================================
// Recipe definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "vmc-humidity",
    name: "VMC Humidity Control",
    description:
      "Starts the ventilation when a room rises above the maximum humidity and keeps it running until every room is back under the target. Accounts for outdoor air: ventilating only dries when the outside air, warmed to the indoor temperature, is drier. Detects showers — humidity climbing together with the temperature — and ventilates until the room is back to its pre-shower level, quiet window included. Optional motion sensors also extract on use (toilets). Use it alone on a ventilation — another recipe on the same equipment would fight it.",

    slots: buildSlots(),

    i18n: { fr: I18N_FR },

    // ============================================================
    // Validation
    // ============================================================

    validate(params: Record<string, unknown>, ctx: RecipeContext): void {
      if (typeof params.zone !== "string" || !params.zone) {
        throw new Error("zone parameter is required");
      }
      if (!ctx.zoneManager.getById(params.zone)) {
        throw new Error("Zone not found");
      }

      const sensorIds = Array.isArray(params.sensors)
        ? (params.sensors as unknown[]).filter((s): s is string => typeof s === "string")
        : typeof params.sensors === "string" && params.sensors
          ? [params.sensors]
          : [];
      if (sensorIds.length === 0) {
        throw new Error("At least one humidity sensor is required");
      }
      for (const id of sensorIds) {
        const eq = ctx.equipmentManager.getByIdWithDetails(id);
        if (!eq) throw new Error(`Sensor equipment not found: ${id}`);
        if (!findAlias(eq, ["humidity"], ["humidity", "humidity_1"])) {
          throw new Error(`Sensor "${eq.name}" does not report humidity`);
        }
      }

      if (typeof params.vmc !== "string" || !params.vmc) {
        throw new Error("vmc parameter is required");
      }
      const vmcEq = ctx.equipmentManager.getByIdWithDetails(params.vmc);
      if (!vmcEq) throw new Error("Ventilation equipment not found");
      // A native `vmc` equipment (spec 153) is driven through its `speed` order
      // (off/v1/v2), which the core decomposes with its own safety interlock;
      // it needs no separate high-speed equipment and ignores the two-speed
      // slots below.
      const nativeVmc = vmcEq.type === "vmc";
      if (!nativeVmc && !findPowerOrderAlias(vmcEq)) {
        throw new Error(`Ventilation "${vmcEq.name}" exposes no on/off order`);
      }

      const twoSpeed = !nativeVmc && isTwoSpeed(params);
      const boostId = twoSpeed && typeof params.vmcBoost === "string" ? params.vmcBoost : "";
      if (twoSpeed && !boostId) {
        throw new Error("A two-speed unit needs its high-speed equipment");
      }
      if (boostId) {
        const boostEq = ctx.equipmentManager.getByIdWithDetails(boostId);
        if (!boostEq) throw new Error("High-speed equipment not found");
        if (!findPowerOrderAlias(boostEq)) {
          throw new Error(`High-speed "${boostEq.name}" exposes no on/off order`);
        }
        if (boostId === params.vmc) {
          throw new Error("High-speed equipment must differ from the ventilation equipment");
        }
      }
      // `alwaysOn` is deliberately NOT checked here. The form hides a slot but
      // keeps its value, so switching back to a single-speed unit leaves
      // "permanent low speed" set to yes behind the scenes. A hidden field
      // must never be able to block a save: the value is simply ignored,
      // exactly as createInstance ignores it without a high-speed equipment.

      if (typeof params.outdoorSensor === "string" && params.outdoorSensor) {
        const outEq = ctx.equipmentManager.getByIdWithDetails(params.outdoorSensor);
        if (!outEq) throw new Error("Outdoor equipment not found");
        if (!findAlias(outEq, ["humidity_outdoor", "humidity"], ["humidity"])) {
          throw new Error(`Outdoor equipment "${outEq.name}" does not report humidity`);
        }
      }

      const max = Number(params.humidityMax ?? 60);
      const min = Number(params.humidityMin ?? 50);
      if (!Number.isFinite(max) || !Number.isFinite(min)) {
        throw new Error("Humidity thresholds must be numbers");
      }
      if (min >= max) {
        throw new Error("Target humidity must be lower than the maximum humidity");
      }

      const minRun = ctx.helpers.parseDuration(params.minRun ?? "15m");
      const maxRun = ctx.helpers.parseDuration(params.maxRun ?? "3h");
      if (!(maxRun > 0) || !(minRun >= 0)) {
        throw new Error("Run durations must be positive (e.g. 15m, 3h)");
      }
      if (minRun >= maxRun) {
        throw new Error("Minimum run time must be shorter than the maximum run time");
      }

      if (params.quietMode === "on") {
        if (Number.isNaN(hmToMinutes(String(params.quietStart ?? "22:00")))) {
          throw new Error("Quiet start must be HH:MM");
        }
        if (Number.isNaN(hmToMinutes(String(params.quietEnd ?? "07:00")))) {
          throw new Error("Quiet end must be HH:MM");
        }
      }

      const motionIds = Array.isArray(params.motionSensors)
        ? (params.motionSensors as unknown[]).filter((s): s is string => typeof s === "string")
        : typeof params.motionSensors === "string" && params.motionSensors
          ? [params.motionSensors]
          : [];
      for (const id of motionIds) {
        const eq = ctx.equipmentManager.getByIdWithDetails(id);
        if (!eq) throw new Error(`Motion equipment not found: ${id}`);
        if (!findAlias(eq, ["motion", "camera_detection"], ["motion", "occupancy"])) {
          throw new Error(`Sensor "${eq.name}" reports no motion`);
        }
      }
      if (motionIds.length > 0) {
        const confirm = ctx.helpers.parseDuration(params.motionConfirm ?? "1m");
        const after = ctx.helpers.parseDuration(params.motionRunAfter ?? "15m");
        const motionMax = ctx.helpers.parseDuration(params.motionMaxRun ?? "45m");
        if (!(after > 0) || !(motionMax > 0)) {
          throw new Error("Occupancy durations must be positive (e.g. 15m, 45m)");
        }
        if (confirm >= motionMax) {
          throw new Error("Occupancy confirmation must be shorter than the occupancy maximum");
        }
      }

      if (isShowerEnabled(params)) {
        const showerMax = ctx.helpers.parseDuration(params.showerMaxRun ?? "1h");
        if (!(showerMax > 0)) {
          throw new Error("Shower drying cap must be positive (e.g. 1h)");
        }
      }
    },

    // ============================================================
    // Instance
    // ============================================================

    createInstance(params: Record<string, unknown>, ctx: RecipeContext): RecipeInstanceHandle {
      // ── Params ──────────────────────────────────────────────
      const sensorIds = Array.isArray(params.sensors)
        ? (params.sensors as unknown[]).filter((s): s is string => typeof s === "string")
        : typeof params.sensors === "string" && params.sensors
          ? [params.sensors]
          : [];
      const vmcId = params.vmc as string;
      // Spec 153 — a native `vmc` equipment is a single 2-speed unit driven by
      // a `speed` order; it never uses a separate boost equipment or the
      // permanent-low-speed trick.
      const nativeVmc = ctx.equipmentManager.getByIdWithDetails(vmcId)?.type === "vmc";
      const boostId =
        !nativeVmc && isTwoSpeed(params) && typeof params.vmcBoost === "string" && params.vmcBoost
          ? params.vmcBoost
          : null;
      const alwaysOn = !nativeVmc && flagOn(params.alwaysOn) && boostId !== null;
      const humidityMax = Number(params.humidityMax ?? 60);
      const humidityMin = Number(params.humidityMin ?? 50);
      const boostDelta = Number(params.boostDelta ?? 5);
      const outdoorId =
        typeof params.outdoorSensor === "string" && params.outdoorSensor
          ? params.outdoorSensor
          : null;
      const outdoorMargin = Number(params.outdoorMargin ?? 3);
      const minRunMs = ctx.helpers.parseDuration(params.minRun ?? "15m");
      const maxRunMs = ctx.helpers.parseDuration(params.maxRun ?? "3h");
      const quietEnabled = params.quietMode === "on";
      const quietStartMin = hmToMinutes(String(params.quietStart ?? "22:00"));
      const quietEndMin = hmToMinutes(String(params.quietEnd ?? "07:00"));
      const quietScope = params.quietScope === "humidity" ? "humidity" : "all";
      const motionIds = Array.isArray(params.motionSensors)
        ? (params.motionSensors as unknown[]).filter((s): s is string => typeof s === "string")
        : typeof params.motionSensors === "string" && params.motionSensors
          ? [params.motionSensors]
          : [];
      const motionConfirmMs = ctx.helpers.parseDuration(params.motionConfirm ?? "1m");
      const motionRunAfterMs = ctx.helpers.parseDuration(params.motionRunAfter ?? "15m");
      const motionMaxRunMs = ctx.helpers.parseDuration(params.motionMaxRun ?? "45m");
      const showerEnabled = isShowerEnabled(params);
      const showerMaxRunMs = ctx.helpers.parseDuration(params.showerMaxRun ?? "1h");

      // ── Resolve equipments and aliases once ─────────────────
      const vmcEq = ctx.equipmentManager.getByIdWithDetails(vmcId);
      const boostEq = boostId ? ctx.equipmentManager.getByIdWithDetails(boostId) : null;
      const outdoorEq = outdoorId ? ctx.equipmentManager.getByIdWithDetails(outdoorId) : null;

      // Native VMC: the single logical `speed` order (off/v1/v2). Legacy: the
      // on/off relay power order.
      const vmcOrderAlias = nativeVmc ? "speed" : (findPowerOrderAlias(vmcEq) ?? "state");
      // What the relay actually reports, so the recipe can tell its own orders
      // from someone else's — and notice when its model of the world is stale.
      const vmcStateAlias = findAlias(vmcEq, ["light_state"], ["state", "power", "switch"]);
      const boostStateAlias = boostEq
        ? findAlias(boostEq, ["light_state"], ["state", "power", "switch"])
        : null;
      const boostOrderAlias = boostEq ? (findPowerOrderAlias(boostEq) ?? "state") : null;

      const outdoorHumAlias = findAlias(outdoorEq, ["humidity_outdoor", "humidity"], ["humidity"]);
      const outdoorTempAlias = findAlias(
        outdoorEq,
        ["temperature_outdoor", "temperature"],
        ["temperature"],
      );

      interface Room {
        id: string;
        name: string;
        humAlias: string;
        tempAlias: string | null;
        humidity: number | null;
        humidityAt: number;
        temperature: number | null;
      }

      const rooms: Room[] = [];
      for (const id of sensorIds) {
        const eq = ctx.equipmentManager.getByIdWithDetails(id);
        if (!eq) {
          ctx.log(`Capteur introuvable (${id.slice(0, 8)}), ignoré`, "warn");
          continue;
        }
        const humAlias = findAlias(eq, ["humidity"], ["humidity", "humidity_1"]);
        if (!humAlias) {
          ctx.log(`Capteur "${eq.name}" sans humidité, ignoré`, "warn");
          continue;
        }
        const tempAlias = findAlias(eq, ["temperature"], ["temperature"]);
        rooms.push({
          id,
          name: eq.name,
          humAlias,
          tempAlias,
          humidity: bindingValue(eq, humAlias),
          humidityAt: bindingUpdatedAt(eq, humAlias) || Date.now(),
          temperature: bindingValue(eq, tempAlias),
        });
      }

      let outdoorHumidity = bindingValue(outdoorEq, outdoorHumAlias);
      let outdoorTemp = bindingValue(outdoorEq, outdoorTempAlias);

      interface MotionSensor {
        id: string;
        name: string;
        alias: string;
        /** Start of the current burst of detections (null when idle). */
        firstAt: number | null;
        /** Last detection of the current burst. */
        lastAt: number | null;
      }

      const motionSensors: MotionSensor[] = [];
      for (const id of motionIds) {
        const eq = ctx.equipmentManager.getByIdWithDetails(id);
        if (!eq) {
          ctx.log(`Détecteur introuvable (${id.slice(0, 8)}), ignoré`, "warn");
          continue;
        }
        const alias = findAlias(eq, ["motion", "camera_detection"], ["motion", "occupancy"]);
        if (!alias) {
          ctx.log(`Détecteur "${eq.name}" sans donnée de mouvement, ignoré`, "warn");
          continue;
        }
        motionSensors.push({ id, name: eq.name, alias, firstAt: null, lastAt: null });
      }

      // ── Runtime state ───────────────────────────────────────
      let running = false; // humidity-driven cycle
      let runStartedAt = 0;
      let motionRunning = false; // occupancy-driven cycle
      let motionRunStartedAt = 0;
      // Restored from the persisted state so a restart (recipe update, param
      // edit) remembers what this recipe switched on — otherwise a VMC turned
      // on by the previous run would never be turned off again. null = the
      // recipe has never driven this output, so it must not force it off.
      const restoreBool = (key: string): boolean | null => {
        const v = ctx.state.get(key);
        return typeof v === "boolean" ? v : null;
      };
      /**
       * Stand-down deadlines outlive the instance. A recipe update restarts
       * every instance, and an in-memory latch would hand back a ventilation
       * the recipe had just decided to leave alone for an hour — the "the VMC
       * comes on right after an update" report.
       */
      const restoreTime = (key: string): number => {
        const v = ctx.state.get(key);
        return typeof v === "number" && Number.isFinite(v) ? v : 0;
      };
      let blockedUntil = restoreTime("blockedUntil");
      let motionBlockedUntil = restoreTime("motionBlockedUntil");
      const setBlockedUntil = (at: number) => {
        blockedUntil = at;
        putState("blockedUntil", at);
      };
      const setMotionBlockedUntil = (at: number) => {
        motionBlockedUntil = at;
        putState("motionBlockedUntil", at);
      };

      let mainOn: boolean | null = restoreBool("vmcOn");
      let vmcObserved: boolean | null = null;
      let boostObserved: boolean | null = null;
      /** True once the relay has reported the state we ordered. Silence is not
       *  evidence: a binding that never agrees says nothing about who acted. */
      let vmcAgreed = false;
      let mismatchSince: number | null = null;
      let lastQuietEnforceAt = 0;
      let boostOn: boolean | null = restoreBool("boostOn");
      // Native VMC: the last speed the recipe commanded (off/v1/v2). null = never
      // driven, so a restart must not force an OFF onto a unit running by hand.
      let lastSpeed: string | null =
        typeof ctx.state.get("vmcSpeed") === "string" ? (ctx.state.get("vmcSpeed") as string) : null;
      let highDemand = false; // high-speed hysteresis of the humidity cycle
      let stopped = false;
      const lastSeen = new Map<string, unknown>();

      // evaluate() runs every 30 s; each ctx.state.set writes to SQLite and
      // pushes a WebSocket update, so only write what actually changed.
      const stateCache = new Map<string, unknown>();
      const putState = (key: string, value: unknown) => {
        if (stateCache.has(key) && stateCache.get(key) === value) return;
        stateCache.set(key, value);
        ctx.state.set(key, value);
      };

      const setStatus = (status: string, detail: string) => {
        putState("status", status);
        putState("reason", detail);
      };

      const sendOrder = (equipmentId: string, alias: string, value: boolean, what: string) => {
        ctx.dispatchOrder(equipmentId, alias, value)
          .then((res) => {
            if (res && res.success === false) {
              ctx.log(`Échec ordre ${what} : ${res.error ?? "erreur"}`, "error");
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log(`Échec ordre ${what} : ${msg}`, "error");
          });
      };

      /** Native VMC: dispatch the `speed` order (off/v1/v2). The core enforces
       *  the break-before-make relay interlock, so the recipe just names a speed. */
      const sendSpeed = (target: string) => {
        ctx.dispatchOrder(vmcId, "speed", target)
          .then((res) => {
            if (res && res.success === false) {
              ctx.log(`Échec ordre vitesse : ${res.error ?? "erreur"}`, "error");
            }
          })
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            ctx.log(`Échec ordre vitesse : ${msg}`, "error");
          });
      };

      /**
       * Native VMC output: one `speed` order per transition. Mirrors setMain's
       * startup silence (a fresh instance must not force an OFF onto a unit
       * running by hand) and its "already there" short-circuit.
       */
      const applyNativeSpeed = (extraction: boolean, high: boolean, why: string) => {
        const target = !extraction ? "off" : high ? "v2" : "v1";
        if (lastSpeed === target) return;
        const firstAssert = lastSpeed === null;
        lastSpeed = target;
        mainOn = extraction;
        boostOn = extraction && high;
        putState("vmcOn", extraction);
        putState("boostOn", extraction && high);
        putState("vmcSpeed", target);
        if (firstAssert && target === "off") return;
        const label = target === "off" ? "arrêt" : target === "v2" ? "grande vitesse" : "petite vitesse";
        ctx.log(`VMC → ${label} — ${why}`);
        sendSpeed(target);
      };

      // An instance is restarted on every recipe update or param edit. Coming
      // up with nothing to do must stay silent: forcing an OFF at startup
      // would fight whoever switched the VMC on by hand.
      const setMain = (on: boolean, why: string) => {
        if (mainOn === on) return;
        const firstAssert = mainOn === null;
        mainOn = on;
        putState("vmcOn", on);
        vmcAgreed = false; // wait for the relay to confirm this one
        if (firstAssert && !on) return;
        // The relay is already there — usually after a restart, where the
        // recipe re-decides from scratch while the ventilation never stopped.
        // Sending the order anyway produces no state change, and the core's
        // delivery confirmation (spec 141) rightly reports an order nothing
        // answered.
        if (vmcObserved === on) {
          vmcAgreed = true;
          ctx.log(`VMC déjà ${on ? "en marche" : "à l'arrêt"} — ${why}`);
          return;
        }
        ctx.log(`VMC ${on ? "ON" : "OFF"} — ${why}`);
        sendOrder(vmcId, vmcOrderAlias, on, "VMC");
      };

      const setBoost = (on: boolean, why: string) => {
        if (!boostId || !boostOrderAlias || boostOn === on) return;
        const firstAssert = boostOn === null;
        boostOn = on;
        putState("boostOn", on);
        if (firstAssert && !on) return;
        if (boostObserved === on) {
          ctx.log(`Grande vitesse déjà ${on ? "en marche" : "à l'arrêt"} — ${why}`);
          return;
        }
        ctx.log(`Grande vitesse ${on ? "ON" : "OFF"} — ${why}`);
        sendOrder(boostId, boostOrderAlias, on, "grande vitesse");
      };

      /**
       * Single place where the two cycles (humidity, occupancy) become orders.
       *
       * With a permanent low speed the main equipment is never switched off,
       * so extraction can only mean the high speed — otherwise the recipe
       * would "run" without changing anything.
       */
      const applyOutputs = (extraction: boolean, high: boolean, why: string) => {
        if (nativeVmc) {
          applyNativeSpeed(extraction, high, why);
          return;
        }
        if (alwaysOn) {
          setMain(true, "petite vitesse permanente");
          setBoost(extraction, why);
          return;
        }
        setMain(extraction, why);
        if (boostId) setBoost(extraction && high, why);
      };

      /**
       * Re-read every binding from the equipment manager.
       *
       * Events alone are not enough: `equipment.data.changed` only fires when
       * the value actually CHANGES, so a room sitting at a stable 65 % emits
       * nothing for hours. Freshness must come from the binding's own
       * `lastUpdated`, which the core refreshes on every device report.
       */
      const refreshReadings = (now: number) => {
        for (const r of rooms) {
          const eq = ctx.equipmentManager.getByIdWithDetails(r.id);
          if (!eq) continue; // equipment gone: keep the last value, staleness will catch it
          const value = bindingValue(eq, r.humAlias);
          if (value !== null) {
            r.humidity = value;
            r.humidityAt = bindingUpdatedAt(eq, r.humAlias) || r.humidityAt || now;
          }
          if (r.tempAlias) {
            const t = bindingValue(eq, r.tempAlias);
            if (t !== null) r.temperature = t;
          }
        }
        if (outdoorId) {
          const eq = ctx.equipmentManager.getByIdWithDetails(outdoorId);
          if (eq) {
            const hum = bindingValue(eq, outdoorHumAlias);
            if (hum !== null) outdoorHumidity = hum;
            const t = bindingValue(eq, outdoorTempAlias);
            if (t !== null) outdoorTemp = t;
          }
        }
        if (vmcStateAlias) {
          const eq = ctx.equipmentManager.getByIdWithDetails(vmcId);
          const raw = eq?.dataBindings.find((b) => b.alias === vmcStateAlias)?.value;
          vmcObserved = isSwitchOn(raw);
        }
        if (boostId && boostStateAlias) {
          const eq = ctx.equipmentManager.getByIdWithDetails(boostId);
          const raw = eq?.dataBindings.find((b) => b.alias === boostStateAlias)?.value;
          boostObserved = isSwitchOn(raw);
        }
        // A PIR that holds `occupancy = true` emits no further event: read the
        // level too, so an ongoing presence keeps refreshing the burst.
        for (const m of motionSensors) {
          const eq = ctx.equipmentManager.getByIdWithDetails(m.id);
          if (!eq) continue;
          const raw = eq.dataBindings.find((b) => b.alias === m.alias)?.value;
          if (isMotionDetected(raw)) noteMotion(m, now);
        }
      };

      /**
       * Record a detection, growing the current burst or opening a new one.
       *
       * Bursts are what tells a real visit from a stray detection: someone in
       * the room keeps the sensor firing, a passer-by seen through an open
       * door produces one short burst and nothing more.
       */
      const noteMotion = (m: MotionSensor, now: number) => {
        if (m.lastAt !== null && now - m.lastAt > MOTION_BURST_GAP_MS) {
          m.firstAt = now; // the previous burst is over — this is a new one
        } else if (m.firstAt === null) {
          m.firstAt = now;
        }
        m.lastAt = now;
      };

      /** Occupancy is confirmed once a burst has lasted `motionConfirm`. */
      const motionState = (now: number) => {
        let lastAt = 0;
        let confirmedBy: string | null = null;
        for (const m of motionSensors) {
          if (m.lastAt === null || m.firstAt === null) continue;
          if (m.lastAt > lastAt) lastAt = m.lastAt;
          if (m.lastAt - m.firstAt >= motionConfirmMs && now - m.lastAt <= motionRunAfterMs) {
            confirmedBy = m.name;
          }
        }
        return { lastAt, confirmedBy };
      };

      // ── Shower detection ────────────────────────────────────
      // The detector itself lives in `shower-detector.ts`: it knows nothing of
      // Sowel, so it can be copied as-is into any other recipe that needs the
      // same signal. What stays here is the policy — what a shower is worth.
      const showerDetector = createShowerDetector();

      interface ShowerCycle {
        /** Kept here rather than read back from the equipment: the log has to
         *  name the room even if its sensor disappears mid-cycle. */
        name: string;
        /** Humidity the room must come back to — its level before the shower. */
        target: number;
        startedAt: number;
      }
      /** One entry per room still drying out. */
      const showerCycles = new Map<string, ShowerCycle>();

      /**
       * A drying cycle outlives the instance, like the stand-down deadlines
       * above: a recipe update in the middle of a shower would otherwise leave
       * a saturated bathroom with nothing running.
       */
      const restoreShowerCycles = () => {
        const raw = ctx.state.get("showerCycles");
        if (typeof raw !== "string" || !raw) return;
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!Array.isArray(parsed)) return;
          for (const entry of parsed) {
            if (!Array.isArray(entry) || entry.length !== 2) continue;
            const [id, cycle] = entry as [unknown, Partial<ShowerCycle>];
            if (typeof id !== "string" || !cycle) continue;
            if (typeof cycle.target !== "number" || typeof cycle.startedAt !== "number") continue;
            showerCycles.set(id, {
              name: typeof cycle.name === "string" ? cycle.name : id.slice(0, 8),
              target: cycle.target,
              startedAt: cycle.startedAt,
            });
          }
        } catch {
          // A state entry we cannot read is not worth a crash — the worst case
          // is a bathroom that falls back to the plain humidity thresholds.
        }
      };
      restoreShowerCycles();

      const saveShowerCycles = () => {
        putState("showerCycles", JSON.stringify([...showerCycles.entries()]));
      };

      /** Feed every fresh room to the detector, and collect what it names. */
      const pollShowers = (now: number): Array<{ room: Room; hit: ShowerHit }> => {
        const hits: Array<{ room: Room; hit: ShowerHit }> = [];
        for (const r of rooms) {
          if (r.humidity === null || now - r.humidityAt > STALE_READING_MS) continue;
          const hit = showerDetector.sample(r.id, {
            at: now,
            humidity: r.humidity,
            temperature: r.temperature,
          });
          if (hit !== null) hits.push({ room: r, hit });
        }
        return hits;
      };

      const fmt = (ms: number) => ctx.helpers.formatDuration(ms);

      const startHumidityRun = (why: string) => {
        running = true;
        runStartedAt = Date.now();
        putState("running", true);
        ctx.log(`Extraction humidité — ${why}`);
      };

      const stopHumidityRun = (why: string) => {
        running = false;
        highDemand = false;
        putState("running", false);
        ctx.log(`Extraction humidité terminée — ${why}`);
      };

      // ── Core evaluation ─────────────────────────────────────
      const evaluate = () => {
        if (stopped) return;
        const now = Date.now();
        const d = new Date(now);
        const nowMin = d.getHours() * 60 + d.getMinutes();

        refreshReadings(now);

        const quiet = quietEnabled && inWindow(nowMin, quietStartMin, quietEndMin);

        // ══ Occupancy cycle (toilets) ═════════════════════════
        const { lastAt: lastMotionAt, confirmedBy } = motionState(now);
        const quietBlocksMotion = quiet && quietScope === "all";

        if (motionRunning) {
          if (quietBlocksMotion) {
            motionRunning = false;
            ctx.log("Extraction occupation arrêtée — plage silencieuse");
          } else if (now - motionRunStartedAt >= motionMaxRunMs) {
            // Sustained detections for that long are not a toilet visit —
            // most likely an open door watching a busy hallway.
            motionRunning = false;
            setMotionBlockedUntil(now + MOTION_BLOCK_MS);
            ctx.log(
              `Extraction occupation arrêtée — ${fmt(motionMaxRunMs)} de détections continues (porte ouverte ?), pause de ${fmt(MOTION_BLOCK_MS)}`,
              "warn",
            );
          } else if (lastMotionAt === 0 || now - lastMotionAt > motionRunAfterMs) {
            motionRunning = false;
            ctx.log(`Extraction occupation terminée — ${fmt(motionRunAfterMs)} sans détection`);
          }
        } else if (!quietBlocksMotion && now >= motionBlockedUntil && confirmedBy !== null) {
          motionRunning = true;
          motionRunStartedAt = now;
          ctx.log(`Occupation confirmée (${confirmedBy}) — extraction`);
        }
        putState("motionRunning", motionRunning);

        // ══ Shower cycle (bathrooms) ══════════════════════════
        // A shower is answered on its own terms. Not "run until 50 %" — a
        // bathroom that sat at 46 % before someone showered is not dry at 50 %
        // — but "run until the room is back where it was". And it is the one
        // demand the quiet window does not hold back: a bathroom left
        // saturated at 23:00 is still wet at 07:00, and the extra minutes cost
        // less noise than a night of condensation costs in mould.
        if (showerEnabled) {
          for (const { room, hit } of pollShowers(now)) {
            const rh = room.humidity as number;
            const floor = ventilationFloor(
              outdoorHumidity,
              outdoorTemp,
              room.temperature ?? ASSUMED_INDOOR_TEMP,
            );
            const gained = round1(hit.gain);
            const existing = showerCycles.get(room.id);
            if (floor !== null && rh <= floor) {
              // The outdoor drying margin is deliberately NOT applied here: a
              // shower is a known event, not a marginal call. What does still
              // apply is the physics — air wetter than the room adds water,
              // and no amount of run time fixes that.
              ctx.log(
                `Douche détectée (${room.name}, +${gained} pts) — rien à extraire, l'air extérieur est plus humide (plancher ${round1(floor)} %)`,
              );
            } else if (existing !== undefined) {
              // A second shower in the same room: the level to come back to is
              // still the one before anybody ran the water, so the target
              // stands — but the cap gets its full time again.
              existing.startedAt = now;
              ctx.log(`Nouvelle douche (${room.name}, +${gained} pts) — séchage prolongé`);
            } else if (now < blockedUntil) {
              // Someone cut the ventilation by hand, or the maximum run time
              // just forced it off. Both are instructions; say what was
              // skipped rather than arguing with them in silence.
              ctx.log(
                `Douche détectée (${room.name}, +${gained} pts) — VMC au repos jusqu'à ${new Date(blockedUntil).toLocaleTimeString("fr-FR")}, pas de séchage`,
                "warn",
              );
            } else {
              const target = round1(hit.baseline + SHOWER_RECOVERY_PTS);
              showerCycles.set(room.id, { name: room.name, target, startedAt: now });
              ctx.log(
                `Douche détectée (${room.name}) — ${round1(rh)} % (+${gained} pts avec +${round1(hit.tempGain)} °C), séchage jusqu'à ${target} %`,
              );
            }
          }

          for (const [id, cycle] of [...showerCycles]) {
            const room = rooms.find((r) => r.id === id);
            const rh = room?.humidity ?? null;
            if (room === undefined || rh === null || now - room.humidityAt > STALE_READING_MS) {
              showerCycles.delete(id);
              ctx.log(`Séchage ${cycle.name} arrêté — plus de mesure d'humidité`, "warn");
              continue;
            }
            const floor = ventilationFloor(
              outdoorHumidity,
              outdoorTemp,
              room.temperature ?? ASSUMED_INDOOR_TEMP,
            );
            if (rh <= cycle.target) {
              showerCycles.delete(id);
              ctx.log(
                `Séchage ${cycle.name} terminé — ${round1(rh)} %, niveau d'avant la douche retrouvé en ${fmt(now - cycle.startedAt)}`,
              );
            } else if (floor !== null && rh <= floor) {
              showerCycles.delete(id);
              ctx.log(
                `Séchage ${cycle.name} arrêté à ${round1(rh)} % — l'air extérieur ne peut pas faire mieux (plancher ${round1(floor)} %)`,
              );
            } else if (now - cycle.startedAt >= showerMaxRunMs) {
              showerCycles.delete(id);
              ctx.log(
                `Séchage ${cycle.name} arrêté — ${fmt(showerMaxRunMs)} sans revenir à ${round1(cycle.target)} % (encore ${round1(rh)} %)`,
                "warn",
              );
            }
          }
        } else if (showerCycles.size > 0) {
          // The option was turned off under a running cycle.
          for (const id of showerCycles.keys()) showerDetector.forget(id);
          showerCycles.clear();
        }

        const showerRunning = showerCycles.size > 0;
        // The vapour is on the walls: give a shower the high speed for as long
        // as the room is still over the maximum, then the low one to finish.
        let showerHigh = false;
        for (const id of showerCycles.keys()) {
          const room = rooms.find((r) => r.id === id);
          if (room === undefined || room.humidity === null) continue;
          if (room.humidity >= humidityMax) showerHigh = true;
        }
        const showerDetail = showerRunning
          ? `Séchage après douche — ${[...showerCycles.values()]
              .map((c) => `${c.name} → ${c.target} %`)
              .join(", ")}`
          : "";
        putState("showerRunning", showerRunning);
        saveShowerCycles();

        // ══ Humidity cycle ════════════════════════════════════
        let status = "idle";
        let detail = "";

        const fresh = rooms.filter(
          (r) => r.humidity !== null && now - r.humidityAt <= STALE_READING_MS,
        );

        if (running && now - runStartedAt >= maxRunMs) {
          // The maximum run time is a hard cap: it outranks every other rule,
          // including the no-data path below.
          setBlockedUntil(now + COOLDOWN_AFTER_MAX_RUN_MS);
          stopHumidityRun(
            `durée maxi atteinte (${fmt(maxRunMs)}), repos ${fmt(COOLDOWN_AFTER_MAX_RUN_MS)}`,
          );
          status = "cooldown";
          detail = "Durée maximale atteinte, repos forcé";
        } else if (fresh.length === 0) {
          if (running && now - runStartedAt >= minRunMs) {
            stopHumidityRun("aucune mesure d'humidité fraîche");
          }
          status = "no_data";
          detail = "Aucune sonde ne remonte d'humidité récente";
        } else {
          // Indoor reference temperature for the psychrometric conversion:
          // the room's own probe when it has one, else the average of the
          // others, else a conventional 20 °C.
          const temps = fresh.map((r) => r.temperature).filter((t): t is number => t !== null);
          const avgTemp =
            temps.length > 0 ? temps.reduce((a, b) => a + b, 0) / temps.length : ASSUMED_INDOOR_TEMP;

          let worstName = "";
          let worstHumidity = -Infinity;
          let worstFloor: number | null = null;
          let demand = false; // a room is above the max AND ventilating would dry it
          let hold = false; // a room is above its effective target AND still gains
          let boostDemand = false;
          let boostHold = false;
          let blockedByOutdoor = false;

          for (const r of fresh) {
            const rh = r.humidity as number;
            const tInt = r.temperature ?? avgTemp;
            const floor = ventilationFloor(outdoorHumidity, outdoorTemp, tInt);
            // The target to chase is the floor itself: the margin is what a
            // cycle must be worth to *begin*, not where it must stop.
            const effectiveMin = floor === null ? humidityMin : Math.max(humidityMin, floor);
            // Hysteresis on usefulness, not just on humidity. The drying
            // margin is what a cycle must be *worth* to begin: the outdoor
            // floor drifts by a couple of points as the evening cools, so a
            // single threshold makes the recipe start and stop on a fraction
            // of a point — less than these sensors can even measure. Once
            // running, it keeps going until there is nothing left to gain.
            const gain = floor === null ? Infinity : rh - floor;
            // An outdoor sensor that is configured but has not reported yet is
            // not the same as having none: the guard is unknown, not absent,
            // so a cycle waits rather than starting unchecked.
            const outdoorUnknown = outdoorId !== null && outdoorHumidity === null;
            const worthStarting = !outdoorUnknown && gain > outdoorMargin;
            const worthContinuing = gain > 0;

            if (rh > worstHumidity) {
              worstHumidity = rh;
              worstName = r.name;
              worstFloor = floor;
            }
            if (!worthContinuing) {
              if (rh >= humidityMax) blockedByOutdoor = true;
              continue;
            }
            if (rh >= humidityMax && !worthStarting) blockedByOutdoor = true;
            if (rh >= humidityMax && worthStarting) demand = true;
            if (rh > effectiveMin) hold = true;
            if (rh >= humidityMax + boostDelta) boostDemand = true;
            if (rh >= humidityMax) boostHold = true;
          }

          putState("maxHumidity", round1(worstHumidity));
          putState("maxHumidityRoom", worstName);
          putState("outdoorFloor", worstFloor === null ? null : round1(worstFloor));

          // The log has to carry the numbers the decision was made on. Without
          // the floor and the gain, a start can only be second-guessed by
          // replaying InfluxDB against the sensors' own sampling — which is
          // exactly what made 2026-08-21 11:11 unexplainable after the fact.
          const worst =
            worstFloor === null
              ? `${worstName} à ${round1(worstHumidity)} %`
              : `${worstName} à ${round1(worstHumidity)} % (plancher ${round1(worstFloor)} %, gain ${round1(worstHumidity - worstFloor)} pts)`;
          const floorText = worstFloor === null ? "?" : String(round1(worstFloor));

          if (running) {
            const elapsed = now - runStartedAt;
            // The quiet window outranks the minimum run time: anti
            // short-cycling protects the motor, silence is a promise made to
            // whoever sleeps next door. A cycle worth starting at 21:59 is
            // worth those nine minutes — it just ends at 22:00 sharp, and
            // nothing restarts until the window closes. The recipe keeps
            // evaluating throughout: readings, occupancy and state stay live,
            // only the orders are withheld.
            if (quiet) {
              stopHumidityRun("plage silencieuse");
              status = "quiet";
              detail = "Plage silencieuse";
            } else if (elapsed < minRunMs) {
              // Anti short-cycling: keep running, but the speed may adapt.
              status = "running";
              detail = `Durée mini en cours — ${worst}`;
            } else if (!hold) {
              stopHumidityRun(
                blockedByOutdoor
                  ? `air extérieur trop humide (plancher ${floorText} %)`
                  : `humidité redescendue (max ${round1(worstHumidity)} % sur ${worstName})`,
              );
              status = "idle";
              detail = "Humidité sous la cible";
            } else {
              status = "running";
              detail = `Extraction en cours — ${worst}`;
            }
          } else if (quiet) {
            status = "quiet";
            detail = "Plage silencieuse";
          } else if (now < blockedUntil) {
            status = "cooldown";
            detail = "Repos après arrêt sur durée maximale";
          } else if (demand) {
            startHumidityRun(`${worst} (max ${humidityMax} %)`);
            status = "running";
            detail = `Extraction en cours — ${worst}`;
          } else if (blockedByOutdoor) {
            status = "blocked_outdoor";
            detail = `Air extérieur trop humide pour assécher (plancher ${floorText} %)`;
          } else {
            status = "idle";
            detail = `Humidité maxi ${round1(worstHumidity)} % sur ${worstName}`;
          }

          // High-speed hysteresis: engage above max + margin, release under
          // the maximum. Only meaningful while the humidity cycle runs.
          if (running) {
            if (boostDemand) highDemand = true;
            else if (!boostHold) highDemand = false;
          }
        }

        // ══ Reconcile with the relay ══════════════════════════
        // Someone else — a hand on the switch, another recipe, another box —
        // may have flipped it. Believing our own last order after that turns
        // every later decision into a no-op, so reality wins once it has held
        // long enough to rule out a slow Zigbee report.
        // Native VMC (spec 153) skips relay reconciliation: the core equipment
        // owns the low/high interlock and there is no on/off relay to second-
        // guess. Manual-override respect on a native unit is left to the core.
        if (nativeVmc) {
          // no-op
        } else if (vmcObserved !== null && vmcObserved === mainOn) {
          vmcAgreed = true;
          mismatchSince = null;
        } else if (vmcAgreed && vmcObserved !== null && mainOn !== null) {
          mismatchSince ??= now;
          if (now - mismatchSince >= MANUAL_CONFIRM_MS) {
            mismatchSince = null;
            if (!vmcObserved && running) {
              // Restarting straight away would be arguing with whoever just
              // reached for the switch. Stand down, then resume normally.
              setBlockedUntil(now + MANUAL_OVERRIDE_BLOCK_MS);
              stopHumidityRun(
                `VMC coupée en dehors de la recette — retrait ${fmt(MANUAL_OVERRIDE_BLOCK_MS)}`,
              );
              status = "cooldown";
              detail = "VMC coupée manuellement";
              mainOn = vmcObserved;
              putState("vmcOn", vmcObserved);
            } else if (vmcObserved && !quiet) {
              // Someone wants it running and the recipe has no reason to
              // object — leave it alone. Do NOT copy the observed state into
              // `mainOn`: that field is what the recipe last COMMANDED, and
              // `applyOutputs` re-asserts it every tick. Adopting `true` here
              // while the recipe is idle would make the very next applyOutputs
              // see a true→false transition and fire an OFF nobody asked for.
              // Clearing `vmcAgreed` instead stops this reconciliation from
              // looping until the recipe acts or the relay reports off again.
              // Inside the quiet window the opposite holds: the enforcement
              // below owns the decision.
              ctx.log("VMC allumée en dehors de la recette");
              vmcAgreed = false;
            }
          }
        } else {
          mismatchSince = null;
        }

        // ══ Outputs ═══════════════════════════════════════════
        const extraction = running || motionRunning || showerRunning;
        const why = showerRunning
          ? showerDetail
          : running
            ? detail
            : motionRunning
              ? "occupation détectée"
              : detail;
        applyOutputs(extraction, highDemand || showerHigh, why);

        // ══ Silence is a promise, not a preference ════════════
        // The recipe stopping at 22:00 is not enough: anything else that
        // switches the ventilation on inside the window breaks the promise the
        // user configured. Whatever the recipe owns, it keeps quiet — rate
        // limited, so a relay that refuses cannot turn this into a loop.
        // `vmcAgreed` matters here: right after the recipe sends its own OFF
        // the relay still reports ON for a second or two, and without this
        // gate the enforcement below would accuse the recipe of what it just
        // did — as it did at 22:00:15 on 2026-08-17.
        if (!nativeVmc && quiet && !extraction && !alwaysOn && vmcAgreed && vmcObserved === true) {
          if (now - lastQuietEnforceAt >= QUIET_ENFORCE_GAP_MS) {
            lastQuietEnforceAt = now;
            mainOn = false;
            putState("vmcOn", false);
            ctx.log("Plage silencieuse : VMC allumée par autre chose, arrêt imposé", "warn");
            sendOrder(vmcId, vmcOrderAlias, false, "silence imposé");
          }
          setStatus("quiet", "Plage silencieuse — arrêt imposé");
          return;
        }

        if (showerRunning) {
          setStatus(
            "shower",
            showerDetail + (running ? " + humidité" : "") + (motionRunning ? " + occupation" : ""),
          );
        } else if (motionRunning) {
          setStatus(
            running ? "running" : "motion",
            running
              ? `${detail} + occupation`
              : `Occupation — extraction jusqu'à ${fmt(motionRunAfterMs)} sans détection`,
          );
        } else {
          setStatus(status, detail);
        }
      };

      // ── Subscriptions ───────────────────────────────────────
      const unsub = ctx.eventBus.onType("equipment.data.changed", (event) => {
        try {
          const eqId = event.equipmentId as string;
          const alias = event.alias as string;
          const value = event.value;

          // Motion first, and deliberately NOT de-duplicated: a momentary
          // detector re-sends the same truthy value on every detection, and
          // each one is what grows the burst.
          let motionMatched = false;
          for (const m of motionSensors) {
            if (m.id !== eqId || m.alias !== alias) continue;
            motionMatched = true;
            if (isMotionDetected(value)) noteMotion(m, Date.now());
          }
          if (motionMatched) {
            evaluate();
            return;
          }

          const key = `${eqId}:${alias}`;
          if (lastSeen.get(key) === value) return; // edge guard: events re-fire unchanged
          lastSeen.set(key, value);

          let matched = false;
          for (const r of rooms) {
            if (r.id !== eqId) continue;
            if (alias === r.humAlias) {
              // A bad reading is not news: keep the last good one and let the
              // staleness window decide. Nulling it here would erase the very
              // measurement the decision rests on.
              const parsed = num(value);
              if (parsed !== null) r.humidity = parsed;
              r.humidityAt = Date.now();
              matched = true;
            }
            if (r.tempAlias && alias === r.tempAlias) {
              const parsed = num(value);
              if (parsed !== null) r.temperature = parsed;
              matched = true;
            }
          }
          if (outdoorId && eqId === outdoorId) {
            if (alias === outdoorHumAlias) {
              // The dangerous one: a null outdoor humidity makes the floor
              // null, which reads as "no outdoor constraint" and lets a cycle
              // start unchecked.
              const parsed = num(value);
              if (parsed !== null) outdoorHumidity = parsed;
              matched = true;
            }
            if (alias === outdoorTempAlias) {
              const parsed = num(value);
              if (parsed !== null) outdoorTemp = parsed;
              matched = true;
            }
          }
          if (!matched) return;
          evaluate();
        } catch (err) {
          ctx.logger.error({ err }, "vmc-humidity: event handler error");
        }
      });

      const clock = setInterval(() => {
        try {
          evaluate();
        } catch (err) {
          ctx.logger.error({ err }, "vmc-humidity: clock error");
        }
      }, CLOCK_MS);

      putState("running", false);
      putState("motionRunning", false);
      putState("showerRunning", showerCycles.size > 0);

      ctx.log(
        `VMC hygro-pilotée démarrée (${rooms.length} pièce(s), max ${humidityMax} %, cible ${humidityMin} %` +
          (outdoorId ? `, compensation extérieure +${outdoorMargin} pts` : "") +
          (boostId ? ", 2 vitesses" : "") +
          (alwaysOn ? ", petite vitesse permanente" : "") +
          (motionSensors.length > 0
            ? `, ${motionSensors.length} détecteur(s) (confirmation ${fmt(motionConfirmMs)}, prolongation ${fmt(motionRunAfterMs)})`
            : "") +
          (showerEnabled
            ? `, détection douche (+${SHOWER_RISE_PTS} pts avec +${SHOWER_TEMP_RISE_C} °C, séchage maxi ${fmt(showerMaxRunMs)})`
            : "") +
          (quietEnabled
            ? `, silence ${String(params.quietStart ?? "22:00")}–${String(params.quietEnd ?? "07:00")}${quietScope === "humidity" ? " (humidité seulement)" : ""}`
            : "") +
          ")",
      );

      if (showerEnabled && rooms.every((r) => r.tempAlias === null)) {
        // Humidity alone cannot tell a shower from the weather, and this
        // recipe will not guess: without a temperature the rooms fall back to
        // the plain thresholds, and it says so rather than looking broken.
        ctx.log(
          "Détection de douche inactive : aucune sonde ne remonte la température de sa pièce.",
          "warn",
        );
      }

      if (quietEnabled && showerEnabled) {
        ctx.log(
          "Plage silencieuse : une douche détectée démarrera quand même la VMC, le temps de faire redescendre l'humidité.",
        );
      }

      if (quietEnabled) {
        // Two recipes driving the same VMC each own the equipment: whichever
        // acts last wins, and a schedule recipe will happily switch it back on
        // inside this recipe's quiet window.
        ctx.log(
          "Plage silencieuse active : ne pas piloter cette VMC avec une autre recette (ex. Programmation horaire), les deux se contrediraient.",
          "warn",
        );
      }

      evaluate();

      return {
        stop() {
          stopped = true;
          clearInterval(clock);
          unsub();
        },
      };
    },
  };
}
