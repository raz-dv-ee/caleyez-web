// Cloudflare Worker: USDA FoodData Central proxy with a SMART FILTER.
// The API key lives in a Worker SECRET (env.USDA_KEY) so it NEVER appears in the public web-app repo.
// The app calls this Worker; the Worker calls USDA, scores the candidates, and returns per-100g
// {kcal, pro, carb, fat, _desc}. With ?debug=1 it also returns _candidates (the ranked list) so the
// engineering console can show exactly why a result was chosen or rejected.
//
// Deploy (free) — pick ONE path:
//   Dashboard: https://dash.cloudflare.com -> Workers & Pages -> Create Worker -> paste this -> Deploy
//   CLI:       npm i -g wrangler && wrangler deploy   (uses wrangler.toml next to this file)
// Then add the secret:
//   Dashboard: Worker -> Settings -> Variables & Secrets -> add Secret  name USDA_KEY  value <your key>
//   CLI:       wrangler secret put USDA_KEY
//   (free key: https://fdc.nal.usda.gov/api-key-signup.html)

const ALLOW_ORIGIN = "*";                       // e.g. "https://raz-dv-ee.github.io"
const CACHE_TTL    = 60 * 60 * 24 * 30;         // 30 days — nutrition facts are effectively static
// USDA nutrient IDs -> our keys. 1008/2047/2048 = energy(kcal), 1003 protein, 1005 carbs, 1004 fat.
const NUTRIENT = {
  1008: "kcal", 2047: "kcal", 2048: "kcal", 1003: "pro", 1005: "carb", 1004: "fat",
  1079: "fiber", 2000: "sugar",
  1106: "vitA", 1162: "vitC", 1114: "vitD", 1109: "vitE", 1185: "vitK",
  1165: "b1", 1166: "b2", 1167: "b3", 1175: "b6", 1177: "folate", 1178: "b12",
  1087: "calcium", 1089: "iron", 1090: "magnesium", 1092: "potassium", 1093: "sodium", 1095: "zinc"
};
const MICRO_KEYS = ["fiber","sugar","vitA","vitC","vitD","vitE","vitK","b1","b2","b3","b6","folate","b12",
  "calcium","iron","magnesium","potassium","sodium","zinc"];

// Descriptions containing a JUNK token are rejected UNLESS the query itself asked for that token.
// This is what stops "apple" -> "apple juice" and "tomato" -> "tomato sauce, canned".
const CACHE_VER = "8";                             // bump to invalidate the edge cache after logic changes
const JUNK = ["juice","drink","beverage","nectar","dried","dehydrated","chips","crisps","powder",
  "flour","baby food","infant","strained","sauce","gravy","soup","broth","candy","candies",
  "syrup","jam","jelly","jellied","preserve","marmalade","cocktail","pie filling","frozen novelties",
  "topping","flavored","imitation","substitute"];
// Stop words never drive a match. Cooking words are here on purpose: a class like "grilled_salmon"
// should resolve to the base SALMON (the method is handled by the separate multiplier), and this
// stops "grilled" from matching "GRILL" inside a restaurant dish name.
const STOP = new Set(["and","with","in","the","of","a","or","style","fresh","food","foods",
  "raw","grilled","grill","fried","deep","baked","roasted","broiled","boiled","steamed","cooked",
  "smoked","dry","moist","heat","prepared","homemade"]);

const tokenize = s => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);
// fuzzy token match: exact, or one is a prefix of the other (handles apple/apples, potato/potatoes).
const tmatch = (a, b) => a === b || (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)));
const has = (tokens, t) => tokens.some(u => tmatch(t, u));

// Score one candidate description against the query tokens. Higher = better; null = rejected.
// USDA descriptions read "PrimaryName, qualifier, qualifier" (e.g. "Apples, raw" vs "Croissants, apple").
// A query word matching the PRIMARY name is worth far more than matching a trailing qualifier, so
// "apple" picks "Apples, raw" over "Croissants, apple".
function scoreCandidate(desc, qTokens) {
  const d = desc.toLowerCase();
  for (const j of JUNK) {                                  // junk token present but not requested?
    if (d.includes(j) && !qTokens.some(t => j.includes(t))) return { score: null, reason: "'" + j + "'" };
  }
  const primary = tokenize(desc.split(",")[0]);            // words before the first comma
  const all = tokenize(desc);
  const q = qTokens.filter(t => !STOP.has(t));
  const need = q.length || 1;
  let pOverlap = 0, aOverlap = 0;
  for (const t of q) { if (has(primary, t)) pOverlap++; if (has(all, t)) aOverlap++; }
  let score = (pOverlap / need) * 100 + (aOverlap / need) * 15;   // primary match dominates
  if (pOverlap && primary.length) score += (pOverlap / primary.length) * 20;  // reward when the food IS
  //   the primary name ("Apples, raw") over one where it is only part of it ("Rose-apples", "egg white")
  if (d.includes("raw")) score += 8;                       // prefer the plain/raw form for a base food
  score -= Math.min(all.length, 20) * 0.5;                 // gently prefer shorter, less-qualified names
  const letters = desc.replace(/[^a-zA-Z]/g, "");          // ALL-CAPS = branded/restaurant SR entry
  if (letters && [...letters].filter(c => c >= "A" && c <= "Z").length / letters.length > 0.6) score -= 40;
  return { score, reason: null };
}

export default {
  async fetch(req, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "content-type": "application/json",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    // POST = Gemini vision fallback: identify the food in an image when the on-device system is unsure.
    // Body: { image: "data:image/jpeg;base64,..." }  ->  { food: "grilled_salmon" | null }
    if (req.method === "POST") return geminiIdentify(req, env, cors);

    const url = new URL(req.url);
    const q = (url.searchParams.get("q") || "").trim();
    const debug = url.searchParams.get("debug") === "1";
    if (!q) return json(null, cors);
    if (!env.USDA_KEY) return json(null, cors);            // not configured -> app falls back to "—"

    // Edge cache: key on normalized query (+debug) so repeated foods are instant and stay under limits.
    const cache = caches.default;
    const cacheKey = new Request("https://usda-proxy/v" + CACHE_VER + "/" + (debug ? "d/" : "") + encodeURIComponent(q.toLowerCase()), req);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    try {
      const api = "https://api.nal.usda.gov/fdc/v1/foods/search?api_key=" + env.USDA_KEY +
        "&pageSize=10&dataType=" + encodeURIComponent("Foundation,SR Legacy") +
        "&query=" + encodeURIComponent(q);
      const r = await fetch(api, { cf: { cacheTtl: CACHE_TTL, cacheEverything: true } });
      if (!r.ok) return json(null, cors);

      const foods = ((await r.json()).foods) || [];
      const qTokens = tokenize(q);
      const ranked = [];
      for (const food of foods) {
        const macros = {};
        for (const n of food.foodNutrients || []) {
          const k = NUTRIENT[n.nutrientId];
          if (k && macros[k] == null && typeof n.value === "number") macros[k] = n.value;
        }
        const { score, reason } = scoreCandidate(food.description || "", qTokens);
        const kept = score != null && macros.kcal != null;
        ranked.push({ desc: food.description || "", score, kept,
          reject: reason || (macros.kcal == null ? "no energy value" : null), macros });
      }
      ranked.sort((a, b) => (b.kept - a.kept) || ((b.score ?? -1) - (a.score ?? -1)));

      const best = ranked.find(c => c.kept);
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
      const payload = (debug && out)
        ? { ...out, _candidates: ranked.map(({ desc, score, kept, reject }) =>
            ({ desc, score: score == null ? null : +score.toFixed(1), kept, reject })) }
        : out;

      const resp = json(payload, { ...cors, "Cache-Control": "public, max-age=" + CACHE_TTL });
      if (out) ctx.waitUntil(cache.put(cacheKey, resp.clone()));   // only cache real hits
      return resp;
    } catch (e) {
      return json(null, cors);
    }
  },
};

const json = (obj, headers) => new Response(JSON.stringify(obj), { headers });

// Gemini vision fallback — mirrors the desktop demo's gemini_identify():
// "Identify the single main food. Reply with only its common English name, no punctuation."
// Returns { food: "<snake_case name>" } or { food: null }. Key is a Worker SECRET (env.GEMINI_KEY).
const GEMINI_MODEL = "gemini-flash-latest";
async function geminiIdentify(req, env, cors) {
  if (!env.GEMINI_KEY) return json({ food: null, error: "no key" }, cors);
  // Abuse cap: the Worker URL is in a public repo, so anyone could POST oversized images to burn the
  // Gemini quota. The real ROI JPEG is ~15-50 KB; reject anything far larger BEFORE parsing the body.
  if (+(req.headers.get("content-length") || 0) > 400_000) return json({ food: null, error: "too large" }, cors);
  let dataUrl;
  try { dataUrl = (await req.json()).image || ""; } catch (e) { return json({ food: null }, cors); }
  const m = /^data:(image\/\w+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return json({ food: null }, cors);
  if (m[2].length > 300_000) return json({ food: null, error: "too large" }, cors);  // ~225 KB of base64: generous headroom over a real ROI, still bounds cost per request
  try {
    const api = "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL +
      ":generateContent?key=" + env.GEMINI_KEY;
    const body = { contents: [{ parts: [
      { text: "Identify the single main food. Reply with only its common English name, no punctuation." },
      { inline_data: { mime_type: m[1], data: m[2] } } ] }] };
    const r = await fetch(api, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body) });
    if (!r.ok) return json({ food: null, error: "gemini " + r.status }, cors);
    const txt = (((await r.json()).candidates || [])[0]?.content?.parts || [])[0]?.text || "";
    const food = txt.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, "_");
    return json({ food: food || null, raw: txt.trim() }, cors);
  } catch (e) {
    return json({ food: null, error: String(e) }, cors);
  }
}
