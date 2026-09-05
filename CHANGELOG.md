# Changelog

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) ; le
projet suit le versionnage sémantique. Les entrées sont regroupées par
publication (`git tag v*`).

## [Unreleased]

Aucune modification en attente de publication.

## [0.1.0] — 2026-09-05

Première publication. Innsekai est une interface web de roleplay avec IA :
mondes, cartes de personnages (import SillyTavern), scénarios, narrateur +
PNJ en solo ou en groupe, illustrations générées localement (Koji), et une
boîte à outils narrative complète. Toutes les fonctionnalités listées ci-après
sont présentes et couvertes par les tests (242).

### Ajouts majeurs — refonte du roleplay IA

- **Prompt RP en couches** : règles dures → données → style → mémoire →
  pilotage, compilé au moment de l'envoi ; le contenu monde/fiche/canon est
  marqué `[DONNÉES]` (contexte, pas instructions) ; le budget de contexte est
  **adapté à la classe du modèle** (petit ≈ 4k, moyen ≈ 8k, grand ≈ 12k tokens)
  et la troncature préserve toujours les règles et le pilotage.
- **Profils de partie** : comportement réactif / équilibré / cinématique,
  longueur de réponse courte / moyenne / longue, mode de contexte Simple ou
  Avancé (défaut : Équilibré + Simple + Court).
- **Détection automatique d'intention** par tour (conversation, romance,
  combat, enquête, exploration, tranche de vie…) : le focus de scène suit le
  joueur, et un changement de direction net met automatiquement le plan de
  scène persistant en veille pour le tour.
- **Focus de scène explicite** (override manuel) + **canal de pilotage** par
  tour (consigne prioritaire) + mode **hors-jeu `/ooc`**.
- **Garde-fou post-génération** : détection des dérives (joueur contrôlé,
  événement majeur non demandé) et régénération corrective transparente.
- **Mémoire unifiée par pertinence** : résumé, mémoire structurée, chapitres,
  récapitulatif, lorebook et boucles temporelles fusionnés en un seul bloc
  sélectionné à chaque tour (le lorebook réagit au message courant, sans délai).
- **Compilateur de réponse** : suggestions « chips », interpellations
  (« fais répondre Alba »), récap « Previously on… » avec storyboard, journal
  de quêtes, canon joueur (faits 🔒 verrouillés + propositions IA), graphe des
  relations 💞, PNJ dynamiques, chapitres, boucles temporelles Re:Zero.
- **Questionnaire du meneur ❓** : le narrateur prépare des questions ancrées
  dans la partie ; l'utilisateur choisit parmi des réponses suggérées ou écrit
  les siennes ; les réponses sont intégrées à l'histoire comme un tour normal.
- **Fichiers de prompts éditables** : tous les prompts des modèles vivent dans
  `prompt/<lang>/<id>.txt` (fr par défaut, en en cours) — éditer un prompt est
  un changement de contenu, pas de code.

### Autres fonctionnalités

- Assistant « Décris ce que tu veux » (création guidée monde / persona /
  cartes), avatars IA, cartes repensées.
- Cohérence visuelle des illustrations (img2img depuis le portrait), scènes
  décor en paysage, carte du monde, galerie avec légendes IA.
- Memory Center 🧠, stats de partie, menu ⋮ par catégories, mini-fiches.
- Presets du narrateur éditables, thèmes (glassmorphism / anime), raccourcis
  clavier, accessibilité, notifications d'onglet, view transitions.
- Backups auto + exports/restauration (mondes, canon, lieux, relations,
  médias), token d'accès LAN optionnel.

### Maintenance technique

- API découpée en routeurs par ressource (worlds, cards, personas,
  conversations, messages, media, jobs, settings, backups, assist) ;
  extraction du flux SSE (`stream.ts`) et des prompts d'images
  (`imgPrompts.ts`) ; tables de routage typées.
- Types partagés client/serveur (`src/shared/contracts.ts`), schémas de
  validation, migrations de schéma versionnées (`PRAGMA user_version`).
- Cache HTTP réel (ETag / Last-Modified) en remplacement du cache-buster
  `?v=` ; typecheck du client (`@ts-check`) contre les contrats partagés.
- Diagnostics et télémétrie : traces structurées par tour
  (`data/metrics.jsonl`), panneau de santé des fournisseurs et résumé des
  métriques RP dans les Réglages.
- 242 tests : routage, imports, prompts, comportement RP (agentivité, focus,
  garde-fou, budgets), mémoire, canon, relations, questions, restauration,
  migrations, contrat des vues, graphe d'imports frontend.
