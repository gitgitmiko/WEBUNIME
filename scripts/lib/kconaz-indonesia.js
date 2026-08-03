/**
 * Scrape film Indonesia dari kconaz.com/country/indonesia/
 * Dipakai oleh scripts/scrape-indonesia.js dan sync katalog.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const KCONAZ_BASE = "https://kconaz.com";
export const INDONESIA_LIST_PATH = "/country/indonesia/";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function fetchKconazHtml(url, referer = `${KCONAZ_BASE}/`) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
      Referer: referer,
    },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} — ${url}`);
  return res.text();
}

export function indonesiaPageUrl(page) {
  if (page <= 1) return `${KCONAZ_BASE}${INDONESIA_LIST_PATH}`;
  return `${KCONAZ_BASE}/country/indonesia/page/${page}/`;
}

function stripTags(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(text) {
  return String(text || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function htmlToMultilineText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function upgradePosterUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  return raw.replace(/-\d+x\d+(\.[a-z0-9]+)$/i, "$1");
}

export function formatKconazDuration(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const min = raw.match(/(\d+)\s*(?:min|menit|m)\b/i);
  if (min) {
    const total = Number(min[1]);
    if (!Number.isFinite(total) || total <= 0) return raw;
    const h = Math.floor(total / 60);
    const m = total % 60;
    if (h && m) return `${h}j ${m}m`;
    if (h) return `${h}j`;
    return `${m}m`;
  }
  const hm = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h === 0) return `${m}m`;
    return `${h}j ${m}m`;
  }
  return raw;
}

function slugFromPath(pathname) {
  return String(pathname || "")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean)
    .pop();
}

function cleanTitle(title) {
  return decodeEntities(stripTags(title))
    .replace(/^Nonton\s+/i, "")
    .replace(/\s+Sub\s+Indo.*$/i, "")
    .trim();
}

function splitNamaTahun(judul) {
  const m = judul.match(/^(.*?)(?:\s*\((\d{4})\))\s*$/);
  if (m) return { nama: m[1].trim(), tahun: m[2] };
  const y = judul.match(/\b(19|20)\d{2}\b/);
  return {
    nama: judul.replace(/\s*\(\d{4}\)\s*$/, "").trim(),
    tahun: y?.[0] || "",
  };
}

function ensureGenre(list, label) {
  const out = [...(list || [])];
  if (label && !out.some((g) => g.toLowerCase() === label.toLowerCase())) {
    out.push(label);
  }
  return out;
}

function extractYear(text) {
  const m = String(text || "").match(/\b((?:19|20)\d{2})\b/);
  return m?.[1] || "";
}

function parseRilisSortKey(rilis) {
  const raw = String(rilis || "").trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const months = {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    mei: "05",
    may: "05",
    jun: "06",
    june: "06",
    jul: "07",
    july: "07",
    agu: "08",
    aug: "08",
    august: "08",
    agustus: "08",
    sep: "09",
    september: "09",
    okt: "10",
    oct: "10",
    october: "10",
    oktober: "10",
    nov: "11",
    november: "11",
    des: "12",
    dec: "12",
    december: "12",
    desember: "12",
  };
  const m = raw.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mon = months[m[2].toLowerCase()];
    if (mon) return `${m[3]}${mon}${m[1].padStart(2, "0")}`;
  }
  return extractYear(raw) ? `${extractYear(raw)}0000` : "00000000";
}

/** Urutkan film terbaru dulu (tahun → tanggal rilis). */
export function sortIndonesiaNewestFirst(movies) {
  return [...movies].sort((a, b) => {
    const ya = Number(a.tahun) || 0;
    const yb = Number(b.tahun) || 0;
    if (yb !== ya) return yb - ya;
    const ra = parseRilisSortKey(a.rilis || a.rilis_iso || "");
    const rb = parseRilisSortKey(b.rilis || b.rilis_iso || "");
    if (rb !== ra) return rb.localeCompare(ra);
    return String(a.nama || "").localeCompare(String(b.nama || ""), "id");
  });
}

function normalizeTitleKey(nama) {
  return String(nama || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Kunci dedup: nama normalisasi + tahun. */
export function indonesiaDedupeKey(namaOrTitle, tahun = "") {
  return `${normalizeTitleKey(namaOrTitle)}|${String(tahun || "").trim()}`;
}

function slugRepostPenalty(slug) {
  const s = String(slug || "").toLowerCase();
  let score = 0;
  if (/-(19|20)\d{2}$/.test(s)) score += 2;
  if (/-\d+$/.test(s.replace(/-(19|20)\d{2}$/, ""))) score += 1;
  return score;
}

/** Pilih listing lebih baik (slug bersih > tanggal rilis lebih baru). */
function preferListing(a, b) {
  const pa = slugRepostPenalty(a.slug);
  const pb = slugRepostPenalty(b.slug);
  if (pa !== pb) return pa < pb ? a : b;
  const ra = parseRilisSortKey(a.rilis_iso || a.rilis || "");
  const rb = parseRilisSortKey(b.rilis_iso || b.rilis || "");
  if (ra !== rb) return ra >= rb ? a : b;
  return a;
}

function pickBestIndonesiaDuplicate(list) {
  if (list.length === 1) return list[0];
  return [...list].sort((a, b) => {
    const ra = parseRilisSortKey(a.rilis_iso || a.rilis || "");
    const rb = parseRilisSortKey(b.rilis_iso || b.rilis || "");
    if (rb !== ra) return rb.localeCompare(ra);
    const pa = Array.isArray(a.players) ? a.players.length : 0;
    const pb = Array.isArray(b.players) ? b.players.length : 0;
    if (pb !== pa) return pb - pa;
    const sa = String(a.sinopsis || "").length;
    const sb = String(b.sinopsis || "").length;
    if (sb !== sa) return sb - sa;
    const pena = slugRepostPenalty(a.slug);
    const penb = slugRepostPenalty(b.slug);
    if (pena !== penb) return pena - penb;
    return String(a.slug || "").localeCompare(String(b.slug || ""));
  })[0];
}

/**
 * Cadangan akhir: dedup nama+tahun (jika ada yang lolos skip saat scrape).
 */
export function dedupeIndonesiaMovies(movies) {
  const groups = new Map();
  for (const m of movies) {
    const key = indonesiaDedupeKey(m.nama || m.judul, m.tahun);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const unique = [];
  for (const list of groups.values()) {
    unique.push(pickBestIndonesiaDuplicate(list));
  }
  // Pasangan judul ID ↔ EN film yang sama (sutradara+pemain+rilis)
  return dedupeIndonesiaAltTitles(unique);
}

const EN_TITLE_WORDS = new Set(
  `
  the of and a an to in for with on at from by or is are was were be been
  black blood tears faith ultimate actor family frugal super business risky
  smothered massacre witches wedding wait believe battle normal woman letter
  youth house haunted dead village bride demon darkness mediterranean sea
  start up never give comedy buddy comic revolution nightborn soulmate voidance
  `.trim().split(/\s+/)
);

const ID_TITLE_WORDS = new Set(
  `
  yang dari untuk dan di ke tak tidak ada ini itu pada dengan sebagai
  cinta hati rumah malam air mata mualaf legenda kelam paling aktor getih ireng
  jodoh bujang keluarga irit pembantaian dukun santet modal nekad takdir mimpi
  keberanian antara mertua menantu sebelum sesudah setelah selepas tahlil
  ibu ayah anak suami istri menantu mertua kafir gerbang sukma esok tanpa
  catatan harian menantu sinting rambut kafan sakaratul maut dilan sumala
  bolehkah sekali saja kumenangis mertua ngeri kali musuh dalam selimut
  pengantin iblis semusim setelah kemarau ambyar mak byar kutukan calon arang
  berebut jenazah dilarang masuk perayaan mati rasa telepon yang tak pernah
  berdering cinta tak pernah tepat waktu vina sebelum hari petaka gunung gede
  pengepungan bukit duri qodrat tujuh hari untuk keshia cinta subuh gowok
  penjagal iblis dosa turunan rego nyowo cocote tonggo rahasia rasa
  patah hati yang kupilih godaan setan yang terkutuk angel pol
  si paling aktor keluarga super irit pembantaian dukun santet
  air mata mualaf legenda kelam malin kundang
  `.trim().split(/\s+/)
);

/** Skor lebih tinggi = judul lebih “berbahasa Indonesia”. */
export function indonesianTitleScore(nama) {
  const words = normalizeTitleKey(nama).split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let score = 0;
  for (const w of words) {
    if (ID_TITLE_WORDS.has(w)) score += 4;
    if (EN_TITLE_WORDS.has(w)) score -= 3;
    if (/^(me|di|ter|ber|pe|se)[a-z]{3,}/.test(w)) score += 1;
    if (/(nya|kan|lah|pun|kah)$/.test(w)) score += 2;
    // Kata Inggris tipikal judul film
    if (/^(the|of|and|with|from|into)$/.test(w)) score -= 2;
  }
  return score;
}

function filmIdentityKey(m) {
  const tahun = String(m.tahun || "").trim();
  const direksi = String(m.direksi || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const pemain = String(m.pemain || "")
    .toLowerCase()
    .replace(/[^a-z0-9,]+/g, " ")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join("|");
  const rilis = String(m.rilis_iso || m.rilis || "")
    .trim()
    .slice(0, 10);
  if (!tahun || !direksi || !pemain) return "";
  return `${tahun}::${direksi}::${pemain}::${rilis}`;
}

function pickPreferredAltTitle(list) {
  if (list.length === 1) return list[0];
  return [...list].sort((a, b) => {
    const sa = indonesianTitleScore(a.nama || a.judul);
    const sb = indonesianTitleScore(b.nama || b.judul);
    if (sb !== sa) return sb - sa;
    // Jika sama-sama ID/EN, pakai aturan dup slug
    return (
      slugRepostPenalty(a.slug) - slugRepostPenalty(b.slug) ||
      String(b.sinopsis || "").length - String(a.sinopsis || "").length ||
      String(a.slug || "").localeCompare(String(b.slug || ""))
    );
  })[0];
}

/**
 * Film yang sama sering diunggah 2x: judul Indonesia + Inggris
 * (Getih Ireng / Black Blood). Simpan yang skor judul ID-nya lebih tinggi.
 * Judul yang memang hanya Inggris (Wed or Wait) tetap.
 */
export function dedupeIndonesiaAltTitles(movies) {
  const groups = new Map();
  const orphans = [];
  for (const m of movies) {
    const key = filmIdentityKey(m);
    if (!key) {
      orphans.push(m);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const unique = [...orphans];
  for (const list of groups.values()) {
    unique.push(pickPreferredAltTitle(list));
  }
  const sorted = sortIndonesiaNewestFirst(unique);
  sorted.forEach((m, idx) => {
    m.id = idx + 1;
  });
  return sorted;
}

/**
 * Masukkan listing dengan skip judul ganda (nama+tahun).
 * @returns {{ added: boolean, skipped: boolean, replaced: boolean }}
 */
function upsertListingUnique(bySlug, byTitle, item) {
  const key = indonesiaDedupeKey(item.title, item.tahun);
  const prev = byTitle.get(key);
  if (!prev) {
    byTitle.set(key, item);
    bySlug.set(item.slug, item);
    return { added: true, skipped: false, replaced: false };
  }
  const best = preferListing(prev, item);
  if (best.slug === prev.slug) {
    return { added: false, skipped: true, replaced: false };
  }
  bySlug.delete(prev.slug);
  bySlug.set(best.slug, best);
  byTitle.set(key, best);
  return { added: false, skipped: false, replaced: true };
}

export function extractKconazListings(html) {
  const items = [];
  const re =
    /<article\b[^>]*itemtype=["']https?:\/\/schema\.org\/Movie["'][^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[0];
    const href =
      block.match(/itemprop=["']url["'][^>]*href=["']([^"']+)["']/i)?.[1] ||
      block.match(/href=["'](https?:\/\/[^"']+|\/[^"']+)["']/i)?.[1];
    if (!href) continue;

    let path;
    try {
      path = new URL(href, KCONAZ_BASE).pathname;
    } catch {
      continue;
    }
    const slug = slugFromPath(path);
    if (
      !slug ||
      /^(country|genre|year|page|category|tag|author|director|cast|search)$/i.test(slug)
    ) {
      continue;
    }

    const title =
      block.match(/entry-title[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ||
      block.match(/title=["']Permalink ke:\s*([^"']+)["']/i)?.[1] ||
      slug;
    const rating =
      block.match(/gmr-rating-item[^>]*>[\s\S]*?<\/span>\s*([^<]+)/i)?.[1]?.trim() ||
      block.match(/itemprop=["']ratingValue["'][^>]*>([^<]+)/i)?.[1]?.trim() ||
      "";
    const durationText =
      block.match(/gmr-duration-item[^>]*>[\s\S]*?<\/svg>\s*([^<]+)/i)?.[1]?.trim() ||
      block.match(/property=["']duration["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
      "";
    const poster =
      block.match(/itemprop=["']image["'][^>]*src=["']([^"']+)["']/i)?.[1] ||
      block.match(/<img[^>]+src=["']([^"']+)["']/i)?.[1] ||
      "";
    const genre = [
      ...block.matchAll(/rel=["']category tag["'][^>]*>([^<]+)/gi),
    ]
      .map((x) => decodeEntities(x[1]).trim())
      .filter(Boolean);
    const rilisIso =
      block.match(/itemprop=["']dateCreated["'][^>]*datetime=["']([^"']+)["']/i)?.[1] ||
      "";
    const rilisText =
      block.match(/itemprop=["']dateCreated["'][^>]*>([^<]+)/i)?.[1]?.trim() || "";
    const tahun = extractYear(rilisIso) || extractYear(rilisText);

    items.push({
      slug,
      path,
      source: `${KCONAZ_BASE}/${slug}/`,
      title: cleanTitle(title),
      tahun,
      rilis: rilisText,
      rilis_iso: rilisIso,
      rating: rating || null,
      durasi: formatKconazDuration(stripTags(durationText)),
      genre,
      thumbnail: upgradePosterUrl(poster),
    });
  }
  return items;
}

export function detectLastIndonesiaPage(html) {
  let max = 1;
  const re = /\/country\/indonesia\/page\/(\d+)\/?/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

function extractMovieDataFields(html) {
  const fields = {};
  const re = /<div class=["']gmr-moviedata["']>([\s\S]*?)<\/div>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const inner = m[1];
    const label = stripTags(inner.match(/<strong>([\s\S]*?)<\/strong>/i)?.[1] || "")
      .replace(/:\s*$/, "")
      .trim()
      .toLowerCase();
    if (!label) continue;
    const valueHtml = inner.replace(/<strong>[\s\S]*?<\/strong>/i, "");
    let value = stripTags(valueHtml).replace(/\s{2,}/g, " ").trim();
    // Normalisasi daftar (genre/pemain), jangan rusak desimal uang "$ 600.000,00"
    if (!/\$/.test(value)) {
      value = value.replace(/\s+,/g, ",").replace(/,\s*/g, ", ");
    } else {
      value = value.replace(/\s+,/g, ",").replace(/,\s+/g, ",");
    }
    if (!value) continue;
    // WordPress kadang cetak tanggal 2x (published + updated teks sama)
    const deduped = value.replace(/\b(.+?)\s+\1\b/g, "$1").trim();
    fields[label] = deduped || value;
  }
  return fields;
}

function pickField(fields, ...keys) {
  for (const key of keys) {
    const found = Object.entries(fields).find(([k]) => k === key || k.startsWith(key));
    if (found?.[1]) return found[1];
  }
  return "";
}

function extractSynopsis(html) {
  const block = html.match(
    /entry-content entry-content-single[^>]*itemprop=["']description["'][^>]*>([\s\S]*?)<div class=["']clearfix content-moviedata["']/i
  );
  if (block) {
    const text = htmlToMultilineText(block[1]);
    if (text) return text;
  }
  const p = html.match(
    /itemprop=["']description["'][^>]*>\s*<p[^>]*>([\s\S]*?)<\/p>/i
  );
  return p ? htmlToMultilineText(p[1]) : "";
}

function buildSinopsis(synopsis, fields) {
  const lines = [];
  if (synopsis) lines.push(synopsis);
  const order = [
    ["oleh", "Oleh"],
    ["diposting pada", "Diposting pada"],
    ["rating", "Rating"],
    ["genre", "Genre"],
    ["tahun", "Tahun"],
    ["durasi", "Durasi"],
    ["negara", "Negara"],
    ["rilis", "Rilis"],
    ["bahasa", "Bahasa"],
    ["anggaran", "Anggaran"],
    ["pendapatan", "Pendapatan"],
    ["direksi", "Direksi"],
    ["pemain", "Pemain"],
  ];
  for (const [key, label] of order) {
    const val = pickField(fields, key);
    if (val) lines.push(`${label}: ${val}`);
  }
  return lines.join("\n\n");
}

export function extractKconazPlayers(html) {
  const players = [];
  const tabScope =
    html.match(/muvipro-player-tabs[^>]*>([\s\S]*?)<\/ul>/i)?.[1] || "";
  const labels = [...tabScope.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)].map((m) =>
    stripTags(m[1])
  );

  const playerRe =
    /id=["']player-(\d+)["'][^>]*>[\s\S]*?<iframe[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = playerRe.exec(html)) !== null) {
    const no = Number(m[1]) || players.length + 1;
    const url = decodeEntities(m[2]).trim();
    if (!url || /^javascript:/i.test(url)) continue;
    const label = labels[no - 1] || `Server ${no}`;
    const host = (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return "embed";
      }
    })();
    players.push({
      no,
      server: host.split(".")[0] || "embed",
      label,
      url,
      default: players.length === 0,
    });
  }

  if (!players.length) {
    const iframe = html.match(
      /gmr-embed-responsive[^>]*>[\s\S]*?<iframe[^>]+src=["']([^"']+)["']/i
    )?.[1];
    if (iframe) {
      players.push({
        no: 1,
        server: "embed",
        label: "Server 1",
        url: decodeEntities(iframe).trim(),
        default: true,
      });
    }
  }

  return players;
}

export function extractKconazDetail(html, fallback = {}) {
  const fields = extractMovieDataFields(html);
  const h1 = cleanTitle(html.match(/<h1[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "");
  const ogTitle = cleanTitle(
    html.match(/property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1] || ""
  );
  const judul = h1 || ogTitle || fallback.title || fallback.judul || fallback.slug;
  const poster =
    upgradePosterUrl(
      html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1] || ""
    ) ||
    upgradePosterUrl(
      html.match(/gmr-movie-data[\s\S]*?<img[^>]+src=["']([^"']+)["']/i)?.[1] || ""
    ) ||
    fallback.thumbnail ||
    "";

  const ratingValue =
    html.match(/itemprop=["']ratingValue["'][^>]*>([^<]+)/i)?.[1]?.trim() ||
    fallback.rating ||
    null;

  const tahun =
    extractYear(pickField(fields, "tahun")) ||
    extractYear(pickField(fields, "rilis")) ||
    fallback.tahun ||
    "";

  const genreRaw = pickField(fields, "genre");
  const genre = genreRaw
    ? genreRaw
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean)
    : fallback.genre || [];

  const durasi =
    formatKconazDuration(pickField(fields, "durasi")) || fallback.durasi || "";
  const rilis = pickField(fields, "rilis") || fallback.rilis || "";
  const rilisIso =
    html.match(/itemprop=["']dateCreated["'][^>]*datetime=["']([^"']+)["']/i)?.[1] ||
    fallback.rilis_iso ||
    "";

  const synopsis = extractSynopsis(html);
  const sinopsis =
    buildSinopsis(synopsis, fields) ||
    `Film ${judul}.`;

  return {
    judul,
    tahun,
    thumbnail: poster,
    rating: ratingValue,
    durasi,
    genre: ensureGenre(genre, "Indonesia"),
    sinopsis,
    rilis,
    rilis_iso: rilisIso,
    negara: pickField(fields, "negara") || "Indonesia",
    bahasa: pickField(fields, "bahasa") || "",
    direksi: pickField(fields, "direksi") || "",
    pemain: pickField(fields, "pemain") || "",
    content_rating: pickField(fields, "rating") || "",
    anggaran: pickField(fields, "anggaran") || "",
    pendapatan: pickField(fields, "pendapatan") || "",
    players: extractKconazPlayers(html),
  };
}

export function buildIndonesiaMovie(item, detail, id) {
  const { nama, tahun: tahunFromTitle } = splitNamaTahun(detail.judul || item.title || "");
  const tahun = detail.tahun || tahunFromTitle || item.tahun || "";
  const namaFinal = nama || item.title || item.slug;
  const judul = detail.judul?.includes("(")
    ? detail.judul
    : `${namaFinal}${tahun ? ` (${tahun})` : ""}`.trim();

  return {
    id,
    nama: namaFinal,
    judul,
    tahun,
    thumbnail: detail.thumbnail || item.thumbnail,
    rating: detail.rating || item.rating || null,
    quality: null,
    durasi: detail.durasi || item.durasi || "",
    genre: detail.genre?.length ? detail.genre : ensureGenre(item.genre, "Indonesia"),
    sinopsis: detail.sinopsis,
    slug: item.slug,
    source: item.source || `${KCONAZ_BASE}/${item.slug}/`,
    catalog: "indonesia",
    rilis: detail.rilis || item.rilis || "",
    rilis_iso: detail.rilis_iso || item.rilis_iso || "",
    negara: detail.negara || "Indonesia",
    bahasa: detail.bahasa || "",
    direksi: detail.direksi || "",
    pemain: detail.pemain || "",
    content_rating: detail.content_rating || "",
    anggaran: detail.anggaran || "",
    pendapatan: detail.pendapatan || "",
    players: detail.players || [],
  };
}

export async function scrapeIndonesiaListings({
  pages = 0,
  start = 1,
  delay = 280,
  log = console.log,
} = {}) {
  const bySlug = new Map();
  const byTitle = new Map();
  let skippedDup = 0;
  let end = start;

  const firstUrl = indonesiaPageUrl(start);
  log(`→ Halaman ${start} ${firstUrl} ...`);
  const firstHtml = await fetchKconazHtml(firstUrl);
  const firstItems = extractKconazListings(firstHtml);
  for (const item of firstItems) {
    const r = upsertListingUnique(bySlug, byTitle, item);
    if (r.skipped || r.replaced) skippedDup += 1;
  }
  const detectedLast = detectLastIndonesiaPage(firstHtml);
  end = pages > 0 ? start + pages - 1 : detectedLast;
  log(
    `  ${firstItems.length} kartu → ${bySlug.size} unik` +
      (skippedDup ? ` (skip/ganti dup ${skippedDup})` : "") +
      ` · halaman terakhir ${detectedLast}, scrape s/d ${end}`
  );

  for (let page = start + 1; page <= end; page++) {
    const url = indonesiaPageUrl(page);
    process.stdout.write(`→ Halaman ${page}/${end} ${url} ... `);
    try {
      const html = await fetchKconazHtml(url);
      const items = extractKconazListings(html);
      let added = 0;
      let pageSkip = 0;
      for (const item of items) {
        const r = upsertListingUnique(bySlug, byTitle, item);
        if (r.added) added += 1;
        if (r.skipped || r.replaced) {
          pageSkip += 1;
          skippedDup += 1;
        }
      }
      console.log(
        `${items.length} kartu, +${added} unik` +
          (pageSkip ? `, skip dup ${pageSkip}` : "") +
          ` (total ${bySlug.size})`
      );
    } catch (err) {
      console.log(`GAGAL: ${err.message}`);
    }
    if (page < end && delay) await sleep(delay);
  }

  log(`\nListing siap: ${bySlug.size} film unik` + (skippedDup ? `, ${skippedDup} duplikat di-skip` : ""));
  return [...bySlug.values()];
}

export async function scrapeIndonesiaDetails(listings, { delay = 280 } = {}) {
  const movies = [];
  const playersMap = {};
  const seenTitle = new Set();
  const seenIdentity = new Set();
  let withPlayers = 0;
  let skippedDup = 0;

  for (let i = 0; i < listings.length; i++) {
    const item = listings[i];
    const n = i + 1;
    const listKey = indonesiaDedupeKey(item.title, item.tahun);
    if (listKey !== "|" && seenTitle.has(listKey)) {
      skippedDup += 1;
      console.log(`→ [${n}/${listings.length}] ${item.slug} ... SKIP dup (${item.title})`);
      continue;
    }
    process.stdout.write(`→ [${n}/${listings.length}] ${item.slug} ... `);
    try {
      const html = await fetchKconazHtml(item.source, `${KCONAZ_BASE}/country/indonesia/`);
      const detail = extractKconazDetail(html, item);
      const movie = buildIndonesiaMovie(item, detail, movies.length + 1);
      const detailKey = indonesiaDedupeKey(movie.nama, movie.tahun);
      if (detailKey !== "|" && seenTitle.has(detailKey)) {
        skippedDup += 1;
        console.log(`SKIP dup setelah detail (${movie.nama} ${movie.tahun})`);
        continue;
      }
      const idKey = filmIdentityKey(movie);
      if (idKey && seenIdentity.has(idKey)) {
        // Sudah punya versi lain (biasanya judul ID) — skip judul EN alternatif
        const existing = movies.find((m) => filmIdentityKey(m) === idKey);
        const keep = pickPreferredAltTitle([existing, movie].filter(Boolean));
        if (keep.slug !== movie.slug) {
          skippedDup += 1;
          console.log(
            `SKIP alt-title EN (${movie.nama}) → kepakai ${keep?.nama || "?"}`
          );
          continue;
        }
        // Versi baru lebih ID: ganti entri lama
        const idx = movies.findIndex((m) => m.slug === existing.slug);
        if (idx >= 0) {
          delete playersMap[existing.slug];
          movies[idx] = movie;
          playersMap[item.slug] = {
            slug: item.slug,
            film: movie.judul,
            source: movie.source,
            catalog: "indonesia",
            scraped_at: new Date().toISOString(),
            players: movie.players,
          };
          if (movie.players.length) withPlayers += 1;
          console.log(`GANTI alt-title → ${movie.nama} (${movie.tahun || "?"})`);
          if (detailKey !== "|") seenTitle.add(detailKey);
          if (listKey !== "|") seenTitle.add(listKey);
          continue;
        }
      }
      if (detailKey !== "|") seenTitle.add(detailKey);
      if (listKey !== "|") seenTitle.add(listKey);
      if (idKey) seenIdentity.add(idKey);
      movies.push(movie);
      playersMap[item.slug] = {
        slug: item.slug,
        film: movie.judul,
        source: movie.source,
        catalog: "indonesia",
        scraped_at: new Date().toISOString(),
        players: movie.players,
      };
      if (movie.players.length) withPlayers += 1;
      console.log(`${movie.players.length} player · tahun ${movie.tahun || "?"}`);
    } catch (err) {
      console.log(`GAGAL: ${err.message}`);
      const detail = extractKconazDetail("", item);
      const movie = buildIndonesiaMovie(item, detail, movies.length + 1);
      const detailKey = indonesiaDedupeKey(movie.nama, movie.tahun);
      if (detailKey !== "|" && seenTitle.has(detailKey)) {
        skippedDup += 1;
        continue;
      }
      if (detailKey !== "|") seenTitle.add(detailKey);
      movies.push(movie);
    }
    if (i < listings.length - 1 && delay) await sleep(delay);
  }

  if (skippedDup) {
    console.log(`\nDetail: ${skippedDup} duplikat/alt-title di-skip.`);
  }

  // Cadangan jika tahun baru terisi di detail dan bentrok
  return { movies: dedupeIndonesiaMovies(movies), playersMap, withPlayers };
}

async function readJsonArray(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function readJsonObject(file) {
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function nextId(items) {
  let max = 0;
  for (const item of items) {
    const n = Number(item.id) || 0;
    if (n > max) max = n;
  }
  return max + 1;
}

/**
 * Sync inkremental: halaman 1 country/indonesia — film baru saja.
 */
export async function syncIndonesiaCatalog(dataDir, { delay = 200 } = {}) {
  const file = join(dataDir, "indonesia.json");
  const playersFile = join(dataDir, "indonesia-players.json");
  const globalPlayersFile = join(dataDir, "players.json");
  const existing = await readJsonArray(file);
  const bySlug = new Map(existing.map((m) => [m.slug, m]));
  const existingTitles = new Set(
    existing.map((m) => indonesiaDedupeKey(m.nama || m.judul, m.tahun)).filter((k) => k !== "|")
  );
  const existingIdentities = new Set(
    existing.map((m) => filmIdentityKey(m)).filter(Boolean)
  );

  process.stdout.write("[kconaz-sync] indonesia /country/indonesia ... ");
  const html = await fetchKconazHtml(indonesiaPageUrl(1));
  const listings = extractKconazListings(html);
  const newcomers = listings.filter((l) => {
    if (bySlug.has(l.slug)) return false;
    const key = indonesiaDedupeKey(l.title, l.tahun);
    if (key !== "|" && existingTitles.has(key)) return false;
    return true;
  });
  console.log(
    `${listings.length} kartu, ${newcomers.length} baru` +
      (newcomers.length ? " → scrape detail" : " (sudah up-to-date)")
  );

  const added = [];
  const addedTitles = new Set();
  const addedIdentities = new Set();
  for (let i = 0; i < newcomers.length; i++) {
    const item = newcomers[i];
    const listKey = indonesiaDedupeKey(item.title, item.tahun);
    if (listKey !== "|" && (existingTitles.has(listKey) || addedTitles.has(listKey))) {
      console.log(`[kconaz-sync] skip dup ${item.slug}`);
      continue;
    }
    try {
      const detailHtml = await fetchKconazHtml(
        item.source,
        `${KCONAZ_BASE}/country/indonesia/`
      );
      const detail = extractKconazDetail(detailHtml, item);
      const movie = buildIndonesiaMovie(item, detail, nextId([...existing, ...added]));
      const detailKey = indonesiaDedupeKey(movie.nama, movie.tahun);
      if (detailKey !== "|" && (existingTitles.has(detailKey) || addedTitles.has(detailKey))) {
        console.log(`[kconaz-sync] skip dup ${movie.slug} (${movie.nama})`);
        continue;
      }
      const idKey = filmIdentityKey(movie);
      if (idKey && (existingIdentities.has(idKey) || addedIdentities.has(idKey))) {
        // Sudah ada versi judul lain (ID/EN) — pilih yang lebih Indonesia
        const rival =
          existing.find((m) => filmIdentityKey(m) === idKey) ||
          added.find((m) => filmIdentityKey(m) === idKey);
        const keep = pickPreferredAltTitle([rival, movie].filter(Boolean));
        if (keep.slug !== movie.slug) {
          console.log(`[kconaz-sync] skip alt-title ${movie.slug} (kepakai ${keep.nama})`);
          continue;
        }
      }
      if (detailKey !== "|") addedTitles.add(detailKey);
      if (listKey !== "|") addedTitles.add(listKey);
      if (idKey) addedIdentities.add(idKey);
      added.push(movie);
      console.log(`[kconaz-sync] +indonesia ${movie.slug} (${movie.tahun || "?"})`);
    } catch (err) {
      console.warn(`[kconaz-sync] indonesia ${item.slug}:`, err.message);
    }
    if (i < newcomers.length - 1) await sleep(delay);
  }

  if (added.length) {
    const merged = dedupeIndonesiaMovies([...added, ...existing]);
    const keptSlugs = new Set(merged.map((m) => m.slug));
    await writeFile(file, JSON.stringify(merged, null, 2) + "\n", "utf8");

    const indonesiaPlayers = await readJsonObject(playersFile);
    const globalPlayers = await readJsonObject(globalPlayersFile);
    for (const movie of added) {
      if (!keptSlugs.has(movie.slug)) continue;
      const entry = {
        slug: movie.slug,
        film: movie.judul,
        source: movie.source,
        catalog: "indonesia",
        scraped_at: new Date().toISOString(),
        players: movie.players,
      };
      indonesiaPlayers[movie.slug] = entry;
      globalPlayers[movie.slug] = entry;
    }
    await writeFile(playersFile, JSON.stringify(indonesiaPlayers, null, 2) + "\n", "utf8");
    await writeFile(globalPlayersFile, JSON.stringify(globalPlayers, null, 2) + "\n", "utf8");
  }

  return {
    checked: listings.length,
    added: added.length,
    updated: 0,
    slugs: added.map((m) => m.slug),
    updatedSlugs: [],
  };
}
