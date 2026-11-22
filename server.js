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

const COLLECTIONS = ["members", "meetings", "actions", "drives", "partners"];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

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

const newId = (prefix) => prefix + "_" + crypto.randomBytes(5).toString("hex");
const nowIso = () => new Date().toISOString();

// Champs autorisés par collection : tout le reste est ignoré.
const FIELDS = {
  members: ["name", "fullName", "role", "focus", "city", "bloodGroup", "phone", "external", "active", "color"],
  meetings: ["title", "date", "time", "duration", "place", "status", "guests", "summary", "score", "scoreLabel",
    "scoreComment", "indicators", "chapters", "decisions", "risks", "questions", "speaking", "kelmaUrl", "stats", "notes"],
  actions: ["title", "description", "assignee", "deadline", "deadlineNote", "status", "priority", "meetingId",
    "timestamp", "tags"],
  drives: ["title", "date", "place", "partnerId", "owner", "status", "target", "candidates", "collected", "notes"],
  partners: ["name", "type", "status", "owner", "contact", "notes", "url"],
};
const STATUS = {
  actions: ["todo", "doing", "done"],
  drives: ["idea", "contact", "planned", "done", "cancelled"],
  partners: ["lead", "contact", "active", "paused"],
  meetings: ["planned", "done"],
};

function clean(collection, input) {
  const out = {};
  for (const f of FIELDS[collection]) if (input[f] !== undefined) out[f] = input[f];
  if (out.status !== undefined && STATUS[collection] && !STATUS[collection].includes(out.status)) {
    throw httpError(400, "Statut inconnu : " + out.status);
  }
  if (out.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(out.deadline)) throw httpError(400, "Échéance au format AAAA-MM-JJ");
  if (out.date && !/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw httpError(400, "Date au format AAAA-MM-JJ");
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && v.length > 5000) throw httpError(400, "Champ trop long : " + k);
  }
  return out;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
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
      if (size > 1_000_000) {
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

  const [collection, id, sub] = parts;
  if (!COLLECTIONS.includes(collection)) throw httpError(404, "Ressource inconnue");
  const list = db[collection];

  if (req.method === "GET") {
    if (!id) return send(res, 200, list);
    const item = list.find((x) => x.id === id);
    return item ? send(res, 200, item) : send(res, 404, { error: "Introuvable" });
  }

  if (!canEdit(req)) throw httpError(401, "Code d'équipe requis pour modifier");
  const body = await readBody(req);

  // Commentaires sur une action : POST /api/actions/:id/comments
  if (collection === "actions" && sub === "comments" && req.method === "POST") {
    const item = list.find((x) => x.id === id);
    if (!item) throw httpError(404, "Action introuvable");
    const text = String(body.text || "").trim();
    if (!text) throw httpError(400, "Commentaire vide");
    if (text.length > 2000) throw httpError(400, "Commentaire trop long");
    const comment = { id: newId("c"), author: String(body.author || "Équipe").slice(0, 60), text, at: nowIso() };
    item.comments = [...(item.comments || []), comment];
    item.updatedAt = nowIso();
    saveDb();
    return send(res, 201, item);
  }

  if (req.method === "POST" && !id) {
    const item = { id: newId(collection.slice(0, 3)), ...clean(collection, body), createdAt: nowIso(), updatedAt: nowIso() };
    if (collection === "actions") {
      item.status = item.status || "todo";
      item.history = [{ at: nowIso(), text: "Action créée" }];
      item.comments = [];
    }
    list.push(item);
    saveDb();
    return send(res, 201, item);
  }

  const idx = list.findIndex((x) => x.id === id);
  if (idx === -1) throw httpError(404, "Introuvable");

  if (req.method === "PUT" || req.method === "PATCH") {
    const before = list[idx];
    const patch = clean(collection, body);
    const after = { ...before, ...patch, updatedAt: nowIso() };
    if (collection === "actions") after.history = [...(before.history || []), ...describeChanges(before, patch)];
    list[idx] = after;
    saveDb();
    return send(res, 200, after);
  }

  if (req.method === "DELETE") {
    list.splice(idx, 1);
    saveDb();
    return send(res, 200, { ok: true });
  }

  throw httpError(405, "Méthode non autorisée");
}

const STATUS_LABEL = { todo: "À faire", doing: "En cours", done: "Terminée" };
function describeChanges(before, patch) {
  const at = nowIso();
  const out = [];
  if (patch.status && patch.status !== before.status) out.push({ at, text: "Statut : " + STATUS_LABEL[patch.status] });
  if (patch.assignee !== undefined && patch.assignee !== before.assignee) {
    const m = db.members.find((x) => x.id === patch.assignee);
    out.push({ at, text: m ? "Attribuée à " + m.name : "Responsable retiré" });
  }
  if (patch.deadline !== undefined && patch.deadline !== before.deadline) {
    out.push({ at, text: patch.deadline ? "Échéance fixée au " + patch.deadline : "Échéance retirée" });
  }
  return out;
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
