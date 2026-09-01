/**
 * Text normalization for TTS (Pocket-TTS). Adapted from the inference-worker.js
 * conventions (english) plus French number/abbreviation expansion, so that
 * roleplay narration and dialogue sound natural.
 */

const ASCII_MAP: Record<string, string> = {
  "à": "a", "á": "a", "â": "a", "ã": "a", "ä": "a", "å": "a", "æ": "ae",
  "ç": "c", "è": "e", "é": "e", "ê": "e", "ë": "e", "ì": "i", "í": "i",
  "î": "i", "ï": "i", "ñ": "n", "ò": "o", "ó": "o", "ô": "o", "õ": "o",
  "ö": "o", "ø": "o", "ù": "u", "ú": "u", "û": "u", "ü": "u", "ý": "y",
  "ÿ": "y", "ß": "ss", "œ": "oe", "ð": "d", "þ": "th",
  "À": "A", "Á": "A", "Â": "A", "Ã": "A", "Ä": "A", "Å": "A", "Æ": "AE",
  "Ç": "C", "È": "E", "É": "E", "Ê": "E", "Ë": "E", "Ì": "I", "Í": "I",
  "Î": "I", "Ï": "I", "Ñ": "N", "Ò": "O", "Ó": "O", "Ô": "O", "Õ": "O",
  "Ö": "O", "Ø": "O", "Ù": "U", "Ú": "U", "Û": "U", "Ü": "U", "Ý": "Y",
  "\u201C": '"', "\u201D": '"', "\u2018": "'", "\u2019": "'", "\u2026": "...",
  "\u2013": "-", "\u2014": "-",
};

export function convertToAscii(text: string): string {
  return text
    .split("")
    .map((c) => ASCII_MAP[c] || c)
    .join("")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ── English numbers ───────────────────────────────────────────────────────────
const EN_ONES = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const EN_O_ONES = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth",
  "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth",
  "seventeenth", "eighteenth", "nineteenth"];
const EN_O_TENS = ["", "", "twentieth", "thirtieth", "fortieth", "fiftieth", "sixtieth", "seventieth",
  "eightieth", "ninetieth"];

export function enNumberToWords(num: number): string {
  if (num === 0) return "zero";
  const convert = (n: number): string => {
    if (n < 20) return EN_ONES[n];
    if (n < 100) return EN_TENS[Math.floor(n / 10)] + (n % 10 ? " " + EN_ONES[n % 10] : "");
    if (n < 1000) {
      const r = n % 100;
      return EN_ONES[Math.floor(n / 100)] + " hundred" + (r ? " " + convert(r) : "");
    }
    if (n < 1_000_000) {
      const t = Math.floor(n / 1000), r = n % 1000;
      return convert(t) + " thousand" + (r ? " " + convert(r) : "");
    }
    if (n < 1_000_000_000) {
      const m = Math.floor(n / 1_000_000), r = n % 1_000_000;
      return convert(m) + " million" + (r ? " " + convert(r) : "");
    }
    const b = Math.floor(n / 1_000_000_000), r = n % 1_000_000_000;
    return convert(b) + " billion" + (r ? " " + convert(r) : "");
  };
  return convert(num);
}

function enOrdinal(num: number): string {
  if (num < 20) return EN_O_ONES[num] || enNumberToWords(num) + "th";
  if (num < 100) {
    const t = Math.floor(num / 10), o = num % 10;
    if (o === 0) return EN_O_TENS[t];
    return EN_TENS[t] + " " + EN_O_ONES[o];
  }
  const card = enNumberToWords(num);
  if (card.endsWith("y")) return card.slice(0, -1) + "ieth";
  if (card.endsWith("one")) return card.slice(0, -3) + "first";
  if (card.endsWith("two")) return card.slice(0, -3) + "second";
  if (card.endsWith("three")) return card.slice(0, -5) + "third";
  if (card.endsWith("ve")) return card.slice(0, -2) + "fth";
  if (card.endsWith("e")) return card.slice(0, -1) + "th";
  return card + "th";
}

// ── French numbers ────────────────────────────────────────────────────────────
const FR_UNITS = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf",
  "dix", "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
const FR_TENS_FULL = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante-dix", "quatre-vingts", "quatre-vingt-dix"];

export function frNumberToWords(num: number): string {
  if (num === 0) return "zéro";
  if (num < 0) return "moins " + frNumberToWords(-num);
  if (num < 20) return FR_UNITS[num];
  if (num < 100) {
    const t = Math.floor(num / 10), u = num % 10;
    if (u === 0) return t === 8 ? "quatre-vingts" : t === 7 ? "soixante-dix" : FR_TENS_FULL[t];
    if (t === 7) return "soixante-" + FR_UNITS[10 + u];
    if (t === 9) return "quatre-vingt-" + FR_UNITS[10 + u];
    return FR_TENS_FULL[t] + (u === 1 ? " et un" : "-" + FR_UNITS[u]);
  }
  if (num < 1000) {
    const h = Math.floor(num / 100), r = num % 100;
    const hw = h === 1 ? "cent" : FR_UNITS[h] + " cent" + (r === 0 ? "s" : "");
    return hw + (r ? " " + frNumberToWords(r) : "");
  }
  if (num < 1_000_000) {
    const t = Math.floor(num / 1000), r = num % 1000;
    const tw = t === 1 ? "mille" : frNumberToWords(t) + " mille";
    return tw + (r ? " " + frNumberToWords(r) : "");
  }
  if (num < 1_000_000_000) {
    const m = Math.floor(num / 1_000_000), r = num % 1_000_000;
    return (m === 1 ? "un million" : frNumberToWords(m) + " millions") + (r ? " " + frNumberToWords(r) : "");
  }
  const b = Math.floor(num / 1_000_000_000), r = num % 1_000_000_000;
  return (b === 1 ? "un milliard" : frNumberToWords(b) + " milliards") + (r ? " " + frNumberToWords(r) : "");
}

function frOrdinal(num: number): string {
  if (num === 1) return "premier";
  return frNumberToWords(num) + "ième";
}

// ── Abbreviations ─────────────────────────────────────────────────────────────
const EN_ABBREVS: [RegExp, string][] = [
  [/\bmrs\./gi, "misus"], [/\bms\./gi, "miss"], [/\bmr\./gi, "mister"], [/\bdr\./gi, "doctor"],
  [/\bst\./gi, "saint"], [/\bco\./gi, "company"], [/\bjr\./gi, "junior"], [/\bmaj\./gi, "major"],
  [/\bgen\./gi, "general"], [/\bdrs\./gi, "doctors"], [/\brev\./gi, "reverend"],
  [/\blt\./gi, "lieutenant"], [/\bhon\./gi, "honorable"], [/\bsgt\./gi, "sergeant"],
  [/\bcapt\./gi, "captain"], [/\besq\./gi, "esquire"], [/\bltd\./gi, "limited"],
  [/\bcol\./gi, "colonel"], [/\bft\./gi, "fort"], [/\bTTS\b/g, "text to speech"],
  [/\bAPI\b/g, "a p i"], [/\bCPU\b/g, "c p u"], [/\bGPU\b/g, "g p u"], [/\betc\.?\b/g, "etcetera"],
];

const FR_ABBREVS: [RegExp, string][] = [
  [/\bM\.\b/gi, "monsieur"], [/\bMme\b/gi, "madame"], [/\bMlle\b/gi, "mademoiselle"],
  [/\bDr\b\.?/gi, "docteur"], [/\bPr\b\.?/gi, "professeur"], [/\bSt\b\.?/gi, "saint"],
  [/\bSte\b\.?/gi, "sainte"], [/\bMgr\b\.?/gi, "monseigneur"], [/\betc\.?/gi, "et cetera"],
  [/\bTTS\b/g, "té té esse"], [/\bAPI\b/g, "a pé i"], [/\bCPU\b/g, "cé pé u"], [/\bGPU\b/g, "gé pé u"],
];

const SPECIALS_EN: [RegExp, string][] = [
  [/@/g, " at "], [/&/g, " and "], [/%/g, " percent "], [/\+/g, " plus "], [/\\/g, " backslash "],
  [/~/g, " about "], [/<=/g, " less than or equal to "], [/>=/g, " greater than or equal to "],
  [/</g, " less than "], [/>/g, " greater than "], [/=/g, " equals "], [/_/g, " "],
];

const SPECIALS_FR: [RegExp, string][] = [
  [/@/g, " arrobase "], [/&/g, " et "], [/%/g, " pour cent "], [/\+/g, " plus "],
  [/</g, " inférieur à "], [/>/g, " supérieur à "], [/=/g, " égale "], [/_/g, " "],
];

export type TtsLang = "fr" | "en";

function expandInts(text: string, lang: TtsLang): string {
  // dates dd/mm or dd/mm/yyyy
  text = text.replace(/(^|[^\d])(\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)($|[^\d])/g, (m, pre, date, post) => {
    const sep = lang === "fr" ? " tiret " : " dash ";
    return pre + date.split(/[\/.-]/).join(sep) + post;
  });
  // times h:mm / hh:mm:ss
  if (lang === "fr") {
    text = text.replace(/(\d{1,2})h(\d{2})?(?:[mM]in)?/g, (_, h, m) => {
      const hh = parseInt(h);
      const hw = hh === 0 ? "minuit" : hh === 12 ? "midi" : frNumberToWords(hh) + " heures";
      if (!m) return hw;
      const mm = parseInt(m);
      if (mm === 0) return hw;
      return mm < 10 && m[0] === "0" ? hw + " zéro " + frNumberToWords(mm) : hw + " " + frNumberToWords(mm);
    });
  } else {
    text = text.replace(/(\d\d?):(\d\d)(?::(\d\d))?/g, (_, hours, minutes, seconds) => {
      const h = parseInt(hours), m = parseInt(minutes), s = seconds ? parseInt(seconds) : 0;
      if (!seconds) {
        if (m === 0) return h === 0 ? "0" : h > 12 ? `${hours} minutes` : `${hours} o'clock`;
        return minutes.startsWith("0") ? `${hours} oh ${minutes[1]}` : `${hours} ${minutes}`;
      }
      let res = "";
      if (h !== 0) res = hours + " " + (m === 0 ? "oh oh" : minutes.startsWith("0") ? `oh ${minutes[1]}` : minutes);
      else if (m !== 0) res = minutes + " " + (s === 0 ? "oh oh" : seconds.startsWith("0") ? `oh ${seconds[1]}` : seconds);
      else res = seconds;
      return res;
    });
  }
  // ordinals
  if (lang === "fr") {
    text = text.replace(/(\d+)(?:er|re|eme|ème|e)\b/gi, (_, n) => frOrdinal(parseInt(n)));
  } else {
    text = text.replace(/(\d+)(st|nd|rd|th)\b/gi, (_, n) => enOrdinal(parseInt(n)));
  }
  // decimals
  text = text.replace(/(\d+(?:[.,]\d+)+)/g, (m) => {
    const parts = m.split(/[.,]/);
    const whole = lang === "fr" ? frNumberToWords(parseInt(parts[0])) : enNumberToWords(parseInt(parts[0]));
    const digits = parts.slice(1).join("").split("").map((c) =>
      lang === "fr" ? FR_UNITS[parseInt(c)] : enNumberToWords(parseInt(c))).join(" ");
    const sep = lang === "fr" ? " virgule " : " point ";
    return whole + sep + digits;
  });
  // currency
  if (lang === "fr") {
    text = text
      .replace(/€\s*(\d[\d\s.,]*)/g, (_, a) => frNumberToWords(parseFloat(a.replace(/\s/g, "").replace(",", "."))) + " euros")
      .replace(/(\d[\d\s.,]*)\s*€/g, (_, a) => frNumberToWords(parseFloat(a.replace(/\s/g, "").replace(",", "."))) + " euros");
  } else {
    text = text
      .replace(/£([\d,]*\d+)/g, (_, a) => enNumberToWords(parseInt(a.replace(/,/g, ""))) + " pounds")
      .replace(/\$([\d.,]*\d+)/g, (_, amount) => {
        const parts = amount.replace(/,/g, "").split(".");
        const dollars = parseInt(parts[0]) || 0, cents = parts[1] ? parseInt(parts[1]) : 0;
        if (dollars && cents) return `${enNumberToWords(dollars)} ${dollars === 1 ? "dollar" : "dollars"}, ${enNumberToWords(cents)} ${cents === 1 ? "cent" : "cents"}`;
        if (dollars) return `${enNumberToWords(dollars)} ${dollars === 1 ? "dollar" : "dollars"}`;
        if (cents) return `${enNumberToWords(cents)} ${cents === 1 ? "cent" : "cents"}`;
        return "zero dollars";
      });
  }
  // plain integers
  text = text.replace(/\d+/g, (m) => {
    const n = parseInt(m);
    if (n > 1_000_000_000_000) return m;
    return lang === "fr" ? frNumberToWords(n) : enNumberToWords(n);
  });
  return text;
}

export function normalizeForSpeech(text: string, lang: TtsLang): string {
  let t = text.trim();
  if (!t) return "";
  if (lang === "fr") t = t.replace(/;/g, ","); // remove_semicolons per bundle
  t = convertToAscii(t);
  t = t.replace(/\s+/g, " ");
  t = expandInts(t, lang);
  for (const [re, rep] of lang === "fr" ? FR_ABBREVS : EN_ABBREVS) t = t.replace(re, rep);
  for (const [re, rep] of lang === "fr" ? SPECIALS_FR : SPECIALS_EN) t = t.replace(re, rep);
  t = t.replace(/\s+/g, " ").replace(/ ([.,!?])/g, "$1");
  t = t.replace(/\.{3,}/g, "...").replace(/,+/g, ",");
  t = t.trim();
  if (t && /[a-zA-Z0-9]/.test(t[t.length - 1])) t += ".";
  if (t && t[0] === t[0].toLowerCase() && /[a-zA-Z]/.test(t[0])) t = t[0].toUpperCase() + t.slice(1);
  return t;
}

/**
 * Token-aware chunking: split on sentence punctuation into segments, regroup
 * them up to maxTokens, and hard-split any oversized segment.
 */
export function chunkForTts(
  encodeIds: (s: string) => number[],
  decodeIds: (ids: number[]) => string,
  text: string,
  maxTokens: number,
): string[] {
  const list = encodeIds(text);
  if (list.length === 0) return [];
  const punctIds = new Set<number>();
  for (const c of [".", "!", "?", "...", ";", ":", "\n"]) {
    for (const id of encodeIds(c).slice(1)) punctIds.add(id);
  }
  const indices = [0];
  let prev = false;
  for (let i = 0; i < list.length; i++) {
    if (punctIds.has(list[i])) prev = true;
    else if (prev) { indices.push(i); prev = false; }
  }
  indices.push(list.length);

  const segments: { n: number; txt: string }[] = [];
  for (let i = 0; i < indices.length - 1; i++) {
    const s = indices[i], e = indices[i + 1];
    if (e - s === 0) continue;
    segments.push({ n: e - s, txt: decodeIds(list.slice(s, e)) });
  }
  // hard-split oversized segments
  const refined: { n: number; txt: string }[] = [];
  for (const seg of segments) {
    if (seg.n <= maxTokens) { refined.push(seg); continue; }
    const sub = encodeIds(seg.txt.trim());
    for (let i = 0; i < sub.length; i += maxTokens) {
      const window = sub.slice(i, i + maxTokens);
      refined.push({ n: window.length, txt: decodeIds(window).trim() });
    }
  }
  // regroup
  const chunks: string[] = [];
  let cur = "", curN = 0;
  for (const seg of refined) {
    const segText = seg.txt.trim();
    if (!segText) continue;
    if (curN && curN + seg.n > maxTokens) {
      if (cur.trim()) chunks.push(cur.trim());
      cur = segText; curN = seg.n;
    } else {
      cur = cur ? `${cur} ${segText}` : segText;
      curN += seg.n;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}