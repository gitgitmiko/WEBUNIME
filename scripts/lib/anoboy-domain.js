/**
 * Domain Anoboy sering pindah (anoboy.xyz → anoboy.quest → anoboy.at → …).
 *
 * resolveAnoboyBase() dipanggil sekali sebelum scraping:
 * 1. ANOBOY_BASE (env) → domain tersimpan (cache lokal) → KNOWN_BASES.
 *    Redirect diikuti, jadi domain lama yang redirect ke domain baru langsung ketemu.
 * 2. Semua gagal → cari kandidat baru: hasil Bing/Google/DuckDuckGo + tebak TLD.
 * Domain yang lolos dicek isinya (harus benar-benar halaman Anoboy), lalu disimpan.
 *
 * URL lama di katalog (source/thumbnail) dipindah ke domain aktif lewat
 * rewriteAnoboyHost() / migrateAnoboyHosts().
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Urutan = prioritas. Tambah domain baru di depan kalau sudah diketahui. */
export const KNOWN_BASES = ["https://anoboy.at", "https://anoboy.quest"];

const CACHE_FILE = join("scripts", "_anoboy-scrape", "domain.json");
const PROBE_TIMEOUT_MS = 15000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** TLD yang biasa dipakai situs streaming saat pindah domain. */
const GUESS_TLDS = [
  "at", "quest", "xyz", "io", "tv", "me", "ch", "to", "li", "cc", "lol", "one",
  "pro", "top", "fun", "site", "live", "stream", "ink", "biz", "info", "net",
  "org", "com", "co", "in", "id", "my.id", "web.id", "pw", "ws", "vip", "icu",
];

/** Semua host anoboy.<tld> (termasuk www.) di dalam URL. */
export const ANOBOY_HOST_RE = /https?:\/\/(?:www\.)?anoboy\.[a-z]{2,10}(?:\.[a-z]{2,4})?(?=[/?#"'\s]|$)/gi;

let current = (process.env.ANOBOY_BASE || KNOWN_BASES[0]).replace(/\/+$/, "");
let resolving = null;

/** Domain aktif saat ini (sinkron; panggil resolveAnoboyBase() dulu). */
export function anoboyBase() {
  return current;
}

/** URL di host anoboy mana pun → host aktif. */
export function rewriteAnoboyHost(url, base = current) {
  return String(url || "").replace(ANOBOY_HOST_RE, base);
}

/** True kalau URL memakai host anoboy (domain apa pun). */
export function isAnoboyUrl(url) {
  ANOBOY_HOST_RE.lastIndex = 0;
  const ok = ANOBOY_HOST_RE.test(String(url || ""));
  ANOBOY_HOST_RE.lastIndex = 0;
  return ok;
}

/** Path saja (tanpa host) — untuk membandingkan URL lintas domain. */
export function anoboyPathKey(url) {
  return rewriteAnoboyHost(url, "").replace(/\/+$/, "").toLowerCase();
}

function looksLikeAnoboy(html) {
  const title = (String(html).match(/<title[^>]*>([^<]*)/i) || [])[1] || "";
  return /anoboy/i.test(title) && /\/anime-movie\/|home_index|wp-pagenavi/i.test(html);
}

/** Cek satu domain; kembalikan origin final (setelah redirect) atau null. */
async function probe(base) {
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/`, {
      headers: { "user-agent": UA },
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return null;
    if (!looksLikeAnoboy(await res.text())) return null;
    return new URL(res.url).origin;
  } catch {
    return null;
  }
}

/** Host anoboy.<tld> yang muncul di hasil mesin pencari (best-effort). */
async function searchCandidates() {
  const engines = [
    "https://www.bing.com/search?q=anoboy+nonton+anime+subtitle+indonesia",
    "https://html.duckduckgo.com/html/?q=anoboy+nonton+anime",
    "https://www.google.com/search?q=anoboy+nonton+anime+subtitle+indonesia&hl=id",
  ];
  const found = new Set();
  await Promise.all(
    engines.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { "user-agent": UA, "accept-language": "id,en;q=0.8" },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        const html = await res.text();
        // Google membungkus link: /url?q=https://anoboy.xx/… — decode dulu.
        const text = decodeURIComponent(html.replace(/%(?![0-9a-f]{2})/gi, "%25"));
        for (const m of text.matchAll(ANOBOY_HOST_RE)) {
          found.add(new URL(m[0]).origin.replace("://www.", "://"));
        }
      } catch {
        /* mesin pencari diblokir / timeout — lanjut */
      }
    }),
  );
  return [...found];
}

async function readCache() {
  try {
    const data = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    return typeof data?.base === "string" ? data.base : "";
  } catch {
    return "";
  }
}

async function writeCache(base) {
  try {
    await mkdir(join("scripts", "_anoboy-scrape"), { recursive: true });
    await writeFile(
      CACHE_FILE,
      `${JSON.stringify({ base, checkedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch {
    /* cache opsional */
  }
}

/** Probe paralel; ambil yang lolos dengan prioritas paling depan. */
async function firstAlive(bases) {
  const results = await Promise.all(bases.map((b) => probe(b)));
  return results.find(Boolean) || null;
}

async function resolve() {
  const primary = [
    ...new Set(
      [process.env.ANOBOY_BASE, await readCache(), ...KNOWN_BASES]
        .filter(Boolean)
        .map((b) => b.replace(/\/+$/, "")),
    ),
  ];
  for (const base of primary) {
    const ok = await probe(base);
    if (ok) return ok;
    console.warn(`[anoboy-domain] ${base} tidak bisa diakses`);
  }

  console.warn("[anoboy-domain] semua domain dikenal mati → cari domain baru…");
  const fromSearch = (await searchCandidates()).filter((b) => !primary.includes(b));
  if (fromSearch.length) {
    console.log(`[anoboy-domain] kandidat pencarian: ${fromSearch.join(", ")}`);
    const ok = await firstAlive(fromSearch);
    if (ok) return ok;
  }
  const guesses = GUESS_TLDS.map((tld) => `https://anoboy.${tld}`).filter(
    (b) => !primary.includes(b) && !fromSearch.includes(b),
  );
  return firstAlive(guesses);
}

/**
 * Tentukan domain Anoboy aktif (sekali per proses).
 * Gagal total → tetap pakai domain default, scraping akan error seperti biasa.
 */
export function resolveAnoboyBase() {
  if (!resolving) {
    resolving = resolve().then(async (found) => {
      if (!found) {
        console.warn(`[anoboy-domain] domain baru tidak ditemukan, pakai ${current}`);
        return current;
      }
      if (found !== current) console.log(`[anoboy-domain] domain aktif: ${found}`);
      else console.log(`[anoboy-domain] base OK: ${found}`);
      current = found;
      await writeCache(found);
      return found;
    });
  }
  return resolving;
}

/**
 * Ganti host anoboy lama di file JSON katalog → host aktif.
 * Dipanggil setelah resolveAnoboyBase(); hanya menulis file yang berubah.
 */
export async function migrateAnoboyHosts(dirs, files) {
  const names = files || [
    "anime.json",
    "anime-index.json",
    "anime-movies.json",
    "anoboy-movies-skipped.json",
  ];
  let changed = 0;
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name);
      let text;
      try {
        text = await readFile(path, "utf8");
      } catch {
        continue;
      }
      // JSON.stringify bisa escape "/" → tangani juga "https:\/\/anoboy.xx".
      const next = rewriteAnoboyHost(text).replace(
        /https?:\\\/\\\/(?:www\.)?anoboy\.[a-z]{2,10}(?:\.[a-z]{2,4})?(?=\\\/|")/gi,
        current.replace(/\//g, "\\/"),
      );
      if (next !== text) {
        await writeFile(path, next);
        changed++;
      }
    }
  }
  if (changed) console.log(`[anoboy-domain] host di ${changed} file dipindah ke ${current}`);
  return changed;
}
