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
