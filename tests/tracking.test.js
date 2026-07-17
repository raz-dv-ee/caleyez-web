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
