/**
 * Resolver domain untuk situs sumber yang sering pindah domain
 * (Anoboy, LK21, nontondrama, Samehadaku).
 *
 * resolve() mencari domain aktif:
 * 1. env → domain cache terakhir → knownBases (berurutan; redirect diikuti,
 *    jadi mirror lama yang redirect ke domain baru langsung ketemu).
 * 2. Semua gagal → kandidat dari mesin pencari + tebakan (pola subdomain/TLD),
 *    dicek paralel.
 * Kandidat lolos kalau halamannya cocok looksLikeSite(). Situs di balik Cloudflare
 * (fetch biasa selalu 403 challenge) dianggap "hidup, belum terverifikasi" dan
 * dipastikan lewat opts.verify (mis. sesi Playwright) bila diberikan.
 *
 * rewrite()/migrate() memindahkan URL domain lama di katalog ke domain aktif.
 */
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const CACHE_DIR = join("scripts", "_domain-cache");
const PROBE_TIMEOUT_MS = 15000;
const DISCOVERY_CONCURRENCY = 6;
/** Hasil resolve dipakai ulang selama ini (server jalan lama → cek ulang berkala). */
const RESOLVE_TTL_MS = 30 * 60 * 1000;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** TLD yang biasa dipakai situs streaming saat pindah domain. */
export const COMMON_TLDS = [
  "at", "quest", "xyz", "io", "tv", "me", "ch", "to", "li", "cc", "lol", "one",
  "pro", "top", "fun", "site", "live", "stream", "ink", "biz", "info", "net",
  "org", "com", "co", "in", "id", "my", "vip", "how", "email", "my.id", "web.id",
  "pw", "ws", "icu", "mom", "skin", "cam", "day",
];

export function pageTitle(html) {
  return (String(html || "").match(/<title[^>]*>([^<]*)/i) || [])[1] || "";
}

async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: size }, worker));
  return out;
}

function trimBase(b) {
  return String(b || "").trim().replace(/\/+$/, "");
}

/**
 * @param {object} cfg
 * @param {string} cfg.name            label log + nama file cache
 * @param {string} [cfg.envVar]        env override (mis. LK21_BASE_URL)
 * @param {string[]} cfg.knownBases    urutan = prioritas
 * @param {string} cfg.host            source regex host (tanpa skema), mis. "(?:tv\\d*\\.)?lk21official\\.[a-z]{2,10}"
 * @param {(html: string) => boolean} cfg.looksLikeSite
 * @param {() => string[]} [cfg.guesses]   kandidat tebakan saat semua domain dikenal mati
 * @param {string} [cfg.searchQuery]
 * @param {string} [cfg.probePath]     path yang di-probe (default "/")
 * @param {number} [cfg.maxDiscoveryVerify]  batas kandidat tebakan yang di-verify (default 5)
 */
export function createSiteDomain(cfg) {
  const tag = `[${cfg.name}-domain]`;
  const hostRe = () =>
    new RegExp(`https?://${cfg.host}(?=[/?#"'\\s\\\\]|$)`, "gi");
  // JSON.stringify bisa escape "/" → "https:\/\/host".
  const escapedHostRe = () => new RegExp(`https?:\\\\/\\\\/${cfg.host}(?=\\\\/|")`, "gi");
  const cacheFile = join(CACHE_DIR, `${cfg.name}.json`);

  let current = trimBase((cfg.envVar && process.env[cfg.envVar]) || cfg.knownBases[0]);
  let resolving = null;
  let resolvedAt = 0;
  let lastOk = false;

  const base = () => current;

  /** URL di host situs ini (domain apa pun) → host aktif. */
  const rewrite = (url, to = current) => String(url || "").replace(hostRe(), to);

  const isSiteUrl = (url) => hostRe().test(String(url || ""));

  /** URL situs ini yang masih memakai domain lama. */
  const isStale = (url) => isSiteUrl(url) && rewrite(url) !== url;

  /** Path saja (tanpa host) — untuk membandingkan URL lintas domain. */
  const pathKey = (url) => rewrite(url, "").replace(/\/+$/, "").toLowerCase();

  /** {origin, verified} | null. verified=false → hidup tapi tertahan Cloudflare. */
  async function probe(candidate) {
    try {
      const res = await fetch(`${trimBase(candidate)}${cfg.probePath || "/"}`, {
        headers: { "user-agent": UA, "accept-language": "id-ID,id;q=0.9,en;q=0.8" },
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const origin = new URL(res.url).origin;
      const html = await res.text();
      if (res.status === 200 && cfg.looksLikeSite(html)) return { origin, verified: true };
      if (
        (res.status === 403 || res.status === 503) &&
        res.headers.get("cf-mitigated") === "challenge"
      ) {
        return { origin, verified: false };
      }
      return null;
    } catch {
      return null;
    }
  }

  async function searchCandidates() {
    if (!cfg.searchQuery) return [];
    const q = encodeURIComponent(cfg.searchQuery);
    const engines = [
      `https://www.bing.com/search?q=${q}`,
      `https://html.duckduckgo.com/html/?q=${q}`,
      `https://www.google.com/search?q=${q}&hl=id`,
    ];
    const found = new Set();
    await Promise.all(
      engines.map(async (url) => {
        try {
          const res = await fetch(url, {
            headers: { "user-agent": UA, "accept-language": "id,en;q=0.8" },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          // Google membungkus link: /url?q=https://host/… — decode dulu.
          const html = await res.text();
          const text = decodeURIComponent(html.replace(/%(?![0-9a-f]{2})/gi, "%25"));
          for (const m of text.matchAll(hostRe())) found.add(new URL(m[0]).origin);
        } catch {
          /* mesin pencari diblokir / timeout — lanjut */
        }
      }),
    );
    return [...found];
  }

  async function readCache() {
    try {
      const data = JSON.parse(await readFile(cacheFile, "utf8"));
      return typeof data?.base === "string" ? data.base : "";
    } catch {
      return "";
    }
  }

  async function writeCache(found) {
    try {
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(
        cacheFile,
        `${JSON.stringify({ base: found, checkedAt: new Date().toISOString() }, null, 2)}\n`,
      );
    } catch {
      /* cache opsional */
    }
  }

  async function search(verify) {
    const seen = new Set();
    /** Terima hasil probe; kandidat Cloudflare dipastikan lewat verify. */
    const accept = async (r) => {
      if (!r || seen.has(r.origin)) return null;
      seen.add(r.origin);
      if (r.verified || !verify) return r.origin;
      try {
        return (await verify(r.origin)) ? r.origin : null;
      } catch (err) {
        console.warn(`${tag} verifikasi ${r.origin} gagal: ${err.message}`);
        return null;
      }
    };

    const primary = [
      ...new Set(
        [cfg.envVar && process.env[cfg.envVar], await readCache(), ...cfg.knownBases]
          .filter(Boolean)
          .map(trimBase),
      ),
    ];
    for (const candidate of primary) {
      const ok = await accept(await probe(candidate));
      if (ok) return ok;
      console.warn(`${tag} ${candidate} tidak bisa diakses`);
    }

    console.warn(`${tag} semua domain dikenal gagal → cari domain baru…`);
    const fromSearch = (await searchCandidates()).filter((b) => !primary.includes(b));
    if (fromSearch.length) console.log(`${tag} kandidat pencarian: ${fromSearch.join(", ")}`);
    const guesses = (cfg.guesses ? cfg.guesses() : []).filter(
      (b) => !primary.includes(b) && !fromSearch.includes(b),
    );
    // Probe paralel terbatas (banyak tebakan redirect ke host yang sama → jangan
    // dibanjiri); urutan prioritas tetap: hasil pencarian dulu, lalu tebakan.
    const results = await mapPool([...fromSearch, ...guesses], DISCOVERY_CONCURRENCY, probe);
    const alive = results
      .filter(Boolean)
      .sort((a, b) => Number(b.verified) - Number(a.verified))
      // Domain parkir/wildcard di Cloudflare juga 403 challenge → batasi verifikasi.
      .slice(0, cfg.maxDiscoveryVerify ?? 5);
    for (const r of alive) {
      const ok = await accept(r);
      if (ok) return ok;
    }
    return null;
  }

  /**
   * Tentukan domain aktif (di-cache RESOLVE_TTL_MS per proses).
   * Tidak ketemu → tetap domain sekarang; cek isResolved() bila perlu.
   */
  function resolve(opts = {}) {
    if (resolving && Date.now() - resolvedAt < RESOLVE_TTL_MS) return resolving;
    resolvedAt = Date.now();
    resolving = search(opts.verify).then(async (found) => {
      lastOk = Boolean(found);
      if (!found) {
        console.warn(`${tag} domain aktif tidak ditemukan, pakai ${current}`);
        return current;
      }
      console.log(found !== current ? `${tag} domain aktif: ${found}` : `${tag} base OK: ${found}`);
      current = found;
      await writeCache(found);
      return found;
    });
    return resolving;
  }

  /**
   * Ganti host lama di file JSON katalog → host aktif. Tanpa `files`:
   * semua *.json di tiap dir (tidak rekursif). Hanya menulis file yang berubah.
   */
  async function migrate(dirs, files) {
    let changed = 0;
    for (const dir of dirs) {
      let names = files;
      if (!names) {
        try {
          names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
        } catch {
          continue;
        }
      }
      for (const name of names) {
        const path = join(dir, name);
        let text;
        try {
          text = await readFile(path, "utf8");
        } catch {
          continue;
        }
        const next = rewrite(text).replace(escapedHostRe(), current.replace(/\//g, "\\/"));
        if (next !== text) {
          await writeFile(path, next);
          changed++;
        }
      }
    }
    if (changed) console.log(`${tag} host di ${changed} file dipindah ke ${current}`);
    return changed;
  }

  return {
    base,
    resolve,
    isResolved: () => lastOk,
    rewrite,
    isSiteUrl,
    isStale,
    pathKey,
    migrate,
  };
}

/** a.b.<tld> untuk semua COMMON_TLDS. */
export function tldGuesses(prefix, tlds = COMMON_TLDS) {
  return tlds.map((tld) => `https://${prefix}.${tld}`);
}

/** tv1..tvN.<domain> (pola mirror LK21/nontondrama). */
export function numberedGuesses(prefix, domain, max = 30) {
  return [
    `https://${prefix}.${domain}`,
    ...Array.from({ length: max }, (_, i) => `https://${prefix}${i + 1}.${domain}`),
  ];
}
