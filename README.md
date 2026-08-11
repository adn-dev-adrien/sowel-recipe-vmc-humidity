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

## ⚠️ Une seule recette par VMC

Ne pilotez pas la même VMC avec cette recette **et** une recette de
programmation horaire : chacune envoie ses ordres de son côté, le dernier
gagne, et la plage silencieuse de l'une sera écrasée par le créneau de
l'autre. Si vous avez besoin d'un fonctionnement horaire de base, utilisez
l'option « petite vitesse permanente » et laissez cette recette gérer
l'extraction.

## Détection de présence (WC)

Optionnel : des détecteurs de mouvement placés dans les toilettes déclenchent
l'extraction pendant tout le passage, prolongée de 15 min après la dernière
détection.

Le problème des portes laissées ouvertes (détections aléatoires du couloir)
est traité par trois garde-fous :

1. **Confirmation** (`motionConfirm`, 1 min) — le mouvement doit se *maintenir*
   pendant cette durée. Une détection isolée ne démarre rien. Deux détections
   espacées de plus de 3 min appartiennent à deux bursts différents et ne
   s'additionnent pas : seule une présence réelle, qui fait déclencher le
   capteur en continu, franchit le seuil.
2. **Plafond** (`motionMaxRun`, 45 min) — au-delà, ce n'est plus un passage aux
   toilettes : la recette conclut à des détections parasites, arrête
   l'extraction et se met en pause 30 min.
3. **Plage silencieuse** — par défaut elle bloque aussi les passages ; l'option
   « Humidité seulement » laisse la VMC réagir à un passage nocturne.

Un capteur qui maintient `occupancy = true` sans réémettre d'événement est
géré : la valeur est relue à chaque évaluation.

## Paramètres

| Slot                            | Défaut | Rôle                                                                 |
| ------------------------------- | ------ | -------------------------------------------------------------------- |
| `zone`                          | —      | Zone de la VMC                                                       |
| `sensors` (liste)               | —      | Sondes des pièces desservies (humidité obligatoire, température utile) |
| `vmc`                           | —      | Équipement on/off (petite vitesse sur une 2 vitesses)                |
| `twoSpeed`                      | Non    | VMC 2 vitesses : révèle les champs de la grande vitesse              |
| `vmcBoost`                      | vide   | Équipement de la 2ᵉ vitesse (masqué si `twoSpeed` = Non)             |
| `alwaysOn`                      | Non    | Petite vitesse permanente : seule la grande vitesse est pilotée      |
| `humidityMax`                   | 60 %   | Seuil de démarrage                                                   |
| `humidityMin`                   | 50 %   | Cible d'arrêt                                                        |
| `boostDelta`                    | 5 pts  | Passage en grande vitesse au-delà de `humidityMax + boostDelta` (masqué si `twoSpeed` = Non) |
| `outdoorSensor` / `outdoorMargin` | vide / 3 pts | Compensation extérieure                                     |
| `minRun` / `maxRun`             | 15 min / 3 h | Anti court-cycle / arrêt forcé (+ 1 h de repos)                |
| `quietMode` + `quietStart`/`quietEnd` | off / 22:00–07:00 | Plage silencieuse (aucun démarrage, cycle en cours coupé) |
| `quietScope`                    | Tout   | Le silence bloque aussi les passages, ou l'humidité seulement         |
| `motionSensors` (liste)         | vide   | Détecteurs de mouvement des WC                                       |
| `motionConfirm`                 | 1 min  | Durée de mouvement soutenu avant de démarrer                          |
| `motionRunAfter`                | 15 min | Prolongation après la dernière détection                             |
| `motionMaxRun`                  | 45 min | Plafond d'un cycle sur présence (puis 30 min de pause)               |

## La VMC peut être pilotée par autre chose

La recette lit l'état réel du relais, pas seulement ce qu'elle a ordonné :

- **Coupure extérieure** — si la VMC s'éteint pendant un cycle (main sur
  l'interrupteur, autre système), la recette le constate après une minute,
  arrête son cycle et **se retire une heure** au lieu de rallumer aussitôt.
- **Allumage extérieur hors plage silencieuse** — elle en prend note et n'envoie
  pas d'ordre d'arrêt que personne n'a demandé.
- **Allumage extérieur pendant la plage silencieuse** — le silence est une
  promesse : la recette réimpose l'arrêt, au plus une fois toutes les 5 minutes
  pour qu'un relais récalcitrant ne provoque pas de boucle. Avec la petite
  vitesse permanente, seule la grande vitesse est concernée.

Un relais qui ne confirme jamais son état n'est jamais interprété comme une
intervention : le silence d'une sonde n'est pas une preuve.

## Comportement

- Ordres envoyés **uniquement sur transition** — un pilotage manuel entre deux
  transitions n'est jamais écrasé.
- Une sonde qui n'a rien remonté depuis 1 h est ignorée ; si plus aucune sonde
  n'est fraîche, la VMC est arrêtée plutôt que de tourner à l'aveugle.
- La durée maxi prime sur tout le reste, y compris la durée mini.
- Au démarrage d'une instance, aucun ordre d'arrêt n'est envoyé : la recette ne
  coupe que ce qu'elle a elle-même allumé (une VMC allumée à la main survit à
  une mise à jour de la recette).
- Avec la petite vitesse permanente, « extraction » signifie grande vitesse —
  l'équipement principal n'est jamais coupé.
- État exposé (visible dans l'UI, exploitable par les modes) : `status`,
  `reason`, `running`, `motionRunning`, `vmcOn`, `boostOn`, `maxHumidity`,
  `maxHumidityRoom`, `outdoorFloor`.

## Formulaire

Par défaut la recette est mono-vitesse : un seul équipement marche/arrêt. Le
drapeau **VMC 2 vitesses** fait apparaître les trois champs associés (grande
vitesse, petite vitesse permanente, marge grande vitesse) ; sinon ils restent
masqués. Idem pour la plage silencieuse, dont les heures n'apparaissent qu'une
fois activée.

Deux contraintes du formulaire de recette sont respectées par construction, et
verrouillées par des tests :

- la grille dispose un groupe en `n ≤ 3 ? n : 2` colonnes, donc chaque groupe
  affiche 2, 3, 4 ou 6 champs dans **tous** les états — jamais 5, qui laisserait
  un trou ;
- la mise en page groupée n'a pas de rendu pour le type `boolean` (elle
  retombe sur un champ texte affichant `false`), donc les drapeaux sont des
  `select` Oui/Non.

Les descriptions de champs sont limitées à 40 caractères : elles s'affichent
sous chaque champ et un texte long rend le formulaire illisible.

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
