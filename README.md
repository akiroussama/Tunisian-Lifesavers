# Tunisian Lifesavers

Site de gestion et de visibilité du collectif bénévole **Tunisian Lifesavers** (don de sang en Tunisie).

![Accueil](docs/captures/01-accueil.png)

## Ce que fait le site

| Page | Contenu |
| --- | --- |
| **Accueil** | Mission, chiffres du CNTS, actions urgentes, actions sans responsable, prochaine réunion, feuille de route, récap WhatsApp prêt à envoyer |
| **Actions** | Tableau (À faire / En cours / Terminée, glisser-déposer) ou liste ; filtres par membre, échéance, recherche ; export CSV |
| **Détail d'une action** | Responsable, échéance, statut, priorité, description, réunion d'origine et minute de l'enregistrement, commentaires, historique, rappel WhatsApp, ajout à l'agenda (.ics avec rappel la veille) |
| **Réunions** | Historique et réunions à venir ; compte rendu complet : résumé, décisions, actions issues, déroulé, questions ouvertes (convertibles en action), note, temps de parole, risques, lien Kelma |
| **Équipe** | Fiches membres avec rôle et charge (actions en cours, en retard) ; page par membre |
| **Collectes** | Pipeline Piste → Contact pris → Planifiée → Réalisée, objectif de poches et progression |
| **Partenaires** | CNTS, OMS, Ahna Maak, Coficab, Croissant-Rouge, Scouts… avec statut et membre référent |
| **Donner son sang** | Page publique : étapes du don, idées reçues, conditions indicatives, lien vers le CNTS |

Les données de départ (`data/seed.json`) viennent de la réunion du 21 novembre 2026 avec le Dr Hamadi Akkari (CNTS), analysée avec Shirokko Kelma.

## Lecture publique, édition par code d'équipe

Tout le monde peut consulter le site. Pour attribuer, commenter, créer une action ou ajouter des images, un membre clique sur **Espace membres**, choisit son prénom et saisit le code d'équipe partagé dans le groupe WhatsApp. Chaque modification est signée dans l'historique de l'action.

## Où vivent les données

- **Supabase (site en ligne)** : `public/config.js` pointe vers le projet Supabase. Le navigateur lit les tables `tl_items` et `tl_images` et écrit via les fonctions `tl_write` et `tl_add_image`, qui vérifient le code d'équipe (stocké haché dans `tl_settings`). Schéma : `supabase/migration.sql`. Données de départ : `node scripts/seed-sql.js`.
- **Fichier local** : sans Supabase, le serveur Node garde tout dans `data/db.json` et les images dans `data/uploads/`, et protège l'écriture avec `EDIT_CODE`.

Vercel (statique) et le serveur Node sur le VPS peuvent tourner en même temps sur les mêmes données Supabase : il suffit de donner `SUPABASE_URL` et `SUPABASE_KEY` au serveur.

Changer le code d'équipe (dans l'éditeur SQL de Supabase) :

```sql
update public.tl_settings set value = encode(extensions.digest('NOUVEAU-CODE', 'sha256'), 'hex') where key = 'edit_code_sha256';
```

## Lancer en local

Aucune dépendance : Node 20 ou plus suffit.

```bash
npm start            # http://localhost:8098
npm test             # tests de l'API
```

Les données vivent dans `data/db.json` (créé à partir de `data/seed.json` au premier lancement, ignoré par git).

## Site en ligne sur Vercel

Vercel sert le dossier `public/` en statique (voir `vercel.json`), et les données passent par Supabase : rien à configurer côté Vercel.

## Déployer sur le VPS (Docker)

```bash
git clone https://github.com/akiroussama/Tunisian-Lifesavers.git && cd Tunisian-Lifesavers
cp .env.example .env     # garde SUPABASE_URL/SUPABASE_KEY pour partager les données du site en ligne
docker compose up -d --build
```

Le conteneur écoute sur `127.0.0.1:8098` ; les données sont dans le volume `lifesavers-data`. Il reste à ajouter un bloc au reverse proxy existant, par exemple avec Nginx :

```nginx
location / { proxy_pass http://127.0.0.1:8098; proxy_set_header Host $host; }
```

Sauvegarde : `docker cp tunisian-lifesavers:/app/storage/db.json ./backup-$(date +%F).json`.

## Structure

```
server.js          serveur HTTP + API JSON (sans dépendance)
public/core.js     règles métier partagées entre le serveur et le navigateur
supabase/          schéma de la base en ligne
public/            site (HTML, CSS, JS vanilla)
data/seed.json     données initiales
test/              tests de l'API (node --test)
```
