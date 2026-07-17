const test = require("node:test");
const assert = require("node:assert");
const T = require("../lib/tracking.js");

test("module loads and exports an object", () => {
  assert.strictEqual(typeof T, "object");
});

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

test("mostEaten handles food names that collide with Object.prototype", () => {
  const m = T.mostEaten([{ food: "__proto__", kcal: 10 }, { food: "pizza", kcal: 5 }], 5);
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m.find((r) => r.food === "__proto__").kcal, 10);
  assert.strictEqual({}.count, undefined); // Object.prototype must not be polluted
});

test("mostEaten handles a food named constructor", () => {
  const m = T.mostEaten([{ food: "constructor", kcal: 10 }], 5);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].count, 1);
});

// mergeSubs returns a null-prototype map, so compare keys/values rather than deepStrictEqual
// against an object literal (deepStrictEqual also compares prototypes).
const plain = (o) => Object.assign({}, o);

test("mergeSubs returns foodmeta subs when there is no recipe", () => {
  const meta = { subs: { ribeye: { kcal: 291 } } };
  assert.deepStrictEqual(plain(T.mergeSubs(meta, undefined)), { ribeye: { kcal: 291 } });
});

test("mergeSubs adds user recipes alongside foodmeta subs", () => {
  const meta = { subs: { ribeye: { kcal: 291 } } };
  const recipes = { "my homemade": { kcal: 240 } };
  const m = T.mergeSubs(meta, recipes);
  assert.deepStrictEqual(Object.keys(m).sort(), ["my homemade", "ribeye"]);
});

test("mergeSubs works when the food has no foodmeta entry", () => {
  assert.deepStrictEqual(plain(T.mergeSubs(undefined, { mine: { kcal: 1 } })), { mine: { kcal: 1 } });
});

test("mergeSubs returns an empty object when there is nothing", () => {
  assert.deepStrictEqual(plain(T.mergeSubs(undefined, undefined)), {});
});

test("mergeSubs keeps a recipe named __proto__ instead of silently dropping it", () => {
  // localStorage round-trips through JSON.parse, where "__proto__" IS a real own key
  // (unlike an object literal), so a user recipe by that name must survive the merge.
  const recipes = JSON.parse('{"__proto__":{"kcal":999},"my pizza":{"kcal":240}}');
  const m = T.mergeSubs({ subs: { ribeye: { kcal: 291 } } }, recipes);
  assert.deepStrictEqual(Object.keys(m).sort(), ["__proto__", "my pizza", "ribeye"]);
  assert.strictEqual(m["__proto__"].kcal, 999);
  assert.strictEqual(Object.getPrototypeOf(m), null); // prototype not corrupted by the key
});

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
