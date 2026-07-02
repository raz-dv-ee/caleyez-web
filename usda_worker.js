// Cloudflare Worker: USDA FoodData Central proxy.
// The API key lives in a Worker SECRET (env.USDA_KEY) so it NEVER appears in the public web-app repo.
// The app calls this Worker; the Worker calls USDA and returns per-100g {kcal, pro, carb, fat}.
//
// Deploy (free) — pick ONE path:
//   Dashboard: https://dash.cloudflare.com -> Workers & Pages -> Create Worker -> paste this -> Deploy
//   CLI:       npm i -g wrangler && wrangler deploy   (uses wrangler.toml next to this file)
// Then add the secret:
//   Dashboard: Worker -> Settings -> Variables & Secrets -> add Secret  name USDA_KEY  value <your key>
//   CLI:       wrangler secret put USDA_KEY
//   (free key: https://fdc.nal.usda.gov/api-key-signup.html)
// Finally set the URL in index.html + engineering.html:  const USDA_PROXY="https://xxxx.workers.dev";
// (Optional) tighten ALLOW_ORIGIN to your Pages domain to limit who can use the proxy.

const ALLOW_ORIGIN = "*";                       // e.g. "https://raz-dv-ee.github.io"
const CACHE_TTL    = 60 * 60 * 24 * 30;         // 30 days — nutrition facts are effectively static
// USDA nutrient IDs -> our keys. 1008/2047/2048 = energy(kcal), 1003 protein, 1005 carbs, 1004 fat.
const NUTRIENT = { 1008: "kcal", 2047: "kcal", 2048: "kcal", 1003: "pro", 1005: "carb", 1004: "fat" };

export default {
  async fetch(req, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "content-type": "application/json",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });

    const q = (new URL(req.url).searchParams.get("q") || "").trim();
    if (!q) return json(null, cors);
    if (!env.USDA_KEY) return json(null, cors);      // not configured -> app falls back to "—"

    // Edge cache: key on the normalized query so repeated foods are instant and stay under USDA limits.
    const cache = caches.default;
    const cacheKey = new Request(new URL("https://usda-proxy/" + encodeURIComponent(q.toLowerCase())), req);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    try {
      const url = "https://api.nal.usda.gov/fdc/v1/foods/search?api_key=" + env.USDA_KEY +
        "&pageSize=5&dataType=" + encodeURIComponent("Foundation,SR Legacy") +
        "&query=" + encodeURIComponent(q);
      const r = await fetch(url, { cf: { cacheTtl: CACHE_TTL, cacheEverything: true } });
      if (!r.ok) return json(null, cors);

      const foods = ((await r.json()).foods) || [];
      // Prefer the first result that actually carries an energy value.
      let out = null;
      for (const food of foods) {
        const o = {};
        for (const n of food.foodNutrients || []) {
          const k = NUTRIENT[n.nutrientId];
          if (k && o[k] == null && typeof n.value === "number") o[k] = n.value;
        }
        if (o.kcal != null) { out = o; break; }
      }

      const resp = json(out, { ...cors, "Cache-Control": "public, max-age=" + CACHE_TTL });
      if (out) ctx.waitUntil(cache.put(cacheKey, resp.clone()));   // only cache real hits
      return resp;
    } catch (e) {
      return json(null, cors);
    }
  },
};

const json = (obj, headers) => new Response(JSON.stringify(obj), { headers });
