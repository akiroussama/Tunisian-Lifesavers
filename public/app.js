/* Tunisian Lifesavers — application monopage, sans dépendance. */
(() => {
  "use strict";

  // Stockage local tolérant aux navigateurs qui le bloquent.
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignoré */ } },
  };

  // ---------------------------------------------------------------- état
  const S = {
    data: null,
    code: store.get("tl_code") || "",
    view: store.get("tl_view") || "board",
    filters: { q: "", member: "", status: "", due: "" },
  };
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const main = $("#main");

  const canEdit = () => S.data && (!S.data.editProtected || Boolean(S.code));

  // ---------------------------------------------------------------- API
  // Deux back-ends possibles : Supabase (site en ligne, partagé) ou l'API du serveur Node (data/db.json).
  const CFG = window.TL_CONFIG || {};
  const SB = CFG.supabaseUrl && CFG.supabaseKey ? { url: CFG.supabaseUrl.replace(/\/$/, ""), key: CFG.supabaseKey } : null;
  const me = () => store.get("tl_me") || "";

  function authError(msg) {
    S.code = ""; store.set("tl_code", null); renderEditToggle();
    return new Error(msg || "Code d'équipe requis");
  }

  async function sb(path, opts = {}) {
    const res = await fetch(`${SB.url}/rest/v1/${path}`, {
      ...opts,
      headers: { apikey: SB.key, Authorization: "Bearer " + SB.key, "Content-Type": "application/json", ...(opts.headers || {}) },
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* réponse vide */ }
    if (!res.ok) {
      if (json && json.code === "28000") throw authError("Code d'équipe incorrect");
      throw new Error((json && json.message) || "Erreur " + res.status);
    }
    return json;
  }
  const rpc = (fn, args) => sb("rpc/" + fn, { method: "POST", body: JSON.stringify(args) });

  async function sbLoadAll() {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const page = await sb("tl_items?select=collection,id,data&order=collection,id", { headers: { Range: `${from}-${from + 999}` } });
      rows.push(...page);
      if (page.length < 1000) break;
    }
    const db = { members: [], meetings: [], actions: [], drives: [], partners: [] };
    for (const r of rows) {
      if (r.collection === "group") db.group = r.data;
      else if (db[r.collection]) db[r.collection].push({ ...r.data, id: r.id });
    }
    // Ordre stable : ordre de création
    for (const c of Object.keys(db)) if (Array.isArray(db[c])) db[c].sort((x, y) => String(x.createdAt || x.id).localeCompare(String(y.createdAt || y.id)));
    return db;
  }

  async function sbApi(method, path, body) {
    const parts = path.split("/").filter(Boolean);
    if (parts[0] === "uploads" && method === "POST") {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/.exec(body.data || "");
      if (!m) throw new Error("Image invalide");
      const id = TLCore.randomId("img");
      await rpc("tl_add_image", { code: S.code, img_id: id, mime: m[1], data: m[2], name: body.name || null });
      return { url: "supabase:" + id };
    }
    const [collection, id] = parts;
    const db = {};
    for (const c of TLCore.COLLECTIONS) db[c] = S.data[c].map((x) => ({ ...x }));
    if (id) {
      // Relire l'élément juste avant de le modifier, pour ne pas écraser le travail d'un autre membre.
      const fresh = await sb(`tl_items?select=id,data&collection=eq.${encodeURIComponent(collection)}&id=eq.${encodeURIComponent(id)}`);
      const list = db[collection] || [];
      const i = list.findIndex((x) => x.id === id);
      if (fresh && fresh[0]) { if (i === -1) list.push({ ...fresh[0].data, id }); else list[i] = { ...fresh[0].data, id }; }
      else if (i !== -1) list.splice(i, 1);
    }
    let out;
    try { out = TLCore.applyOp(db, { method, parts, body: body || {}, by: me() }); }
    catch (e) { throw new Error(e.message); }
    await rpc("tl_write", {
      code: S.code,
      writes: out.writes.map((w) => ({ collection: w.collection, id: w.item.id, data: w.item })),
      deletes: out.deletes,
    });
    return out.body;
  }

  async function api(method, path, body) {
    if (SB) return sbApi(method, path, body);
    const res = await fetch("/api/" + path, {
      method,
      headers: { "Content-Type": "application/json", "X-Edit-Code": S.code, "X-Edit-By": encodeURIComponent(me()) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401) throw authError(json.error);
      throw new Error(json.error || "Erreur " + res.status);
    }
    return json;
  }

  async function checkCode(code) {
    if (SB) return (await rpc("tl_check", { code })) === true;
    const res = await fetch("/api/auth", { method: "POST", headers: { "X-Edit-Code": code } });
    return res.ok;
  }

  async function load() {
    if (SB) { S.data = { ...(await sbLoadAll()), editProtected: true }; return; }
    try {
      S.data = await (await fetch("/api/data")).json();
      if (!S.data.actions) throw new Error("API indisponible");
    } catch (e) {
      // Hébergement statique sans base : données de départ en lecture seule.
      const res = await fetch("/seed.json");
      if (!res.ok) throw e;
      S.data = { ...(await res.json()), editProtected: true, staticMode: true };
    }
  }

  // Images : "/uploads/…" (serveur Node) ou "supabase:img_…" (table tl_images).
  const imgCache = new Map();
  async function imageSrc(url) {
    if (!url.startsWith("supabase:")) return url;
    if (imgCache.has(url)) return imgCache.get(url);
    const p = sb(`tl_images?select=mime,data&id=eq.${encodeURIComponent(url.slice(9))}`).then((r) => (r && r[0] ? `data:${r[0].mime};base64,${r[0].data}` : ""));
    imgCache.set(url, p);
    return p;
  }

  // Réduit l'image côté navigateur (1600 px max) avant l'envoi.
  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\//.test(file.type)) return reject(new Error("Ce fichier n'est pas une image"));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Lecture impossible"));
      reader.onload = () => {
        if (file.type === "image/gif" && file.size < 2_000_000) return resolve(reader.result);
        const img = new Image();
        img.onerror = () => reject(new Error("Image illisible"));
        img.onload = () => {
          const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL("image/jpeg", 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function save(collection, item, patch) {
    try {
      let out;
      if (item && item.id) {
        out = await api("PATCH", `${collection}/${item.id}`, patch);
        const list = S.data[collection];
        list[list.findIndex((x) => x.id === item.id)] = out;
      } else {
        out = await api("POST", collection, patch);
        S.data[collection].push(out);
      }
      return out;
    } catch (e) {
      toast(e.message);
      throw e;
    }
  }
  async function remove(collection, id) {
    await api("DELETE", `${collection}/${id}`);
    S.data[collection] = S.data[collection].filter((x) => x.id !== id);
  }

  // ---------------------------------------------------------------- utilitaires
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const MONTHS_LONG = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
  const DAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const parseDate = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  const fmtDate = (s, long) => { if (!s) return ""; const d = parseDate(s); return long ? `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
  const fmtShort = (s) => { const d = parseDate(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
  const daysUntil = (s) => Math.round((parseDate(s) - parseDate(todayStr())) / 86400000);
  const fmtDateTime = (iso) => { const d = new Date(iso); return `${d.getDate()} ${MONTHS[d.getMonth()]} · ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const member = (id) => S.data.members.find((m) => m.id === id);
  const meeting = (id) => S.data.meetings.find((m) => m.id === id);
  const partner = (id) => S.data.partners.find((p) => p.id === id);
  const initials = (name) => name.replace(/^Dr\s+/i, "").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const avatar = (m, cls = "") => m
    ? `<span class="avatar ${cls}" style="background:${esc(m.color || "#5E5A66")}" title="${esc(m.name)}">${esc(initials(m.name))}</span>`
    : `<span class="avatar empty ${cls}" title="Non attribuée">?</span>`;
  const person = (id) => { const m = member(id); return `<span class="person">${avatar(m)}${m ? esc(m.name) : '<span class="muted">À attribuer</span>'}</span>`; };

  const ICON = {
    cal: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3"/></svg>',
    plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
    lock: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
    unlock: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/></svg>',
    wa: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.3a6.6 6.6 0 0 0-5.7 10l-.9 3.3 3.4-.9A6.6 6.6 0 1 0 8 1.3Zm0 12a5.4 5.4 0 0 1-2.8-.8l-.2-.1-2 .5.5-1.9-.1-.2A5.4 5.4 0 1 1 8 13.3Zm3-4c-.2-.1-1-.5-1.1-.5-.2-.1-.3-.1-.4.1l-.5.6c-.1.1-.2.1-.4 0a4.4 4.4 0 0 1-2.2-1.9c-.2-.3.2-.3.5-1 .1-.1 0-.2 0-.3l-.5-1.2c-.1-.3-.3-.3-.4-.3h-.3a.7.7 0 0 0-.5.2c-.2.2-.7.7-.7 1.6s.7 1.9.8 2c.1.1 1.4 2.2 3.4 3 1.3.5 1.8.6 2.4.5.4-.1 1.1-.5 1.3-.9.2-.4.2-.8.1-.9l-.5-.1Z"/></svg>',
    ext: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5v3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h3"/></svg>',
    dl: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M2.5 13.5h11"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>',
  };

  const STATUS = { todo: "À faire", doing: "En cours", done: "Terminée" };
  const PRIO = { high: ["Haute", "red"], medium: ["Normale", "blue"], low: ["Basse", ""] };
  const DRIVE_STATUS = { idea: ["Piste", ""], contact: ["Contact pris", "blue"], planned: ["Planifiée", "amber"], done: ["Réalisée", "green"], cancelled: ["Annulée", ""] };
  const PARTNER_STATUS = { lead: ["Piste", ""], contact: ["En discussion", "blue"], active: ["Partenaire actif", "green"], paused: ["En pause", "amber"] };

  function deadlineChip(a) {
    if (a.status === "done") return '<span class="chip green">Terminée</span>';
    if (!a.deadline) return a.deadlineNote ? `<span class="chip">${esc(a.deadlineNote)}</span>` : '<span class="chip">Sans échéance</span>';
    const d = daysUntil(a.deadline);
    if (d < 0) return `<span class="chip red">${ICON.cal}En retard · ${fmtShort(a.deadline)}</span>`;
    if (d === 0) return `<span class="chip red">${ICON.cal}Aujourd'hui</span>`;
    if (d <= 3) return `<span class="chip amber">${ICON.cal}${d === 1 ? "Demain" : "Dans " + d + " jours"}</span>`;
    return `<span class="chip">${ICON.cal}${fmtShort(a.deadline)}</span>`;
  }
  const isOverdue = (a) => a.status !== "done" && a.deadline && daysUntil(a.deadline) < 0;
  const isSoon = (a) => a.status !== "done" && a.deadline && daysUntil(a.deadline) >= 0 && daysUntil(a.deadline) <= 7;
  const prioChip = (p) => p && PRIO[p] && p !== "medium" ? `<span class="chip ${PRIO[p][1]}">${PRIO[p][0]}</span>` : "";
  const statusChip = (s) => `<span class="chip ${s === "done" ? "green" : s === "doing" ? "amber" : ""}"><span class="dot"></span>${STATUS[s]}</span>`;
  const sortActions = (list) => [...list].sort((a, b) => {
    const da = a.deadline || "9999", dbb = b.deadline || "9999";
    if (da !== dbb) return da < dbb ? -1 : 1;
    const pr = { high: 0, medium: 1, low: 2 };
    return (pr[a.priority] ?? 1) - (pr[b.priority] ?? 1);
  });

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove("show"), 2600);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("Copié dans le presse-papiers"); }
    catch {
      const ta = document.createElement("textarea"); ta.value = text; document.body.append(ta); ta.select();
      try { document.execCommand("copy"); toast("Copié dans le presse-papiers"); } catch { toast("Copie impossible"); }
      ta.remove();
    }
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------------------------------------------------------- partage
  function actionText(a) {
    const m = member(a.assignee);
    return `🩸 Tunisian Lifesavers · Action\n${a.title}\nResponsable : ${m ? m.name : "à attribuer"}\nÉchéance : ${a.deadline ? fmtDate(a.deadline, true) : (a.deadlineNote || "à fixer")}\nStatut : ${STATUS[a.status]}\n${location.origin}/#/actions/${a.id}`;
  }
  function recapText() {
    const open = sortActions(S.data.actions.filter((a) => a.status !== "done"));
    const lines = ["🩸 *Tunisian Lifesavers* · actions en cours", `Point du ${fmtDate(todayStr(), true)}`, ""];
    const byMember = {};
    for (const a of open) (byMember[a.assignee || ""] ||= []).push(a);
    for (const m of [...S.data.members, { id: "", name: "À attribuer" }]) {
      const list = byMember[m.id];
      if (!list) continue;
      lines.push(`*${m.name}*`);
      for (const a of list) {
        const due = a.deadline ? ` (${isOverdue(a) ? "⚠️ en retard, " : ""}${fmtShort(a.deadline)})` : "";
        lines.push(`• ${a.title}${due}`);
      }
      lines.push("");
    }
    lines.push(`Détails : ${location.origin}/#/actions`);
    return lines.join("\n");
  }
  const waLink = (text) => "https://wa.me/?text=" + encodeURIComponent(text);

  function icsFor(a) {
    const d = a.deadline.replace(/-/g, "");
    const next = parseDate(a.deadline); next.setDate(next.getDate() + 1);
    const d2 = `${next.getFullYear()}${String(next.getMonth() + 1).padStart(2, "0")}${String(next.getDate()).padStart(2, "0")}`;
    const m = member(a.assignee);
    const escI = (s) => String(s || "").replace(/[\\;,]/g, (c) => "\\" + c).replace(/\n/g, "\\n");
    return [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Tunisian Lifesavers//FR", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT", `UID:${a.id}@tunisian-lifesavers`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
      `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${d2}`,
      `SUMMARY:${escI("Échéance · " + a.title)}`,
      `DESCRIPTION:${escI((a.description || "") + "\nResponsable : " + (m ? m.name : "à attribuer") + "\n" + location.origin + "/#/actions/" + a.id)}`,
      "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", "DESCRIPTION:Rappel Tunisian Lifesavers", "END:VALARM",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
  }

  function csvActions() {
    const rows = [["Action", "Responsable", "Statut", "Priorité", "Échéance", "Réunion", "Description"]];
    for (const a of sortActions(S.data.actions)) {
      const m = member(a.assignee), mt = meeting(a.meetingId);
      rows.push([a.title, m ? m.name : "", STATUS[a.status], PRIO[a.priority]?.[0] || "", a.deadline || a.deadlineNote || "", mt ? fmtDate(mt.date) : "", a.description || ""]);
    }
    return "﻿" + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  }

  // ---------------------------------------------------------------- routeur
  function parseRoute() {
    const [, page = "", id = ""] = (location.hash || "#/").split("/");
    return { page: page || "home", id: decodeURIComponent(id) };
  }

  function render() {
    if (!S.data) return;
    const { page, id } = parseRoute();
    const nav = { home: "home", actions: "actions", reunions: "reunions", equipe: "equipe", collectes: "collectes", partenaires: "partenaires", donner: "donner" };
    $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === nav[page]));
    $("#nav").classList.remove("open");
    $("#menuBtn").setAttribute("aria-expanded", "false");

    const pages = { home: pageHome, actions: pageActions, reunions: id ? pageMeeting : pageMeetings, equipe: id ? pageMember : pageTeam, collectes: pageDrives, partenaires: pagePartners, donner: pageDonate };
    const fn = pages[page] || pageHome;
    const keepPage = page === "actions" && main.dataset.page === "actions";
    if (keepPage) refreshActionsView();
    else {
      main.innerHTML = fn(id);
      main.dataset.page = page + (page !== "actions" && id ? "/" + id : "");
      bindPage(page, id);
      if (!render.first) window.scrollTo(0, 0);
    }
    render.first = false;
    if (page === "actions" && id) openActionDrawer(id); else closeDrawer(true);
    document.title = titleFor(page, id) + " · Tunisian Lifesavers";
  }
  render.first = true;

  function titleFor(page, id) {
    if (page === "actions") return id && S.data.actions.find((a) => a.id === id)?.title || "Actions";
    if (page === "reunions") return id ? meeting(id)?.title || "Réunion" : "Réunions";
    if (page === "equipe") return id ? member(id)?.name || "Équipe" : "Équipe";
    return { collectes: "Collectes", partenaires: "Partenaires", donner: "Donner son sang" }[page] || "Accueil";
  }

  const rerender = () => { main.dataset.page = ""; render(); };

  // ---------------------------------------------------------------- page : accueil
  function pageHome() {
    const acts = S.data.actions;
    const open = acts.filter((a) => a.status !== "done");
    const done = acts.length - open.length;
    const overdue = open.filter(isOverdue);
    const urgent = sortActions(open.filter((a) => isOverdue(a) || isSoon(a))).slice(0, 5);
    const unassigned = open.filter((a) => !a.assignee);
    const upcoming = S.data.meetings.filter((m) => m.status === "planned").sort((a, b) => a.date.localeCompare(b.date))[0];
    const last = S.data.meetings.filter((m) => m.status === "done").sort((a, b) => b.date.localeCompare(a.date))[0];
    const drives = S.data.drives.filter((d) => d.status !== "cancelled");
    const partnersActive = S.data.partners.filter((p) => p.status === "active").length;
    const g = S.data.group || {};
    const pct = acts.length ? Math.round((done / acts.length) * 100) : 0;
    const members = S.data.members.filter((m) => !m.external);

    return `
    <section class="hero">
      <div class="hero-inner">
        <div>
          <div class="eyebrow">Collectif bénévole · Tunisie</div>
          <h1>Chaque don compte.<br>Ensemble, comblons le déficit.</h1>
          <p class="lead">${esc(g.mission || "")}</p>
          <div class="row">
            <a class="btn primary" href="#/donner">Je veux donner mon sang</a>
            <a class="btn light" href="#/actions">Suivre nos actions</a>
          </div>
        </div>
        <div class="hero-panel">
          <h3>Le défi national</h3>
          <div class="hero-stat"><b>240 000</b><span>poches collectées par an</span></div>
          <div class="bar"><i style="width:${Math.round(240 / 295 * 100)}%"></i></div>
          <div class="legend"><span>Aujourd'hui</span><span>Autosuffisance : 290 à 300 000</span></div>
          <p class="small" style="color:#FBE3E7;margin-top:16px">Il manque <b style="color:#fff">50 à 60 000 poches</b> chaque année. Un tiers seulement des dons sont volontaires. Source : CNTS, novembre 2026.</p>
        </div>
      </div>
    </section>

    <div class="wrap page">
      <div class="grid g4">
        <div class="card kpi"><b>${members.length}</b><span>membres engagés</span></div>
        <div class="card kpi"><b>${open.length}</b><span>actions en cours · ${pct} % terminées</span></div>
        <div class="card kpi ${overdue.length ? "alert" : ""}"><b>${overdue.length}</b><span>action${overdue.length > 1 ? "s" : ""} en retard</span></div>
        <div class="card kpi"><b>${drives.length}</b><span>collectes en préparation · ${partnersActive} partenaire${partnersActive > 1 ? "s" : ""} actif${partnersActive > 1 ? "s" : ""}</span></div>
      </div>

      <div class="split section">
        <div>
          <div class="section-title"><h2>À traiter en priorité</h2><a href="#/actions">Toutes les actions →</a></div>
          ${urgent.length ? `<div class="stack">${urgent.map(taskCard).join("")}</div>` : `<div class="empty">Aucune échéance dans les 7 prochains jours.</div>`}
          ${unassigned.length ? `<div class="card flat" style="margin-top:12px;background:var(--red-soft);border-color:var(--red-line)">
            <div class="row between"><div><b>${unassigned.length} action${unassigned.length > 1 ? "s" : ""} sans responsable</b><p class="small muted">Qui peut s'en charger ?</p></div>
            <a class="btn sm" href="#/actions/${unassigned[0].id}">Attribuer</a></div></div>` : ""}

          ${last ? `<div class="section">
            <div class="section-title"><h2>Dernière réunion</h2><a href="#/reunions">Historique →</a></div>
            ${meetingCard(last)}
            <div class="card flat" style="margin-top:12px">
              <h3 style="margin-bottom:6px">Décisions prises</h3>
              <ol class="num-list">${(last.decisions || []).slice(0, 3).map((d) => `<li><b>${esc(d[0])}</b><div class="small muted">${esc(d[1])}</div></li>`).join("")}</ol>
              <a class="small" href="#/reunions/${last.id}">Voir les ${(last.decisions || []).length} décisions et le compte rendu →</a>
            </div>
          </div>` : ""}
        </div>

        <div class="stack">
          ${upcoming ? `<div class="card">
            <div class="eyebrow">Prochaine réunion</div>
            <h3 style="font-size:18px">${esc(upcoming.title)}</h3>
            <p class="muted small" style="margin-top:6px">${fmtDate(upcoming.date, true)}${upcoming.time ? " · " + esc(upcoming.time) : ""} · ${esc(upcoming.place || "")}</p>
            ${upcoming.notes ? `<p class="small" style="margin-top:10px">${esc(upcoming.notes)}</p>` : ""}
            <a class="btn sm" style="margin-top:14px" href="#/reunions/${upcoming.id}">Voir l'ordre du jour</a>
          </div>` : ""}

          <div class="card">
            <div class="eyebrow">Feuille de route</div>
            <ul class="timeline" style="margin-top:10px">
              <li class="done"><span class="when">21 nov.</span><b>Réunion avec le CNTS</b><span class="small muted">5 décisions, 12 actions</span></li>
              <li><span class="when">22 nov.</span><b>Compte rendu partagé</b><span class="small muted">Envoyé au groupe par Oussama</span></li>
              <li><span class="when">29 nov.</span><b>Logo finalisé</b><span class="small muted">Puis nouvelle réunion</span></li>
              <li><span class="when">Ensuite</span><b>QR code et collectes</b><span class="small muted">Flyer diffusé par le CNTS, collectes en entreprise, à l'OMS et via Ahna Maak</span></li>
            </ul>
          </div>

          <div class="card">
            <div class="row between"><h3>Récap pour le groupe</h3></div>
            <p class="small muted" style="margin-top:6px">Un message prêt à coller dans le groupe WhatsApp, avec les actions de chacun.</p>
            <div class="row" style="margin-top:12px">
              <a class="btn sm primary" target="_blank" rel="noopener" href="${waLink(recapText())}">${ICON.wa}Partager sur WhatsApp</a>
              <button class="btn sm" data-copy-recap>${ICON.copy}Copier</button>
            </div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title"><h2>L'équipe</h2><a href="#/equipe">Voir l'équipe →</a></div>
        <div class="row">${S.data.members.map((m) => `<a href="#/equipe/${m.id}" class="person" style="background:var(--white);border:1px solid var(--line);padding:5px 12px 5px 5px;border-radius:99px;color:inherit">${avatar(m)}${esc(m.name)}</a>`).join("")}</div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- page : actions
  function taskCard(a) {
    const m = member(a.assignee);
    return `<a class="task ${a.status === "done" ? "done" : ""}" href="#/actions/${a.id}" draggable="${canEdit()}" data-id="${a.id}">
      <div class="task-title">${esc(a.title)}</div>
      <div class="task-meta">
        <div class="chips">${deadlineChip(a)}${prioChip(a.priority)}${(a.comments || []).length ? `<span class="chip" title="Commentaires">💬 ${a.comments.length}</span>` : ""}${(a.images || []).length ? `<span class="chip" title="Images">🖼 ${a.images.length}</span>` : ""}</div>
        ${avatar(m)}
      </div>
    </a>`;
  }

  function filteredActions() {
    const f = S.filters;
    const q = f.q.trim().toLowerCase();
    return S.data.actions.filter((a) => {
      if (q && !(a.title + " " + (a.description || "") + " " + (a.tags || []).join(" ")).toLowerCase().includes(q)) return false;
      if (f.member === "none" ? a.assignee : f.member && a.assignee !== f.member) return false;
      if (f.status && a.status !== f.status) return false;
      if (f.due === "overdue" && !isOverdue(a)) return false;
      if (f.due === "week" && !(isOverdue(a) || isSoon(a))) return false;
      return true;
    });
  }

  function pageActions() {
    const f = S.filters;
    return `<div class="wrap page">
      <div class="page-head">
        <div><div class="eyebrow">Plan d'actions</div><h1>Actions</h1>
        <p class="lead">Qui fait quoi, et pour quand. Ouvrez une action pour l'attribuer, fixer une échéance, commenter ou l'ajouter à votre agenda.</p></div>
        <div class="row">
          <button class="btn sm" data-export-csv>${ICON.dl}Exporter</button>
          <a class="btn sm" target="_blank" rel="noopener" href="${waLink(recapText())}">${ICON.wa}Récap WhatsApp</a>
          ${canEdit() ? `<button class="btn primary" data-new-action>${ICON.plus}Nouvelle action</button>` : ""}
        </div>
      </div>
      <div class="toolbar">
        <input class="input search" type="search" placeholder="Rechercher une action…" value="${esc(f.q)}" data-filter="q" aria-label="Rechercher">
        <select class="input" data-filter="member" aria-label="Responsable">
          <option value="">Tous les membres</option>
          <option value="none" ${f.member === "none" ? "selected" : ""}>Sans responsable</option>
          ${S.data.members.map((m) => `<option value="${m.id}" ${f.member === m.id ? "selected" : ""}>${esc(m.name)}</option>`).join("")}
        </select>
        <select class="input" data-filter="due" aria-label="Échéance">
          <option value="">Toutes les échéances</option>
          <option value="overdue" ${f.due === "overdue" ? "selected" : ""}>En retard</option>
          <option value="week" ${f.due === "week" ? "selected" : ""}>Cette semaine</option>
        </select>
        <div class="seg" role="tablist" aria-label="Affichage">
          <button class="${S.view === "board" ? "on" : ""}" data-view="board">Tableau</button>
          <button class="${S.view === "list" ? "on" : ""}" data-view="list">Liste</button>
        </div>
      </div>
      <div id="actionsView">${actionsView()}</div>
    </div>`;
  }

  function actionsView() {
    const list = sortActions(filteredActions());
    if (S.view === "list") {
      if (!list.length) return `<div class="empty">Aucune action ne correspond à ces filtres.</div>`;
      return `<div class="table-wrap"><table class="table"><thead><tr><th>Action</th><th>Responsable</th><th>Échéance</th><th>Statut</th></tr></thead><tbody>
        ${list.map((a) => `<tr data-open="${a.id}"><td><b style="font-weight:600">${esc(a.title)}</b></td><td>${person(a.assignee)}</td><td>${deadlineChip(a)}</td><td>${statusChip(a.status)}</td></tr>`).join("")}
      </tbody></table></div>`;
    }
    return `<div class="board">${Object.entries(STATUS).map(([k, label]) => {
      const items = list.filter((a) => a.status === k);
      return `<div class="column" data-status="${k}">
        <div class="column-head"><span>${label}</span><span class="count">${items.length}</span></div>
        <div class="tasks">${items.map(taskCard).join("") || `<p class="small muted" style="padding:8px 6px">Rien ici.</p>`}</div>
      </div>`;
    }).join("")}</div>`;
  }

  function refreshActionsView() {
    const el = $("#actionsView");
    if (el) { el.innerHTML = actionsView(); bindBoard(); }
  }

  function bindBoard() {
    $$("[data-open]").forEach((tr) => tr.addEventListener("click", () => { location.hash = "#/actions/" + tr.dataset.open; }));
    if (!canEdit()) return;
    $$(".task[draggable=true]").forEach((t) => {
      t.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", t.dataset.id); t.classList.add("dragging"); });
      t.addEventListener("dragend", () => t.classList.remove("dragging"));
    });
    $$(".column").forEach((col) => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("drop"); });
      col.addEventListener("dragleave", () => col.classList.remove("drop"));
      col.addEventListener("drop", async (e) => {
        e.preventDefault(); col.classList.remove("drop");
        const a = S.data.actions.find((x) => x.id === e.dataTransfer.getData("text/plain"));
        if (!a || a.status === col.dataset.status) return;
        await save("actions", a, { status: col.dataset.status });
        refreshActionsView();
        toast("Statut mis à jour : " + STATUS[col.dataset.status]);
      });
    });
  }

  // ---------------------------------------------------------------- tiroir : détail d'une action
  function openActionDrawer(id) {
    const a = S.data.actions.find((x) => x.id === id);
    const drawer = $("#drawer");
    if (!a) { drawer.innerHTML = `<div class="drawer-body"><p>Action introuvable.</p></div>`; }
    else drawer.innerHTML = actionDetail(a);
    drawer.hidden = false;
    $("#drawerBackdrop").hidden = false;
    document.body.style.overflow = "hidden";
    if (a) bindActionDetail(a);
    const t = $("textarea[data-field=title]", drawer);
    if (t) { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; t.addEventListener("input", () => { t.style.height = "auto"; t.style.height = t.scrollHeight + "px"; }); }
    drawer.setAttribute("tabindex", "-1");
    setTimeout(() => drawer.focus({ preventScroll: true }), 30);
  }

  function closeDrawer(silent) {
    const drawer = $("#drawer");
    if (drawer.hidden) return;
    drawer.hidden = true;
    $("#drawerBackdrop").hidden = true;
    document.body.style.overflow = "";
    if (!silent && parseRoute().page === "actions" && parseRoute().id) {
      history.replaceState(null, "", "#/actions");
      refreshActionsView();
    }
  }

  function actionDetail(a) {
    const ed = canEdit();
    const mt = meeting(a.meetingId);
    const opts = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${Array.isArray(v) ? v[0] : v}</option>`).join("");
    const memberOpts = `<option value="">À attribuer</option>` + S.data.members.map((m) => `<option value="${m.id}" ${m.id === a.assignee ? "selected" : ""}>${esc(m.name)}${m.external ? " (externe)" : ""}</option>`).join("");
    return `
      <div class="drawer-head">
        <div class="row">${statusChip(a.status)}${deadlineChip(a)}</div>
        <button class="close-x" data-close aria-label="Fermer">×</button>
      </div>
      <div class="drawer-body">
        ${ed ? `<textarea class="input" data-field="title" id="drawerTitle" rows="1" style="font-family:var(--head);font-size:20px;font-weight:800;border-color:transparent;padding:4px 6px;margin:-4px -6px;min-height:0;resize:none">${esc(a.title)}</textarea>`
             : `<h2 id="drawerTitle">${esc(a.title)}</h2>`}
        <dl class="props">
          <dt>Responsable</dt>
          <dd>${ed ? `<select class="input" data-field="assignee">${memberOpts}</select>` : person(a.assignee)}</dd>
          <dt>Échéance</dt>
          <dd>${ed ? `<div class="row" style="flex-wrap:nowrap"><input class="input" type="date" data-field="deadline" value="${esc(a.deadline || "")}">${a.deadline ? `<button class="btn ghost sm" data-clear-deadline title="Retirer l'échéance">×</button>` : ""}</div>` : (a.deadline ? fmtDate(a.deadline, true) : esc(a.deadlineNote || "Non fixée"))}
            ${ed && a.deadlineNote && !a.deadline ? `<div class="tiny muted" style="margin-top:4px">Note : ${esc(a.deadlineNote)}</div>` : ""}</dd>
          <dt>Statut</dt>
          <dd>${ed ? `<select class="input" data-field="status">${opts(STATUS, a.status)}</select>` : statusChip(a.status)}</dd>
          <dt>Priorité</dt>
          <dd>${ed ? `<select class="input" data-field="priority">${opts(PRIO, a.priority || "medium")}</select>` : (PRIO[a.priority]?.[0] || "Normale")}</dd>
          ${mt ? `<dt>Origine</dt><dd><a href="#/reunions/${mt.id}">${esc(mt.title)}</a><div class="tiny muted">${fmtDate(mt.date)}${a.timestamp ? ` · à <span class="ts">${esc(a.timestamp)}</span> de l'enregistrement` : ""}</div></dd>` : ""}
          ${(a.tags || []).length ? `<dt>Thèmes</dt><dd class="row">${a.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</dd>` : ""}
        </dl>

        <div class="block">
          <h4>Description</h4>
          ${ed ? `<textarea class="input" data-field="description" placeholder="Contexte, étapes, liens utiles…">${esc(a.description || "")}</textarea>`
               : `<p>${esc(a.description || "Pas de description.")}</p>`}
        </div>

        <div class="block">
          <h4>Partager et planifier</h4>
          <div class="row">
            <a class="btn sm" target="_blank" rel="noopener" href="${waLink(actionText(a))}">${ICON.wa}Rappel WhatsApp</a>
            ${a.deadline ? `<button class="btn sm" data-ics>${ICON.cal}Ajouter à l'agenda</button>` : ""}
            <button class="btn sm" data-copy-link>${ICON.copy}Copier le lien</button>
            ${mt && mt.kelmaUrl ? `<a class="btn sm" target="_blank" rel="noopener" href="${esc(mt.kelmaUrl)}">${ICON.ext}Écouter le passage</a>` : ""}
          </div>
        </div>

        <div class="block" data-drop>
          <div class="row between" style="margin-bottom:12px"><h4 style="margin:0">Images${(a.images || []).length ? ` (${a.images.length})` : ""}</h4>
            ${ed ? `<label class="btn sm">${ICON.plus}Ajouter<input type="file" accept="image/*" multiple data-upload hidden></label>` : ""}</div>
          ${(a.images || []).length ? `<div class="gallery">${a.images.map((im) => `<figure class="thumb" data-img="${esc(im.id)}">
              <img alt="${esc(im.name)}" data-src="${esc(im.url)}">
              ${ed ? `<button class="thumb-del" data-del-img="${esc(im.id)}" aria-label="Supprimer l'image" title="Supprimer">×</button>` : ""}
              <figcaption>${esc(im.author || "")} · ${fmtDateTime(im.at)}</figcaption></figure>`).join("")}</div>`
            : `<p class="small muted">${ed ? "Ajoutez une photo, une capture ou un visuel (vous pouvez aussi coller une image avec Ctrl+V)." : "Aucune image."}</p>`}
          <p class="tiny muted" data-upload-status hidden></p>
        </div>

        <div class="block">
          <h4>Commentaires</h4>
          ${(a.comments || []).length ? (a.comments || []).map((c) => `<div class="comment"><div class="row between"><span class="who">${esc(c.author)}</span><span class="row" style="gap:6px"><span class="tiny muted">${fmtDateTime(c.at)}</span>${ed ? `<button class="btn ghost sm" style="padding:0 6px" data-del-comment="${esc(c.id)}" title="Supprimer le commentaire" aria-label="Supprimer le commentaire">×</button>` : ""}</span></div><p class="small" style="margin-top:4px;white-space:pre-wrap">${esc(c.text)}</p></div>`).join("") : `<p class="small muted">Aucun commentaire pour l'instant.</p>`}
          ${ed ? `<form data-comment style="margin-top:12px" class="stack">
            <div class="row" style="flex-wrap:nowrap">
              <select class="input" name="author" style="width:170px;flex:none" aria-label="Auteur">${S.data.members.map((m) => `<option ${store.get("tl_me") === m.name ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
              <input class="input" name="text" placeholder="Ajouter un commentaire…" required maxlength="2000">
            </div>
            <div class="row" style="justify-content:flex-end"><button class="btn sm primary">Publier</button></div>
          </form>` : ""}
        </div>

        ${(a.history || []).length ? `<div class="block"><h4>Historique</h4><ul class="history">${[...a.history].reverse().map((h) => `<li><span>${esc(h.text.replace(/(\d{4}-\d{2}-\d{2})/, (x) => fmtDate(x)))}</span><span>${fmtDateTime(h.at)}</span></li>`).join("")}</ul></div>` : ""}

        ${ed ? `<div class="block row between"><span class="tiny muted">Modifications enregistrées automatiquement.</span><button class="btn sm danger" data-delete>Supprimer l'action</button></div>` : `<div class="block"><p class="small muted row" style="gap:6px">${ICON.lock}${S.data.staticMode ? "Version de démonstration : lecture seule." : "Passez en mode édition pour modifier cette action."}</p></div>`}
      </div>`;
  }

  function bindActionDetail(a) {
    const d = $("#drawer");
    $("[data-close]", d).addEventListener("click", () => closeDrawer());
    $$("[data-field]", d).forEach((el) => {
      const ev = el.tagName === "SELECT" || el.type === "date" ? "change" : "blur";
      el.addEventListener(ev, async () => {
        const field = el.dataset.field;
        const value = el.value.trim();
        if ((a[field] || "") === value) return;
        if (field === "title" && !value) { el.value = a.title; return; }
        const updated = await save("actions", a, { [field]: value });
        Object.assign(a, updated);
        if (["status", "assignee", "deadline", "priority"].includes(field)) openActionDrawer(a.id);
        refreshActionsView();
        toast("Enregistré");
      });
    });
    $("[data-clear-deadline]", d)?.addEventListener("click", async () => {
      Object.assign(a, await save("actions", a, { deadline: "" }));
      openActionDrawer(a.id); refreshActionsView();
    });
    $("[data-ics]", d)?.addEventListener("click", () => download(`echeance-${a.id}.ics`, icsFor(a), "text/calendar;charset=utf-8"));
    $("[data-copy-link]", d).addEventListener("click", () => copyText(`${location.origin}/#/actions/${a.id}`));
    $("[data-delete]", d)?.addEventListener("click", async () => {
      if (!(await confirmModal("Supprimer cette action ?", `« ${a.title} » sera définitivement supprimée.`))) return;
      await remove("actions", a.id);
      closeDrawer();
      toast("Action supprimée");
    });
    // Images : affichage paresseux, ajout (fichier, glisser-déposer, coller), suppression, agrandissement.
    $$("img[data-src]", d).forEach(async (img) => { img.src = await imageSrc(img.dataset.src); });
    $$(".thumb img", d).forEach((img) => img.addEventListener("click", () => {
      if (!img.src) return;
      openModal(`<div style="position:relative"><img src="${img.src}" alt="${esc(img.alt)}" style="width:100%;max-height:80vh;object-fit:contain;background:#111;border-radius:18px"><button class="close-x" data-x style="position:absolute;top:12px;right:12px" aria-label="Fermer">×</button></div>`);
      $("#modal [data-x]").onclick = closeModal;
    }));
    const upload = async (files) => {
      files = [...files].filter((f) => /^image\//.test(f.type));
      if (!files.length || !canEdit()) return;
      const status = $("[data-upload-status]", d);
      let ok = 0;
      for (let i = 0; i < files.length; i++) {
        if (status) { status.hidden = false; status.textContent = `Envoi de l'image ${i + 1} sur ${files.length}…`; }
        try {
          const data = await resizeImage(files[i]);
          const { url } = await api("POST", "uploads", { data, name: files[i].name });
          const updated = await api("POST", `actions/${a.id}/images`, { url, name: files[i].name });
          const list = S.data.actions; list[list.findIndex((x) => x.id === a.id)] = updated;
          ok++;
        } catch (err) { toast(err.message); }
      }
      openActionDrawer(a.id); refreshActionsView();
      if (ok) toast(ok > 1 ? ok + " images ajoutées" : "Image ajoutée");
    };
    $("[data-upload]", d)?.addEventListener("change", (e) => upload(e.target.files));
    const zone = $("[data-drop]", d);
    if (canEdit() && zone) {
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dropping"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("dropping"));
      zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("dropping"); upload(e.dataTransfer.files); });
      d.onpaste = (e) => { const f = [...((e.clipboardData && e.clipboardData.files) || [])]; if (f.length) { e.preventDefault(); upload(f); } };
    } else d.onpaste = null;
    $$("[data-del-img]", d).forEach((b) => b.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!(await confirmModal("Supprimer cette image ?", "Elle sera retirée de l'action."))) return;
      try {
        const updated = await api("DELETE", `actions/${a.id}/images/${b.dataset.delImg}`);
        const list = S.data.actions; list[list.findIndex((x) => x.id === a.id)] = updated;
        openActionDrawer(a.id); refreshActionsView();
      } catch (err) { toast(err.message); }
    }));
    $$("[data-del-comment]", d).forEach((b) => b.addEventListener("click", async () => {
      if (!(await confirmModal("Supprimer ce commentaire ?", "Cette action est définitive."))) return;
      try {
        const updated = await api("DELETE", `actions/${a.id}/comments/${b.dataset.delComment}`);
        const list = S.data.actions; list[list.findIndex((x) => x.id === a.id)] = updated;
        openActionDrawer(a.id);
      } catch (err) { toast(err.message); }
    }));

    $("[data-comment]", d)?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      store.set("tl_me", fd.get("author"));
      try {
        const updated = await api("POST", `actions/${a.id}/comments`, { author: fd.get("author"), text: fd.get("text") });
        const list = S.data.actions; list[list.findIndex((x) => x.id === a.id)] = updated;
        openActionDrawer(a.id);
      } catch (err) { toast(err.message); }
    });
  }

  // ---------------------------------------------------------------- pages : réunions
  function meetingCard(m) {
    const d = parseDate(m.date);
    const planned = m.status === "planned";
    const n = S.data.actions.filter((a) => a.meetingId === m.id).length;
    const sc = m.score;
    return `<a class="card meeting-card" href="#/reunions/${m.id}">
      <div class="datebox ${planned ? "planned" : ""}"><b>${d.getDate()}</b><span>${MONTHS[d.getMonth()]}</span></div>
      <div>
        <div class="row" style="margin-bottom:4px">${planned ? '<span class="chip amber">À venir</span>' : '<span class="chip green">Compte rendu disponible</span>'}${m.duration ? `<span class="chip">${esc(m.duration)}</span>` : ""}</div>
        <h3 style="font-size:17px">${esc(m.title)}</h3>
        <p class="small muted" style="margin-top:4px">${fmtDate(m.date, true)}${m.time ? " · " + esc(m.time) : ""}${m.place ? " · " + esc(m.place) : ""}${n ? ` · ${n} actions` : ""}</p>
      </div>
      ${sc ? `<div class="score" style="background:conic-gradient(var(--red) ${sc * 3.6}deg, var(--line) 0)"><span style="background:#fff;width:52px;height:52px;border-radius:50%;display:grid;place-items:center">${sc}</span></div>` : "<span></span>"}
    </a>`;
  }

  function pageMeetings() {
    const ms = [...S.data.meetings].sort((a, b) => b.date.localeCompare(a.date));
    const planned = ms.filter((m) => m.status === "planned").reverse();
    const done = ms.filter((m) => m.status !== "planned");
    return `<div class="wrap page">
      <div class="page-head">
        <div><div class="eyebrow">Mémoire du groupe</div><h1>Réunions</h1>
        <p class="lead">Chaque réunion, ses décisions et les actions qui en découlent. Les comptes rendus sont produits avec Shirokko Kelma à partir de l'enregistrement.</p></div>
        ${canEdit() ? `<button class="btn primary" data-new-meeting>${ICON.plus}Planifier une réunion</button>` : ""}
      </div>
      ${planned.length ? `<div class="section-title"><h2>À venir</h2></div><div class="stack">${planned.map(meetingCard).join("")}</div>` : ""}
      <div class="section-title ${planned.length ? "section" : ""}"><h2>Historique</h2></div>
      ${done.length ? `<div class="stack">${done.map(meetingCard).join("")}</div>` : `<div class="empty">Aucune réunion passée.</div>`}
    </div>`;
  }

  function pageMeeting(id) {
    const m = meeting(id);
    if (!m) return `<div class="wrap page"><div class="empty">Réunion introuvable. <a href="#/reunions">Retour</a></div></div>`;
    const acts = sortActions(S.data.actions.filter((a) => a.meetingId === m.id));
    const total = (m.speaking || []).reduce((s, x) => s + x[1], 0);
    const maxS = Math.max(1, ...(m.speaking || []).map((x) => x[1]));
    const guests = (m.guests || []).map(member).filter(Boolean);
    return `<div class="wrap page">
      <a href="#/reunions" class="small">← Toutes les réunions</a>
      <div class="page-head" style="margin-top:12px">
        <div>
          <div class="eyebrow">${m.status === "planned" ? "Réunion à venir" : "Compte rendu"}</div>
          <h1>${esc(m.title)}</h1>
          <p class="lead">${fmtDate(m.date, true)}${m.time ? " · " + esc(m.time) : ""}${m.duration ? " · " + esc(m.duration) : ""}${m.place ? " · " + esc(m.place) : ""}${guests.length ? " · avec " + guests.map((g) => esc(g.name)).join(", ") : ""}</p>
        </div>
        <div class="row">
          ${m.kelmaUrl ? `<a class="btn" target="_blank" rel="noopener" href="${esc(m.kelmaUrl)}">${ICON.ext}Compte rendu complet sur Kelma</a>` : ""}
          ${canEdit() ? `<button class="btn" data-edit-meeting="${m.id}">Modifier</button>` : ""}
        </div>
      </div>

      <div class="split">
        <div class="stack">
          ${m.summary ? `<div class="card"><h3 style="margin-bottom:8px">${m.status === "planned" ? "Objectif" : "L'essentiel"}</h3><p>${esc(m.summary)}</p>${m.notes ? `<p class="small muted" style="margin-top:10px">${esc(m.notes)}</p>` : ""}</div>` : ""}

          ${(m.decisions || []).length ? `<div class="card"><h3>Décisions (${m.decisions.length})</h3>
            <ol class="num-list" style="margin-top:6px">${m.decisions.map((d) => `<li><div class="row between" style="flex-wrap:nowrap;align-items:flex-start"><b>${esc(d[0])}</b><span class="ts">${esc(d[2] || "")}</span></div><div class="small muted">${esc(d[1])}</div></li>`).join("")}</ol></div>` : ""}

          ${acts.length ? `<div class="card"><div class="row between"><h3>Actions issues de la réunion (${acts.length})</h3><a class="small" href="#/actions">Plan d'actions →</a></div>
            <div class="table-wrap" style="margin-top:12px"><table class="table"><tbody>${acts.map((a) => `<tr onclick="location.hash='#/actions/${a.id}'"><td><b style="font-weight:600">${esc(a.title)}</b></td><td>${person(a.assignee)}</td><td>${deadlineChip(a)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}

          ${(m.chapters || []).length ? `<div class="card"><h3>Déroulé</h3><div style="margin-top:6px">${m.chapters.map((c) => `<div class="chapter"><span class="ts">${esc(c[0])}</span><div><b>${esc(c[1])}</b><p class="small muted">${esc(c[2])}</p></div></div>`).join("")}</div></div>` : ""}

          ${(m.questions || []).length ? `<div class="card"><h3>Questions restées ouvertes</h3><div class="stack" style="margin-top:12px">${m.questions.map((q, i) => `<div class="card flat" style="background:var(--paper)"><b>${esc(q[0])}</b><p class="tiny" style="color:var(--red);font-weight:600;margin-top:4px">${esc(q[1])}</p><p class="small muted" style="margin-top:4px">${esc(q[2])}</p>${canEdit() ? `<button class="btn sm" style="margin-top:10px" data-q-to-action="${i}">${ICON.plus}En faire une action</button>` : ""}</div>`).join("")}</div></div>` : ""}
        </div>

        <div class="stack">
          ${m.score ? `<div class="card">
            <div class="row between"><div><div class="eyebrow">Note de la réunion</div><b style="font-family:var(--head);font-size:34px">${m.score}</b><span class="muted">/100</span></div><span class="chip green">${esc(m.scoreLabel || "")}</span></div>
            <div class="stack" style="margin-top:12px">${(m.indicators || []).map(([l, v]) => `<div><div class="row between small"><span>${esc(l)}</span><b>${v}</b></div><div class="meter"><i style="width:${v}%"></i></div></div>`).join("")}</div>
            ${m.scoreComment ? `<p class="small muted" style="margin-top:14px">${esc(m.scoreComment)}</p>` : ""}
          </div>` : ""}

          ${(m.speaking || []).length ? `<div class="card"><h3>Temps de parole</h3><div style="margin-top:10px">${m.speaking.map(([id2, s]) => { const p = member(id2); return `<div class="speak"><span class="person">${avatar(p)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p ? p.name.replace(/^Dr\s+/, "Dr ").split(" ").slice(0, 2).join(" ") : id2)}</span></span><div class="meter"><i style="width:${(s / maxS) * 100}%"></i></div><span class="tiny muted" style="text-align:right">${Math.round((s / total) * 100)} %</span></div>`; }).join("")}</div>
            ${m.stats ? `<p class="tiny muted" style="margin-top:10px">${m.stats.sentences} phrases transcrites · ${esc(m.stats.languages)}</p>` : ""}</div>` : ""}

          ${(m.risks || []).length ? `<div class="card"><h3>Risques identifiés</h3><div class="stack" style="margin-top:12px">${m.risks.map((r) => `<div class="card flat risk ${r[2] === "high" ? "high" : ""}" style="padding:12px 14px"><div class="row between"><b class="small">${esc(r[0])}</b><span class="chip ${r[2] === "high" ? "red" : "amber"}">${r[2] === "high" ? "Ralentit" : "À surveiller"}</span></div><p class="small muted" style="margin-top:4px">${esc(r[1])}</p></div>`).join("")}</div></div>` : ""}
        </div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- pages : équipe
  function memberStats(m) {
    const mine = S.data.actions.filter((a) => a.assignee === m.id);
    return { open: mine.filter((a) => a.status !== "done").length, done: mine.filter((a) => a.status === "done").length, late: mine.filter(isOverdue).length };
  }

  function pageTeam() {
    const core = S.data.members.filter((m) => !m.external);
    const ext = S.data.members.filter((m) => m.external);
    const card = (m) => { const s = memberStats(m); return `<a class="card member" href="#/equipe/${m.id}">
      <div class="top">${avatar(m, "lg")}<div><h3>${esc(m.name)}</h3><div class="small" style="color:var(--red);font-weight:600">${esc(m.role || "Membre")}</div></div></div>
      <p class="focus">${esc(m.focus || "")}</p>
      <div class="stats"><span class="chip">${s.open} en cours</span>${s.done ? `<span class="chip green">${s.done} terminée${s.done > 1 ? "s" : ""}</span>` : ""}${s.late ? `<span class="chip red">${s.late} en retard</span>` : ""}</div>
    </a>`; };
    return `<div class="wrap page">
      <div class="page-head">
        <div><div class="eyebrow">Qui sommes-nous</div><h1>L'équipe</h1>
        <p class="lead">Des bénévoles aux profils variés, unis par une même conviction : personne en Tunisie ne devrait attendre une poche de sang.</p></div>
        ${canEdit() ? `<button class="btn primary" data-new-member>${ICON.plus}Ajouter un membre</button>` : ""}
      </div>
      <div class="grid g3">${core.map(card).join("")}</div>
      ${ext.length ? `<div class="section"><div class="section-title"><h2>Référents et partenaires</h2></div><div class="grid g3">${ext.map(card).join("")}</div></div>` : ""}
    </div>`;
  }

  function pageMember(id) {
    const m = member(id);
    if (!m) return `<div class="wrap page"><div class="empty">Membre introuvable. <a href="#/equipe">Retour</a></div></div>`;
    const mine = sortActions(S.data.actions.filter((a) => a.assignee === m.id));
    const s = memberStats(m);
    const drives = S.data.drives.filter((d) => d.owner === m.id);
    const partners = S.data.partners.filter((p) => p.owner === m.id);
    const spoke = S.data.meetings.filter((mt) => (mt.speaking || []).some((x) => x[0] === m.id));
    return `<div class="wrap page">
      <a href="#/equipe" class="small">← Toute l'équipe</a>
      <div class="card" style="margin-top:12px;display:flex;gap:20px;align-items:center;flex-wrap:wrap">
        ${avatar(m, "xl")}
        <div style="flex:1;min-width:200px">
          <h1 style="font-size:28px">${esc(m.name)}</h1>
          <div style="color:var(--red);font-weight:600">${esc(m.role || "Membre")}${m.external ? " · externe" : ""}</div>
          ${m.focus ? `<p class="muted" style="margin-top:6px">${esc(m.focus)}</p>` : ""}
          <div class="row" style="margin-top:10px">${m.city ? `<span class="chip">${esc(m.city)}</span>` : ""}${m.bloodGroup ? `<span class="chip red">Groupe ${esc(m.bloodGroup)}</span>` : ""}<span class="chip">${s.open} action${s.open > 1 ? "s" : ""} en cours</span>${s.late ? `<span class="chip red">${s.late} en retard</span>` : ""}${spoke.length ? `<span class="chip">${spoke.length} réunion${spoke.length > 1 ? "s" : ""}</span>` : ""}</div>
        </div>
        ${canEdit() ? `<button class="btn" data-edit-member="${m.id}">Modifier</button>` : ""}
      </div>
      <div class="split section">
        <div>
          <div class="section-title"><h2>Ses actions</h2></div>
          ${mine.length ? `<div class="stack">${mine.map(taskCard).join("")}</div>` : `<div class="empty">Aucune action attribuée.</div>`}
        </div>
        <div class="stack">
          ${drives.length ? `<div class="card"><h3>Collectes suivies</h3><div class="stack" style="margin-top:10px">${drives.map((d) => `<div class="row between"><span>${esc(d.title)}</span><span class="chip ${DRIVE_STATUS[d.status][1]}">${DRIVE_STATUS[d.status][0]}</span></div>`).join("")}</div></div>` : ""}
          ${partners.length ? `<div class="card"><h3>Partenaires suivis</h3><div class="stack" style="margin-top:10px">${partners.map((p) => `<div class="row between"><span>${esc(p.name)}</span><span class="chip ${PARTNER_STATUS[p.status][1]}">${PARTNER_STATUS[p.status][0]}</span></div>`).join("")}</div></div>` : ""}
        </div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- page : collectes
  function pageDrives() {
    const ds = S.data.drives;
    const target = ds.filter((d) => d.status !== "cancelled").reduce((s, d) => s + (Number(d.target) || 0), 0);
    const collected = ds.reduce((s, d) => s + (Number(d.collected) || 0), 0);
    const cols = ["idea", "contact", "planned", "done"];
    return `<div class="wrap page">
      <div class="page-head">
        <div><div class="eyebrow">Sur le terrain</div><h1>Collectes</h1>
        <p class="lead">De la piste à la collecte réalisée. Le CNTS ne se déplace qu'à partir d'environ 50 candidats, soit au moins 40 poches par sortie.</p></div>
        ${canEdit() ? `<button class="btn primary" data-new-drive>${ICON.plus}Nouvelle collecte</button>` : ""}
      </div>
      <div class="grid g4" style="margin-bottom:24px">
        <div class="card kpi"><b>${ds.filter((d) => !["done", "cancelled"].includes(d.status)).length}</b><span>collectes en préparation</span></div>
        <div class="card kpi"><b>${ds.filter((d) => d.status === "done").length}</b><span>collectes réalisées</span></div>
        <div class="card kpi"><b>${target}</b><span>poches visées</span></div>
        <div class="card kpi"><b>${collected}</b><span>poches collectées</span></div>
      </div>
      <div class="pipeline">${cols.map((c) => {
        const items = ds.filter((d) => d.status === c);
        return `<div class="column"><div class="column-head"><span>${DRIVE_STATUS[c][0]}</span><span class="count">${items.length}</span></div>
          <div class="tasks">${items.map((d) => {
            const p = partner(d.partnerId), pct = d.target ? Math.min(100, Math.round(((d.collected || 0) / d.target) * 100)) : 0;
            return `<div class="task drive" ${canEdit() ? `data-edit-drive="${d.id}"` : ""} style="${canEdit() ? "" : "cursor:default"}">
              <div class="task-title">${esc(d.title)}</div>
              <p class="tiny muted" style="margin-top:4px">${[d.date ? fmtDate(d.date) : "", d.place, p ? p.name : ""].filter(Boolean).map(esc).join(" · ")}</p>
              ${d.notes ? `<p class="small" style="margin-top:8px">${esc(d.notes)}</p>` : ""}
              <div class="progress"><div class="row between tiny muted"><span>${d.collected || 0} / ${d.target || "?"} poches</span>${d.candidates ? `<span>${d.candidates} candidats</span>` : ""}</div><div class="meter" style="margin-top:4px"><i style="width:${pct}%"></i></div></div>
              <div class="task-meta"><span></span>${avatar(member(d.owner))}</div>
            </div>`;
          }).join("") || `<p class="small muted" style="padding:8px 6px">Rien ici.</p>`}</div></div>`;
      }).join("")}</div>
    </div>`;
  }

  // ---------------------------------------------------------------- page : partenaires
  function pagePartners() {
    const ps = [...S.data.partners].sort((a, b) => ["active", "contact", "lead", "paused"].indexOf(a.status) - ["active", "contact", "lead", "paused"].indexOf(b.status));
    return `<div class="wrap page">
      <div class="page-head">
        <div><div class="eyebrow">Réseau</div><h1>Partenaires</h1>
        <p class="lead">Institutions, entreprises et associations avec qui nous organisons les collectes et la sensibilisation.</p></div>
        ${canEdit() ? `<button class="btn primary" data-new-partner>${ICON.plus}Ajouter un partenaire</button>` : ""}
      </div>
      <div class="table-wrap"><table class="table">
        <thead><tr><th>Partenaire</th><th>Type</th><th>Statut</th><th>Suivi par</th><th>Notes</th></tr></thead>
        <tbody>${ps.map((p) => `<tr ${canEdit() ? `data-edit-partner="${p.id}"` : 'style="cursor:default"'}>
          <td><b style="font-weight:600">${esc(p.name)}</b>${p.contact ? `<div class="tiny muted">${esc(p.contact)}</div>` : ""}</td>
          <td class="small">${esc(p.type || "")}</td>
          <td><span class="chip ${PARTNER_STATUS[p.status][1]}">${PARTNER_STATUS[p.status][0]}</span></td>
          <td>${p.owner ? person(p.owner) : '<span class="muted small">—</span>'}</td>
          <td class="small muted" style="max-width:340px">${esc(p.notes || "")}${p.url ? ` <a href="${esc(p.url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">site</a>` : ""}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>`;
  }

  // ---------------------------------------------------------------- page : donner
  function pageDonate() {
    const myths = [
      ["Le sang donné est revendu.", "Le don est bénévole et anonyme. Les poches collectées vont aux centres de transfusion et aux hôpitaux publics qui soignent les patients."],
      ["Donner son sang est dangereux.", "Tout le matériel est stérile et à usage unique. Un médecin vérifie votre état de santé avant chaque don."],
      ["Mes proches donneront si un jour j'en ai besoin.", "Deux tiers des dons sont encore familiaux, faits dans l'urgence. Les donneurs réguliers et volontaires permettent d'avoir des réserves avant l'urgence."],
      ["Un don suffit pour longtemps.", "Les besoins sont permanents, et les dons chutent en été et pendant le Ramadan. Donner régulièrement fait toute la différence."],
    ];
    return `<div class="wrap page">
      <div class="donate-hero">
        <div>
          <div class="eyebrow" style="color:#FF9FAF">Passer à l'action</div>
          <h1>Donner son sang, c'est simple, et ça sauve des vies.</h1>
          <p>Le don prend une heure à peine, de l'accueil à la collation. Il existe des centres de transfusion dans tout le pays, et le CNTS organise aussi des collectes mobiles.</p>
          <div class="row" style="margin-top:22px">
            <a class="btn primary" href="https://www.cnts.tn" target="_blank" rel="noopener">${ICON.ext}Trouver un centre (CNTS)</a>
            <a class="btn light" href="#/collectes">Nos prochaines collectes</a>
          </div>
        </div>
        <div class="facts" style="grid-template-columns:1fr 1fr;background:transparent;border-color:rgba(255,255,255,.15)">
          <div style="border-color:rgba(255,255,255,.15)"><b style="color:#fff">1/3</b><span style="color:#CFC4C7">des dons seulement sont volontaires</span></div>
          <div style="border-color:rgba(255,255,255,.15)"><b style="color:#fff">50 000+</b><span style="color:#CFC4C7">poches manquent chaque année</span></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title"><h2>Le don, étape par étape</h2></div>
        <div class="steps">
          <div class="card"><h3>Accueil</h3><p class="small muted" style="margin-top:6px">Munissez-vous de votre carte d'identité. Venez reposé, après avoir mangé et bu.</p></div>
          <div class="card"><h3>Entretien médical</h3><p class="small muted" style="margin-top:6px">Un médecin vérifie confidentiellement que le don est sans risque pour vous et pour le patient.</p></div>
          <div class="card"><h3>Prélèvement</h3><p class="small muted" style="margin-top:6px">Une dizaine de minutes, avec du matériel stérile à usage unique.</p></div>
          <div class="card"><h3>Collation</h3><p class="small muted" style="margin-top:6px">Un temps de repos et une collation avant de repartir. Le centre vous indique quand revenir.</p></div>
        </div>
      </div>

      <div class="split section">
        <div>
          <div class="section-title"><h2>Idées reçues</h2></div>
          <div class="stack">${myths.map(([f, t]) => `<div class="card myth"><div class="false"><div class="label">Idée reçue</div><b>${esc(f)}</b></div><div class="true"><div class="label">En réalité</div><p class="small">${esc(t)}</p></div></div>`).join("")}</div>
        </div>
        <div class="stack">
          <div class="card">
            <h3>Qui peut donner ?</h3>
            <ul class="check" style="margin-top:10px">
              <li>Être majeur et en bonne santé</li>
              <li>Peser au moins 50 kg</li>
              <li>Ne pas venir à jeun</li>
              <li>Respecter le délai entre deux dons indiqué par le centre</li>
            </ul>
            <p class="tiny muted" style="margin-top:12px">Conditions indicatives. Les critères officiels (âge, délais, contre-indications) sont fixés par le CNTS et confirmés lors de l'entretien médical.</p>
          </div>
          <div class="card" style="background:var(--red-soft);border-color:var(--red-line)">
            <h3>Organiser une collecte</h3>
            <p class="small" style="margin-top:6px">Votre entreprise, votre école ou votre association peut réunir au moins 50 volontaires ? Nous faisons le lien avec le CNTS pour organiser une collecte sur place.</p>
            <a class="btn sm primary" style="margin-top:12px" href="#/partenaires">Voir nos partenaires</a>
          </div>
        </div>
      </div>
    </div>`;
  }

  // ---------------------------------------------------------------- formulaires (modale)
  function openModal(html) {
    const m = $("#modal");
    m.innerHTML = html;
    if (typeof m.showModal === "function") m.showModal(); else m.setAttribute("open", "");
    return m;
  }
  function closeModal() { const m = $("#modal"); if (m.open) m.close(); }

  function confirmModal(title, text) {
    return new Promise((resolve) => {
      const m = openModal(`<div class="modal-head"><h3>${esc(title)}</h3></div><div class="modal-body"><p class="muted">${esc(text)}</p></div>
        <div class="modal-foot"><button class="btn" data-no>Annuler</button><button class="btn primary" data-yes>Confirmer</button></div>`);
      const done = (v) => { closeModal(); resolve(v); };
      $("[data-no]", m).onclick = () => done(false);
      $("[data-yes]", m).onclick = () => done(true);
      m.onclose = () => resolve(false);
    });
  }

  // Formulaire générique : fields = [{name, label, type, options, full, required, value}]
  function formModal(title, fields, onSubmit, extra = "") {
    const input = (f) => {
      const v = f.value ?? "";
      if (f.type === "select") return `<select class="input" name="${f.name}" ${f.required ? "required" : ""}>${f.options.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
      if (f.type === "textarea") return `<textarea class="input" name="${f.name}" ${f.required ? "required" : ""}>${esc(v)}</textarea>`;
      return `<input class="input" name="${f.name}" type="${f.type || "text"}" value="${esc(v)}" ${f.required ? "required" : ""} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ""}>`;
    };
    const m = openModal(`<form method="dialog" data-form>
      <div class="modal-head"><h3>${esc(title)}</h3><button type="button" class="close-x" data-x aria-label="Fermer">×</button></div>
      <div class="modal-body"><div class="form-grid">${fields.map((f) => `<div class="field ${f.full ? "full" : ""}"><label>${esc(f.label)}</label>${input(f)}</div>`).join("")}</div></div>
      <div class="modal-foot">${extra}<button type="button" class="btn" data-x>Annuler</button><button class="btn primary" type="submit">Enregistrer</button></div>
    </form>`);
    $$("[data-x]", m).forEach((b) => (b.onclick = closeModal));
    $("[data-form]", m).addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target));
      for (const f of fields) if (f.type === "number" && data[f.name] !== "") data[f.name] = Number(data[f.name]);
      try { await onSubmit(data); closeModal(); } catch { /* toast déjà affiché */ }
    });
    setTimeout(() => $("input, textarea, select", m)?.focus(), 30);
    return m;
  }

  const memberOptions = (withEmpty = "À attribuer") => [["", withEmpty], ...S.data.members.map((m) => [m.id, m.name])];

  function newAction(prefill = {}) {
    formModal("Nouvelle action", [
      { name: "title", label: "Action", required: true, full: true, value: prefill.title, placeholder: "Ex. : Contacter la mairie pour une collecte" },
      { name: "assignee", label: "Responsable", type: "select", options: memberOptions() },
      { name: "deadline", label: "Échéance", type: "date" },
      { name: "priority", label: "Priorité", type: "select", options: Object.entries(PRIO).map(([k, v]) => [k, v[0]]), value: "medium" },
      { name: "meetingId", label: "Réunion d'origine", type: "select", options: [["", "Aucune"], ...S.data.meetings.map((m) => [m.id, `${fmtShort(m.date)} · ${m.title}`])], value: prefill.meetingId },
      { name: "description", label: "Description", type: "textarea", full: true, value: prefill.description },
    ], async (d) => {
      const a = await save("actions", null, { ...d, status: "todo" });
      toast("Action créée");
      location.hash = "#/actions/" + a.id;
      rerender();
    });
  }

  function editMember(m = {}) {
    formModal(m.id ? "Modifier " + m.name : "Ajouter un membre", [
      { name: "name", label: "Prénom ou nom affiché", required: true, value: m.name },
      { name: "role", label: "Rôle", value: m.role, placeholder: "Ex. : Communication" },
      { name: "focus", label: "Ce qu'il ou elle porte", full: true, value: m.focus },
      { name: "city", label: "Ville", value: m.city },
      { name: "bloodGroup", label: "Groupe sanguin (facultatif)", type: "select", options: [["", "Non renseigné"], ...["O+", "O-", "A+", "A-", "B+", "B-", "AB+", "AB-"].map((g) => [g, g])], value: m.bloodGroup },
      { name: "external", label: "Type", type: "select", options: [["", "Membre du collectif"], ["true", "Référent externe"]], value: m.external ? "true" : "" },
      { name: "color", label: "Couleur de l'avatar", type: "color", value: m.color || "#B3122E" },
    ], async (d) => {
      d.external = d.external === "true";
      await save("members", m.id ? m : null, d);
      toast("Membre enregistré");
      rerender();
    }, m.id ? `<button type="button" class="btn danger" style="margin-right:auto" data-del-member>Retirer</button>` : "");
    $("[data-del-member]")?.addEventListener("click", async () => {
      if (!(await confirmModal("Retirer " + m.name + " ?", "Ses actions resteront, sans responsable."))) return;
      await remove("members", m.id);
      for (const a of S.data.actions.filter((x) => x.assignee === m.id)) await save("actions", a, { assignee: "" });
      location.hash = "#/equipe";
      rerender();
    });
  }

  function editMeeting(m = {}) {
    formModal(m.id ? "Modifier la réunion" : "Planifier une réunion", [
      { name: "title", label: "Titre", required: true, full: true, value: m.title },
      { name: "date", label: "Date", type: "date", required: true, value: m.date },
      { name: "time", label: "Heure", type: "time", value: m.time || "20:30" },
      { name: "place", label: "Lieu", value: m.place || "Google Meet" },
      { name: "status", label: "Statut", type: "select", options: [["planned", "À venir"], ["done", "Passée"]], value: m.status || "planned" },
      { name: "summary", label: "Objectif ou résumé", type: "textarea", full: true, value: m.summary },
      { name: "kelmaUrl", label: "Lien du compte rendu Kelma", full: true, value: m.kelmaUrl, placeholder: "https://shirokko.net/kelma/r/…" },
      { name: "notes", label: "Notes", full: true, value: m.notes },
    ], async (d) => {
      const out = await save("meetings", m.id ? m : null, d);
      toast("Réunion enregistrée");
      location.hash = "#/reunions/" + out.id;
      rerender();
    });
  }

  function editDrive(dv = {}) {
    formModal(dv.id ? "Modifier la collecte" : "Nouvelle collecte", [
      { name: "title", label: "Collecte", required: true, full: true, value: dv.title },
      { name: "status", label: "Étape", type: "select", options: Object.entries(DRIVE_STATUS).map(([k, v]) => [k, v[0]]), value: dv.status || "idea" },
      { name: "date", label: "Date", type: "date", value: dv.date },
      { name: "place", label: "Lieu", value: dv.place },
      { name: "partnerId", label: "Partenaire", type: "select", options: [["", "Aucun"], ...S.data.partners.map((p) => [p.id, p.name])], value: dv.partnerId },
      { name: "owner", label: "Suivie par", type: "select", options: memberOptions("Personne"), value: dv.owner },
      { name: "target", label: "Objectif (poches)", type: "number", value: dv.target ?? 40 },
      { name: "candidates", label: "Candidats attendus", type: "number", value: dv.candidates },
      { name: "collected", label: "Poches collectées", type: "number", value: dv.collected },
      { name: "notes", label: "Notes", type: "textarea", full: true, value: dv.notes },
    ], async (d) => {
      await save("drives", dv.id ? dv : null, d);
      toast("Collecte enregistrée");
      rerender();
    }, dv.id ? `<button type="button" class="btn danger" style="margin-right:auto" data-del>Supprimer</button>` : "");
    $("#modal [data-del]")?.addEventListener("click", async () => { await remove("drives", dv.id); closeModal(); rerender(); });
  }

  function editPartner(p = {}) {
    formModal(p.id ? "Modifier " + p.name : "Ajouter un partenaire", [
      { name: "name", label: "Nom", required: true, value: p.name },
      { name: "type", label: "Type", value: p.type, placeholder: "Entreprise, association…" },
      { name: "status", label: "Statut", type: "select", options: Object.entries(PARTNER_STATUS).map(([k, v]) => [k, v[0]]), value: p.status || "lead" },
      { name: "owner", label: "Suivi par", type: "select", options: memberOptions("Personne"), value: p.owner },
      { name: "contact", label: "Contact", value: p.contact },
      { name: "url", label: "Site web", type: "url", value: p.url },
      { name: "notes", label: "Notes", type: "textarea", full: true, value: p.notes },
    ], async (d) => {
      await save("partners", p.id ? p : null, d);
      toast("Partenaire enregistré");
      rerender();
    }, p.id ? `<button type="button" class="btn danger" style="margin-right:auto" data-del>Supprimer</button>` : "");
    $("#modal [data-del]")?.addEventListener("click", async () => { await remove("partners", p.id); closeModal(); rerender(); });
  }

  // ---------------------------------------------------------------- mode édition
  function renderEditToggle() {
    const b = $("#editToggle");
    if (!S.data || !S.data.editProtected || S.data.staticMode) { b.hidden = true; return; }
    b.hidden = false;
    b.classList.toggle("on", Boolean(S.code));
    b.innerHTML = S.code ? `${ICON.unlock}<span class="lbl">Mode édition</span>` : `${ICON.lock}<span class="lbl">Espace membres</span>`;
    b.title = S.code ? "Quitter le mode édition" : "Entrer le code d'équipe pour modifier";
  }

  $("#editToggle").addEventListener("click", () => {
    if (S.code) { S.code = ""; store.set("tl_code", null); renderEditToggle(); rerender(); toast("Mode lecture"); return; }
    const m = openModal(`<form data-auth>
      <div class="modal-head"><h3>Espace membres</h3><button type="button" class="close-x" data-x aria-label="Fermer">×</button></div>
      <div class="modal-body"><p class="muted small" style="margin-bottom:12px">Entrez le code d'équipe partagé dans le groupe pour attribuer, modifier et commenter les actions.</p>
      <div class="form-grid">
        <div class="field"><label>Je suis</label><select class="input" name="me">${S.data.members.map((m) => `<option ${me() === m.name ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select></div>
        <div class="field"><label>Code d'équipe</label><input class="input" type="password" name="code" required autocomplete="current-password"></div>
      </div></div>
      <div class="modal-foot"><button type="button" class="btn" data-x>Annuler</button><button class="btn primary">Entrer</button></div></form>`);
    $$("[data-x]", m).forEach((b) => (b.onclick = closeModal));
    $("[data-auth]", m).addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = new FormData(e.target).get("code");
      let ok = false;
      try { ok = await checkCode(code); } catch { ok = false; }
      if (!ok) { toast("Code incorrect"); return; }
      const who = new FormData(e.target).get("me");
      if (who) store.set("tl_me", who);
      S.code = code; store.set("tl_code", code);
      closeModal(); renderEditToggle(); rerender(); toast("Mode édition activé");
    });
    setTimeout(() => $("input", m).focus(), 30);
  });

  // ---------------------------------------------------------------- liaisons
  function bindPage(page, id) {
    $("[data-copy-recap]")?.addEventListener("click", () => copyText(recapText()));
    $("[data-export-csv]")?.addEventListener("click", () => download(`actions-tunisian-lifesavers-${todayStr()}.csv`, csvActions(), "text/csv;charset=utf-8"));
    $("[data-new-action]")?.addEventListener("click", () => newAction());
    $("[data-new-member]")?.addEventListener("click", () => editMember());
    $("[data-new-meeting]")?.addEventListener("click", () => editMeeting());
    $("[data-new-drive]")?.addEventListener("click", () => editDrive());
    $("[data-new-partner]")?.addEventListener("click", () => editPartner());
    $("[data-edit-member]")?.addEventListener("click", (e) => editMember(member(e.currentTarget.dataset.editMember)));
    $("[data-edit-meeting]")?.addEventListener("click", (e) => editMeeting(meeting(e.currentTarget.dataset.editMeeting)));
    $$("[data-edit-drive]").forEach((el) => el.addEventListener("click", () => editDrive(S.data.drives.find((d) => d.id === el.dataset.editDrive))));
    $$("[data-edit-partner]").forEach((el) => el.addEventListener("click", () => editPartner(partner(el.dataset.editPartner))));
    $$("[data-q-to-action]").forEach((el) => el.addEventListener("click", () => {
      const m = meeting(id); const q = m.questions[Number(el.dataset.qToAction)];
      newAction({ title: "Répondre : " + q[0], description: q[1] + "\n" + q[2], meetingId: m.id });
    }));

    if (page === "actions") {
      $$("[data-filter]").forEach((el) => el.addEventListener(el.type === "search" ? "input" : "change", () => { S.filters[el.dataset.filter] = el.value; refreshActionsView(); }));
      $$("[data-view]").forEach((b) => b.addEventListener("click", () => {
        S.view = b.dataset.view; store.set("tl_view", S.view);
        $$("[data-view]").forEach((x) => x.classList.toggle("on", x === b));
        refreshActionsView();
      }));
      bindBoard();
    }
  }

  $("#drawerBackdrop").addEventListener("click", () => closeDrawer());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#drawer").hidden && !$("#modal").open) closeDrawer(); });
  $("#menuBtn").addEventListener("click", () => {
    const open = $("#nav").classList.toggle("open");
    $("#menuBtn").setAttribute("aria-expanded", String(open));
  });
  window.addEventListener("hashchange", render);

  // ---------------------------------------------------------------- démarrage
  (async () => {
    try {
      await load();
      if (S.code && S.data.editProtected) {
        if (!(await checkCode(S.code).catch(() => false))) { S.code = ""; store.set("tl_code", null); }
      }
      renderEditToggle();
      render();
    } catch (e) {
      main.innerHTML = `<div class="wrap page"><div class="empty">Impossible de charger les données (${esc(e.message)}). Réessayez dans un instant.</div></div>`;
    }
  })();
})();
