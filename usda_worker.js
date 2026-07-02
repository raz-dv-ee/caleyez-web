// Cloudflare Worker: USDA proxy. The API key lives in a Worker SECRET (env.USDA_KEY),
// so it NEVER appears in the public web-app repo. The app calls this Worker; the Worker calls USDA.
//
// Deploy (free):
//   1. https://dash.cloudflare.com  ->  Workers & Pages  ->  Create Worker  ->  paste this  ->  Deploy
//   2. Worker -> Settings -> Variables -> add a SECRET:  name USDA_KEY,  value <your free USDA key>
//      (get a key at https://fdc.nal.usda.gov/api-key-signup.html)
//   3. Copy the Worker URL (https://xxxx.workers.dev) into index.html: const USDA_PROXY="https://xxxx.workers.dev";
//   (Optional) tighten ALLOW_ORIGIN to your Pages domain to limit who can use it.

const ALLOW_ORIGIN = "*";  // e.g. "https://raz-dv-ee.github.io"

export default {
  async fetch(req, env) {
    const cors = { "Access-Control-Allow-Origin": ALLOW_ORIGIN, "content-type": "application/json" };
    const q = new URL(req.url).searchParams.get("q") || "";
    if (!q) return new Response("null", { headers: cors });
    try {
      const r = await fetch("https://api.nal.usda.gov/fdc/v1/foods/search?api_key=" +
        env.USDA_KEY + "&pageSize=1&dataType=Foundation,SR%20Legacy&query=" + encodeURIComponent(q));
      const food = ((await r.json()).foods || [])[0];
      if (!food) return new Response("null", { headers: cors });
      const map = { 1008: "kcal", 2047: "kcal", 1003: "pro", 1005: "carb", 1004: "fat" };
      const o = {};
      for (const n of food.foodNutrients || []) {
        const k = map[n.nutrientId];
        if (k && o[k] == null) o[k] = n.value;
      }
      return new Response(JSON.stringify(o.kcal != null ? o : null), { headers: cors });
    } catch (e) {
      return new Response("null", { headers: cors });
    }
  }
};
