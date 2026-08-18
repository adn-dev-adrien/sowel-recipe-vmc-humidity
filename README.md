# sowel-recipe-vmc-humidity

External Sowel recipe: humidity-driven ventilation, on the rooms the unit
actually serves.

> When a supervised room passes the maximum humidity the ventilation starts and
> runs until **every** room is back under target — unless the outdoor air is too
> wet to dry them.

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
sensor at all, it is a plain max/target hysteresis.

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
