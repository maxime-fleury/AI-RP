/**
 * World starter templates. Each one seeds a world with editable structure:
 * description, tone, lore, a few locations, lorebook entries and a sample
 * scenario — NOT a locked-in genre. The user edits everything afterwards
 * (nothing is marked read-only; the scenario is just a draft opening).
 */
import { createWorld, createLocation, createLorebookEntry, createScenario } from "./db";

export interface WorldTemplateLocation {
  name: string;
  description: string;
  x: number;
  y: number;
}
export interface WorldTemplateLore {
  name: string;
  triggers: string;
  content: string;
  priority: number;
}
export interface WorldTemplate {
  id: string;
  name: string;
  icon: string;
  tagline: string;
  description: string;
  tone: string;
  narration_style: string;
  lore: string;
  locations: WorldTemplateLocation[];
  lorebook: WorldTemplateLore[];
  scenario: { name: string; intro: string };
}

export const WORLD_TEMPLATES: WorldTemplate[] = [
  {
    id: "fantasy",
    name: "Fantaisie",
    icon: "🐉",
    tagline: "Épées, magie et royaumes en conflit",
    description: "Un royaume médiéval-fantastique où la magie imprègne la terre, les guildes se disputent le pouvoir et d'anciens secrets dorment sous les cités.",
    tone: "épique",
    narration_style: "immersive et cinématique",
    lore: "Le royaume d'Astoria survit entre deux ères : les vieilles dynasties magiques déclinent tandis que les académies de runes forment une nouvelle génération d'enchanteurs. La Guilde des Cartographes détient seule les cartes des routes sûres, car les terres sauvages changent chaque saison. Au nord, la Citadelle de Fer est tombée aux mains du Seigneur des Cendres ; au sud, les marchands d'éclats de lune vendent la magie comme une épice. Un ancien pacte entre les rois et les esprits des forêts s'efface lentement — et les forêts commencent à répondre.",
    locations: [
      { name: "La Taverne du Chêne Fendu", description: "Repaire des aventuriers, auberge bruyante où se négocient les contrats.", x: 30, y: 60 },
      { name: "Académie des Runes", description: "Tour de cristal où l'on enseigne la magie écrite, au cœur de la capitale.", x: 50, y: 45 },
      { name: "Citadelle de Fer", description: "Forteresse déchue du nord, envahie de cendres et de spectres.", x: 15, y: 15 },
      { name: "Port des Éclats", description: "Cité portuaire marchande, plaque tournante des éclats de lune.", x: 75, y: 70 },
    ],
    lorebook: [
      { name: "Éclats de lune", triggers: "éclat, lune, magie marchande", content: "Les éclats de lune sont des fragments cristallisés de magie ancienne, utilisés comme monnaie et carburant des enchantements.", priority: 3 },
      { name: "Guildes", triggers: "guilde, cartographes, runes", content: "Les guildes (Cartographes, Runeurs, Ferronniers) se disputent l'influence ; la Guilde des Cartographes contrôle les routes sûres.", priority: 2 },
      { name: "Pacte des forêts", triggers: "pacte, forêt, esprits", content: "L'ancien pacte entre les rois et les esprits des forêts s'efface — les forêts réagissent et reprennent les terres.", priority: 2 },
    ],
    scenario: {
      name: "La première ruine",
      intro: "*Le Chêne Fendu vibre de rumeurs : une ruine vient de surgir de terre à l'orée de la forêt, portes grandes ouvertes. La Guilde des Cartographes offre une bourse d'éclats de lune au premier qui en rapporte une carte.*",
    },
  },
  {
    id: "isekai",
    name: "Isekai",
    icon: "🌌",
    tagline: "Réincarnation dans un monde parallèle",
    description: "Un monde parallèle de fantasy qui suit ses propres règles, découvert depuis notre réalité — au choix : réincarnation, invocation ou simple passage de portail.",
    tone: "aventureux",
    narration_style: "immersive et cinématique",
    lore: "Personne ne sait pourquoi les portails s'ouvrent, ni ce qui choisit ceux qui les franchissent. De l'autre côté, le monde de Valden suit des règles de jeu : des compétences se débloquent par l'expérience, certains objets « ne fonctionnent que pour les invoqués », et une Grande Guilde catalogue tout ce que les voyageurs rapportent. Les habitants y sont réels et conscients, les conséquences aussi. Revenir n'est pas garanti.",
    locations: [
      { name: "Place des Portails", description: "Là où les nouveaux arrivants surgissent, surveillée par la Guilde.", x: 50, y: 50 },
      { name: "Guilde des Catalogues", description: "Archives de tout ce que les invoqués ont découvert.", x: 65, y: 40 },
      { name: "Forêt des échos", description: "Les arbres répètent les phrases prononcées cent ans plus tôt.", x: 20, y: 25 },
    ],
    lorebook: [
      { name: "Les invoqués", triggers: "invoqué, portail, voyageur", content: "Les personnes venues d'ailleurs acquièrent des capacités liées à leur arrivée ; la Guilde les catalogue pour mieux les comprendre.", priority: 3 },
      { name: "Règles de Valden", triggers: "compétence, niveau, règle", content: "Certaines lois du monde se comportent comme des règles de jeu : l'expérience débloque des compétences, mais personne n'explique pourquoi.", priority: 2 },
    ],
    scenario: {
      name: "Première nuit à Valden",
      intro: "*Tu ouvres les yeux sur la Place des Portails, entouré d'inconnus qui parlent une langue que tu comprends pourtant. Un clerc de la Guilde s'avance, calepin à la main : « Encore un. Alors — qu'est-ce que tu sais faire ? »*",
    },
  },
  {
    id: "mystery",
    name: "Mystère",
    icon: "🕵️",
    tagline: "Enquêtes, secrets et non-dits",
    description: "Une petite ville tranquille — trop tranquille. Chaque habitant a un secret, chaque lieu une histoire cachée, et un seul fil tiré défait toute la pelote.",
    tone: "suspense",
    narration_style: "sobre et précise, détails révélateurs",
    lore: "Bienvenue à Bellacourt, 12 000 habitants, un lac, un journal local qui ne dort jamais et un maire qui ne sourit que lors des élections. Il y a vingt ans, la brasserie a fermé du jour au lendemain ; le fondateur a disparu avec les recettes. Depuis, chaque automne, une porte se retrouve ouverte sans explication. La bibliothèque municipale conserve un registre des incidents — les pages de septembre sont toujours manquantes.",
    locations: [
      { name: "Café du Lac", description: "Le point de ralliement des commérages, tenu par une femme qui sait tout.", x: 45, y: 55 },
      { name: "Bibliothèque municipale", description: "Vieille bâtisse au registre des incidents incomplet.", x: 60, y: 40 },
      { name: "Brasserie fermée", description: "Le bâtiment condamné qui domine la place, fenêtres scellées.", x: 30, y: 45 },
      { name: "Poste de police", description: "Un commissariat à deux bureaux, ouvert aux confidences.", x: 55, y: 65 },
    ],
    lorebook: [
      { name: "Le registre", triggers: "registre, incidents, septembre", content: "Le registre des incidents de la bibliothèque a toujours des pages manquantes en septembre — personne ne s'explique pourquoi.", priority: 3 },
      { name: "La brasserie", triggers: "brasserie, fondateur, recette", content: "La brasserie a fermé en une nuit, il y a vingt ans ; son fondateur a disparu avec les recettes et n'a jamais été retrouvé.", priority: 2 },
    ],
    scenario: {
      name: "Une porte ouverte",
      intro: "*Un appel anonyme te conduit à l'aube devant la brasserie fermée : la porte principale, condamnée depuis vingt ans, est grande ouverte. Dans la poussière du hall, des pas frais mènent vers les cuves.*",
    },
  },
  {
    id: "romance",
    name: "Romance",
    icon: "💞",
    tagline: "Rencontres, étincelles et cœurs hésitants",
    description: "Un décor charmant, une ville où tout le monde se connaît, et une rencontre qui ne cesse de se reproduire — jusqu'à ce que les deux personnes finissent par se parler.",
    tone: "chaleureux",
    narration_style: "sensoriel et tendre, en deuxième personne",
    lore: "À Port-Soleil, les étés durent jusqu'en octobre et tout le monde finit par se croiser au marché du dimanche. La boulangerie des sœurs Marelle, le kiosque de la plage, la promenade des phares : chaque lieu porte les souvenirs de quelqu'un. La règle non écrite du village : on ne parle pas des histoires d'avant — chacun a droit à un nouveau départ, et le soleil couchant sur le port pardonne presque tout.",
    locations: [
      { name: "Marché du dimanche", description: "Le rendez-vous de toute la ville, entre étals de fleurs et crêpes.", x: 40, y: 50 },
      { name: "Boulangerie des sœurs Marelle", description: "Chaleureuse, sent le pain chaud, vitrine de conversations.", x: 55, y: 45 },
      { name: "Promenade des phares", description: "Le meilleur endroit pour parler — ou pour se taire ensemble.", x: 75, y: 70 },
      { name: "Kiosque de la plage", description: "Location de vélos et de secrets d'été.", x: 20, y: 25 },
    ],
    lorebook: [
      { name: "Nouveaux départs", triggers: "nouveau départ, histoire d'avant", content: "À Port-Soleil, on ne remue pas les passés compliqués : chacun a droit à un nouveau départ.", priority: 2 },
      { name: "Le coucher de soleil", triggers: "coucher de soleil, port, phare", content: "Le coucher de soleil sur le port est célèbre ; c'est aussi l'endroit où les aveux ont lieu.", priority: 1 },
    ],
    scenario: {
      name: "Le client du kiosque",
      intro: "*Un inconnu au sourire désarmant loue le même vélo rouge trois dimanches de suite « par hasard ». La sœur Marelle te fait un clin d'œil depuis sa vitrine : il est temps de dire bonjour.*",
    },
  },
  {
    id: "horror",
    name: "Horreur",
    icon: "🕯️",
    tagline: "Ce qui rôde sous la surface",
    description: "Un lieu isolé où les règles changent la nuit. La peur est une ressource, les silences en disent long, et ce qui est vu ne peut plus être ignoré.",
    tone: "oppressant",
    narration_style: "dense et sensoriel, atmosphère pesante",
    lore: "Brumesborough s'est construite sur un marais qu'on n'a jamais vraiment asséché. Les maisons se tassent, les caves pleurent, et chaque famille garde un objet qu'il ne faut pas déplacer. La légende locale parle de la Lanterne Pâle, une lumière qui traverse les rues sans projeter d'ombre. Depuis le dernier hiver, les miroirs de la ville reflètent une seconde trop tard. Personne n'en parle — c'est la règle numéro un.",
    locations: [
      { name: "Manoir des Tisserands", description: "La grande maison grise, habitée par un silence trop organisé.", x: 50, y: 50 },
      { name: "Le marais", description: "Des sentiers qui ne mènent pas deux fois au même endroit.", x: 15, y: 20 },
      { name: "Chapelle de la Lanterne", description: "Une chapelle fermée où la lumière veille encore.", x: 65, y: 35 },
      { name: "Rue des miroirs", description: "La rue où les reflets traînent.", x: 40, y: 70 },
    ],
    lorebook: [
      { name: "La Lanterne Pâle", triggers: "lanterne, pâle, lumière", content: "Une lumière traverse Brumesborough sans projeter d'ombre ; la voir deux fois est considéré comme un présage.", priority: 3 },
      { name: "Les miroirs", triggers: "miroir, reflet", content: "Depuis le dernier hiver, les miroirs reflètent une seconde trop tard — on évite de s'y regarder deux fois.", priority: 3 },
      { name: "Règle numéro un", triggers: "règle, silence", content: "On ne parle pas de ce qui rôde. En parler le rend plus précis.", priority: 2 },
    ],
    scenario: {
      name: "La lumière sur le marais",
      intro: "*La nuit tombe vite à Brumesborough. À la fenêtre, une lueur pâle traverse le jardin sans bruit — et ne projette aucune ombre. La vieille Mme Harlow, ta voisine, ferme ses volets sans un mot. Derrière toi, un miroir attend.*",
    },
  },
  {
    id: "space-opera",
    name: "Space opera",
    icon: "🚀",
    tagline: "Étoiles lointaines, empires et vaisseaux",
    description: "Un secteur de la galaxie à la croisée des routes commerciales : flottes impériales, contrebandiers, stations orbitales et civilisations anciennes qui n'ont pas dit leur dernier mot.",
    tone: "grandiose",
    narration_style: "immersive et cinématique",
    lore: "L'Empire du Noyau contrôle les routes stables qui relient douze systèmes, mais son autorité s'effiloche aux marges. Dans le Secteur d'Orion, la station-relais Vérion fait office de frontière poreuse : on y croise des négociants honnêtes, des chasseurs de primes discrets et des archéologues qui fouillent les ruines précurseurs. Les vaisseaux à saut partent et reviennent, mais parfois — très rarement — un vaisseau revient du mauvais côté du temps.",
    locations: [
      { name: "Station Vérion", description: "Relais commercial à la frontière de l'Empire, ville flottante en métal.", x: 50, y: 50 },
      { name: "Ruines précurseurs", description: "Souterrains d'une civilisation disparue, sur la lune d'Atria.", x: 25, y: 30 },
      { name: "Docks de contrebande", description: "Niveau inférieur de Vérion, où tout s'achète.", x: 60, y: 70 },
      { name: "Croiseur impérial « Fierté »", description: "Navire amiral en inspection — sa présence n'annonce rien de bon.", x: 45, y: 15 },
    ],
    lorebook: [
      { name: "Précurseurs", triggers: "précurseur, ruine, atria", content: "Les ruines précurseurs n'ont livré aucune technologie utilisable — seulement des portes verrouillées et des inscriptions qui changent de sens.", priority: 3 },
      { name: "Sauts temporels", triggers: "saut, temps, vaisseau", content: "Rarement, un vaisseau revient avec un équipage qui a vécu des décennies en quelques jours de voyage.", priority: 2 },
      { name: "Empire du Noyau", triggers: "empire, noyau, impérial", content: "L'Empire contrôle les routes stables ; aux marges comme Orion, son autorité est négociable.", priority: 2 },
    ],
    scenario: {
      name: "Retard à Vérion",
      intro: "*Ton vaisseau est cloué au quai de la station Vérion par une « inspection douanière » qui dure depuis trois jours. Un cargo de contrebande vient de s'amarrer au niveau inférieur, et un message codé t'attend au bar de la passe-relais : « On a besoin de toi, avant que la Fierté ne parte. »*",
    },
  },
  {
    id: "modern",
    name: "Moderne",
    icon: "🏙️",
    tagline: "Ville, secrets et vies ordinaires",
    description: "Une grande ville contemporaine où des vies ordinaires croisent des choses qui ne le sont pas : quartiers, nuits, réseaux et retrouvailles inattendues.",
    tone: "réaliste",
    narration_style: "direct et vivant",
    lore: "La métropole dort rarement. Entre les tours de verre du centre, les immeubles anciens de Belleville, le campus et la gare qui ne vide jamais ses quais, chacun trace sa route sans regarder celle des autres. Et pourtant tout se recoupe : le livreur qui connaît toutes les portes, l'appartement au-dessus de la boulangerie qui change de locataire trop souvent, la ligne de tram 7 qui continue de circuler après la dernière station. Le présent est simple — jusqu'à ce qu'on commence à poser des questions.",
    locations: [
      { name: "Café Central", description: "Café de quartier, table du fond toujours libre, wifi qui traîne.", x: 40, y: 55 },
      { name: "Gare Belleville", description: "Grande gare de banlieue, quais en réfection perpétuelle.", x: 65, y: 60 },
      { name: "Tours du centre", description: "Quartier d'affaires lisse, où les vitres ne laissent rien deviner.", x: 55, y: 30 },
      { name: "L'appartement au-dessus de la boulangerie", description: "Locataires trop fréquents, rideaux toujours tirés.", x: 30, y: 45 },
    ],
    lorebook: [
      { name: "Le tram 7", triggers: "tram, ligne 7, dernière station", content: "La ligne 7 circule après la dernière station officielle — certains disent que le tram continue, d'autres qu'il ne s'arrête pas.", priority: 2 },
      { name: "L'appartement", triggers: "appartement, boulangerie, locataire", content: "L'appartement au-dessus de la boulangerie change de locataire tous les mois ; personne ne les croise deux fois.", priority: 2 },
    ],
    scenario: {
      name: "Le voisin du 3e",
      intro: "*Un nouveau voisin emménage au 3e étage, cartons en carton recyclé, pas de meubles, sourire rapide. Le lendemain, quelqu'un glisse une enveloppe sous ta porte : « Ne t'inquiète pas de ce que tu entends. »*",
    },
  },
];

export interface WorldTemplateSummary {
  id: string; name: string; icon: string; tagline: string; description: string;
  tone: string; narration_style: string;
  counts: { locations: number; lorebook: number; hasScenario: boolean };
}

export function listWorldTemplates(): WorldTemplateSummary[] {
  return WORLD_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    icon: t.icon,
    tagline: t.tagline,
    description: t.description,
    tone: t.tone,
    narration_style: t.narration_style,
    counts: {
      locations: t.locations.length,
      lorebook: t.lorebook.length,
      hasScenario: Boolean(t.scenario.name),
    },
  }));
}

export function getWorldTemplate(id: string): WorldTemplate | null {
  return WORLD_TEMPLATES.find((t) => t.id === id) ?? null;
}

/**
 * Apply a template: create the world + starter locations + lorebook entries +
 * a draft scenario, all as ordinary editable rows. Returns the new world id.
 */
export function applyWorldTemplate(id: string): { worldId: number } | null {
  const t = getWorldTemplate(id);
  if (!t) return null;
  const world = createWorld({
    name: t.name,
    description: t.description,
    lore: t.lore,
    tone: t.tone,
    narration_style: t.narration_style,
    language: "fr",
  });
  for (const loc of t.locations) {
    createLocation({ world_id: world.id, name: loc.name, description: loc.description, x: loc.x, y: loc.y });
  }
  for (const le of t.lorebook) {
    createLorebookEntry({ world_id: world.id, name: le.name, triggers: le.triggers, content: le.content, priority: le.priority, enabled: 1 });
  }
  if (t.scenario.name) {
    createScenario({ world_id: world.id, name: t.scenario.name, intro: t.scenario.intro, notes: "" });
  }
  return { worldId: world.id };
}