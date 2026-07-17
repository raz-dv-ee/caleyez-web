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

  // A user recipe is just another "sub". Recipes win on a name clash.
  function mergeSubs(meta, recipesForFood) {
    var base = (meta && meta.subs) ? meta.subs : {};
    var out = Object.create(null); // null-prototype: recipe names come from JSON.parse, where "__proto__" is a real key
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    if (recipesForFood) Object.keys(recipesForFood).forEach(function (k) { out[k] = recipesForFood[k]; });
    return out;
  }

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

  return {
    DAY: DAY, periodStart: periodStart, filterPeriod: filterPeriod, totals: totals,
    dayBuckets: dayBuckets, mostEaten: mostEaten, mergeSubs: mergeSubs,
    MICRO_KEYS: MICRO_KEYS, scaleMicros: scaleMicros, sumMicros: sumMicros,
    bmi: bmi, bmr: bmr, tdee: tdee,
    toCSV: toCSV, fromCSV: fromCSV, mergeRows: mergeRows
  };
});
