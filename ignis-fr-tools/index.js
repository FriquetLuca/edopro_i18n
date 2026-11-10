#!/usr/bin/env node
'use strict';
/**
 * Sync the French .cdb files of IgnisMulti with the up-to-date BabelCDB / DeltaBagooska.
 *
 *  1. Source .cdb files (same file name as the French ones) tell us WHICH cards exist
 *     and give the language-independent `datas` rows (ATK, DEF, level, type...).
 *  2. passcode -> Konami ID: YGOPRODeck (`misc=yes` -> misc_info[].konami_id),
 *     falling back to the English name via the ygoresources name index.
 *     Alternate artworks have their own passcode, unknown to YGOPRODeck: they are resolved
 *     through the `alias` column of the source `datas` table (the base card), but only if the
 *     base card has the same English name, so a "treated as" alias can't give a wrong card.
 *     Names: the "(Rush)", "(Anime)"... part removed to search is put back on the French name.
 *     Descriptions: the headers are written in French: "[ Effet Pendule ]", "[ Texte de Carte ]",
 *     "[ Effet de Monstre ]".
 *     Names: "TBR - ", "Speed Spell - ", " - TBR" and " TBR)" are also removed to search and put back.
 *     Skipped on purpose (no French text exists anywhere for them): whole files matching
 *     --skip-files, cards whose `ot` flags say Anime / Video game / Rush without OCG or TCG
 *     (EDOPro scope bits 0x4, 0x10, 0x200, from memory, check fr-skipped.json), and names tagged
 *     like "(Anime)". Everything skipped is listed in fr-skipped.json; the checker ignores it.
 *  3. Konami ID -> French name / text: https://db.ygoresources.com/data/card/<id>
 *     Pendulum monsters: ygoresources gives `pendulumEffectText` and `effectText` separately,
 *     in every language. The French description is built by replacing the English texts
 *     inside the SOURCE description with the French ones, so the layout (headers, separator
 *     line, line endings) stays exactly the one of the source .cdb.
 *     If the English wording of the source differs (typical for prerelease .cdb files, which
 *     carry draft translations), a structural fallback is used instead: the source description
 *     is cut at its dashed separator line, each part keeps its own `[ ... ]` header line and
 *     only the text under it is replaced by the French one.
 *     If both fail, the card is skipped and listed in the report (the source description is
 *     saved in cache-failures.json to see why).
 *  4. Last resort for cards still without French text: Cardsrealm (game_id=2, language_code=fr),
 *     searched by the English name without its trailing "(Rush)", "(Anime)"... part.
 *     The answer is only accepted if its English name (`name_ing`) matches the searched name.
 *     Pendulum text ("[ Effet Pendule ]" / "[ Effet Monstre ]") is split and merged into the
 *     source layout like the ygoresources one. Every row coming from Cardsrealm is listed in
 *     fr-cardsrealm.json (nameUntranslated = French name still equal to the English one).
 *
 * Usage (dry run by default, nothing is modified):
 *   node update-french-cdb.js --fr ./IgnisMulti/Français
 *   node update-french-cdb.js --fr ./IgnisMulti/Français --write
 *   node update-french-cdb.js --probe 13092      # print the raw French entry of a Konami ID
 *
 * Options:
 *   --fr <dir>            folder containing the French .cdb files (default: .)
 *   --src <a,b,...>       source folders, later ones override earlier ones
 *                         (default: cdbs/BabelCDB,cdbs/DeltaBagooska)
 *   --write               actually modify the French .cdb files
 *   --refresh             also rewrite name/desc of cards ALREADY in the French .cdb
 *                         (only rows whose text really changed are updated, they are
 *                         listed with old/new text in fr-changes.json). `datas` rows are
 *                         always synced. Existing rows are never replaced by English text.
 *   --no-skip             don't skip Anime / Manga / Rush / video game cards (see below)
 *   --skip-files <regex>  .cdb file names to skip entirely (default: rush|unofficial)
 *   --skip-names <regex>  card-name tags to skip, matched inside the trailing parentheses
 *                         (default: Anime|Manga|Rush|Video Game|Duel Links|Master Duel|...)
 *   --offline             NO network call at all (YGOPRODeck, ygoresources, Cardsrealm): write
 *                         whatever can be built from the cache-*.json files. Use it together
 *                         with --write to write down cards the checker lists as "French text is
 *                         in the cache but not written" (a dry run fills the caches, only
 *                         --write writes the .cdb). Failure records are not touched.
 *   --fix-headers         in the French .cdb, replace the English headers of existing rows
 *                         ("[ Pendulum Effect ]", "[ Flavor Text ]", "[ Monster Effect ]") by
 *                         the French ones, without fetching anything
 *   --retry-konami        ask YGOPRODeck again for passcodes it had no Konami ID for
 *                         (these misses are remembered for 30 days in cache-konami-missing.json)
 *   --no-cardsrealm       don't use Cardsrealm as a last resort (see below)
 *   --retry-cardsrealm    ask Cardsrealm again for names it already failed on
 *   --cardsrealm-strict   reject Cardsrealm results whose French name is still the English one
 *                         (usually a card not translated yet, its text then contains English names)
 *   --probe-cr <name>     print the raw Cardsrealm answer for an English card name, exit
 *   --force               ignore the local ygoresources cache and re-fetch every card needed
 *                         (use with --refresh; one request per card, so avoid on huge runs:
 *                         the cache + /manifest/<revision> already refetch changed cards)
 *   --fallback-en         insert source (English) text when no French text is found
 *   --probe <konamiId>    fetch one card from ygoresources, print its French entry, exit
 *
 * Requires: npm i better-sqlite3   (Node 18+ for global fetch)
 *
 * Caches and fr-report.json are written next to this script (not in the current directory).
 *
 * Be nice to ygoresources (see https://db.ygoresources.com/about/api): everything is
 * cached in cache-*.json, only missing cards are requested, one request at a time, and the
 * X-Cache-Revision header + /manifest/<revision> are used to invalidate changed cards.
 */
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const FR_DIR = path.resolve(opt('fr', '.'));
const SRC_DIRS = opt('src', 'cdbs/BabelCDB,cdbs/DeltaBagooska')
  .split(',')
  .map((d) => path.resolve(d.trim()));
const WRITE = has('write');
const REFRESH = has('refresh');
const FALLBACK_EN = has('fallback-en');
const FORCE = has('force');
const USE_CARDSREALM = !has('no-cardsrealm');
const RETRY_CARDSREALM = has('retry-cardsrealm');
const CR_STRICT = has('cardsrealm-strict');
const RETRY_KONAMI = has('retry-konami');
const OFFLINE = has('offline');
const USE_SKIP = !has('no-skip');
const SKIP_FILES = new RegExp(opt('skip-files', 'rush|unofficial'), 'i');
const SKIP_NAME_TAGS = new RegExp(
  `\\((?:[^()]*\\b)?(?:${opt('skip-names', "Anime|Manga|Rush|Video ?Game|Duel Links|Master Duel|Tag Force|Legacy of the Duelist|Dark Duel Stories|Duel Evolution|Capsule Monster|Zexal|Arc-?V|VRAINS|5D'?s")})\\b[^()]*\\)`,
  'i'
);
// EDOPro scope bits of datas.ot
const SCOPE_OCG = 0x1;
const SCOPE_TCG = 0x2;
const SCOPE_ANIME = 0x4;
const SCOPE_VIDEO_GAME = 0x10;
const SCOPE_RUSH = 0x200;
function skipReason(card) {
  const ot = card.data?.ot ?? 0;
  if (ot & (SCOPE_ANIME | SCOPE_VIDEO_GAME | SCOPE_RUSH) && !(ot & (SCOPE_OCG | SCOPE_TCG)))
    return 'ot flags: Anime / Video game / Rush';
  if (SKIP_NAME_TAGS.test(String(card.text?.name ?? ''))) return 'name tag (Anime, Manga, Rush...)';
  return null;
}
const FIX_HEADERS = has('fix-headers');
const MISSING_TTL_DAYS = 30;

const PRODECK_API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
const YGORES = 'https://db.ygoresources.com';
const CHUNK = 100; // passcodes per YGOPRODeck request
const PRODECK_DELAY_MS = 60; // YGOPRODeck allows 20 requests / second
const YGORES_DELAY_MS = 150; // one card at a time, politely
const TYPE_PENDULUM = 0x1000000;

const FILES = {
  konami: path.join(__dirname, 'cache-konami.json'), // passcode -> Konami ID
  cards: path.join(__dirname, 'cache-ygores-cards.json'), // Konami ID -> {name, effectText, cardType}
  meta: path.join(__dirname, 'cache-ygores-meta.json'), // {revision}
  konamiMissing: path.join(__dirname, 'cache-konami-missing.json'), // passcode -> date YGOPRODeck had no Konami ID
  cardsrealm: path.join(__dirname, 'cache-cardsrealm.json'), // cleaned English name -> {name, desc} | null
  failures: path.join(__dirname, 'cache-failures.json'), // passcode -> {kind, reason, name, date} (read by check-missing-french.js)
  report: path.join(__dirname, 'fr-report.json'),
  changes: path.join(__dirname, 'fr-changes.json'),
  crRows: path.join(__dirname, 'fr-cardsrealm.json'),
  skipped: path.join(__dirname, 'fr-skipped.json'),
};
const load = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : d);
const konamiCache = load(FILES.konami, {});
const cardCache = load(FILES.cards, {});
const meta = load(FILES.meta, { revision: null });
const failures = load(FILES.failures, {});
const crCache = load(FILES.cardsrealm, {});
const konamiMissing = load(FILES.konamiMissing, {});
const today = () => new Date().toISOString().slice(0, 10);
let lastSave = 0;
const saveCaches = () => {
  lastSave = Date.now();
  fs.writeFileSync(FILES.konami, JSON.stringify(konamiCache));
  fs.writeFileSync(FILES.cards, JSON.stringify(cardCache));
  fs.writeFileSync(FILES.meta, JSON.stringify(meta));
  fs.writeFileSync(FILES.failures, JSON.stringify(failures));
  fs.writeFileSync(FILES.cardsrealm, JSON.stringify(crCache));
  fs.writeFileSync(FILES.konamiMissing, JSON.stringify(konamiMissing));
};
/** Periodic save for long loops: at most every 20 s (the caches can be several MB). */
const maybeSave = () => {
  if (Date.now() - lastSave > 20000) saveCaches();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s).replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

async function getJson(url) {
  if (OFFLINE) throw new Error(`offline mode: network call attempted (${url})`);
  const res = await fetch(url);
  const rev = res.headers?.get?.('x-cache-revision');
  if (rev != null && rev !== '') meta.revision = Number(rev);
  if (res.status === 400 || res.status === 404) return { status: res.status, json: null };
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return { status: res.status, json: await res.json() };
}

// ---------------------------------------------------------------- sqlite helpers
function listCdbs(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listCdbs(full));
    else if (e.isFile() && e.name.endsWith('.cdb')) out.push(full);
  }
  return out;
}
const tableExists = (db, name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const columnsOf = (db, table) =>
  db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
const q = (c) => `"${c}"`; // "desc" is an SQL keyword, always quote identifiers

/** Merge all source files sharing a file name: id -> { data, text } */
function loadSource(files) {
  const map = new Map();
  for (const f of files) {
    const db = new Database(f, { readonly: true });
    const dataRows = tableExists(db, 'datas') ? db.prepare('SELECT * FROM datas').all() : [];
    const textRows = tableExists(db, 'texts') ? db.prepare('SELECT * FROM texts').all() : [];
    db.close();
    for (const d of dataRows) map.set(d.id, { ...(map.get(d.id) ?? {}), data: d });
    for (const t of textRows) map.set(t.id, { ...(map.get(t.id) ?? {}), text: t });
  }
  return map;
}

// ---------------------------------------------------------------- ygoresources
/** Drop cached cards that changed since the last run (their /manifest/<revision>). */
async function syncManifest() {
  if (OFFLINE || meta.revision == null) return;
  try {
    const r = await getJson(`${YGORES}/manifest/${meta.revision}`);
    if (!r.json) return;
    let dropped = 0;
    for (const m of JSON.stringify(r.json).matchAll(/card\/(\d+)/g))
      if (cardCache[m[1]] !== undefined) {
        delete cardCache[m[1]];
        dropped++;
      }
    if (dropped) console.log(`ygoresources manifest: ${dropped} cached card(s) invalidated`);
  } catch (e) {
    console.warn(`manifest check failed (${e.message}), continuing with the cache`);
  }
}

const missingThisRun = new Set(); // Konami IDs with no French entry (not persisted)

const freshThisRun = new Set(); // Konami IDs already fetched during this run (for --force)
async function ygoresCard(kid, needPend = false) {
  const cached = cardCache[kid];
  if (OFFLINE) return cached && (!needPend || 'pend' in cached) ? cached : null;
  if (cached && (!needPend || 'pend' in cached) && (!FORCE || freshThisRun.has(kid))) return cached;
  if (missingThisRun.has(kid)) return null;
  await sleep(YGORES_DELAY_MS);
  const r = await getJson(`${YGORES}/data/card/${kid}`);
  const fr = r.json?.cardData?.fr;
  const en = r.json?.cardData?.en ?? {};
  if (!fr || !fr.name) {
    missingThisRun.add(kid);
    return null;
  }
  const entry = { name: fr.name, effectText: fr.effectText ?? '', cardType: fr.cardType ?? '', pend: null };
  if (fr.pendulumEffectText !== undefined || fr.pendulumScale !== undefined)
    entry.pend = {
      frPend: fr.pendulumEffectText ?? '',
      enPend: en.pendulumEffectText ?? '',
      enEffect: en.effectText ?? '',
    };
  cardCache[kid] = entry;
  freshThisRun.add(kid);
  return entry;
}

/** Fuzzy matcher: whitespace and straight/curly quotes are interchangeable. */
const fuzzy = (t) =>
  new RegExp(
    t
      .trim()
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+')
      .replace(/["\u201c\u201d]/g, '["\u201c\u201d]')
      .replace(/['\u2019]/g, "['\u2019]")
  );

/** Build the French description of a Pendulum monster from the source description. */
function composePendulum(srcDesc, fre) {
  if (typeof srcDesc !== 'string' || !fre.pend) return null;
  const nl = srcDesc.includes('\r\n') ? '\r\n' : '\n';
  const toNl = (t) => String(t).replace(/\r?\n/g, nl);
  const pairs = [];
  if (fre.pend.enPend.trim()) pairs.push([fre.pend.enPend, fre.pend.frPend]);
  if (fre.pend.enEffect.trim()) pairs.push([fre.pend.enEffect, fre.desc]);
  if (!pairs.length) return null;
  let out = srcDesc;
  for (const [enText, frText] of pairs) {
    const re = fuzzy(enText);
    if (!re.test(out)) return null;
    out = out.replace(re, () => toNl(frText));
  }
  return out;
}

/**
 * Fallback when the English wording of the source differs from ygoresources' English:
 * cut the source description at its dashed separator line, keep each part's `[ ... ]`
 * header line and replace only the text under it.
 */
function composePendulumStructural(srcDesc, fre) {
  if (typeof srcDesc !== 'string' || !fre.pend || !fre.pend.frPend.trim()) return null;
  const nl = srcDesc.includes('\r\n') ? '\r\n' : '\n';
  const lines = srcDesc.split(/\r?\n/);
  const sep = lines.findIndex((l) => /^-{10,}\s*$/.test(l));
  if (sep <= 0 || sep >= lines.length - 1) return null;
  const rebuild = (part, text) => {
    const hasHeader = part.length > 0 && /^\[.*\]\s*$/.test(part[0].trim());
    return (hasHeader ? [part[0]] : []).concat(String(text).split(/\r?\n/));
  };
  return [...rebuild(lines.slice(0, sep), fre.pend.frPend), lines[sep], ...rebuild(lines.slice(sep + 1), fre.desc)].join(nl);
}

let nameIndex = null; // normalised English name -> Konami ID (lazy, only if needed)
async function lookupByName(name) {
  if (OFFLINE) return undefined;
  if (!nameIndex) {
    nameIndex = new Map();
    const r = await getJson(`${YGORES}/data/idx/card/name/en`);
    const add = (n, id) => {
      if (typeof n === 'string' && Number.isInteger(Number(id))) nameIndex.set(norm(n), Number(id));
    };
    const j = r.json;
    if (Array.isArray(j)) for (const e of j) Array.isArray(e) ? add(e[0], e[1]) : e && add(e.name, e.id);
    else if (j) for (const [k, v] of Object.entries(j)) add(k, Array.isArray(v) ? v[0] : v);
    if (!nameIndex.size) console.warn('name index empty or in an unexpected shape, name fallback disabled');
  }
  return nameIndex.get(norm(name));
}

// ---------------------------------------------------------------- Cardsrealm (last resort, by name)
const CR_URL = 'https://mtg.cardsrealm.com/en-us/api/cardinfo'; // game_id=2 selects Yu-Gi-Oh!
const CR_DELAY_MS = 700; // their limit is 100 requests / minute
/**
 * Markers added to card names in the source databases, removed before searching a card and put
 * back on the French name afterwards:
 *   prefixes: "TBR - Foo", "Speed Spell - Foo"
 *   suffixes: "Foo (Anime)", "Foo (Rush Duel) (Legend)", "Foo - TBR", "Foo TBR)" (typo in a source)
 * The parenthesised group comes first so "(Anime TBR)" is removed as a whole.
 */
const NAME_PREFIXES = [/^TBR\s*-\s*/i, /^Speed Spell\s*-\s*/i];
const NAME_SUFFIXES = [/\s*\([^()]*\)\s*$/, /\s*-\s*TBR\s*$/i, /\s+TBR\)\s*$/i];
function splitName(n) {
  let t = String(n ?? '').trim();
  let prefix = '';
  let suffix = '';
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of NAME_PREFIXES) {
      const m = t.match(re);
      if (m && m[0].length < t.length) {
        prefix += m[0];
        t = t.slice(m[0].length);
        changed = true;
      }
    }
    for (const re of NAME_SUFFIXES) {
      const m = t.match(re);
      if (m && m.index > 0) {
        suffix = t.slice(m.index) + suffix;
        t = t.slice(0, m.index);
        changed = true;
      }
    }
  }
  return { base: t.trim(), prefix, suffix };
}
const cleanName = (n) => splitName(n).base;
/** Put the removed prefix / suffix back on the French name (nothing is added twice). */
function restoreSuffix(srcName, frName) {
  const { base, prefix, suffix } = splitName(srcName);
  if (!base || !frName || (!prefix && !suffix)) return frName;
  let fr = String(frName).trim();
  if (prefix && !fr.startsWith(prefix.trim())) fr = prefix + fr;
  if (suffix && !fr.endsWith(suffix.trim())) fr = fr.trimEnd() + suffix.trimEnd();
  return fr;
}
const HEADERS = [
  [/\[\s*Pendulum Effect\s*\]/g, '[ Effet Pendule ]'],
  [/\[\s*Flavor Text\s*\]/g, '[ Texte de Carte ]'],
  [/\[\s*Monster Effect\s*\]/g, '[ Effet de Monstre ]'],
];
const translateHeaders = (d) => (typeof d === 'string' ? HEADERS.reduce((t, [re, to]) => t.replace(re, to), d) : d);

let warnedShape = false;
/**
 * Real answer shape: name_ing (English name), name_of_card (French name), text_of_card (French text).
 * The answer is rejected if its English name is not the one we searched for (no "nearest card").
 */
function extractFrench(json, searched) {
  const o = Array.isArray(json) ? json[0] : json;
  if (!o || typeof o !== 'object') return null;
  const str = (k) => (typeof o[k] === 'string' && o[k].trim() ? o[k].trim() : null);
  const name = str('name_of_card');
  const desc = str('text_of_card');
  const en = str('name_ing');
  if (!en && !name && !desc) return null; // empty answer = unknown card
  if (!name || !desc || !en) {
    if (!warnedShape) {
      warnedShape = true;
      console.warn(`\n  Cardsrealm answer has an unexpected shape (keys: ${Object.keys(o).join(', ')}), see --probe-cr`);
    }
    return null;
  }
  if (searched && norm(en) !== norm(searched)) return null; // another card
  return { name, desc, nameUntranslated: norm(name) === norm(en) };
}

/** "[ Effet Pendule ]\n<pendulum>\n\n[ Effet Monstre ]\n<monster>" -> {pend, monster} */
function splitPendulumText(text) {
  const sections = String(text)
    .split(/\n\s*\n(?=\s*\[)/)
    .map((sec) => sec.trim())
    .filter(Boolean);
  if (sections.length !== 2) return null;
  const body = (sec) => {
    const m = sec.match(/^\[[^\]\n]*\][ \t]*\n([\s\S]+)$/);
    return m ? m[1].trim() : null;
  };
  const pend = body(sections[0]);
  const monster = body(sections[1]);
  return pend && monster ? { pend, monster } : null;
}
async function cardsrealmRaw(name) {
  const res = await fetch(CR_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ cardname: name, game_id: '2', currency: 'EUR', language_code: 'fr' }),
  });
  if (!res.ok) return { status: res.status, json: null };
  try {
    return { status: res.status, json: await res.json() };
  } catch {
    return { status: res.status, json: null };
  }
}
async function cardsrealmLookup(rawName) {
  const name = cleanName(rawName);
  if (!name) return null;
  if (OFFLINE) return crCache[name] ?? null;
  if (name in crCache && !(crCache[name] === null && RETRY_CARDSREALM)) return crCache[name];
  await sleep(CR_DELAY_MS);
  const { json } = await cardsrealmRaw(name);
  const entry = json ? extractFrench(json, name) : null;
  crCache[name] = entry;
  return entry;
}

// ---------------------------------------------------------------- YGOPRODeck (passcode -> Konami ID)
const daysAgo = (d) => (Date.now() - Date.parse(d)) / 86400000;
const knownMissing = (id) => !RETRY_KONAMI && konamiMissing[id] && daysAgo(konamiMissing[id]) < MISSING_TTL_DAYS;
async function ensureKonami(ids) {
  if (OFFLINE) return;
  const todo = ids.filter((id) => !konamiCache[id] && !knownMissing(id));
  const skipped = ids.filter((id) => !konamiCache[id]).length - todo.length;
  if (skipped) console.log(`  passcode -> Konami ID: ${skipped} passcode(s) without Konami ID remembered from earlier runs (--retry-konami to ask again)`);
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    const r = await getJson(`${PRODECK_API}?id=${chunk.join(',')}&misc=yes`);
    for (const card of r.json?.data ?? []) {
      const kid = card.misc_info?.[0]?.konami_id;
      if (!kid) continue;
      // alternate-artwork passcodes share the same Konami ID
      const all = new Set([card.id, ...(card.card_images ?? []).map((c) => c.id)]);
      for (const pc of all) {
        konamiCache[pc] = kid;
        delete konamiMissing[pc];
      }
    }
    for (const id of chunk) if (!konamiCache[id]) konamiMissing[id] = today();
    process.stdout.write(`\r  passcode -> Konami ID: ${Math.min(i + CHUNK, todo.length)}/${todo.length}`);
    maybeSave();
    await sleep(PRODECK_DELAY_MS);
  }
  if (todo.length) process.stdout.write('\n');
}

/** ids = passcodes; returns {out: Map<id,{name,desc}>, fail: Map<id,reason>} */
async function resolveFrench(ids, src, isPend) {
  // alternate artwork -> base passcode, only when the base card has the very same name
  const aliasOf = (id) => {
    const a = src.get(id).data?.alias;
    if (!a || a === id || !src.has(a)) return 0;
    const mine = norm(cleanName(src.get(id).text?.name));
    return mine && mine === norm(cleanName(src.get(a).text?.name)) ? a : 0;
  };
  await ensureKonami([...new Set(ids.flatMap((id) => [id, aliasOf(id)]).filter(Boolean))]);
  const out = new Map();
  const fail = new Map();
  let n = 0;
  let viaAlias = 0;
  for (const id of ids) {
    let kid = konamiCache[id];
    if (!kid && aliasOf(id) && konamiCache[aliasOf(id)]) {
      kid = konamiCache[aliasOf(id)];
      konamiCache[id] = kid;
      viaAlias++;
    }
    if (!kid) {
      kid = await lookupByName(cleanName(src.get(id).text.name));
      if (kid) konamiCache[id] = kid;
    }
    if (!kid) {
      fail.set(id, { kind: 'no-konami-id', reason: 'no Konami ID found' });
      continue;
    }
    const card = await ygoresCard(kid, isPend(id));
    if (!card) fail.set(id, { kind: 'no-french-entry', reason: `no French entry for Konami ID ${kid}`, konami: kid });
    else out.set(id, { name: card.name, desc: card.effectText, pend: card.pend, konami: kid });
    if (++n % 25 === 0) {
      process.stdout.write(`\r  French text: ${n}/${ids.length}`);
      maybeSave();
    }
  }
  if (ids.length) process.stdout.write(`\r  French text: ${ids.length}/${ids.length}\n`);
  const kinds = [...fail.values()].reduce((m, f) => ((m[f.kind] = (m[f.kind] ?? 0) + 1), m), {});
  if (viaAlias) console.log(`  ${viaAlias} alternate artwork(s) resolved through their base card`);
  if (fail.size)
    console.log(`  ${fail.size} card(s) without French text from ygoresources (${kinds['no-konami-id'] ?? 0} without Konami ID, ${kinds['no-french-entry'] ?? 0} with a Konami ID but no French entry)${USE_CARDSREALM && !OFFLINE ? ': only these are searched on Cardsrealm' : ''}`);
  if (USE_CARDSREALM) {
    const todo = [...fail.keys()];
    const started = Date.now();
    let k = 0;
    let found = 0;
    for (const id of todo) {
      const cr = await cardsrealmLookup(src.get(id).text.name);
      if (cr && !(CR_STRICT && cr.nameUntranslated)) {
        const why = fail.get(id);
        let entry = { name: cr.name, desc: cr.desc, pend: null, konami: why?.konami ?? null, via: 'cardsrealm', nameUntranslated: cr.nameUntranslated, why: why?.kind };
        let usable = true;
        if (isPend(id)) {
          const sp = splitPendulumText(cr.desc);
          if (sp) entry = { ...entry, desc: sp.monster, pend: { frPend: sp.pend, enPend: '', enEffect: '' } };
          else usable = false; // Pendulum text in an unknown format
        }
        if (usable) {
          out.set(id, entry);
          fail.delete(id);
          found++;
        }
      }
      if (++k % 20 === 0) {
        const left = Math.round(((Date.now() - started) / k) * (todo.length - k) / 60000);
        process.stdout.write(`\r  Cardsrealm: ${k}/${todo.length} (${found} found, ~${left} min left)   `);
        maybeSave();
      }
    }
    if (todo.length) process.stdout.write(`\r  Cardsrealm: ${todo.length}/${todo.length} (${found} found)                    \n`);
  }
  if (!OFFLINE) for (const [id, f] of fail) failures[id] = { ...f, name: src.get(id).text.name, date: today() }; // offline = not tried, nothing to record
  saveCaches();
  return { out, fail };
}

// ---------------------------------------------------------------- main
async function probe(kid) {
  const r = await getJson(`${YGORES}/data/card/${kid}`);
  const fr = r.json?.cardData?.fr;
  if (!fr) return console.log('no French entry (or unknown Konami ID)');
  const { prints, thisSrc, ...rest } = fr;
  console.log(JSON.stringify(rest, null, 2));
}

/** Replace the English headers by the French ones in the existing rows. No network. */
function fixHeaders(frFiles) {
  for (const f of frFiles) {
    const db = new Database(f, { readonly: !WRITE });
    if (!tableExists(db, 'texts')) {
      db.close();
      continue;
    }
    const rows = db
      .prepare('SELECT id, "desc" AS d FROM texts WHERE "desc" LIKE ? OR "desc" LIKE ? OR "desc" LIKE ?')
      .all('%Pendulum Effect%', '%Flavor Text%', '%Monster Effect%')
      .map((r) => ({ id: r.id, old: r.d, d: translateHeaders(r.d) }))
      .filter((r) => r.d !== r.old);
    if (WRITE && rows.length) {
      const upd = db.prepare('UPDATE texts SET "desc" = ? WHERE id = ?');
      db.transaction(() => rows.forEach((r) => upd.run(r.d, r.id)))();
    }
    console.log(`- ${path.basename(f)}: ${rows.length} row(s) with English headers ${WRITE ? 'fixed' : '(dry run)'}`);
    db.close();
  }
}

async function probeCr(name) {
  const clean = cleanName(name);
  console.log(`Cardsrealm lookup for "${clean}" (cleaned from "${name}")`);
  const r = await cardsrealmRaw(clean);
  console.log(`HTTP ${r.status}`);
  console.log(JSON.stringify(r.json, null, 2));
  console.log('extracted:', extractFrench(r.json, clean));
  const sp = r.json && splitPendulumText(r.json.text_of_card ?? '');
  if (sp) console.log('Pendulum split:', sp);
}

async function main() {
  if (has('probe')) return probe(opt('probe'));
  if (has('probe-cr')) return probeCr(opt('probe-cr'));

  const frFiles = listCdbs(FR_DIR).filter((f) => path.dirname(f) === FR_DIR);
  if (!frFiles.length) throw new Error(`No .cdb files in ${FR_DIR}`);

  const srcByName = new Map();
  for (const dir of SRC_DIRS)
    for (const f of listCdbs(dir)) {
      const n = path.basename(f);
      srcByName.set(n, [...(srcByName.get(n) ?? []), f]);
    }

  if (FIX_HEADERS) fixHeaders(frFiles);

  await syncManifest();
  const report = {};
  const changes = {};
  const crRows = []; // rows from Cardsrealm seen in this run
  const crGone = []; // keys of rows now covered by ygoresources
  const skippedList = []; // cards / files skipped on purpose
  const processed = new Set(); // French .cdb names handled in this run

  for (const frFile of frFiles) {
    const name = path.basename(frFile);
    const srcFiles = srcByName.get(name);
    if (!srcFiles) {
      console.log(`- ${name}: no matching source file, skipped`);
      continue;
    }
    if (USE_SKIP && SKIP_FILES.test(name)) {
      console.log(`- ${name}: skipped (file name matches --skip-files /${SKIP_FILES.source}/)`);
      skippedList.push({ cdb: name, all: true, reason: 'file name' });
      processed.add(name);
      continue;
    }
    console.log(`- ${name}: ${srcFiles.length} source file(s)`);
    processed.add(name);

    const src = loadSource(srcFiles);
    const fr = new Database(frFile, { readonly: !WRITE });
    const hasTexts = tableExists(fr, 'texts');
    const hasDatas = tableExists(fr, 'datas');
    if (!hasTexts) {
      console.log('  no `texts` table, skipped');
      fr.close();
      continue;
    }

    const frTexts = new Map(fr.prepare('SELECT id, name, "desc" FROM texts').all().map((r) => [r.id, r]));
    const frTextIds = new Set(frTexts.keys());
    const frDatas = new Map();
    if (hasDatas) for (const r of fr.prepare('SELECT * FROM datas').all()) frDatas.set(r.id, r);
    const textCols = columnsOf(fr, 'texts');
    const dataCols = hasDatas ? columnsOf(fr, 'datas') : [];

    const isPend = (id) => ((src.get(id).data?.type ?? 0) & TYPE_PENDULUM) !== 0;
    const skipCounts = {};
    const wanted = [...src.keys()].filter((id) => {
      const c = src.get(id);
      if (!c.text || !(REFRESH || !frTextIds.has(id))) return false;
      const why = USE_SKIP ? skipReason(c) : null;
      if (why) {
        skipCounts[why] = (skipCounts[why] ?? 0) + 1;
        skippedList.push({ cdb: name, id, name: c.text.name, reason: why });
        return false;
      }
      return true;
    });
    const nSkipped = Object.values(skipCounts).reduce((a, b) => a + b, 0);
    if (nSkipped) console.log(`  ${nSkipped} card(s) skipped on purpose (${Object.entries(skipCounts).map(([k, v]) => `${v}: ${k}`).join('; ')})`);
    console.log(`  ${wanted.length} card(s) need French text`);
    const { out: french, fail } = wanted.length
      ? await resolveFrench(wanted, src, isPend)
      : { out: new Map(), fail: new Map() };

    const insertText = WRITE
      ? fr.prepare(`INSERT INTO texts (${textCols.map(q).join(',')}) VALUES (${textCols.map(() => '?').join(',')})`)
      : null;
    const updateText = WRITE ? fr.prepare(`UPDATE texts SET ${q('name')}=?, ${q('desc')}=? WHERE id=?`) : null;
    const replaceData =
      WRITE && hasDatas
        ? fr.prepare(`INSERT OR REPLACE INTO datas (${dataCols.map(q).join(',')}) VALUES (${dataCols.map(() => '?').join(',')})`)
        : null;

    const stats = { inserted: 0, updated: 0, unchanged: 0, datas: 0, fallback: 0, structural: 0, cardsrealm: 0, notFound: [], changes: [] };

    const apply = () => {
      const known = new Set(frTextIds); // ids that will have a French texts row
      for (const id of wanted) {
        const s = src.get(id).text;
        let fre = french.get(id);
        if (!fre) {
          if (!FALLBACK_EN || frTextIds.has(id)) {
            stats.notFound.push({ id, name: s.name, reason: fail.get(id)?.reason ?? 'unknown' });
            continue;
          }
          fre = { name: s.name, desc: s.desc };
          stats.fallback++;
        }
        // keep the line-ending style used by the source database
        let desc;
        if (isPend(id) && french.has(id)) {
          desc = fre.pend ? composePendulum(s.desc, fre) : null;
          if (desc === null && fre.pend) {
            desc = composePendulumStructural(s.desc, fre);
            if (desc !== null) stats.structural++;
          }
          if (desc === null) {
            const reason = fre.pend
              ? 'French text found but the source description could not be merged (no matching English text, no dashed separator line)'
              : 'source says Pendulum but no Pendulum text was found for this card';
            failures[id] = {
              kind: 'pendulum-layout',
              reason,
              konami: fre.konami,
              name: s.name,
              date: today(),
              detail: { srcDesc: String(s.desc ?? '').slice(0, 600), enPend: String(fre.pend?.enPend ?? '').slice(0, 300), enEffect: String(fre.pend?.enEffect ?? '').slice(0, 300) },
            };
            stats.notFound.push({ id, name: s.name, reason });
            continue;
          }
        } else {
          const crlf = typeof s.desc === 'string' && s.desc.includes('\r\n');
          desc = crlf ? String(fre.desc).replace(/\r?\n/g, '\r\n') : fre.desc;
        }

        let frName = fre.name;
        if (french.has(id)) {
          delete failures[id]; // French text found and usable
          frName = restoreSuffix(s.name, fre.name);
          desc = translateHeaders(desc);
        }
        if (fre.via === 'cardsrealm') {
          stats.cardsrealm++;
          crRows.push({ cdb: name, id, englishName: s.name, frenchName: frName, nameUntranslated: !!fre.nameUntranslated, why: fre.why, konamiId: fre.konami ?? null });
        } else if (french.has(id)) crGone.push(`${name}:${id}`);
        if (frTextIds.has(id)) {
          const old = frTexts.get(id);
          if (old.name === frName && old.desc === desc) {
            stats.unchanged++;
            continue;
          }
          if (WRITE) updateText.run(frName, desc, id);
          stats.updated++;
          stats.changes.push({ id, oldName: old.name, newName: frName, oldDesc: old.desc, newDesc: desc });
        } else {
          // str1..str16 (script prompts) are copied from the source as a fallback
          if (WRITE) {
            const row = textCols.map((c) => (c === 'id' ? id : c === 'name' ? frName : c === 'desc' ? desc : s[c] ?? ''));
            insertText.run(...row);
          }
          stats.inserted++;
          known.add(id);
        }
      }
      if (hasDatas) {
        for (const [id, { data }] of src) {
          if (!data || !known.has(id)) continue; // no orphan datas rows
          const old = frDatas.get(id);
          if (old && dataCols.every((c) => old[c] === (data[c] ?? 0))) continue;
          if (WRITE) replaceData.run(...dataCols.map((c) => data[c] ?? 0));
          stats.datas++;
        }
      }
    };

    if (WRITE) fr.transaction(apply)();
    else apply(); // dry run: only counts, no statement is executed

    console.log(
      `  texts: +${stats.inserted} inserted, ${stats.updated} updated` +
        (REFRESH ? `, ${stats.unchanged} unchanged` : '') +
        (stats.structural ? ` (${stats.structural} Pendulum via structural layout)` : '') +
        (stats.cardsrealm ? ` (${stats.cardsrealm} via Cardsrealm)` : '') +
        (stats.fallback ? ` (${stats.fallback} with English fallback)` : '') +
        `; datas: ${stats.datas} synced; no French text for ${stats.notFound.length}`
    );
    if (stats.notFound.length) report[name] = stats.notFound;
    if (stats.changes.length) changes[name] = stats.changes;
    fr.close();
  }

  saveCaches();
  {
    // keep the entries of .cdb files not processed in this run
    const kept = load(FILES.skipped, []).filter((r) => !processed.has(r.cdb));
    fs.writeFileSync(FILES.skipped, JSON.stringify([...kept, ...skippedList], null, 2));
  }
  fs.writeFileSync(FILES.report, JSON.stringify(report, null, 2));
  fs.writeFileSync(FILES.changes, JSON.stringify(changes, null, 2));
  if (WRITE && USE_CARDSREALM) {
    // cumulative list of the rows that came from Cardsrealm (read by check-missing-french.js)
    const all = new Map(load(FILES.crRows, []).map((r) => [`${r.cdb}:${r.id}`, r]));
    for (const k of crGone) all.delete(k);
    for (const r of crRows) all.set(`${r.cdb}:${r.id}`, r);
    fs.writeFileSync(FILES.crRows, JSON.stringify([...all.values()], null, 2));
  }
  console.log(`\n${WRITE ? 'Changes written.' : 'Dry run only, use --write to apply.'}`);
  console.log(`Cards without French text are listed in ${FILES.report}`);
  if (skippedList.length) console.log(`Skipped on purpose (check that nothing real is in there): ${FILES.skipped}`);
  if (crRows.length) console.log(`${crRows.length} row(s) come from Cardsrealm (${crRows.filter((r) => r.nameUntranslated).length} with a French name still equal to the English one)${WRITE ? `, listed in ${FILES.crRows}` : ''}`);
  if (REFRESH) console.log(`Rows whose text changed (old -> new) are listed in ${FILES.changes}`);
}

main().catch((e) => {
  saveCaches();
  console.error(e);
  process.exit(1);
});