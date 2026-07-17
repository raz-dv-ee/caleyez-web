// Pure helpers for tracking, recipes, nutrition scaling and CSV.
// UMD: works as a plain <script> in the browser (global CZTrack) and require() in Node tests.
// No DOM, no localStorage, no network in this file - that keeps it testable.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.CZTrack = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

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

  // A user recipe is just another "sub". Recipes win on a name clash.
  function mergeSubs(meta, recipesForFood) {
    var base = (meta && meta.subs) ? meta.subs : {};
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    if (recipesForFood) Object.keys(recipesForFood).forEach(function (k) { out[k] = recipesForFood[k]; });
    return out;
  }

  return {
    DAY: DAY, periodStart: periodStart, filterPeriod: filterPeriod, totals: totals,
    dayBuckets: dayBuckets, mostEaten: mostEaten, mergeSubs: mergeSubs
  };
});
