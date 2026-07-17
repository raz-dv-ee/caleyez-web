# CalEyeZ Tracking, Recipes, Vitamins & Profile - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six front-end-only, on-device features to the CalEyeZ web app: a history dashboard (Today/Week/Month), user-defined recipes, vitamins and minerals, CSV export/import, a searchable food list, and a local profile with BMI + TDEE for "eaten vs burned".

**Architecture:** All new *pure* logic (aggregation, BMI/TDEE, CSV, recipe merge, nutrient scaling) goes in a new `lib/tracking.js` written UMD-style, so the browser loads it with a plain `<script>` tag and Node `require()`s it in tests. `index.html` stays thin wiring (DOM + localStorage). No backend, no build step, no framework.

**Tech Stack:** Vanilla JS (ES2020), plain `<script>` tags, `localStorage`, Chart.js (already loaded in the app), Node v24 built-in test runner (`node --test`). Static site on GitHub Pages.

**Spec:** `docs/superpowers/specs/2026-07-17-tracking-recipes-vitamins-design.md` - read it first.

---

## CRITICAL RULES (violating these breaks the project)

1. **NEVER add arbiter or gate overrides.** The XGBoost router decides routing. `ARB_TRUST` / `ARB_ISR_TRUST`
   heuristics were added once and reverted (`c9e6b7e`). Do not touch `arbiterP`, `routeI`, `arbUnsure`,
   `confident`, `GATE_G`, `GATE_I`, `ARB_BAND`, or anything in `analyze()` that decides routing. This plan
   touches **none** of it.
2. **No em dashes or en dashes** in any user-visible string. Plain hyphens only.
3. **No AI attribution** in commits, code or docs. No `Co-Authored-By`.
4. Do not present the reported metrics (86.2% system top-1, 88.8% oracle) as affected. Nothing here changes them.

---

## Context for a fresh session

- Repo: `E:\caleyez-web` (separate from the main `final project - models retrain` repo). Branch `main`.
  Pushing to `main` deploys to GitHub Pages: https://raz-dv-ee.github.io/caleyez-web/
- `index.html` (~672 lines) is the whole app: inline `<script>`, no modules, no build.
- **The meal log already exists** at `index.html:622`: key `caleyez_log`, `loadLog()`, `saveLog()`,
  `logMeal()` (line 625), `renderHistory()` (line 637). Rows already carry `ts` and full macros.
  `renderHistory()` currently filters to today only.
- `effNut(label)` (line 482) resolves nutrition: `selSub ? m.subs[selSub] : NUTR[label]`.
- `controlsHTML(label)` (line 492) renders the sub/prep dropdowns.
- `NUTR` loads from `nutrition.json`, `FOODMETA` from `foodmeta.json` (lines 370-371).
- `namesG` / `namesI` load from remote `global_names.json` / `israeli_names.json` (lines 367-368) = 132 + 13 labels.
- USDA Worker: `usda_worker.js`, deployed **separately** with `wrangler deploy` (NOT by pushing to Pages).

**Verify the app runs before starting:**
```bash
cd "E:/caleyez-web" && python -m http.server 8080
# open http://127.0.0.1:8080/index.html - it should load and show the camera prompt
```

---

## File Structure

| File | Responsibility |
| --- | --- |
| `lib/tracking.js` | **NEW.** All pure logic: period aggregation, per-day buckets, most-eaten, BMI/BMR/TDEE, CSV serialize/parse, recipe merge, nutrient scaling. No DOM, no localStorage, no network. |
| `tests/tracking.test.js` | **NEW.** Node tests for every function in `lib/tracking.js`. |
| `index.html` | Wiring only: load `lib/tracking.js`, read/write localStorage, render DOM, call the pure functions. |
| `nutrition.json` | Gains vitamin/mineral fields. |
| `usda_worker.js` | Gains vitamin nutrient IDs. Deploys separately. |
| `tools/harvest_micros.mjs` | **NEW.** One-off Node script: queries the Worker per local food and writes micros into `nutrition.json`. |

---

## Task 0: Test harness and `lib/tracking.js` skeleton

**Files:**
- Create: `lib/tracking.js`
- Create: `tests/tracking.test.js`
- Modify: `index.html` (add one `<script>` tag)

- [ ] **Step 1: Create the UMD skeleton**

Create `lib/tracking.js`:

```js
// Pure helpers for tracking, recipes, nutrition scaling and CSV.
// UMD: works as a plain <script> in the browser (global CZTrack) and require() in Node tests.
// No DOM, no localStorage, no network in this file - that keeps it testable.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CZTrack = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  return {};
});
```

- [ ] **Step 2: Write the failing test**

Create `tests/tracking.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const T = require("../lib/tracking.js");

test("module loads and exports an object", () => {
  assert.strictEqual(typeof T, "object");
});
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `cd "E:/caleyez-web" && node --test`
Expected: `# pass 1`, exit code 0.

- [ ] **Step 4: Load the library in the app**

In `index.html`, find the first inline `<script>` in the body and add this line **immediately before it**:

```html
<script src="lib/tracking.js"></script>
```

- [ ] **Step 5: Verify the browser sees it**

Serve the app (`python -m http.server 8080`), open `http://127.0.0.1:8080/index.html`, and in the browser
console run: `typeof CZTrack`
Expected: `"object"`.

- [ ] **Step 6: Commit**

```bash
git add lib/tracking.js tests/tracking.test.js index.html
git commit -m "Add pure tracking library skeleton and Node test harness"
```

---

# PHASE 1 - History dashboard

## Task 1: Period filtering and totals (pure)

**Files:**
- Modify: `lib/tracking.js`
- Test: `tests/tracking.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tracking.test.js`:

```js
const DAY = 86400000;

test("periodStart returns midnight boundaries", () => {
  const now = new Date("2026-07-17T15:30:00Z").getTime();
  assert.ok(T.periodStart("today", now) <= now);
  assert.strictEqual(T.periodStart("week", now), T.periodStart("today", now) - 6 * DAY);
  assert.strictEqual(T.periodStart("month", now), T.periodStart("today", now) - 29 * DAY);
});

test("filterPeriod keeps only rows at or after the boundary", () => {
  const now = Date.now();
  const rows = [{ ts: now }, { ts: now - 3 * DAY }, { ts: now - 40 * DAY }];
  assert.strictEqual(T.filterPeriod(rows, "week", now).length, 2);
  assert.strictEqual(T.filterPeriod(rows, "month", now).length, 2);
  assert.strictEqual(T.filterPeriod(rows, "today", now).length, 1);
});

test("totals sums macros and ignores nulls", () => {
  const rows = [
    { kcal: 100, pro: 5, carb: 10, fat: 2 },
    { kcal: 50, pro: null, carb: 5, fat: 1 },
    { kcal: null, pro: 3, carb: null, fat: null },
  ];
  const t = T.totals(rows);
  assert.strictEqual(t.kcal, 150);
  assert.strictEqual(t.pro, 8);
  assert.strictEqual(t.carb, 15);
  assert.strictEqual(t.fat, 3);
});

test("totals on an empty list is all zeros", () => {
  const t = T.totals([]);
  assert.deepStrictEqual(t, { kcal: 0, pro: 0, carb: 0, fat: 0 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test`
Expected: FAIL, `T.periodStart is not a function`.

- [ ] **Step 3: Implement**

In `lib/tracking.js`, replace `return {};` with:

```js
  var DAY = 86400000;

  // Midnight (local) of `now`, then step back N days for the longer periods.
  function periodStart(period, now) {
    var d = new Date(now);
    d.setHours(0, 0, 0, 0);
    var midnight = d.getTime();
    if (period === "week") return midnight - 6 * DAY;   // today + the previous 6 days
    if (period === "month") return midnight - 29 * DAY; // rolling 30 days
    return midnight;                                     // "today"
  }

  function filterPeriod(rows, period, now) {
    var from = periodStart(period, now);
    return rows.filter(function (r) { return r.ts >= from; });
  }

  function totals(rows) {
    var out = { kcal: 0, pro: 0, carb: 0, fat: 0 };
    rows.forEach(function (r) {
      ["kcal", "pro", "carb", "fat"].forEach(function (k) {
        if (typeof r[k] === "number") out[k] += r[k];
      });
    });
    out.pro = +out.pro.toFixed(1);
    out.carb = +out.carb.toFixed(1);
    out.fat = +out.fat.toFixed(1);
    return out;
  }

  return { DAY: DAY, periodStart: periodStart, filterPeriod: filterPeriod, totals: totals };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/tracking.js tests/tracking.test.js
git commit -m "Add period filtering and macro totals"
```

---

## Task 2: Per-day buckets and most-eaten (pure)

**Files:**
- Modify: `lib/tracking.js`
- Test: `tests/tracking.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tracking.test.js`:

```js
test("dayBuckets returns one entry per day including empty days", () => {
  const now = new Date("2026-07-17T12:00:00").getTime();
  const rows = [{ ts: now, kcal: 100 }, { ts: now - 2 * DAY, kcal: 50 }];
  const b = T.dayBuckets(rows, "week", now);
  assert.strictEqual(b.length, 7);
  assert.strictEqual(b[6].kcal, 100);   // today is last
  assert.strictEqual(b[4].kcal, 50);
  assert.strictEqual(b[5].kcal, 0);     // empty day is a zero bar, not a gap
  assert.ok(typeof b[0].label === "string");
});

test("mostEaten counts and sums per food, sorted by count", () => {
  const rows = [
    { food: "pizza", kcal: 300 },
    { food: "pizza", kcal: 200 },
    { food: "apple", kcal: 50 },
  ];
  const m = T.mostEaten(rows, 5);
  assert.strictEqual(m[0].food, "pizza");
  assert.strictEqual(m[0].count, 2);
  assert.strictEqual(m[0].kcal, 500);
  assert.strictEqual(m[1].food, "apple");
});

test("mostEaten respects the limit", () => {
  const rows = [{ food: "a" }, { food: "b" }, { food: "c" }];
  assert.strictEqual(T.mostEaten(rows, 2).length, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test`
Expected: FAIL, `T.dayBuckets is not a function`.

- [ ] **Step 3: Implement**

In `lib/tracking.js`, add these functions before the `return` and add them to the returned object:

```js
  // One bucket per day across the period, oldest first. Empty days are zeros, not gaps.
  function dayBuckets(rows, period, now) {
    var from = periodStart(period, now);
    var todayMid = periodStart("today", now);
    var days = Math.round((todayMid - from) / DAY) + 1;
    var buckets = [];
    for (var i = 0; i < days; i++) {
      var start = from + i * DAY;
      var d = new Date(start);
      buckets.push({
        start: start,
        label: d.getDate() + "/" + (d.getMonth() + 1),
        kcal: 0, pro: 0, carb: 0, fat: 0, count: 0
      });
    }
    rows.forEach(function (r) {
      var idx = Math.floor((r.ts - from) / DAY);
      if (idx < 0 || idx >= buckets.length) return;
      var b = buckets[idx];
      ["kcal", "pro", "carb", "fat"].forEach(function (k) {
        if (typeof r[k] === "number") b[k] += r[k];
      });
      b.count++;
    });
    return buckets;
  }

  function mostEaten(rows, limit) {
    var by = Object.create(null); // null-prototype: a food named "__proto__" or "constructor" must not reach Object.prototype
    rows.forEach(function (r) {
      if (!r.food) return;
      if (!by[r.food]) by[r.food] = { food: r.food, count: 0, kcal: 0 };
      by[r.food].count++;
      if (typeof r.kcal === "number") by[r.food].kcal += r.kcal;
    });
    return Object.keys(by)
      .map(function (k) { return by[k]; })
      .sort(function (a, b) { return b.count - a.count || b.kcal - a.kcal; })
      .slice(0, limit || 5);
  }
```

Add `dayBuckets: dayBuckets, mostEaten: mostEaten` to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/tracking.js tests/tracking.test.js
git commit -m "Add per-day buckets and most-eaten aggregation"
```

---

## Task 3: Wire the period selector and totals into the UI

**Files:**
- Modify: `index.html` (the `histCard` block near line 196, and `renderHistory()` near line 637)

- [ ] **Step 1: Add the period selector markup**

In `index.html`, find:

```html
  <div class="result" id="histCard">
```

Immediately after the line containing `<b>Today</b><span class="chip" id="histTotal">0 kcal</span>`, replace
that whole header line with:

```html
      <b id="histTitle">Today</b>
      <span class="chip" id="histTotal">0 kcal</span>
      <span style="margin-left:auto;display:flex;gap:4px">
        <button class="chip" id="pTODAY" onclick="setPeriod('today')">Today</button>
        <button class="chip" id="pWEEK" onclick="setPeriod('week')">Week</button>
        <button class="chip" id="pMONTH" onclick="setPeriod('month')">Month</button>
      </span>
```

Then add an averages line immediately after the `<div class="macros" id="histMacros" ...></div>` line
(the macros grid is `repeat(3,1fr)`, so the average goes on its own row rather than as a fourth cell):

```html
      <div id="histAvg" class="muted" style="margin-top:6px;font-size:12px"></div>
```

- [ ] **Step 2: Add the period state and setter**

In `index.html`, immediately after the line `const LKEY='caleyez_log';` (line ~622), add:

```js
let PERIOD='today';                                     // 'today' | 'week' | 'month'
function setPeriod(p){ PERIOD=p; renderHistory(); }
```

- [ ] **Step 3: Rewrite `renderHistory()` to use the period**

Replace the whole `renderHistory()` function (starts line ~637, ends at the closing `}` before
`$("logBtn").onclick=logMeal;`) with:

```js
function renderHistory(){
  const all=loadLog();
  if(!all.length){ $("histCard").classList.remove('show'); return; }
  $("histCard").classList.add('show');
  const now=Date.now();
  const rows=CZTrack.filterPeriod(all, PERIOD, now);
  const t=CZTrack.totals(rows);
  const title={today:'Today',week:'Last 7 days',month:'Last 30 days'}[PERIOD];
  $("histTitle").textContent=title;
  $("histTotal").textContent='🔥 '+t.kcal+' kcal';
  ['TODAY','WEEK','MONTH'].forEach(k=>{
    const b=$("p"+k); if(b) b.style.opacity = (k.toLowerCase()===PERIOD)?'1':'.45';
  });
  $("histMacros").innerHTML=[['pro','protein'],['carb','carbs'],['fat','fat']]
    .map(([k,l])=>`<div class="macro"><b>${t[k].toFixed(0)}g</b><span>${l}</span></div>`).join('');
  const nDays={today:1,week:7,month:30}[PERIOD];
  $("histAvg").textContent = nDays>1
    ? `average per day: ${Math.round(t.kcal/nDays)} kcal · ${(t.pro/nDays).toFixed(1)}g protein · `+
      `${(t.carb/nDays).toFixed(1)}g carbs · ${(t.fat/nDays).toFixed(1)}g fat`
    : '';
  $("histList").innerHTML=rows.slice(-8).reverse().map(r=>{
    const tm=new Date(r.ts).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const macros=(r.pro!=null)?`<div class="lm">
        <span><i style="background:var(--blue)"></i>${r.pro}g protein</span>
        <span><i style="background:var(--amber)"></i>${r.carb}g carbs</span>
        <span><i style="background:var(--accent)"></i>${r.fat}g fat</span></div>`:'';
    return `<div class="logrow"><div class="lh">
        <span class="lf">${r.food.replace(/_/g,' ')} <span class="lsub">${r.sub?r.sub+' · ':''}${r.method?r.method.replace(/_/g,' ')+' · ':''}${r.grams}g · ${tm}</span></span>
        <span class="lk">${r.kcal!=null?r.kcal+' kcal':'-'}</span></div>${macros}</div>`;
  }).join('') || '<span class="chip">no entries in this period</span>';
}
```

- [ ] **Step 4: Verify in the browser**

Serve the app and run this in the console to seed data and check all three periods:

```js
const DAY=86400000, now=Date.now();
localStorage.setItem('caleyez_log', JSON.stringify([
  {ts:now,           food:'pizza', grams:200, kcal:400, pro:20, carb:40, fat:15},
  {ts:now-3*DAY,     food:'apple', grams:150, kcal:78,  pro:0.5,carb:21, fat:0.3},
  {ts:now-20*DAY,    food:'steak', grams:200, kcal:542, pro:50, carb:0,  fat:38}
]));
setPeriod('today');  console.log('today',  $("histTotal").textContent);  // 400 kcal
setPeriod('week');   console.log('week',   $("histTotal").textContent);  // 478 kcal
setPeriod('month');  console.log('month',  $("histTotal").textContent);  // 1020 kcal
```
Expected: 400, 478, 1020 kcal respectively, and the active button is fully opaque.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Add Today/Week/Month period selector to the history card"
```

---

## Task 4: Per-day bar chart

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the canvas**

In `index.html`, immediately after the line `<div id="histList" ...></div>` inside `histCard`, add:

```html
      <canvas id="histChart" height="120" style="margin-top:10px"></canvas>
```

- [ ] **Step 2: Add the chart renderer**

In `index.html`, add above `function renderHistory(){`:

```js
let histChart=null;
function renderChart(buckets){
  const el=$("histChart"); if(!el || typeof Chart==='undefined') return;
  const data={labels:buckets.map(b=>b.label),
    datasets:[{data:buckets.map(b=>Math.round(b.kcal)), backgroundColor:'#46c98d', borderRadius:4}]};
  const opts={responsive:true, plugins:{legend:{display:false}},
    scales:{x:{grid:{display:false},ticks:{color:'#8b949e',font:{size:10}}},
            y:{beginAtZero:true,grid:{color:'#222b36'},ticks:{color:'#8b949e',font:{size:10}}}}};
  if(histChart){ histChart.data=data; histChart.update(); return; }
  histChart=new Chart(el.getContext('2d'), {type:'bar', data, options:opts});
}
```

- [ ] **Step 3: Call it from `renderHistory()`**

In `renderHistory()`, immediately after the `const t=CZTrack.totals(rows);` line, add:

```js
  renderChart(CZTrack.dayBuckets(rows, PERIOD, now));
```

- [ ] **Step 4: Ensure Chart.js is loaded**

Check whether `index.html` already includes Chart.js:

```bash
grep -n "chart.js\|Chart.min.js\|cdn.jsdelivr.net/npm/chart" index.html
```
If there is **no** match, add this in the `<head>`:
```html
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
```

- [ ] **Step 5: Verify in the browser**

Reload, seed the data from Task 3 Step 4, then run `setPeriod('week')`.
Expected: a 7-bar chart appears; the bar for 3 days ago is 78 and today is 400; empty days show as zero-height bars.

- [ ] **Step 6: Commit**

```bash
git add index.html
git commit -m "Add per-day kcal bar chart to the history card"
```

---

## Task 5: Most-eaten list

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the container**

In `index.html`, immediately after the `<canvas id="histChart" ...>` line, add:

```html
      <div id="histTop" style="margin-top:10px;font-size:13px"></div>
```

- [ ] **Step 2: Render it**

In `renderHistory()`, immediately after the `renderChart(...)` line, add:

```js
  const top=CZTrack.mostEaten(rows,5);
  $("histTop").innerHTML = top.length
    ? '<div class="muted" style="margin-bottom:4px">Most eaten</div>'+top.map(m=>
        `<div class="logrow"><div class="lh"><span class="lf">${m.food.replace(/_/g,' ')}
         <span class="lsub">x${m.count}</span></span><span class="lk">${Math.round(m.kcal)} kcal</span></div></div>`).join('')
    : '';
```

- [ ] **Step 3: Verify in the browser**

Reload, seed the Task 3 data plus a second pizza:
```js
const a=JSON.parse(localStorage.getItem('caleyez_log'));
a.push({ts:Date.now(),food:'pizza',grams:100,kcal:200,pro:10,carb:20,fat:8});
localStorage.setItem('caleyez_log',JSON.stringify(a)); setPeriod('month');
```
Expected: "Most eaten" lists pizza x2 (600 kcal) first, then steak and apple.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add most-eaten foods to the history card"
```

---

# PHASE 2 - Custom recipes

## Task 6: Recipe merge (pure)

**Files:**
- Modify: `lib/tracking.js`
- Test: `tests/tracking.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tracking.test.js`:

```js
test("mergeSubs returns foodmeta subs when there is no recipe", () => {
  const meta = { subs: { ribeye: { kcal: 291 } } };
  assert.deepStrictEqual(T.mergeSubs(meta, undefined), { ribeye: { kcal: 291 } });
});

test("mergeSubs adds user recipes alongside foodmeta subs", () => {
  const meta = { subs: { ribeye: { kcal: 291 } } };
  const recipes = { "my homemade": { kcal: 240 } };
  const m = T.mergeSubs(meta, recipes);
  assert.deepStrictEqual(Object.keys(m).sort(), ["my homemade", "ribeye"]);
});

test("mergeSubs works when the food has no foodmeta entry", () => {
  assert.deepStrictEqual(T.mergeSubs(undefined, { mine: { kcal: 1 } }), { mine: { kcal: 1 } });
});

test("mergeSubs returns an empty object when there is nothing", () => {
  assert.deepStrictEqual(T.mergeSubs(undefined, undefined), {});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test`
Expected: FAIL, `T.mergeSubs is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/tracking.js` and to the returned object:

```js
  // A user recipe is just another "sub". Recipes win on a name clash.
  function mergeSubs(meta, recipesForFood) {
    var base = (meta && meta.subs) ? meta.subs : {};
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    if (recipesForFood) Object.keys(recipesForFood).forEach(function (k) { out[k] = recipesForFood[k]; });
    return out;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/tracking.js tests/tracking.test.js
git commit -m "Add recipe/sub merge helper"
```

---

## Task 7: Recipe storage and use in the app

**Files:**
- Modify: `index.html` (`effNut` line ~482, `controlsHTML` line ~492)

- [ ] **Step 1: Add recipe storage**

In `index.html`, immediately after `const LKEY='caleyez_log';`, add:

```js
const RKEY='caleyez_recipes';
const loadRecipes=()=>{try{return JSON.parse(localStorage.getItem(RKEY)||'{}');}catch(e){return {};}};
const saveRecipes=o=>localStorage.setItem(RKEY,JSON.stringify(o));
let RECIPES=loadRecipes();
```

- [ ] **Step 2: Use merged subs in `effNut`**

In `effNut(label)` (line ~482), replace:

```js
  const base=(selSub && m.subs && m.subs[selSub]) ? m.subs[selSub] : NUTR[label];
```
with:
```js
  const allSubs=CZTrack.mergeSubs(m, RECIPES[label]);
  const base=(selSub && allSubs[selSub]) ? allSubs[selSub] : NUTR[label];
```

- [ ] **Step 3: Show recipes in the dropdown**

In `controlsHTML(label)` (line ~492), replace:

```js
  const m=FOODMETA[label]; if(!m) return '';
```
with:
```js
  const m=FOODMETA[label]||{};
  const allSubs=CZTrack.mergeSubs(m, RECIPES[label]);
  if(!Object.keys(allSubs).length && !(m.prep&&m.prep.length)) return '';
```
and replace:
```js
  const subs=m.subs?Object.keys(m.subs):[];
```
with:
```js
  const subs=Object.keys(allSubs);
```

- [ ] **Step 4: Verify in the browser**

Reload and run:
```js
RECIPES={pizza:{"my homemade":{kcal:240,pro:11,carb:28,fat:9}}};
selSub=''; console.log(controlsHTML('pizza').includes('my homemade'));  // true
selSub='my homemade'; console.log(effNut('pizza').kcal);                 // 240
console.log(controlsHTML('hummus').includes('my homemade'));             // false - no recipe for hummus
```
Expected: `true`, `240`, `false`.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Let user recipes appear as sub-food options"
```

---

## Task 8: Recipe editor UI

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the button and form markup**

In `index.html`, immediately after the `<button class="btn" id="logBtn" ...>` line (~193), add:

```html
    <button class="btn ghost" id="recipeBtn" style="margin-top:6px;font-size:13px">＋ Save my own values</button>
    <div id="recipeForm" style="display:none;margin-top:8px;gap:6px;flex-wrap:wrap">
      <input id="rcName" placeholder="name (e.g. my homemade)" style="flex:1;min-width:140px">
      <input id="rcKcal" type="number" placeholder="kcal/100g" style="width:90px">
      <input id="rcPro"  type="number" placeholder="protein"   style="width:80px">
      <input id="rcCarb" type="number" placeholder="carbs"     style="width:80px">
      <input id="rcFat"  type="number" placeholder="fat"       style="width:70px">
      <button class="btn" id="rcSave" style="width:auto;padding:8px 14px">Save</button>
    </div>
```

- [ ] **Step 2: Wire it up**

In `index.html`, immediately above `$("logBtn").onclick=logMeal;`, add:

```js
$("recipeBtn").onclick=()=>{
  if(!last || last.abstain){ alert('Analyze a recognized food first.'); return; }
  const f=$("recipeForm"); f.style.display = f.style.display==='none' ? 'flex' : 'none';
};
$("rcSave").onclick=()=>{
  if(!last || last.abstain) return;
  const label=last.chosen.label, name=($("rcName").value||'').trim();
  const kcal=+$("rcKcal").value;
  if(!name || !kcal){ alert('Give it a name and a kcal value.'); return; }
  RECIPES[label]=RECIPES[label]||{};
  RECIPES[label][name]={kcal, pro:+$("rcPro").value||0, carb:+$("rcCarb").value||0, fat:+$("rcFat").value||0};
  saveRecipes(RECIPES);
  selSub=name; $("recipeForm").style.display='none';
  render(last);
};
```

- [ ] **Step 3: Verify in the browser**

Analyze any food (or set `last` manually), click "Save my own values", enter `my homemade` / `240` / `11` / `28` / `9`, click Save.
Expected: the sub dropdown now shows "my homemade" selected and the kcal figure changes. Reload the page,
analyze the same food: "my homemade" is still offered (it persisted to localStorage).

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add a recipe editor for user-defined nutrition values"
```

---

# PHASE 3 - Vitamins and minerals

## Task 9: Extend the USDA Worker

**Files:**
- Modify: `usda_worker.js:18` (the `NUTRIENT` map) and `:22` (`CACHE_VER`), and the `out` object (~line 114)

- [ ] **Step 1: Extend the nutrient map**

In `usda_worker.js`, replace:

```js
const NUTRIENT = { 1008: "kcal", 2047: "kcal", 2048: "kcal", 1003: "pro", 1005: "carb", 1004: "fat" };
```
with:
```js
// USDA nutrient IDs -> our keys. Energy 1008/2047/2048, then macros, then micros.
const NUTRIENT = {
  1008: "kcal", 2047: "kcal", 2048: "kcal", 1003: "pro", 1005: "carb", 1004: "fat",
  1079: "fiber", 2000: "sugar",
  1106: "vitA", 1162: "vitC", 1114: "vitD", 1109: "vitE", 1185: "vitK",
  1165: "b1", 1166: "b2", 1167: "b3", 1175: "b6", 1177: "folate", 1178: "b12",
  1087: "calcium", 1089: "iron", 1090: "magnesium", 1092: "potassium", 1093: "sodium", 1095: "zinc"
};
const MICRO_KEYS = ["fiber","sugar","vitA","vitC","vitD","vitE","vitK","b1","b2","b3","b6","folate","b12",
  "calcium","iron","magnesium","potassium","sodium","zinc"];
```

- [ ] **Step 2: Bump the cache version**

In `usda_worker.js`, change `const CACHE_VER = "7";` to `const CACHE_VER = "8";`
(the edge cache holds responses for 30 days; without this bump you will keep serving macro-only answers).

- [ ] **Step 3: Pass the micros through**

Find the `out` assignment (~line 114):

```js
      const out = best
        ? { kcal: best.macros.kcal, pro: best.macros.pro ?? 0, carb: best.macros.carb ?? 0,
```
Replace the whole `const out = best ? {...} : ...;` expression with:

```js
      const out = best
        ? Object.assign(
            { kcal: best.macros.kcal, pro: best.macros.pro ?? 0, carb: best.macros.carb ?? 0,
              fat: best.macros.fat ?? 0, _desc: best.desc },
            MICRO_KEYS.reduce((acc, k) => {
              if (typeof best.macros[k] === "number") acc[k] = best.macros[k];
              return acc;
            }, {})
          )
        : null;
```

> If the existing `out` object has extra fields beyond `kcal/pro/carb/fat/_desc`, keep them: read the current
> lines first and merge, do not delete anything.

- [ ] **Step 4: Deploy the Worker (separate from Pages)**

```bash
cd "E:/caleyez-web" && wrangler deploy
```
Expected: a successful deploy of `caleyez-usda`.

- [ ] **Step 5: Verify against the live Worker**

```bash
curl -s "https://caleyez-usda.caleyez.workers.dev/?q=broccoli" | python -m json.tool
```
Expected: the JSON now contains `vitC`, `vitK`, `calcium`, `iron` etc. in addition to `kcal/pro/carb/fat`.
If it does not, the cache did not invalidate: re-check `CACHE_VER`.

- [ ] **Step 6: Commit**

```bash
git add usda_worker.js
git commit -m "Return vitamins and minerals from the USDA worker"
```

---

## Task 10: Harvest micros into the local nutrition table

**Files:**
- Create: `tools/harvest_micros.mjs`
- Modify: `nutrition.json` (generated by the script)

- [ ] **Step 1: Write the harvester**

Create `tools/harvest_micros.mjs`:

```js
// One-off: fills vitamin/mineral fields into nutrition.json by asking the deployed Worker.
// Foods the Worker cannot resolve (the Israeli dishes) are reported and left untouched.
// Run: node tools/harvest_micros.mjs
import { readFileSync, writeFileSync } from "node:fs";

const WORKER = "https://caleyez-usda.caleyez.workers.dev/?q=";
const MICROS = ["fiber","sugar","vitA","vitC","vitD","vitE","vitK","b1","b2","b3","b6","folate","b12",
  "calcium","iron","magnesium","potassium","sodium","zinc"];

const path = new URL("../nutrition.json", import.meta.url);
const nut = JSON.parse(readFileSync(path, "utf8"));
const foods = Object.keys(nut).filter((k) => !k.startsWith("_"));
const missed = [];

for (const food of foods) {
  const q = encodeURIComponent(food.replace(/_/g, " "));
  let j = null;
  try {
    const r = await fetch(WORKER + q);
    j = r.ok ? await r.json() : null;
  } catch (e) { j = null; }
  if (!j || typeof j.kcal !== "number") { missed.push(food); continue; }
  let added = 0;
  for (const k of MICROS) {
    if (typeof j[k] === "number") { nut[food][k] = +j[k].toFixed(2); added++; }
  }
  console.log(`${food.padEnd(22)} ${added} micros  (${j._desc || "?"})`);
  await new Promise((r) => setTimeout(r, 250)); // be polite to the API
}

writeFileSync(path, JSON.stringify(nut, null, 2) + "\n");
console.log("\nNo USDA match (fill these by hand):", missed.join(", ") || "none");
```

- [ ] **Step 2: Run it**

```bash
cd "E:/caleyez-web" && node tools/harvest_micros.mjs
```
Expected: a line per food showing how many micros were added, then a list of foods with no USDA match.
The 13 Israeli dishes (jachnun, sabich, malawach, meorav_yerushalmi, samosa, schnitzel, bourekas_cheese,
hummus, falafel, shakshuka, shawarma, baklava, sufganiyah) should appear in that "no match" list, or match
poorly - handle them in Task 11.

- [ ] **Step 3: Verify the file is still valid and got richer**

```bash
node -e "const n=require('./nutrition.json'); console.log('apple:', JSON.stringify(n.apple));"
```
Expected: `apple` now has `vitC`, `potassium` etc. alongside kcal/pro/carb/fat.

- [ ] **Step 4: Commit**

```bash
git add tools/harvest_micros.mjs nutrition.json
git commit -m "Harvest vitamin and mineral values into the local nutrition table"
```

---

## Task 11: Israeli dish micro estimates

**Files:**
- Modify: `nutrition.json`

- [ ] **Step 1: Add estimates for any dish the harvester missed**

For each Israeli dish reported as "no USDA match", add estimated micros derived from its main ingredients.
Use these starting values (per 100 g) and adjust if you have a better source. Mark them as estimates in the
`_note` field so the report can be honest about it.

```json
  "hummus":     {"kcal":166,"pro":7.9,"carb":14,"fat":9.6,"fiber":6.0,"iron":2.4,"folate":83,"calcium":38,"potassium":228},
  "falafel":    {"kcal":333,"pro":13.3,"carb":32,"fat":18,"fiber":4.9,"iron":3.4,"folate":78,"calcium":54,"potassium":585},
  "shakshuka":  {"kcal":95,"pro":5,"carb":6,"fat":6,"fiber":1.5,"vitC":14,"vitA":60,"iron":1.1,"potassium":260},
  "jachnun":    {"kcal":330,"pro":7,"carb":45,"fat":13,"fiber":1.8,"iron":1.6,"calcium":15,"potassium":90},
  "malawach":   {"kcal":360,"pro":7,"carb":40,"fat":19,"fiber":1.5,"iron":1.5,"calcium":14,"potassium":85},
  "sabich":     {"kcal":210,"pro":7,"carb":25,"fat":9,"fiber":3.0,"iron":1.4,"folate":40,"potassium":250},
  "bourekas_cheese": {"kcal":330,"pro":8,"carb":30,"fat":20,"fiber":1.2,"calcium":110,"iron":1.2,"potassium":95},
  "sufganiyah": {"kcal":340,"pro":5,"carb":45,"fat":16,"fiber":1.2,"iron":1.3,"calcium":30,"potassium":75},
  "baklava":    {"kcal":430,"pro":6,"carb":45,"fat":26,"fiber":2.2,"iron":1.5,"calcium":45,"potassium":170},
  "shawarma":   {"kcal":250,"pro":17,"carb":10,"fat":16,"fiber":0.8,"iron":1.8,"b12":1.2,"zinc":3.0,"potassium":260},
  "schnitzel":  {"kcal":300,"pro":20,"carb":15,"fat":18,"fiber":0.8,"iron":1.1,"b3":8.0,"zinc":1.2,"potassium":260},
  "samosa":     {"kcal":290,"pro":5,"carb":32,"fat":16,"fiber":2.5,"iron":1.4,"vitC":6,"potassium":230},
  "meorav_yerushalmi": {"kcal":250,"pro":20,"carb":4,"fat":17,"fiber":0.3,"iron":4.5,"b12":6.0,"zinc":3.5,"potassium":210}
```

Only replace entries that the harvester did **not** fill. Keep the existing kcal/pro/carb/fat values exactly
as they are; you are only adding micro fields.

- [ ] **Step 2: Update the note**

In `nutrition.json`, change the `_note` value to:

```
"per 100 g: kcal, protein g, carb g, fat g, plus optional vitamins/minerals. Macro and micro values for foods present in USDA FoodData Central are harvested from it; the Israeli dishes are ingredient-based estimates."
```

- [ ] **Step 3: Verify**

```bash
node -e "const n=require('./nutrition.json'); const isr=['jachnun','sabich','hummus','falafel','shakshuka','malawach','meorav_yerushalmi','samosa','schnitzel','bourekas_cheese','shawarma','baklava','sufganiyah']; isr.forEach(k=>console.log(k, n[k] && n[k].iron!==undefined ? 'has micros' : 'MISSING'));"
```
Expected: every dish prints `has micros`.

- [ ] **Step 4: Commit**

```bash
git add nutrition.json
git commit -m "Add ingredient-based micro estimates for the Israeli dishes"
```

---

## Task 12: Store and render micros

**Files:**
- Modify: `lib/tracking.js`, `tests/tracking.test.js`, `index.html`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tracking.test.js`:

```js
test("scaleMicros scales per-100g micros to the eaten grams", () => {
  const m = T.scaleMicros({ kcal: 100, vitC: 10, iron: 2 }, 200);
  assert.strictEqual(m.vitC, 20);
  assert.strictEqual(m.iron, 4);
  assert.strictEqual(m.kcal, undefined); // macros are handled separately, not duplicated here
});

test("scaleMicros returns null when there are no micros", () => {
  assert.strictEqual(T.scaleMicros({ kcal: 100, pro: 5 }, 100), null);
});

test("sumMicros adds across rows and skips nulls", () => {
  const s = T.sumMicros([{ micros: { vitC: 10 } }, { micros: null }, { micros: { vitC: 5, iron: 1 } }]);
  assert.strictEqual(s.vitC, 15);
  assert.strictEqual(s.iron, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test`
Expected: FAIL, `T.scaleMicros is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/tracking.js` and to the returned object:

```js
  var MICRO_KEYS = ["fiber","sugar","vitA","vitC","vitD","vitE","vitK","b1","b2","b3","b6","folate","b12",
    "calcium","iron","magnesium","potassium","sodium","zinc"];

  // per-100g micros -> the amount actually eaten. Returns null when the food has no micros.
  function scaleMicros(nut, grams) {
    if (!nut || !grams) return null;
    var out = {}, any = false;
    MICRO_KEYS.forEach(function (k) {
      if (typeof nut[k] === "number") { out[k] = +(nut[k] * grams / 100).toFixed(2); any = true; }
    });
    return any ? out : null;
  }

  function sumMicros(rows) {
    var out = {};
    rows.forEach(function (r) {
      if (!r.micros) return;
      Object.keys(r.micros).forEach(function (k) {
        if (typeof r.micros[k] === "number") out[k] = +((out[k] || 0) + r.micros[k]).toFixed(2);
      });
    });
    return out;
  }
```

Add `MICRO_KEYS: MICRO_KEYS, scaleMicros: scaleMicros, sumMicros: sumMicros` to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Store micros when logging**

In `index.html`, in `logMeal()` (line ~625), inside the `const row={...}` object, add this final property
(after `fat:...`):

```js
    micros: CZTrack.scaleMicros(nut, g)
```

- [ ] **Step 6: Show micros on the result card**

In `index.html`, add a container immediately after the line `<div class="macros" id="rMacros"></div>` (line ~191):

```html
    <div id="rMicros"></div>
```

Then add this helper immediately above `function render({chosen, ...})`:

```js
const MICRO_LABEL={fiber:'fiber g',sugar:'sugar g',vitA:'vit A µg',vitC:'vit C mg',vitD:'vit D µg',
  vitE:'vit E mg',vitK:'vit K µg',b1:'B1 mg',b2:'B2 mg',b3:'B3 mg',b6:'B6 mg',folate:'folate µg',
  b12:'B12 µg',calcium:'calcium mg',iron:'iron mg',magnesium:'magnesium mg',potassium:'potassium mg',
  sodium:'sodium mg',zinc:'zinc mg'};
function microsHTML(nut,grams){
  const m=CZTrack.scaleMicros(nut,grams);
  if(!m) return '<div class="muted" style="margin-top:6px;font-size:12px">no vitamin data for this food</div>';
  return '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12px" class="muted">'+
    Object.keys(m).map(k=>`<span>${MICRO_LABEL[k]||k}: <b style="color:var(--ink)">${m[k]}</b></span>`).join('')+'</div>';
}
```
Now wire it into `render()`. Find this block (line ~536):

```js
    $("rMacros").innerHTML=[['pro','protein'],['carb','carbs'],['fat','fat']]
      .map(([k,l])=>`<div class="macro"><b>${(nut[k]*r).toFixed(1)}g</b><span>${l}</span></div>`).join('');
  }else{
```
and change it to:
```js
    $("rMacros").innerHTML=[['pro','protein'],['carb','carbs'],['fat','fat']]
      .map(([k,l])=>`<div class="macro"><b>${(nut[k]*r).toFixed(1)}g</b><span>${l}</span></div>`).join('');
    $("rMicros").innerHTML=microsHTML(nut, g);
  }else{
```

Then find the next line `$("rMacros").innerHTML='';` (line ~541, the no-nutrition branch) and add after it:

```js
    $("rMicros").innerHTML='';
```

Also clear it on the three reset paths: after each existing `$("rMacros").innerHTML='';` at lines ~284,
~300 and ~471, add `$("rMicros").innerHTML='';`

- [ ] **Step 7: Verify in the browser**

Reload, analyze (or simulate) a food that exists in `nutrition.json` with micros (e.g. `apple`), set grams to 200.
Expected: the card lists vitamins scaled to 200 g (double the per-100 g values). Log the meal, then run
`JSON.parse(localStorage.caleyez_log).slice(-1)[0].micros` in the console.
Expected: a micros object is stored on the row.

- [ ] **Step 8: Commit**

```bash
git add lib/tracking.js tests/tracking.test.js index.html
git commit -m "Scale, store and display vitamins and minerals"
```

---

## Task 13: Show period vitamin totals in the dashboard

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add the container**

In `index.html`, immediately after the `<div id="histTop" ...></div>` line, add:

```html
      <div id="histMicros" style="margin-top:8px"></div>
```

- [ ] **Step 2: Render the totals**

In `renderHistory()`, immediately after the `$("histTop").innerHTML = ...` statement, add:

```js
  const sm=CZTrack.sumMicros(rows), mk=Object.keys(sm);
  $("histMicros").innerHTML = mk.length
    ? '<div class="muted" style="margin-bottom:4px">Vitamins and minerals this period</div>'+
      '<div style="display:flex;flex-wrap:wrap;gap:4px 10px;font-size:12px" class="muted">'+
      mk.map(k=>`<span>${MICRO_LABEL[k]||k}: <b style="color:var(--ink)">${sm[k]}</b></span>`).join('')+'</div>'
    : '';
```

- [ ] **Step 3: Verify in the browser**

Seed a couple of rows that have `micros`, then `setPeriod('week')`.
Expected: a "Vitamins and minerals this period" row appears with summed values. Old rows without `micros`
are silently skipped and nothing breaks.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Show period vitamin totals in the history card"
```

---

# PHASE 4 - Profile, BMI and TDEE

## Task 14: BMI and TDEE (pure)

**Files:**
- Modify: `lib/tracking.js`
- Test: `tests/tracking.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tracking.test.js`:

```js
test("bmi computes weight over height squared", () => {
  assert.strictEqual(T.bmi(74, 178), 23.4);
});

test("bmr uses Mifflin-St Jeor for men", () => {
  // 10*74 + 6.25*178 - 5*24 + 5 = 740 + 1112.5 - 120 + 5 = 1737.5
  assert.strictEqual(T.bmr({ sex: "m", weightKg: 74, heightCm: 178, age: 24 }), 1737.5);
});

test("bmr uses Mifflin-St Jeor for women", () => {
  // 10*60 + 6.25*165 - 5*30 - 161 = 600 + 1031.25 - 150 - 161 = 1320.25
  assert.strictEqual(T.bmr({ sex: "f", weightKg: 60, heightCm: 165, age: 30 }), 1320.25);
});

test("tdee multiplies bmr by the activity factor", () => {
  const p = { sex: "m", weightKg: 74, heightCm: 178, age: 24, activity: 1.55 };
  assert.strictEqual(T.tdee(p), Math.round(1737.5 * 1.55));
});

test("bmi and bmr return null on an incomplete profile", () => {
  assert.strictEqual(T.bmi(0, 178), null);
  assert.strictEqual(T.bmr({ sex: "m", weightKg: 74 }), null);
  assert.strictEqual(T.tdee({}), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test`
Expected: FAIL, `T.bmi is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/tracking.js` and to the returned object:

```js
  function bmi(weightKg, heightCm) {
    if (!weightKg || !heightCm) return null;
    var m = heightCm / 100;
    return +(weightKg / (m * m)).toFixed(1);
  }

  // Mifflin-St Jeor (1990). Resting energy expenditure, kcal/day.
  function bmr(p) {
    if (!p || !p.weightKg || !p.heightCm || !p.age || !p.sex) return null;
    var base = 10 * p.weightKg + 6.25 * p.heightCm - 5 * p.age;
    return p.sex === "f" ? base - 161 : base + 5;
  }

  // Total daily energy expenditure = BMR x activity factor.
  function tdee(p) {
    var b = bmr(p);
    if (b == null || !p.activity) return null;
    return Math.round(b * p.activity);
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/tracking.js tests/tracking.test.js
git commit -m "Add BMI and Mifflin-St Jeor BMR/TDEE"
```

---

## Task 15: Profile UI, greeting and eaten vs burned

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add storage and markup**

In `index.html`, after the `RECIPES` block from Task 7, add:

```js
const PKEY='caleyez_profile';
const loadProfile=()=>{try{return JSON.parse(localStorage.getItem(PKEY)||'null');}catch(e){return null;}};
const saveProfile=o=>localStorage.setItem(PKEY,JSON.stringify(o));
let PROFILE=loadProfile();
```

Add this markup immediately above the `<div class="result" id="histCard">` line:

```html
  <div class="result show" id="greetCard" style="display:none">
    <div class="lh"><span class="lf" id="greetText">Hello</span>
      <button class="chip" id="profBtn">profile</button></div>
    <div id="profForm" style="display:none;flex-wrap:wrap;gap:6px;margin-top:8px">
      <input id="pfName" placeholder="name" style="flex:1;min-width:110px">
      <select id="pfSex" style="width:90px"><option value="m">male</option><option value="f">female</option></select>
      <input id="pfAge" type="number" placeholder="age" style="width:70px">
      <input id="pfH" type="number" placeholder="height cm" style="width:95px">
      <input id="pfW" type="number" placeholder="weight kg" style="width:95px">
      <select id="pfAct" style="width:130px">
        <option value="1.2">sedentary</option><option value="1.375">light</option>
        <option value="1.55" selected>moderate</option><option value="1.725">very active</option>
        <option value="1.9">extra active</option>
      </select>
      <button class="btn" id="pfSave" style="width:auto;padding:8px 14px">Save</button>
    </div>
  </div>
```

- [ ] **Step 2: Wire it up**

Add above `$("logBtn").onclick=logMeal;`:

```js
function renderGreeting(){
  const c=$("greetCard");
  c.style.display='';
  if(!PROFILE || !PROFILE.name){ $("greetText").textContent='Hello - set up your profile'; return; }
  const b=CZTrack.bmi(PROFILE.weightKg, PROFILE.heightCm), t=CZTrack.tdee(PROFILE);
  $("greetText").innerHTML=`Hello <b>${PROFILE.name}</b>`+
    (b?` <span class="lsub">BMI ${b}${t?` · burns ~${t} kcal/day`:''}</span>`:'');
}
$("profBtn").onclick=()=>{
  const f=$("profForm"); f.style.display = f.style.display==='none' ? 'flex' : 'none';
  if(PROFILE){ $("pfName").value=PROFILE.name||''; $("pfSex").value=PROFILE.sex||'m';
    $("pfAge").value=PROFILE.age||''; $("pfH").value=PROFILE.heightCm||'';
    $("pfW").value=PROFILE.weightKg||''; $("pfAct").value=PROFILE.activity||1.55; }
};
$("pfSave").onclick=()=>{
  PROFILE={name:($("pfName").value||'').trim(), sex:$("pfSex").value, age:+$("pfAge").value||0,
    heightCm:+$("pfH").value||0, weightKg:+$("pfW").value||0, activity:+$("pfAct").value||1.55};
  saveProfile(PROFILE); $("profForm").style.display='none'; renderGreeting(); renderHistory();
};
renderGreeting();
```

- [ ] **Step 3: Show eaten vs burned in the dashboard**

In `renderHistory()`, immediately after the `$("histTotal").textContent=...` line, add:

```js
  const t2=CZTrack.tdee(PROFILE||{});
  if(t2){
    const days={today:1,week:7,month:30}[PERIOD];
    const burned=t2*days, net=t.kcal-burned;
    $("histTotal").textContent=`🔥 ${t.kcal} kcal · burned ~${burned} · net ${net>0?'+':''}${net}`;
  }
```

- [ ] **Step 4: Verify in the browser**

Reload, click "profile", enter `Raz` / male / 24 / 178 / 74 / moderate, Save.
Expected: the greeting reads `Hello Raz  BMI 23.4 · burns ~2693 kcal/day`, and the history chip shows
`kcal · burned ~... · net ...`. Reload the page: the profile persists.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "Add local profile with BMI, TDEE and eaten vs burned"
```

---

# PHASE 5 - Food-list discovery

## Task 16: Searchable list of recognisable foods

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add markup**

Immediately above the `<div class="result" id="greetCard" ...>` line, add:

```html
  <button class="chip" id="foodsBtn" style="margin-bottom:6px">I know 145 foods</button>
  <div class="result" id="foodsCard" style="display:none">
    <input id="foodSearch" placeholder="search a food..." style="width:100%;margin-bottom:6px">
    <div id="foodList" style="max-height:240px;overflow:auto;font-size:13px"></div>
  </div>
```

- [ ] **Step 2: Wire it up**

Add above `$("logBtn").onclick=logMeal;`:

```js
function allFoods(){
  const g=Object.values(namesG||{}).map(n=>({n, grp:'Global'}));
  const i=Object.values(namesI||{}).filter(n=>n!=='background').map(n=>({n, grp:'Israeli'}));
  return g.concat(i).sort((a,b)=>a.n.localeCompare(b.n));
}
function renderFoods(){
  const q=($("foodSearch").value||'').toLowerCase().replace(/\s+/g,'_');
  const list=allFoods().filter(f=>!q || f.n.includes(q));
  $("foodsBtn").textContent=`I know ${allFoods().length} foods`;
  $("foodList").innerHTML = list.length ? list.map(f=>{
    const off = NUTR && NUTR[f.n] ? '<span class="chip" style="background:#123a2a;color:#46c98d">offline</span>' : '';
    return `<div class="logrow"><div class="lh"><span class="lf">${f.n.replace(/_/g,' ')}
      <span class="lsub">${f.grp}</span></span>${off}</div></div>`;
  }).join('') : '<span class="chip">no match</span>';
}
$("foodsBtn").onclick=()=>{
  const c=$("foodsCard"); c.style.display = c.style.display==='none' ? '' : 'none';
  if(c.style.display==='') renderFoods();
};
$("foodSearch").oninput=renderFoods;
```

- [ ] **Step 3: Verify in the browser**

Wait for the models/names to load, click the chip, type `shak`.
Expected: the button reads "I know 145 foods"; searching shows `shakshuka` tagged `Israeli` with an
"offline" chip; `background` never appears.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add a searchable list of recognisable foods"
```

---

# PHASE 6 - CSV export and import

## Task 17: CSV serialize and parse (pure)

**Files:**
- Modify: `lib/tracking.js`
- Test: `tests/tracking.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/tracking.test.js`:

```js
test("toCSV writes a header and one line per row", () => {
  const csv = T.toCSV([{ ts: 1, food: "pizza", grams: 100, kcal: 200, pro: 1, carb: 2, fat: 3 }]);
  const lines = csv.trim().split("\n");
  assert.ok(lines[0].startsWith("ts,food,grams"));
  assert.ok(lines[1].includes("pizza"));
  assert.strictEqual(lines.length, 2);
});

test("toCSV quotes values containing commas", () => {
  const csv = T.toCSV([{ ts: 1, food: "rice, fried", grams: 1, kcal: 1, pro: 0, carb: 0, fat: 0 }]);
  assert.ok(csv.includes('"rice, fried"'));
});

test("fromCSV round-trips toCSV", () => {
  const rows = [{ ts: 1, food: "pizza", grams: 100, kcal: 200, pro: 1, carb: 2, fat: 3 }];
  const back = T.fromCSV(T.toCSV(rows));
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].food, "pizza");
  assert.strictEqual(back[0].ts, 1);
  assert.strictEqual(back[0].kcal, 200);
});

test("mergeRows dedupes by ts", () => {
  const a = [{ ts: 1, food: "x" }, { ts: 2, food: "y" }];
  const b = [{ ts: 2, food: "y" }, { ts: 3, food: "z" }];
  const m = T.mergeRows(a, b);
  assert.strictEqual(m.length, 3);
  assert.deepStrictEqual(m.map((r) => r.ts), [1, 2, 3]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test`
Expected: FAIL, `T.toCSV is not a function`.

- [ ] **Step 3: Implement**

Add to `lib/tracking.js` and to the returned object:

```js
  var CSV_COLS = ["ts","food","grams","expert","sub","method","kcal","pro","carb","fat"];

  function csvCell(v) {
    if (v == null) return "";
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(rows) {
    var head = CSV_COLS.join(",");
    var body = rows.map(function (r) {
      return CSV_COLS.map(function (c) { return csvCell(r[c]); }).join(",");
    }).join("\n");
    return head + "\n" + body + "\n";
  }

  // Minimal RFC4180-ish parser: handles quoted cells with commas and doubled quotes.
  function splitLine(line) {
    var out = [], cur = "", q = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function fromCSV(text) {
    var lines = String(text).split(/\r?\n/).filter(function (l) { return l.trim() !== ""; });
    if (!lines.length) return [];
    var cols = splitLine(lines[0]);
    var num = { ts: 1, grams: 1, kcal: 1, pro: 1, carb: 1, fat: 1 };
    return lines.slice(1).map(function (l) {
      var cells = splitLine(l), row = {};
      cols.forEach(function (c, i) {
        var v = cells[i];
        if (v === "" || v === undefined) { row[c] = null; return; }
        row[c] = num[c] ? Number(v) : v;
      });
      return row;
    });
  }

  function mergeRows(a, b) {
    var seen = {}, out = [];
    a.concat(b).forEach(function (r) {
      if (r == null || r.ts == null || seen[r.ts]) return;
      seen[r.ts] = 1;
      out.push(r);
    });
    return out.sort(function (x, y) { return x.ts - y.ts; });
  }
```

Add `toCSV: toCSV, fromCSV: fromCSV, mergeRows: mergeRows` to the returned object.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add lib/tracking.js tests/tracking.test.js
git commit -m "Add CSV serialize, parse and dedupe merge"
```

---

## Task 18: Export and import UI

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Add markup**

Immediately after the `<canvas id="histChart" ...>` line, add:

```html
      <div style="display:flex;gap:6px;margin-top:8px">
        <button class="chip" id="csvExport">⬇ export CSV</button>
        <label class="chip" style="cursor:pointer">⬆ import CSV
          <input id="csvImport" type="file" accept=".csv,text/csv" style="display:none">
        </label>
      </div>
```

- [ ] **Step 2: Wire it up**

Add above `$("logBtn").onclick=logMeal;`:

```js
$("csvExport").onclick=()=>{
  const rows=loadLog();
  if(!rows.length){ alert('Nothing to export yet.'); return; }
  const blob=new Blob([CZTrack.toCSV(rows)], {type:'text/csv'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='caleyez-log-'+new Date().toISOString().slice(0,10)+'.csv';
  a.click(); URL.revokeObjectURL(a.href);
};
$("csvImport").onchange=async(e)=>{
  const f=e.target.files && e.target.files[0]; if(!f) return;
  try{
    const merged=CZTrack.mergeRows(loadLog(), CZTrack.fromCSV(await f.text()));
    saveLog(merged); renderHistory();
    alert('Imported. Log now has '+merged.length+' entries.');
  }catch(err){ alert('Could not read that CSV.'); }
  e.target.value='';
};
```

- [ ] **Step 3: Verify in the browser**

Seed a few rows, click "export CSV" (a file downloads), clear the log with
`localStorage.removeItem('caleyez_log'); renderHistory();`, then import the downloaded file.
Expected: the entries come back, the totals match, and importing the same file twice does not duplicate rows.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "Add CSV export and import for the meal log"
```

---

## Task 19: Final verification and deploy

- [ ] **Step 1: Run the whole test suite**

Run: `cd "E:/caleyez-web" && node --test`
Expected: all tests pass, exit code 0.

- [ ] **Step 2: Check the style rules**

```bash
node -e "const s=require('fs').readFileSync('index.html','utf8')+require('fs').readFileSync('lib/tracking.js','utf8'); console.log('em/en dashes:', /[—–]/.test(s));"
```
Expected: `em/en dashes: false`. If true, replace them with plain hyphens.

- [ ] **Step 3: Confirm the arbiter was not touched**

```bash
git diff --stat b342050 -- index.html | tail -1
grep -n "ARB_TRUST\|ARB_ISR_TRUST\|isrTrust" index.html engineering.html || echo "no overrides - correct"
```
Expected: `no overrides - correct`. The routing logic (`arbiterP`, `routeI`, `arbUnsure`, `confident`) must be
unchanged from before this plan.

- [ ] **Step 4: Manual smoke test against the acceptance criteria**

Work through section 10 of the spec
(`docs/superpowers/specs/2026-07-17-tracking-recipes-vitamins-design.md`) and confirm each bullet.

- [ ] **Step 5: Deploy**

```bash
git push origin main          # deploys the app to GitHub Pages
wrangler deploy               # deploys the Worker (only if Task 9 changed it)
```

- [ ] **Step 6: Verify live**

Open https://raz-dv-ee.github.io/caleyez-web/ on a phone. Check: greeting, period selector, chart,
vitamins on a recognised food, the food list, and a CSV export.
