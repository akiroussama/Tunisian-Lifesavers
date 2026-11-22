// Faux PostgREST minimal pour tester le mode Supabase du navigateur sans réseau.
// Reproduit tl_items, tl_images et les fonctions tl_check / tl_write / tl_add_image.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

function createMock({ code = "test", seedFile = path.join(__dirname, "..", "data", "seed.json") } = {}) {
  const items = new Map();
  const images = new Map();
  const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  for (const c of ["members", "meetings", "actions", "drives", "partners"]) {
    for (const it of seed[c]) items.set(c + "/" + it.id, { collection: c, id: it.id, data: it });
  }
  items.set("group/main", { collection: "group", id: "main", data: seed.group });

  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
  const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json", ...cors }); res.end(body === undefined ? "" : JSON.stringify(body)); };
  const eq = (url, k) => { const v = url.searchParams.get(k); return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null; };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return json(res, 204);
    if (req.headers.apikey !== "mock-key") return json(res, 401, { message: "bad key" });
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const p = url.pathname.replace("/rest/v1/", "");
      if (req.method === "GET" && p === "tl_items") {
        const c = eq(url, "collection"), id = eq(url, "id");
        return json(res, 200, [...items.values()].filter((r) => (!c || r.collection === c) && (!id || r.id === id)));
      }
      if (req.method === "GET" && p === "tl_images") {
        const im = images.get(eq(url, "id"));
        return json(res, 200, im ? [im] : []);
      }
      if (req.method === "POST" && p.startsWith("rpc/")) {
        const fn = p.slice(4);
        if (fn === "tl_check") return json(res, 200, body.code === code);
        if (body.code !== code) return json(res, 400, { code: "28000", message: "Code d'équipe incorrect" });
        if (fn === "tl_write") {
          for (const w of body.writes) items.set(w.collection + "/" + w.id, { collection: w.collection, id: w.id, data: w.data });
          for (const d of body.deletes) items.delete(d.collection + "/" + d.id);
          return json(res, 204);
        }
        if (fn === "tl_add_image") {
          images.set(body.img_id, { mime: body.mime, data: body.data });
          return json(res, 204);
        }
      }
      json(res, 404, { message: "not found" });
    });
  });
  return { server, items, images };
}

module.exports = { createMock };
if (require.main === module) createMock().server.listen(Number(process.env.PORT || 8300));
