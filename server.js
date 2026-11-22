// Tunisian Lifesavers — serveur sans dépendance (Node 20+).
// Sert le site statique de /public et une petite API JSON stockée dans data/db.json.
// Lecture publique ; écriture protégée par un code d'équipe (variable EDIT_CODE).

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = process.env.DATA_FILE || path.join(ROOT, "data", "db.json");
const SEED_FILE = path.join(ROOT, "data", "seed.json");
const PORT = Number(process.env.PORT || 8098);
const EDIT_CODE = process.env.EDIT_CODE || "";

const core = require("./public/core.js");
const { COLLECTIONS, httpError } = core;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(path.dirname(DATA_FILE), "uploads");
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
};
const IMAGE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

// ------------------------------------------------------------------ stockage
function loadDb() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.copyFileSync(SEED_FILE, DATA_FILE);
  }
  const db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  for (const c of COLLECTIONS) db[c] = db[c] || [];
  return db;
}
let db = loadDb();

function saveDb() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ------------------------------------------------------------------ HTTP
function send(res, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...headers,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 5_000_000) {
        reject(httpError(413, "Requête trop volumineuse"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(httpError(400, "JSON invalide"));
      }
    });
    req.on("error", reject);
  });
}

function canEdit(req) {
  if (!EDIT_CODE) return true; // mode local : pas de code configuré
  const given = String(req.headers["x-edit-code"] || "");
  const a = Buffer.from(given);
  const b = Buffer.from(EDIT_CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleApi(req, res, url) {
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);

  if (req.method === "GET" && parts[0] === "data") {
    return send(res, 200, { ...db, editProtected: Boolean(EDIT_CODE) });
  }
  if (req.method === "POST" && parts[0] === "auth") {
    return canEdit(req) ? send(res, 200, { ok: true }) : send(res, 401, { error: "Code incorrect" });
  }
  if (req.method === "GET" && parts[0] === "health") return send(res, 200, { ok: true });

  if (req.method === "GET") {
    const [collection, id] = parts;
    if (!COLLECTIONS.includes(collection)) throw httpError(404, "Ressource inconnue");
    if (!id) return send(res, 200, db[collection]);
    const item = db[collection].find((x) => x.id === id);
    return item ? send(res, 200, item) : send(res, 404, { error: "Introuvable" });
  }

  if (!canEdit(req)) throw httpError(401, "Code d'équipe requis pour modifier");
  const body = await readBody(req);
  const by = decodeURIComponent(String(req.headers["x-edit-by"] || "")).slice(0, 60);

  // Téléversement d'image : POST /api/uploads { data: "data:image/jpeg;base64,...", name }
  if (parts[0] === "uploads" && req.method === "POST") {
    const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.data || ""));
    if (!m) throw httpError(400, "Image invalide");
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 3_000_000) throw httpError(413, "Image trop lourde (3 Mo max)");
    const id = core.randomId("img");
    const file = id + "." + IMAGE_EXT[m[1]];
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    return send(res, 201, { url: "/uploads/" + file });
  }

  const out = core.applyOp(db, { method: req.method, parts, body, by });
  saveDb();
  return send(res, out.status, out.body);
}

function serveUpload(res, url) {
  const name = path.basename(url.pathname);
  if (!/^img_[a-z0-9]+\.(jpg|png|webp|gif)$/.test(name)) return send(res, 404, { error: "Introuvable" });
  fs.readFile(path.join(UPLOAD_DIR, name), (e, buf) => {
    if (e) return send(res, 404, { error: "Introuvable" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(name)], "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
    res.end(buf);
  });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: "Interdit" });
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(PUBLIC_DIR, "index.html");
    const ext = path.extname(target);
    fs.readFile(target, (e, buf) => {
      if (e) return send(res, 500, { error: "Erreur de lecture" });
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(buf);
    });
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
      if (url.pathname.startsWith("/uploads/")) return serveUpload(res, url);
      if (url.pathname === "/config.js") {
        // Avec SUPABASE_URL/SUPABASE_KEY, le serveur partage les données du site en ligne ; sinon il utilise data/db.json.
        const cfg = SUPABASE_URL ? { supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY } : {};
        res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-cache" });
        return res.end("window.TL_CONFIG = " + JSON.stringify(cfg) + ";");
      }
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Méthode non autorisée" });
      return serveStatic(req, res, url);
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : "Erreur serveur" });
      if (!e.status) console.error(e);
    }
  });
}

if (require.main === module) {
  createServer().listen(PORT, () => {
    console.log(`Tunisian Lifesavers sur http://localhost:${PORT}` + (EDIT_CODE ? " (édition protégée)" : " (édition libre : définir EDIT_CODE en production)"));
  });
}

module.exports = { createServer, reload: () => { db = loadDb(); } };
