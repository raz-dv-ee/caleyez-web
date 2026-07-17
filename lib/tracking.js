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

  return { DAY: DAY, periodStart: periodStart, filterPeriod: filterPeriod, totals: totals };
});
