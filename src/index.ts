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

const SENSOR_TYPES = ["sensor", "weather", "thermostat", "heater", "camera"];
const VMC_TYPES = ["switch", "appliance"];

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

// ============================================================
// Slots
// ============================================================

function buildSlots(): RecipeSlotDef[] {
  return [
    {
      id: "zone",
      name: "Zone",
      description: "Zone the ventilation belongs to",
      type: "zone",
      required: true,
    },
    {
      id: "sensors",
      name: "Humidity sensors",
      description: "Sensors of the rooms served by the ventilation (each must report humidity)",
      type: "equipment",
      required: true,
      list: true,
      constraints: { equipmentType: SENSOR_TYPES, crossZone: true, includeDescendants: true },
      group: "sensors",
    },
    {
      id: "vmc",
      name: "Ventilation",
      description: "On/off equipment driving the ventilation (low speed on a two-speed unit)",
      type: "equipment",
      required: true,
      constraints: { equipmentType: VMC_TYPES, crossZone: true },
      group: "vmc",
    },
    {
      id: "vmcBoost",
      name: "High speed",
      description:
        "Second on/off equipment for the high speed of a two-speed unit. Leave empty for a single-speed ventilation.",
      type: "equipment",
      required: false,
      constraints: { equipmentType: VMC_TYPES, crossZone: true },
      group: "vmc",
    },
    {
      id: "alwaysOn",
      name: "Permanent low speed",
      description:
        "The ventilation always runs at low speed: the recipe keeps it on and only drives the high speed. Requires a high-speed equipment.",
      type: "boolean",
      required: false,
      defaultValue: false,
      group: "vmc",
    },
    {
      id: "humidityMax",
      name: "Maximum humidity",
      description: "Above this level in any room, the ventilation starts (%)",
      type: "number",
      required: false,
      defaultValue: 60,
      constraints: { min: 40, max: 90 },
      group: "thresholds",
    },
    {
      id: "humidityMin",
      name: "Target humidity",
      description: "The ventilation runs until every room is back under this level (%)",
      type: "number",
      required: false,
      defaultValue: 50,
      constraints: { min: 30, max: 80 },
      group: "thresholds",
    },
    {
      id: "boostDelta",
      name: "High-speed margin",
      description:
        "Switch to high speed when a room exceeds the maximum by this margin (%). Ignored without a high-speed equipment.",
      type: "number",
      required: false,
      defaultValue: 5,
      constraints: { min: 0, max: 30 },
      group: "thresholds",
    },
    {
      id: "outdoorSensor",
      name: "Outdoor sensor",
      description:
        "Equipment reporting outdoor humidity (and ideally outdoor temperature). Indoor humidity can never fall below what the outdoor air brings in.",
      type: "equipment",
      required: false,
      constraints: {
        equipmentType: ["weather", "sensor", "weather_forecast"],
        crossZone: true,
      },
      group: "outdoor",
    },
    {
      id: "outdoorMargin",
      name: "Drying margin",
      description:
        "Ventilating must gain at least this many points over the outdoor floor to be worth running (%)",
      type: "number",
      required: false,
      defaultValue: 3,
      constraints: { min: 0, max: 15 },
      group: "outdoor",
    },
    {
      id: "minRun",
      name: "Minimum run time",
      description: "Once started, the ventilation runs at least this long (anti short-cycling)",
      type: "duration",
      required: false,
      defaultValue: "15m",
      group: "limits",
    },
    {
      id: "maxRun",
      name: "Maximum run time",
      description:
        "Forced stop after this duration even if humidity has not dropped (stuck sensor, open window), followed by a one-hour cooldown",
      type: "duration",
      required: false,
      defaultValue: "3h",
      group: "limits",
    },
    {
      id: "quietMode",
      name: "Quiet hours",
      description: "Block the ventilation during a nightly window",
      type: "select",
      required: false,
      defaultValue: "off",
      options: [
        { value: "off", label: "Disabled" },
        { value: "on", label: "Enabled" },
      ],
      group: "limits",
    },
    {
      id: "quietStart",
      name: "Quiet start",
      description: "Start of the quiet window",
      type: "time",
      required: false,
      defaultValue: "22:00",
      hiddenWhen: { slot: "quietMode", equals: "off" },
      group: "limits",
    },
    {
      id: "quietEnd",
      name: "Quiet end",
      description: "End of the quiet window",
      type: "time",
      required: false,
      defaultValue: "07:00",
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
    "Démarre la VMC quand une pièce supervisée dépasse l'humidité maximale et la maintient jusqu'à ce que toutes soient revenues sous la consigne. Tient compte de l'air extérieur : l'humidité extérieure est convertie à la température intérieure (formule de Magnus) pour connaître le plancher réellement atteignable — la VMC ne tourne jamais quand ventiler humidifierait au lieu d'assécher.",
  slots: {
    zone: { name: "Zone", description: "Zone de la VMC" },
    sensors: {
      name: "Sondes d'humidité",
      description:
        "Capteurs des pièces desservies par la VMC (chacun doit remonter une humidité)",
    },
    vmc: {
      name: "VMC",
      description: "Équipement on/off pilotant la VMC (petite vitesse sur une 2 vitesses)",
    },
    vmcBoost: {
      name: "Grande vitesse",
      description:
        "Second équipement on/off pour la grande vitesse d'une VMC 2 vitesses. Laisser vide pour une VMC mono-vitesse.",
    },
    alwaysOn: {
      name: "Petite vitesse permanente",
      description:
        "La VMC tourne en permanence en petite vitesse : la recette la maintient allumée et ne pilote que la grande vitesse. Nécessite un équipement grande vitesse.",
    },
    humidityMax: {
      name: "Humidité maximale",
      description: "Au-dessus de ce taux dans une pièce, la VMC démarre (%)",
    },
    humidityMin: {
      name: "Humidité cible",
      description: "La VMC tourne jusqu'à ce que toutes les pièces repassent sous ce taux (%)",
    },
    boostDelta: {
      name: "Marge grande vitesse",
      description:
        "Passe en grande vitesse quand une pièce dépasse le maximum de cette marge (%). Ignoré sans équipement grande vitesse.",
    },
    outdoorSensor: {
      name: "Capteur extérieur",
      description:
        "Équipement remontant l'humidité extérieure (et idéalement la température extérieure). L'humidité intérieure ne peut jamais descendre sous ce que l'air extérieur apporte.",
    },
    outdoorMargin: {
      name: "Marge d'assèchement",
      description:
        "Ventiler doit gagner au moins ce nombre de points sous le plancher extérieur pour valoir le coup (%)",
    },
    minRun: {
      name: "Durée mini de marche",
      description: "Une fois démarrée, la VMC tourne au moins ce temps (anti court-cycle)",
    },
    maxRun: {
      name: "Durée maxi de marche",
      description:
        "Arrêt forcé après cette durée même si l'humidité n'est pas redescendue (sonde bloquée, fenêtre ouverte), suivi d'une heure de repos",
    },
    quietMode: {
      name: "Plage silencieuse",
      description: "Interdit la VMC pendant une plage nocturne",
      options: { off: "Désactivée", on: "Activée" },
    },
    quietStart: { name: "Début plage silencieuse", description: "Début de la plage silencieuse" },
    quietEnd: { name: "Fin plage silencieuse", description: "Fin de la plage silencieuse" },
  },
  groups: {
    sensors: "Pièces supervisées",
    vmc: "VMC",
    thresholds: "Seuils d'humidité",
    outdoor: "Air extérieur",
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
      "Starts the ventilation when a supervised room rises above the maximum humidity and keeps it running until every room is back under the target. Accounts for outdoor air: the outdoor humidity is converted to the indoor temperature (Magnus formula) to know the floor ventilation can actually reach — the VMC never runs when ventilating would add moisture instead of removing it.",

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

      const boostId = typeof params.vmcBoost === "string" ? params.vmcBoost : "";
      if (boostId) {
        const boostEq = ctx.equipmentManager.getByIdWithDetails(boostId);
        if (!boostEq) throw new Error("High-speed equipment not found");
        if (!findPowerOrderAlias(boostEq)) {
          throw new Error(`High-speed "${boostEq.name}" exposes no on/off order`);
        }
        if (boostId === params.vmc) {
          throw new Error("High-speed equipment must differ from the ventilation equipment");
        }
      } else if (params.alwaysOn === true) {
        throw new Error(
          "Permanent low speed requires a high-speed equipment — otherwise the recipe has nothing to drive",
        );
      }

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
      const boostId = typeof params.vmcBoost === "string" && params.vmcBoost ? params.vmcBoost : null;
      const alwaysOn = params.alwaysOn === true && boostId !== null;
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

      // ── Runtime state ───────────────────────────────────────
      let running = false;
      let runStartedAt = 0;
      let blockedUntil = 0;
      let boostOn = false;
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

      const setBoost = (on: boolean, why: string) => {
        if (!boostId || !boostOrderAlias || boostOn === on) return;
        boostOn = on;
        putState("boostOn", on);
        ctx.log(`Grande vitesse ${on ? "ON" : "OFF"} — ${why}`);
        sendOrder(boostId, boostOrderAlias, on, "grande vitesse");
      };

      const startRun = (why: string) => {
        running = true;
        runStartedAt = Date.now();
        putState("running", true);
        if (!alwaysOn) {
          putState("vmcOn", true);
          ctx.log(`VMC ON — ${why}`);
          sendOrder(vmcId, vmcOrderAlias, true, "VMC");
        } else {
          ctx.log(`Extraction demandée — ${why}`);
        }
      };

      const stopRun = (why: string) => {
        running = false;
        setBoost(false, why);
        putState("running", false);
        if (!alwaysOn) {
          putState("vmcOn", false);
          ctx.log(`VMC OFF — ${why}`);
          sendOrder(vmcId, vmcOrderAlias, false, "VMC");
        } else {
          ctx.log(`Extraction terminée — ${why}`);
        }
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
      };

      // ── Core evaluation ─────────────────────────────────────
      const evaluate = () => {
        if (stopped) return;
        const now = Date.now();
        const d = new Date(now);
        const nowMin = d.getHours() * 60 + d.getMinutes();

        refreshReadings(now);

        const fresh = rooms.filter(
          (r) => r.humidity !== null && now - r.humidityAt <= STALE_READING_MS,
        );

        // The maximum run time is a hard cap: it wins over every other rule,
        // including the no-data path below (which would report a vaguer reason).
        if (running && now - runStartedAt >= maxRunMs) {
          blockedUntil = now + COOLDOWN_AFTER_MAX_RUN_MS;
          stopRun(
            `durée maxi atteinte (${ctx.helpers.formatDuration(maxRunMs)}), repos ${ctx.helpers.formatDuration(COOLDOWN_AFTER_MAX_RUN_MS)}`,
          );
          setStatus("cooldown", "Durée maximale atteinte, repos forcé");
          return;
        }

        if (fresh.length === 0) {
          if (running && now - runStartedAt >= minRunMs) {
            stopRun("aucune mesure d'humidité fraîche");
          }
          setStatus("no_data", "Aucune sonde ne remonte d'humidité récente");
          return;
        }

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
        let hold = false; // a room is above its effective target AND ventilating still gains
        let boostDemand = false;
        let boostHold = false;
        let blockedByOutdoor = false;

        for (const r of fresh) {
          const rh = r.humidity as number;
          const tInt = r.temperature ?? avgTemp;
          const floor = ventilationFloor(outdoorHumidity, outdoorTemp, tInt);
          const effectiveMin = floor === null ? humidityMin : Math.max(humidityMin, floor + outdoorMargin);
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

        const quiet = quietEnabled && inWindow(nowMin, quietStartMin, quietEndMin);

        if (running) {
          const elapsed = now - runStartedAt;

          // 1. Anti short-cycling: keep running, but the speed may still adapt.
          // (The maximum run time is enforced earlier — it outranks everything.)
          if (elapsed < minRunMs) {
            if (boostDemand) setBoost(true, `${worstName} à ${round1(worstHumidity)} %`);
            else if (!boostHold) setBoost(false, "humidité sous le maximum");
            setStatus("running", `Durée mini en cours — ${worstName} à ${round1(worstHumidity)} %`);
            return;
          }

          // 3. Quiet hours cut the cycle short.
          if (quiet) {
            stopRun("plage silencieuse");
            setStatus("quiet", "Plage silencieuse");
            return;
          }

          // 4. Nothing left to gain → stop.
          if (!hold) {
            stopRun(
              blockedByOutdoor
                ? `air extérieur trop humide (plancher ${worstFloor === null ? "?" : round1(worstFloor)} %)`
                : `humidité redescendue (max ${round1(worstHumidity)} % sur ${worstName})`,
            );
            setStatus("idle", "Humidité sous la cible");
            return;
          }

          if (boostDemand) setBoost(true, `${worstName} à ${round1(worstHumidity)} %`);
          else if (!boostHold) setBoost(false, "humidité sous le maximum");
          setStatus("running", `Extraction en cours — ${worstName} à ${round1(worstHumidity)} %`);
          return;
        }

        // ── Idle ──────────────────────────────────────────────
        if (quiet) {
          setStatus("quiet", "Plage silencieuse");
          return;
        }
        if (now < blockedUntil) {
          setStatus("cooldown", "Repos après arrêt sur durée maximale");
          return;
        }
        if (demand) {
          startRun(`${worstName} à ${round1(worstHumidity)} % (max ${humidityMax} %)`);
          if (boostDemand) setBoost(true, `${worstName} à ${round1(worstHumidity)} %`);
          setStatus("running", `Extraction en cours — ${worstName} à ${round1(worstHumidity)} %`);
          return;
        }
        if (blockedByOutdoor) {
          setStatus(
            "blocked_outdoor",
            `Air extérieur trop humide pour assécher (plancher ${worstFloor === null ? "?" : round1(worstFloor)} %)`,
          );
          return;
        }
        setStatus("idle", `Humidité maxi ${round1(worstHumidity)} % sur ${worstName}`);
      };

      // ── Subscriptions ───────────────────────────────────────
      const unsub = ctx.eventBus.onType("equipment.data.changed", (event) => {
        try {
          const eqId = event.equipmentId as string;
          const alias = event.alias as string;
          const value = event.value;
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

      // Permanent low speed: assert it once at start, never turn it off.
      if (alwaysOn) {
        putState("vmcOn", true);
        sendOrder(vmcId, vmcOrderAlias, true, "petite vitesse permanente");
      }
      putState("running", false);
      putState("boostOn", false);

      ctx.log(
        `VMC hygro-pilotée démarrée (${rooms.length} pièce(s), max ${humidityMax} %, cible ${humidityMin} %` +
          (outdoorId ? `, compensation extérieure +${outdoorMargin} pts` : "") +
          (boostId ? ", 2 vitesses" : "") +
          (alwaysOn ? ", petite vitesse permanente" : "") +
          (quietEnabled ? `, silence ${String(params.quietStart ?? "22:00")}–${String(params.quietEnd ?? "07:00")}` : "") +
          ")",
      );

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
