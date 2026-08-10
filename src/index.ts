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
// Effective minimum per room = max(humidityMin, floor + outdoorMargin), and
// the VMC only runs while a room is above that AND ventilation still gains
// at least `outdoorMargin` points. Without an outdoor temperature the recipe
// falls back to the raw RH comparison; without an outdoor sensor at all it
// is a plain max/min hysteresis.
//
// Orders are sent on TRANSITIONS only — a manual change in between is never
// overridden until the next transition.
// ============================================================

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

const SENSOR_TYPES = ["sensor", "weather", "thermostat", "heater", "camera"];
const VMC_TYPES = ["switch", "appliance"];
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

const round1 = (v: number): number => Math.round(v * 10) / 10;

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
    "Démarre la VMC quand une pièce dépasse l'humidité maximale et la maintient jusqu'à ce que toutes soient sous la cible. Tient compte de l'air extérieur : ventiler n'assèche que si l'air du dehors, réchauffé à la température intérieure, est plus sec. Peut aussi extraire sur détection de présence (WC). À utiliser seule sur une VMC — une autre recette sur le même équipement entrerait en conflit.",
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
      "Starts the ventilation when a room rises above the maximum humidity and keeps it running until every room is back under the target. Accounts for outdoor air: ventilating only dries when the outside air, warmed to the indoor temperature, is drier. Optional motion sensors also extract on use (toilets). Use it alone on a ventilation — another recipe on the same equipment would fight it.",

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
      if (!findPowerOrderAlias(vmcEq)) {
        throw new Error(`Ventilation "${vmcEq.name}" exposes no on/off order`);
      }

      const twoSpeed = isTwoSpeed(params);
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
      const boostId =
        isTwoSpeed(params) && typeof params.vmcBoost === "string" && params.vmcBoost
          ? params.vmcBoost
          : null;
      const alwaysOn = flagOn(params.alwaysOn) && boostId !== null;
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

      // ── Resolve equipments and aliases once ─────────────────
      const vmcEq = ctx.equipmentManager.getByIdWithDetails(vmcId);
      const boostEq = boostId ? ctx.equipmentManager.getByIdWithDetails(boostId) : null;
      const outdoorEq = outdoorId ? ctx.equipmentManager.getByIdWithDetails(outdoorId) : null;

      const vmcOrderAlias = findPowerOrderAlias(vmcEq) ?? "state";
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
      let blockedUntil = 0;
      let motionRunning = false; // occupancy-driven cycle
      let motionRunStartedAt = 0;
      let motionBlockedUntil = 0;
      // Restored from the persisted state so a restart (recipe update, param
      // edit) remembers what this recipe switched on — otherwise a VMC turned
      // on by the previous run would never be turned off again. null = the
      // recipe has never driven this output, so it must not force it off.
      const restoreBool = (key: string): boolean | null => {
        const v = ctx.state.get(key);
        return typeof v === "boolean" ? v : null;
      };
      let mainOn: boolean | null = restoreBool("vmcOn");
      let boostOn: boolean | null = restoreBool("boostOn");
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

      // An instance is restarted on every recipe update or param edit. Coming
      // up with nothing to do must stay silent: forcing an OFF at startup
      // would fight whoever switched the VMC on by hand.
      const setMain = (on: boolean, why: string) => {
        if (mainOn === on) return;
        const firstAssert = mainOn === null;
        mainOn = on;
        putState("vmcOn", on);
        if (firstAssert && !on) return;
        ctx.log(`VMC ${on ? "ON" : "OFF"} — ${why}`);
        sendOrder(vmcId, vmcOrderAlias, on, "VMC");
      };

      const setBoost = (on: boolean, why: string) => {
        if (!boostId || !boostOrderAlias || boostOn === on) return;
        const firstAssert = boostOn === null;
        boostOn = on;
        putState("boostOn", on);
        if (firstAssert && !on) return;
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
            motionBlockedUntil = now + MOTION_BLOCK_MS;
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

        // ══ Humidity cycle ════════════════════════════════════
        let status = "idle";
        let detail = "";

        const fresh = rooms.filter(
          (r) => r.humidity !== null && now - r.humidityAt <= STALE_READING_MS,
        );

        if (running && now - runStartedAt >= maxRunMs) {
          // The maximum run time is a hard cap: it outranks every other rule,
          // including the no-data path below.
          blockedUntil = now + COOLDOWN_AFTER_MAX_RUN_MS;
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
            const effectiveMin =
              floor === null ? humidityMin : Math.max(humidityMin, floor + outdoorMargin);
            // Ventilation is only useful while the room sits above what the
            // outdoor air can deliver, by at least the drying margin.
            const useful = floor === null ? true : rh > floor + outdoorMargin;

            if (rh > worstHumidity) {
              worstHumidity = rh;
              worstName = r.name;
              worstFloor = floor;
            }
            if (!useful) {
              if (rh >= humidityMax) blockedByOutdoor = true;
              continue;
            }
            if (rh >= humidityMax) demand = true;
            if (rh > effectiveMin) hold = true;
            if (rh >= humidityMax + boostDelta) boostDemand = true;
            if (rh >= humidityMax) boostHold = true;
          }

          putState("maxHumidity", round1(worstHumidity));
          putState("maxHumidityRoom", worstName);
          putState("outdoorFloor", worstFloor === null ? null : round1(worstFloor));

          const worst = `${worstName} à ${round1(worstHumidity)} %`;
          const floorText = worstFloor === null ? "?" : String(round1(worstFloor));

          if (running) {
            const elapsed = now - runStartedAt;
            if (elapsed < minRunMs) {
              // Anti short-cycling: keep running, but the speed may adapt.
              status = "running";
              detail = `Durée mini en cours — ${worst}`;
            } else if (quiet) {
              stopHumidityRun("plage silencieuse");
              status = "quiet";
              detail = "Plage silencieuse";
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

        // ══ Outputs ═══════════════════════════════════════════
        const extraction = running || motionRunning;
        const why = running ? detail : motionRunning ? "occupation détectée" : detail;
        applyOutputs(extraction, highDemand, why);

        if (motionRunning) {
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
              r.humidity = num(value);
              r.humidityAt = Date.now();
              matched = true;
            }
            if (r.tempAlias && alias === r.tempAlias) {
              r.temperature = num(value);
              matched = true;
            }
          }
          if (outdoorId && eqId === outdoorId) {
            if (alias === outdoorHumAlias) {
              outdoorHumidity = num(value);
              matched = true;
            }
            if (alias === outdoorTempAlias) {
              outdoorTemp = num(value);
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

      ctx.log(
        `VMC hygro-pilotée démarrée (${rooms.length} pièce(s), max ${humidityMax} %, cible ${humidityMin} %` +
          (outdoorId ? `, compensation extérieure +${outdoorMargin} pts` : "") +
          (boostId ? ", 2 vitesses" : "") +
          (alwaysOn ? ", petite vitesse permanente" : "") +
          (motionSensors.length > 0
            ? `, ${motionSensors.length} détecteur(s) (confirmation ${fmt(motionConfirmMs)}, prolongation ${fmt(motionRunAfterMs)})`
            : "") +
          (quietEnabled
            ? `, silence ${String(params.quietStart ?? "22:00")}–${String(params.quietEnd ?? "07:00")}${quietScope === "humidity" ? " (humidité seulement)" : ""}`
            : "") +
          ")",
      );

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
