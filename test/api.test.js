const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tl-"));
process.env.DATA_FILE = path.join(dir, "db.json");
process.env.EDIT_CODE = "secret-test";
const { createServer } = require("../server.js");

let base, server;
test.before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const call = (method, p, body, code) =>
  fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(code ? { "X-Edit-Code": code } : {}) }, body: body && JSON.stringify(body) });

test("les données de départ sont servies publiquement", async () => {
  const res = await call("GET", "/api/data");
  assert.equal(res.status, 200);
  const db = await res.json();
  assert.equal(db.editProtected, true);
  assert.equal(db.actions.length, 12);
  assert.ok(db.members.find((m) => m.name === "Zied"));
  assert.equal(db.meetings[0].decisions.length, 5);
});

test("l'écriture exige le code d'équipe", async () => {
  assert.equal((await call("PATCH", "/api/actions/act_07", { assignee: "m_dhia" })).status, 401);
  assert.equal((await call("PATCH", "/api/actions/act_07", { assignee: "m_dhia" }, "faux")).status, 401);
  assert.equal((await call("POST", "/api/auth", null, "secret-test")).status, 200);
});

test("attribuer une action avec échéance garde un historique", async () => {
  const res = await call("PATCH", "/api/actions/act_07", { assignee: "m_dhia", deadline: "2026-12-05", status: "doing" }, "secret-test");
  assert.equal(res.status, 200);
  const a = await res.json();
  assert.equal(a.assignee, "m_dhia");
  assert.equal(a.deadline, "2026-12-05");
  const texts = a.history.map((h) => h.text);
  assert.ok(texts.includes("Attribuée à Dhia"));
  assert.ok(texts.includes("Statut : En cours"));
  const saved = JSON.parse(fs.readFileSync(process.env.DATA_FILE, "utf8"));
  assert.equal(saved.actions.find((x) => x.id === "act_07").assignee, "m_dhia");
});

test("valide les statuts, les dates et ignore les champs inconnus", async () => {
  assert.equal((await call("PATCH", "/api/actions/act_01", { status: "nope" }, "secret-test")).status, 400);
  assert.equal((await call("PATCH", "/api/actions/act_01", { deadline: "29/11/2026" }, "secret-test")).status, 400);
  const a = await (await call("PATCH", "/api/actions/act_01", { id: "pirate", hacked: true }, "secret-test")).json();
  assert.equal(a.id, "act_01");
  assert.equal(a.hacked, undefined);
});

test("créer, commenter et supprimer une action", async () => {
  const created = await (await call("POST", "/api/actions", { title: "Préparer les vidéos éducatives", assignee: "m_rahma" }, "secret-test")).json();
  assert.equal(created.status, "todo");
  const commented = await (await call("POST", `/api/actions/${created.id}/comments`, { author: "Rahma", text: "Je commence lundi" }, "secret-test")).json();
  assert.equal(commented.comments[0].text, "Je commence lundi");
  assert.equal((await call("DELETE", `/api/actions/${created.id}`, null, "secret-test")).status, 200);
  assert.equal((await call("GET", `/api/actions/${created.id}`)).status, 404);
});

test("sert le site et bloque la traversée de répertoires", async () => {
  const home = await call("GET", "/");
  assert.match(await home.text(), /Tunisian/);
  const evil = await call("GET", "/..%2fserver.js");
  assert.doesNotMatch(await evil.text(), /createServer/);
});
