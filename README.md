# sowel-recipe-vmc-humidity

External Sowel recipe: humidity-driven ventilation, on the rooms the unit
actually serves.

> When a supervised room passes the maximum humidity the ventilation starts and
> runs until **every** room is back under target — unless the outdoor air is too
> wet to dry them. A **shower** is answered before any threshold is crossed, and
> runs until the room is back to the humidity it had before it.

## The heart of it: the psychrometric floor

Two relative humidities are not comparable at two temperatures. What the
ventilation brings in is outdoor air **warmed to the indoor temperature**:

```
floor = RH_out × Psat(T_out) / Psat(T_in)        (Magnus formula)
```

| Situation                          | Raw RH_out | Actual floor | Verdict                  |
| ---------------------------------- | ---------- | ------------ | ------------------------ |
| Winter: 90 % at 5 °C → 20 °C       | 90 %       | ~34 %        | ventilating dries hard   |
| Shoulder season: 70 % at 15 °C → 21 °C | 70 %   | ~48 %        | ventilating dries        |
| Muggy summer: 70 % at 25 °C → 22 °C | 70 %      | ~84 %        | ventilating **adds water** |

`outdoorMargin` is a **start** condition, not a stop one: a cycle begins only
when the room sits at least `margin` points above the floor, then runs until it
reaches the floor (or the configured target, whichever is higher).

That hysteresis is not optional. The floor drifts two or three points over an
evening as the outdoor temperature falls; with a single threshold the recipe
starts and stops over a fraction of a point — less than the sensors can measure.
On 2026-08-17 a cycle started for a theoretical gain of 0.7 point and took the
room down by 0.4 point in an hour.

With no outdoor temperature, it falls back to comparing raw RH. With no outdoor
sensor at all, it is a plain max/target hysteresis. A sensor that is configured
but has not reported yet is **not** treated as "no constraint": the recipe waits
rather than starting unchecked, and a reading that arrives unparseable never
erases the last good one.

Every start and stop states the numbers it acted on — `SDB à 64.7 % (plancher
54.6 %, gain 10.1 pts)` — so a decision can be re-read months later without
replaying InfluxDB against the sensors' own sampling.

## Showers

A shower never trips the thresholds in time. By the time the bathroom crosses
60 % the vapour has been on the walls for a quarter of an hour, and the cycle
that follows stops at the target — which may be well above where the room
actually was.

So a shower is detected, not waited for, and what names it is **water actually
added** — not relative humidity, which is not a quantity of water at all. The
same air reads 50 % at 24 °C and 56 % at 22 °C without a drop being added, so
an evening of cooling looks exactly like a room getting wetter.

Each reading is therefore converted to its vapour pressure, and the driest
sample of the window is expressed at the room's *current* temperature before
being compared — the same psychrometric trick as the outdoor floor above,
applied to the room's own past:

```
what the room held 30 min ago, read at today's temperature
        = RH_before × Psat(T_before) / Psat(T_now)
```

| What moves                       | Raw reading | Water | Verdict    |
| -------------------------------- | ----------- | ----- | ---------- |
| Someone showers                  | ↑ fast      | ↑     | **shower** |
| The room cools down for the night| ↑           | flat  | ignored    |
| The heating comes on             | ↓           | flat  | ignored    |
| Weather, a wet evening           | ↑ slow      | ↑ slow| ignored    |

Concretely: **+4 points of added water within 45 minutes**, measured against
the driest reading of that window — not against the previous one, so a probe
reporting every 30 min and one reporting every minute are judged the same way.
A room that reports no temperature falls back to the raw reading, which cannot
tell water from cooling; the recipe says so at startup rather than pretending.

> **Why not require the temperature to rise too?** Because it does not. On
> 2026-08-24 at 22:33 two bathrooms took a shower each: one gained 6.1 points
> with the temperature dead flat at 24.7 °C, the other 1.2 raw points while
> warming 1.5 °C — 6.2 points of water. A version of this recipe that demanded
> half a degree of warming missed the first one entirely, and the room held
> 60 % until morning. In summer a bathroom already at 25 °C does not warm up.
> Temperature belongs in the conversion, not in a gate.

### Each bathroom sets its own bar

Volume, extraction, an open door, and above all where the probe hangs — over
the door or beside the shower — decide whether the same shower reads as four
points or twenty-five. A single threshold is therefore deaf in one room and
jumpy in the other.

So `showerRise` is only a **starting** bar. Each room then fits its own on what
its showers actually do to it: the bar settles at about a third of the
amplitude the room reaches, which puts the trigger part-way up the ramp rather
than at the peak. It takes two measured showers before a room stops using the
configured value, keeps the last five, and is bounded to 3–15 points — under 3
lies the weather (the worst drift measured over a window is 1.5 points), over
15 no ordinary shower would clear it. A cycle that hit its cap without the room
ever coming back teaches nothing and is not counted.

The fit is stated in the journal when it moves — `SDB : seuil de détection
4 → 8.3 pts — les douches y font 23.7 pts` — and it survives a recipe update.

The **temperature** side stays the same everywhere on purpose. 0.5 °C is not an
amplitude, it is a sign test — did the room warm up while it got wetter —
sitting just above what a probe reporting in 0.1 steps can resolve. A bathroom
where a shower does not move the temperature half a degree has a probe that
cannot see showers at all, and tuning would only paper over it.

What follows is a **drying cycle**, not a normal one:

- it stops at whichever comes **first**: the humidity the room had before the
  shower (+1 point — the last one is asymptotic), or the configured target;
- it runs at the high speed while the room is over `humidityMax`, then at the
  low one to finish;
- it **starts inside the quiet window**. A bathroom left saturated at 23:00 is
  still wet at 07:00, and the noise costs less than the mould;
- it stops early if the outdoor air is wetter than the room — no run time beats
  the psychrometry;
- it gives up after `showerMaxRun` (45 min by default) rather than running all
  night on a room that will not come back;
- a second shower on the same room extends the cycle and keeps the **first**
  baseline: the level to come back to is the one before anybody ran the water.

It stands down for the same reasons everything else does: a ventilation cut by
hand, or a maximum-run cooldown, blocks the start and says so in the journal.

The detector itself lives in [`src/shower-detector.ts`](src/shower-detector.ts)
— a self-contained module with no Sowel types in it, meant to be copied as-is
by any other recipe needing the same signal (`sowel-recipe-water-heater-smart`
counts showers to bill the tank).

## The journal

Every start and every stop is **one line**, and it carries the reason it acted
on. The room is named after its **zone**, not after the probe — Zigbee sensors
all arrive called `Température`, which made three bathrooms read alike:

```
VMC ON  — Humidité Salle de bain 60.1 % au-dessus du maxi 56 % — l'air extérieur
          permet de descendre à 42.5 % (17.6 pts à gagner)
VMC OFF — Humidité redescendue — Salle de bain 49.4 %, sous la cible 50 %

VMC ON  — Douche Salle de bain — 60.5 %, +6.1 pts d'eau (seuil 4) : séchage jusqu'à 55.4 %
VMC OFF — Fin du séchage Salle de bain — 55.2 % en 38min, revenue à son niveau
          d'avant la douche (54.4 %)

VMC ON  — Présence confirmée — WC
VMC OFF — Fin de la présence — 15min sans détection

VMC OFF — Plage silencieuse (22:00–08:00)
VMC OFF — Durée maxi 3h atteinte — repos forcé 1h
VMC OFF — VMC coupée à la main pendant le cycle — la recette se retire 1h
```

Before, each of these was written twice: once by the cycle, once by the relay,
with the same numbers in both. When a cycle ends without the ventilation
stopping — because a visit or another room still holds it — the line says so
rather than disappearing:

```
Humidité redescendue — Salle de bain 49.4 %, sous la cible 50 % — la VMC continue de tourner
```

## ⚠️ One recipe per ventilation

Do not drive the same unit with this recipe **and** a schedule recipe: each
sends its own orders, the last one wins, and one recipe's quiet window gets
overwritten by the other's time slot. If you need a baseline schedule, use the
permanent low speed option and let this recipe own the extraction.

## Native VMC equipment (Sowel core spec 153)

If the ventilation is bound as a single **`vmc`** equipment (Sowel core with the
2-speed VMC type), select it in the `vmc` slot and the recipe drives it through
that equipment's `speed` order (`off` / `v1` / `v2`). The core owns the
break-before-make safety interlock (the two windings are never energized at
once), so you do **not** wire a separate high-speed equipment and the two-speed
/ permanent-low-speed / high-speed slots are ignored. The recipe still decides
the speed from humidity (and occupancy): V2 above `humidityMax + boostDelta`, V1
above `humidityMax`, off under the target. On an older core with no `vmc` type,
nothing changes — use the two on/off switch equipments as before.

## Occupancy (toilets)

Optional: motion sensors in the toilets trigger extraction for the whole visit,
extended by 15 minutes after the last detection.

Doors left open — which make the sensor fire at random from the hallway — are
handled by three guards:

1. **Confirmation** (`motionConfirm`, 1 min) — motion must be *sustained* for
   that long. An isolated detection starts nothing. Two detections more than
   3 minutes apart belong to different bursts and do not add up: only a real
   presence, which keeps the sensor firing, clears the bar.
2. **Cap** (`motionMaxRun`, 45 min) — beyond that it is no longer a toilet
   visit: the recipe treats the detections as spurious, stops and pauses for
   30 minutes.
3. **Quiet window** — by default it blocks visits too; `quietScope` set to
   humidity-only lets the ventilation answer a night visit.

A sensor holding `occupancy = true` without re-emitting an event is handled:
the value is re-read on every evaluation.

## Parameters

| Slot                              | Default | Role                                                              |
| --------------------------------- | ------- | ----------------------------------------------------------------- |
| `zone`                            | —       | Zone of the ventilation                                           |
| `sensors` (list)                  | —       | Probes of the served rooms (humidity required, temperature useful) |
| `vmc`                             | —       | On/off equipment (low speed on a two-speed unit)                  |
| `twoSpeed`                        | No      | Two-speed unit: reveals the high-speed fields                     |
| `vmcBoost`                        | empty   | Equipment of the second speed (hidden when `twoSpeed` = No)       |
| `alwaysOn`                        | No      | Permanent low speed: only the high speed is driven                |
| `humidityMax`                     | 60 %    | Start threshold                                                   |
| `humidityMin`                     | 50 %    | Stop target                                                       |
| `boostDelta`                      | 5 pts   | High speed beyond `humidityMax + boostDelta` (hidden when `twoSpeed` = No) |
| `outdoorSensor` / `outdoorMargin` | empty / 3 pts | Outdoor compensation                                        |
| `minRun` / `maxRun`               | 15 min / 3 h | Anti short-cycling / forced stop (+ 1 h rest)                |
| `quietMode` + `quietStart`/`quietEnd` | off / 22:00–07:00 | Quiet window (no start, running cycle cut)      |
| `quietScope`                      | Everything | Whether the silence also blocks visits, or humidity only       |
| `motionSensors` (list)            | empty   | Motion sensors of the toilets                                     |
| `motionConfirm`                   | 1 min   | Sustained motion required before starting                         |
| `motionRunAfter`                  | 15 min  | Extra run after the last detection                                |
| `motionMaxRun`                    | 45 min  | Cap of an occupancy cycle (then a 30 min pause)                   |
| `showerMode`                      | Yes     | Detect showers and dry the room back to its pre-shower level      |
| `showerRise`                      | 4 pts   | Starting bar, then fitted per room                                 |
| `showerMaxRun`                    | 45 min  | Cap of a drying cycle                                             |

## The ventilation can be driven by something else

The recipe reads the relay's actual state, not just what it ordered:

- **Switched off elsewhere** — if the ventilation stops during a cycle (a hand
  on the switch, another system), the recipe notices after a minute, ends its
  cycle and **stands down for an hour** instead of switching it straight back on.
- **Switched on outside the quiet window** — it takes note and sends no OFF
  nobody asked for.
- **Switched on inside the quiet window** — silence is a promise: the recipe
  puts it back off, at most once every 5 minutes so a stubborn relay cannot
  start a loop. With a permanent low speed, only the high speed is concerned.

A relay that never confirms its state is never read as human intervention: a
silent sensor is not evidence.

## Behaviour

- Orders are sent **on transitions only** — a manual change between two
  transitions is never overridden.
- A probe that has reported nothing for an hour is ignored; when no probe is
  fresh any more, the ventilation is stopped rather than run blind.
- **Rule order**: max run > quiet window > min run > target reached. Silence
  therefore outranks anti short-cycling — a cycle started at 21:59 is cut dead
  at 22:00, not fifteen minutes later. A cycle worth starting before the window
  still starts: those few minutes of extraction are taken, and they end on time.
- For the whole quiet window **no restart** is possible, by humidity or by
  presence (unless `quietScope` is humidity-only). The recipe keeps evaluating
  throughout — readings, state and occupancy stay current, only the orders are
  withheld — and acts as soon as the window closes.
- Starting an instance sends no OFF: the recipe only switches off what it
  switched on itself (a ventilation started by hand survives a recipe update).
- With a permanent low speed, "extraction" means the high speed — the main
  equipment is never cut.
- Exposed state (visible in the UI, usable by modes): `status`, `reason`,
  `running`, `motionRunning`, `vmcOn`, `boostOn`, `maxHumidity`,
  `maxHumidityRoom`, `outdoorFloor`.

## The form

By default the recipe is single-speed: one on/off equipment. The **two-speed**
flag reveals the three related fields (high speed, permanent low speed,
high-speed margin); otherwise they stay hidden. Same for the quiet window,
whose hours only appear once it is enabled.

Two constraints of the recipe form are met by construction and locked by tests:

- the grid lays a group out in `n ≤ 3 ? n : 2` columns, so every group shows
  2, 3, 4 or 6 fields in **every** state — never 5, which would leave a hole;
- the grouped layout has no renderer for the `boolean` type (it falls back to a
  text input showing `false`), so the flags are Yes/No `select`s.

Labels are capped at 14 characters in the groups that can render three columns,
20 elsewhere; help text at 20 and 30 characters respectively. A label that wraps
pushes its field below its neighbours' and the row stops lining up.

## Development

```bash
npm install
npm run build     # → dist/index.js (what Sowel loads)
npm test          # vitest
```

Publishing a version:

```bash
npm run build
tar -czf sowel-recipe-vmc-humidity-<version>.tar.gz manifest.json package.json dist/
gh release create v<version> sowel-recipe-vmc-humidity-<version>.tar.gz --title "v<version>"
```

Installing on an instance: **Plugins → Store → Personal sources** →
`adn-dev-adrien/sowel-recipe-vmc-humidity` → Install → confirm the SHA256
fingerprint (TOFU, spec 136).
