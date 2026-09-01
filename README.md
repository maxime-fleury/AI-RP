# AI-RP — Roleplay & Mondes

Interface web de roleplay avec IA : crée des mondes (isekai…), importe des cartes
de personnages SillyTavern, définis des scénarios et joue avec un narrateur + des
personnages — le tout avec **voix différentes par rôle** (TTS local) et
**illustrations générées** (Koji / SDXL).

## Démarrage

```bash
# 1. Lancer l'API compatible OpenAI (LM Studio sur http://172.17.240.1:3007/v1, par ex.)
# 2. Lancer le serveur de l'app
PORT=3210 bun src/index.ts
# → http://localhost:3210
```

- Le port est choisi par `PORT` (sinon 3000→3600 automatiquement).
- L'URL de LM Studio et le modèle se règlent dans **Réglages** (⚙️) de l'app.
- Le TTS (Pocket-TTS, 8 voix FR + EN) se précharge au démarrage ; les voix se
  règlent par rôle dans les réglages, avec override par carte.
- Le serveur d'images (Koji) se lance automatiquement à la première demande.

## Scripts utiles

| Commande | Rôle |
| --- | --- |
| `bun src/index.ts` | Serveur de l'app (API + SPA) |
| `bun test` | Tests unitaires (routage, prompt, import, TTS) |
| `bun run check` | Build + tests (CI locale) |
| `bun scripts/test-api.ts` | Test d'intégration API de bout en bout |
| `bun scripts/test-tts.ts fr jean "…"` | Synthèse vocale en CLI |
| `python python/image_server/server.py --port 8770` | Sidecar images Koji |

## Sauvegarde

- **Réglages → Sauvegarde** : « ⬇️ Exporter tout » télécharge un JSON complet
  (mondes, scénarios, cartes, personas, conversations) ; « ⬆️ Restaurer »
  recrée tout depuis un fichier.
- Le dossier `data/` contient la base SQLite et tous les fichiers générés
  (audio + images) : copie-le régulièrement pour tout conserver, ou ajoute
  `AI_RP_DATA_DIR` comme variable d'environnement pour déplacer ces données
  ailleurs.

## Stack

- **Serveur** : Bun + TypeScript, SQLite (`data/app.db`), SSE pour le streaming.
- **Chat** : LM Studio (local) ou OpenRouter, prompt RP (narrateur + personnages),
  mode solo ou groupe, suggestions de réponses (« chips » 💡), boutons
  « Faire parler » (narrateur ou un personnage précis), presets de style du
  narrateur (Épique, Sarcastique, Cynique, En colère, Nagatoro…), panneau
  latéral réductible, commandes slash (`/dice 2d6`, `/ooc`, `/narrate`, `/card`),
  recherche dans le fil, export Markdown, édition des messages au double-clic.
- **TTS** : Pocket-TTS (ONNX) dans Bun — voix par rôle : narrateur, joueur, chaque
  personnage (réglages globaux + override par carte). Audio pré-généré en
  arrière-plan (messages récents sans voix synthétisés à l'ouverture) ; les
  segments courts sont fusionnés et le nombre de segments par réponse est
  configurable (le reste se génère à la demande).
- **Images** : Koji v2.1 (SD 1.5) via sidecar Python (diffusers + torch CUDA),
  illustrations de scène en prompt style tags danbooru (FR→EN) + négatif complet ;
  les scènes de décor sont détectées et générées en format paysage (seed affiché,
  bouton « Variante »). Pré-chargement du modèle au démarrage en option.
- **Front** : SPA vanilla, deux thèmes (glassmorphism néon / anime vibrant),
  import de cartes PNG+JSON (spec SillyTavern V1/V2).

## Structure

```
src/server/   API, base de données, routes, import de cartes
src/llm/      providers (LM Studio / OpenRouter) + prompt RP + parsing segments
src/tts/      moteur Pocket-TTS (tokenizer WASM, inférence ONNX), service + voix
python/image_server/  sidecar images (diffusers + Koji)
public/       SPA (HTML/CSS/JS)
models/       modèles locaux (Koji, Pocket-TTS)
data/samples/ échantillons de voix TTS pré-générés (aperçu dans les réglages)
data/         base SQLite, audio et images générées (créé au runtime)
```
