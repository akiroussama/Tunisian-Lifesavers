/* Logique métier partagée entre le serveur Node et le navigateur (mode Supabase). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.TLCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const COLLECTIONS = ["members", "meetings", "actions", "drives", "partners"];
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
  const STATUS_LABEL = { todo: "À faire", doing: "En cours", done: "Terminée" };
  const MAX_IMAGES = 12;

  function httpError(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
  }

  function randomId(prefix) {
    let s = "";
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = new Uint8Array(10);
    (globalThis.crypto || require("node:crypto").webcrypto).getRandomValues(bytes);
    for (const b of bytes) s += chars[b % chars.length];
    return prefix + "_" + s;
  }

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

  function describeChanges(db, before, patch, at, by) {
    const out = [];
    const who = by ? " par " + by : "";
    if (patch.status && patch.status !== before.status) out.push({ at, text: "Statut : " + STATUS_LABEL[patch.status] + who });
    if (patch.assignee !== undefined && patch.assignee !== (before.assignee || "")) {
      const m = db.members.find((x) => x.id === patch.assignee);
      out.push({ at, text: (m ? "Attribuée à " + m.name : "Responsable retiré") + who });
    }
    if (patch.deadline !== undefined && patch.deadline !== (before.deadline || "")) {
      out.push({ at, text: (patch.deadline ? "Échéance fixée au " + patch.deadline : "Échéance retirée") + who });
    }
    if (patch.title !== undefined && patch.title !== before.title) out.push({ at, text: "Titre modifié" + who });
    return out;
  }

  /**
   * Applique une opération d'API à la base en mémoire.
   * op = { method, parts: ["actions", "id", "comments"], body, by }
   * Retourne { status, body, writes: [{collection, item}], deletes: [{collection, id}] }.
   */
  function applyOp(db, op) {
    const { method, parts, body = {}, by = "" } = op;
    const [collection, id, sub, subId] = parts;
    if (!COLLECTIONS.includes(collection)) throw httpError(404, "Ressource inconnue");
    const list = db[collection];
    const now = new Date().toISOString();
    const writes = [], deletes = [];
    const done = (status, out) => ({ status, body: out, writes, deletes });

    if (collection === "actions" && id && sub) {
      const item = list.find((x) => x.id === id);
      if (!item) throw httpError(404, "Action introuvable");
      const author = String(body.author || by || "Équipe").slice(0, 60);
      if (sub === "comments" && method === "POST") {
        const text = String(body.text || "").trim();
        if (!text) throw httpError(400, "Commentaire vide");
        if (text.length > 2000) throw httpError(400, "Commentaire trop long");
        item.comments = [...(item.comments || []), { id: randomId("c"), author, text, at: now }];
      } else if (sub === "comments" && method === "DELETE" && subId) {
        item.comments = (item.comments || []).filter((c) => c.id !== subId);
      } else if (sub === "images" && method === "POST") {
        const url = String(body.url || "");
        if (!/^(\/uploads\/img_[a-z0-9]+\.(jpg|png|webp|gif)|supabase:img_[a-z0-9]+)$/.test(url)) throw httpError(400, "Image invalide");
        if ((item.images || []).length >= MAX_IMAGES) throw httpError(400, "Maximum " + MAX_IMAGES + " images par action");
        item.images = [...(item.images || []), { id: randomId("im"), url, name: String(body.name || "image").slice(0, 120), author, at: now }];
        item.history = [...(item.history || []), { at: now, text: "Image ajoutée par " + author }];
      } else if (sub === "images" && method === "DELETE" && subId) {
        item.images = (item.images || []).filter((im) => im.id !== subId);
      } else throw httpError(405, "Méthode non autorisée");
      item.updatedAt = now;
      writes.push({ collection, item });
      return done(201, item);
    }

    if (method === "POST" && !id) {
      const item = { id: randomId(collection.slice(0, 3)), ...clean(collection, body), createdAt: now, updatedAt: now };
      if (collection === "actions") {
        item.status = item.status || "todo";
        item.history = [{ at: now, text: "Action créée" + (by ? " par " + by : "") }];
        item.comments = [];
        item.images = [];
      }
      list.push(item);
      writes.push({ collection, item });
      return done(201, item);
    }

    const idx = list.findIndex((x) => x.id === id);
    if (idx === -1) throw httpError(404, "Introuvable");

    if (method === "PUT" || method === "PATCH") {
      const before = list[idx];
      const patch = clean(collection, body);
      const after = { ...before, ...patch, updatedAt: now };
      if (collection === "actions") after.history = [...(before.history || []), ...describeChanges(db, before, patch, now, by)];
      list[idx] = after;
      writes.push({ collection, item: after });
      return done(200, after);
    }

    if (method === "DELETE") {
      list.splice(idx, 1);
      deletes.push({ collection, id });
      return done(200, { ok: true });
    }
    throw httpError(405, "Méthode non autorisée");
  }

  return { COLLECTIONS, FIELDS, STATUS, STATUS_LABEL, clean, applyOp, httpError, randomId };
});
