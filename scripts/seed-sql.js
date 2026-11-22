// Génère le SQL qui charge data/seed.json dans la table tl_items (sans écraser l'existant).
const seed = require("../data/seed.json");
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const rows = [["group", "main", seed.group]];
for (const c of ["members", "meetings", "actions", "drives", "partners"]) for (const it of seed[c]) rows.push([c, it.id, it]);
console.log("insert into public.tl_items (collection, id, data) values\n" +
  rows.map(([c, id, d]) => `(${q(c)}, ${q(id)}, ${q(JSON.stringify(d))}::jsonb)`).join(",\n") +
  "\non conflict (collection, id) do nothing;");
