# sowel-recipe-vmc-humidity

Recette Sowel externe : pilotage de la VMC à l'humidité des pièces desservies.

> Quand une pièce supervisée dépasse l'humidité maximale, la VMC démarre et
> tourne jusqu'à ce que **toutes** les pièces soient repassées sous la cible —
> sauf si l'air extérieur est trop humide pour les assécher.

## Le cœur de la recette : le plancher psychrométrique

Deux humidités relatives ne sont pas comparables à des températures
différentes. Ce que la VMC apporte, c'est l'air extérieur **réchauffé à la
température intérieure** :

```
plancher = HR_ext × Psat(T_ext) / Psat(T_int)        (formule de Magnus)
```

| Situation                        | HR_ext brute | Plancher réel | Décision                    |
| -------------------------------- | ------------ | ------------- | --------------------------- |
| Hiver : 90 % à 5 °C → 20 °C      | 90 %         | ~34 %         | ventiler assèche fortement  |
| Mi-saison : 70 % à 15 °C → 21 °C | 70 %         | ~48 %         | ventiler assèche            |
| Été moite : 70 % à 25 °C → 22 °C | 70 %         | ~84 %         | ventiler **humidifierait**  |

La cible effective de chaque pièce est donc `max(cible configurée, plancher +
marge)`. Cela répond au cas « HR_ext > 60 % » : la recette ne s'acharne pas à
descendre sous un plancher inatteignable, et elle ne bloque pas non plus la
ventilation en hiver alors qu'une HR extérieure de 90 % est en réalité de l'air
très sec.

Sans température extérieure, repli sur la comparaison HR brute. Sans capteur
extérieur, hystérésis max/cible simple.

## Paramètres

| Slot                            | Défaut | Rôle                                                                 |
| ------------------------------- | ------ | -------------------------------------------------------------------- |
| `zone`                          | —      | Zone de la VMC                                                       |
| `sensors` (liste)               | —      | Sondes des pièces desservies (humidité obligatoire, température utile) |
| `vmc`                           | —      | Équipement on/off (petite vitesse sur une 2 vitesses)                |
| `vmcBoost`                      | vide   | Grande vitesse d'une VMC 2 vitesses                                  |
| `alwaysOn`                      | non    | Petite vitesse permanente : seule la grande vitesse est pilotée      |
| `humidityMax`                   | 60 %   | Seuil de démarrage                                                   |
| `humidityMin`                   | 50 %   | Cible d'arrêt                                                        |
| `boostDelta`                    | 5 pts  | Passage en grande vitesse au-delà de `humidityMax + boostDelta`      |
| `outdoorSensor` / `outdoorMargin` | vide / 3 pts | Compensation extérieure                                     |
| `minRun` / `maxRun`             | 15 min / 3 h | Anti court-cycle / arrêt forcé (+ 1 h de repos)                |
| `quietMode` + `quietStart`/`quietEnd` | off / 22:00–07:00 | Plage silencieuse (aucun démarrage, cycle en cours coupé) |

## Comportement

- Ordres envoyés **uniquement sur transition** — un pilotage manuel entre deux
  transitions n'est jamais écrasé.
- Une sonde qui n'a rien remonté depuis 1 h est ignorée ; si plus aucune sonde
  n'est fraîche, la VMC est arrêtée plutôt que de tourner à l'aveugle.
- La durée maxi prime sur tout le reste, y compris la durée mini.
- État exposé (visible dans l'UI, exploitable par les modes) : `status`,
  `reason`, `running`, `vmcOn`, `boostOn`, `maxHumidity`, `maxHumidityRoom`,
  `outdoorFloor`.

## Développement

```bash
npm install
npm run build     # → dist/index.js (ce que Sowel charge)
npm test          # vitest
```

Publication d'une version :

```bash
npm run build
tar -czf sowel-recipe-vmc-humidity-<version>.tar.gz manifest.json package.json dist/
gh release create v<version> sowel-recipe-vmc-humidity-<version>.tar.gz --title "v<version>"
```

Installation sur une instance : **Plugins → Store → Sources personnelles** →
`adn-dev-adrien/sowel-recipe-vmc-humidity` → Installer → confirmer l'empreinte
SHA256 (TOFU, spec 136).
