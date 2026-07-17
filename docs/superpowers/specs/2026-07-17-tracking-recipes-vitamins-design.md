# CalEyeZ Web App - Tracking, Recipes, Vitamins & Profile (Design Spec)

**Date:** 2026-07-17
**Status:** Approved (design). Not yet implemented.
**Repo:** `caleyez-web` (the browser app). Live: https://raz-dv-ee.github.io/caleyez-web/
**Deadline:** ~4 weeks from 2026-07-17.
**Origin:** Supervisors asked for user-facing tracking features (weekly/monthly history), vitamins in the
nutrition output, a way to see which foods the system recognises, and a more personal experience.

---

## 1. Goal

Add six user-facing features to the web app, **entirely front-end, entirely on-device**:

1. **History dashboard** - weekly/monthly tracking (chart + per-day breakdown + most-eaten + averages).
2. **Custom recipes** - the user saves their own nutrition values (e.g. homemade pizza) and picks
   "mine vs standard" when that food is recognised.
3. **Vitamins & minerals** - extend the nutrition output beyond kcal/protein/carb/fat.
4. **CSV export** - a backup / escape hatch (also the answer to "what if they lose their data?").
5. **Food-list discovery** - show the user which foods the system can recognise.
6. **Profile + BMI/TDEE** - a local profile (name, sex, age, height, weight, activity) giving a personal
   greeting and a calories-burned-per-day figure, so the dashboard can show **eaten vs burned**.

## 2. Constraints and principles

- **Front-end only.** No backend, no database, no accounts. `localStorage` is the store.
- **On-device is the product thesis.** The profile, the history and the recognition never leave the device.
  This is a selling point, not a limitation: say so in the report.
- **DO NOT add arbiter or gate overrides.** A previous attempt added `ARB_TRUST` / `ARB_ISR_TRUST`
  heuristics that bypassed the XGBoost router; they were reverted at the user's instruction because
  hardcoded bypasses contradict the project's learned-arbiter thesis. The arbiter decides routing. Full stop.
- **Do not touch the reported metrics.** System top-1 (86.2%), oracle (88.8%) and every experiment are
  argmax/offline measurements. Nothing in this spec changes them. Say so if asked.
- **No em dashes or en dashes** anywhere the user sees (standing project style rule). Use plain hyphens.
- **Reuse existing patterns.** Every feature below extends something that already works.

## 3. Approved approach

**Approach A - extend what exists.** Rejected alternatives:
- *IndexedDB + a data layer*: a month of meals is ~100 rows; `localStorage` (5-10 MB) is ample. Not worth a rewrite.
- *CSV as the database*: browsers cannot silently read/write a file. The sandbox requires user interaction
  (download prompt / file picker) every time; the File System Access API is unsupported on iOS Safari and
  Firefox. CSV is an **export**, not a store.

---

## 4. Data model

Three `localStorage` keys carry this feature set (one already exists), plus one unrelated key already present:

| Key | Status | Holds |
| --- | --- | --- |
| `caleyez_log` | exists | meal history, one row per logged meal |
| `caleyez_recipes` | **new** | the user's own nutrition values |
| `caleyez_profile` | **new** | name, sex, age, height, weight, activity |
| `caleyez_sound` | exists (unrelated) | sound on/off |

### 4.1 Canonical nutrient object (per 100 g)

One shape used by `nutrition.json`, the USDA Worker response, and user recipes:

```js
{ kcal, pro, carb, fat,                                        // existing macros
  fiber, sugar,                                                // optional
  vitA, vitC, vitD, vitE, vitK, b1, b2, b3, b6, folate, b12,   // vitamins
  calcium, iron, potassium, sodium, magnesium, zinc }          // minerals
```

Any missing field is `null` and the UI renders `-`. Nothing breaks if a food only has the four macros.

### 4.2 Log row (extends the existing shape)

Micros are stored **denormalised**, exactly as `kcal` already is, so history works offline with no re-lookup.

```js
{ ts, food, grams, expert, sub, method,
  kcal, pro, carb, fat,                        // existing
  micros: { vitC: 12.3, iron: 0.5, ... } | null }   // NEW, only when known
}
```

**Backward compatibility:** rows already logged have no `micros`. Treat as `null` and skip them in
vitamin aggregation. No migration, no data loss.

### 4.3 Custom recipes

Deliberately shaped **exactly like `foodmeta.json` `subs`**, so it drops into the existing dropdown:

```js
// caleyez_recipes
{ "pizza":     { "my homemade": {kcal:240, pro:11, carb:28, fat:9} },
  "shakshuka": { "mom's":       {kcal:110, pro:6,  carb:7,  fat:7} } }
```

Merged at render time:

```js
subs = { ...FOODMETA[label]?.subs, ...RECIPES[label] }
```

"Mine" appears next to "typical" only when a recipe exists for that label. No recipe = the dropdown is
unchanged from today. Zero new UI mechanism (this is the steak-cut / bell-pepper-colour pattern).

### 4.4 Profile

```js
// caleyez_profile
{ name:"Raz", sex:"m"|"f", age:24, heightCm:178, weightKg:74, activity:1.55 }
```

---

## 5. Features

### 5.1 History dashboard

**What exists:** `logMeal()` already writes a full row with `ts` and macros. `renderHistory()` currently
filters to **today only** (`r.ts >= todayMidnight`) and shows a total + last 8 entries.

**What to build:** a period selector (**Today / Week / Month**) over the same log, plus:

- **Totals and averages** for the period: kcal, protein, carb, fat, and the vitamins that are present.
- **Bar chart**: kcal per day across the period (Chart.js, same style as the main report).
- **Per-day breakdown**: expandable day rows with their meals.
- **Most-eaten foods**: count and total kcal per food, top N.
- **Eaten vs burned**: period kcal against TDEE x days (see 5.6), with the net.

**Aggregation rule:** sum only non-null fields; a day with no entries is a zero bar, not a gap.

### 5.2 Custom recipes

- **Create/edit:** a small form (name + kcal/pro/carb/fat per 100 g, optional micros) reachable from the
  result card ("save my own values for this food") and from a recipes list in settings.
- **Use:** on recognition, `controlsHTML(label)` merges `RECIPES[label]` into the subs dropdown. Selecting
  "my homemade" makes `effNut()` use those values (it already prefers `subs[selSub]` over `NUTR[label]`).
- **Storage:** `caleyez_recipes`. Exported in the CSV (5.4).
- **Deletion:** removable from the recipes list.

**Why this is clean:** `effNut()` already resolves `selSub ? subs[selSub] : NUTR[label]`. A user recipe is
just another sub. No change to the nutrition resolution logic.

### 5.3 Vitamins and minerals

USDA already returns the full nutrient array; the Worker currently **discards** all but six IDs:

```js
// usda_worker.js line ~18
const NUTRIENT = { 1008:"kcal", 2047:"kcal", 2048:"kcal", 1003:"pro", 1005:"carb", 1004:"fat" };
// extraction loop ~line 102: for (const n of food.foodNutrients||[]) { const k = NUTRIENT[n.nutrientId]; ... }
```

**Step 1 - extend the Worker map** with these USDA FoodData Central nutrient IDs, and pass them through in
the returned object:

| Nutrient | ID | Nutrient | ID |
| --- | --- | --- | --- |
| Vitamin A, RAE | 1106 | Vitamin B6 | 1175 |
| Vitamin C | 1162 | Folate, total | 1177 |
| Vitamin D (D2+D3) | 1114 | Vitamin B12 | 1178 |
| Vitamin E | 1109 | Calcium | 1087 |
| Vitamin K | 1185 | Iron | 1089 |
| Thiamin (B1) | 1165 | Magnesium | 1090 |
| Riboflavin (B2) | 1166 | Potassium | 1092 |
| Niacin (B3) | 1167 | Sodium | 1093 |
| Fiber | 1079 | Zinc | 1095 |
| Sugars | 2000 | | |

Bump `CACHE_VER` so the 30-day edge cache invalidates.

**Coverage reality:** `nutrition.json` holds ~40 foods against **132 Global + 13 Israeli = 145 labels**, so
**~72% of foods hit USDA and get vitamins for free**. The gap is the ~40 pinned local foods, which includes
**all 13 Israeli dishes**.

**Step 2 - harvest, do not hand-type.** Write a one-off script that queries the Worker once per local food
and writes the vitamin fields back into `nutrition.json`. Accurate, sourced ("values harvested from USDA
FoodData Central"), no manual entry.

**Step 3 - the 13 Israeli dishes** (jachnun, sabich, malawach, meorav_yerushalmi, samosa, schnitzel,
bourekas_cheese, hummus, falafel, shakshuka, shawarma, baklava, sufganiyah) are **not in USDA**. Estimate
from ingredients and mark them as estimates. Document this as an honest limitation.

**Gemini fallback** returns only the four macros; its micros are `null`.

### 5.4 CSV export

- **Export**: build a CSV blob from `caleyez_log` (+ a second section or file for `caleyez_recipes`) and
  trigger a download via an `<a download>`. Saves to the phone's Downloads. Works everywhere.
- **Import**: `<input type="file">` to pick the CSV back and merge it in (dedupe by `ts`).
- **Why it matters:** it is the escape hatch for the storage caveats in section 7.

### 5.5 Food-list discovery

The class lists are **already fetched** at load (`namesG` from `global_names.json` = 132, `namesI` from
`israeli_names.json` = 13 + background). No new data needed.

- A chip on the home screen: **"I know 145 foods"** -> opens a **searchable sheet**.
- Type-ahead search so a user can answer "does it know shakshuka?" in one tap.
- Grouped **Global cuisine** / **Israeli dishes**; exclude `background` (it is an internal class, not a food).
- Mark which foods are **offline-ready** (present in `nutrition.json`) vs USDA-backed. This quietly
  showcases the architecture.
- Show once as a first-visit intro, then keep it behind the chip.

### 5.6 Profile, BMI and calories burned

All local arithmetic. No network, no database.

- **Greeting:** "Hello <name>" from `caleyez_profile.name`.
- **BMI** = `weightKg / (heightCm/100)^2`.
- **BMR - Mifflin-St Jeor** (the clinical standard):
  - men: `BMR = 10*weightKg + 6.25*heightCm - 5*age + 5`
  - women: `BMR = 10*weightKg + 6.25*heightCm - 5*age - 161`
- **TDEE** = `BMR * activity`, where activity is one of
  1.2 (sedentary), 1.375 (light), 1.55 (moderate), 1.725 (very), 1.9 (extra).
- **Dashboard use:** show **eaten vs burned** and the net for the selected period.
- **Report line:** "Your profile, your history and the recognition all run on your device and never leave it."
- **Cite:** Mifflin MD, St Jeor ST, et al. (1990), *A new predictive equation for resting energy expenditure
  in healthy individuals*, Am J Clin Nutr 51(2):241-7.

---

## 6. File change map

| File | Change |
| --- | --- |
| `index.html` | period selector + dashboard render; recipe form + merge into `controlsHTML`; micros in `logMeal`; profile form + greeting + TDEE; food-list sheet; CSV export/import |
| `nutrition.json` | add vitamin/mineral fields (harvested for USDA foods, estimated for the 13 Israeli dishes) |
| `usda_worker.js` | extend `NUTRIENT` map, pass micros through, bump `CACHE_VER`. **Deploys separately via `wrangler deploy`.** |
| `foodmeta.json` | unchanged (recipes live in localStorage, merged at runtime) |
| new: harvest script | one-off, queries the Worker per local food, writes micros into `nutrition.json` |
| `README.md` | document the new features + the storage caveats |

**Existing anchors** (approximate lines, verify before editing): `effNut` ~484, `controlsHTML` ~493,
`NUTR`/`FOODMETA` load ~370, `namesG`/`namesI` load ~367, meal log `loadLog`/`saveLog`/`logMeal`/
`renderHistory` ~621+.

---

## 7. Risks and caveats (document these)

1. **iOS Safari deletes localStorage after 7 days without a visit** (tracking prevention). A monthly history
   can silently vanish on iPhone. Mitigations: **Add to Home Screen**, `navigator.storage.persist()`, and
   the CSV export as a manual backup. **Document this honestly.**
2. **Clearing "cookies and site data"** wipes it (plain cache clearing does not).
3. **Incognito** wipes it at session end. The kiosk config uses `--incognito`: drop that flag if a kiosk
   should remember history.
4. **The Worker deploys separately** (`wrangler deploy`), not with GitHub Pages.
5. **The 13 Israeli dishes' vitamins are estimates**, not USDA-sourced.
6. **Vitamin coverage is partial** by food and by data type; render `-` rather than guessing.

---

## 8. Non-goals

- No backend, accounts, sync or cloud storage.
- No IndexedDB migration.
- No changes to the models, the arbiter, the routing, or any reported metric.
- No re-adding arbiter/gate overrides.
- No barcode scanning, no multi-food plates, no recipe sharing between users.

---

## 9. Order of work

1. **History dashboard** (highest supervisor value, uses data you already store).
2. **Custom recipes** (small, reuses `subs`).
3. **Vitamins** (Worker map -> harvest script -> Israeli estimates).
4. **Profile + BMI/TDEE** (pure math, enables eaten-vs-burned).
5. **Food-list discovery** (cheap, data already loaded).
6. **CSV export/import** (last; also the natural place to dump recipes + micros).

## 10. Acceptance criteria

- Log a meal, switch to **Week** and **Month**: totals, chart, per-day rows and most-eaten all populate from
  `caleyez_log`, including days with zero entries.
- Old log rows (no `micros`) do not break any view.
- Save a recipe for `pizza`; recognise a pizza; the dropdown offers **typical** and **my homemade**; selecting
  it changes the kcal. A food with no recipe shows an unchanged dropdown.
- A USDA-backed food shows vitamins; a local food shows the harvested vitamins; an Israeli dish shows its
  estimates; a Gemini-fallback food shows `-`.
- Fill the profile: the greeting shows the name; BMI and TDEE compute; the dashboard shows eaten vs burned.
- The food sheet lists 145 foods, searchable, `background` excluded.
- Export produces a CSV that re-imports without duplicates.
- No em/en dashes in any new UI text. Arbiter/routing untouched.
