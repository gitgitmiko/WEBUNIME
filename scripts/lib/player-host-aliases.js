/**
 * Alias host player LK21 / wrapper.
 *
 * Jika domain embed berubah lagi (seperti playeriframe.sbs → videonode.de):
 * 1. Tambah entri di PLAYER_HOST_ALIASES di bawah
 * 2. Sync malam / `npm run sync:catalog` otomatis rewrite seluruh JSON
 *    ATAU jalankan: `npm run fix:player-hosts`
 *
 * Format: host lama (tanpa protokol) → host baru (tanpa protokol)
 */
export const PLAYER_HOST_ALIASES = Object.freeze({
  "playeriframe.sbs": "videonode.de",
  // contoh ke depan:
  // "videonode.de": "player-baru.example",
});

export function rewritePlayerUrl(url) {
  let out = String(url || "");
  if (!out) return out;
  for (const [from, to] of Object.entries(PLAYER_HOST_ALIASES)) {
    if (!from || !to || from === to) continue;
    const re = new RegExp(
      `https?:\\/\\/${from.replace(/\./g, "\\.")}`,
      "gi"
    );
    out = out.replace(re, `https://${to}`);
  }
  return out;
}

function rewritePlayers(players) {
  if (!Array.isArray(players)) return { players, n: 0 };
  let n = 0;
  const out = players.map((p) => {
    const url = rewritePlayerUrl(p?.url);
    if (url && url !== p.url) {
      n += 1;
      return { ...p, url };
    }
    return p;
  });
  return { players: out, n };
}

function walkEpisodes(eps) {
  let n = 0;
  if (!Array.isArray(eps)) return { eps, n };
  const out = eps.map((ep) => {
    const r = rewritePlayers(ep.players);
    n += r.n;
    return r.n ? { ...ep, players: r.players } : ep;
  });
  return { eps: out, n };
}

/**
 * Rewrite semua URL player di file katalog public/data.
 * @returns {{ files: Record<string, number>, total: number }}
 */
export async function rewritePlayerHostsInCatalog(dataDir, { writeFile, readFile }) {
  const files = [
    "movies.json",
    "horror.json",
    "indonesia.json",
    "series.json",
    "players.json",
    "horror-players.json",
    "indonesia-players.json",
    "series-players.json",
  ];
  const summary = { files: {}, total: 0 };

  for (const name of files) {
    const path = `${dataDir}/${name}`.replace(/\\/g, "/");
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      continue;
    }

    let n = 0;
    let out;
    if (Array.isArray(data)) {
      out = data.map((item) => {
        let row = { ...item };
        let changed = false;
        const rp = rewritePlayers(row.players);
        if (rp.n) {
          row.players = rp.players;
          n += rp.n;
          changed = true;
        }
        const re = walkEpisodes(row.episodes);
        if (re.n) {
          row.episodes = re.eps;
          n += re.n;
          changed = true;
        }
        return changed ? row : item;
      });
    } else if (data && typeof data === "object") {
      out = {};
      for (const [k, v] of Object.entries(data)) {
        const row = { ...(v || {}) };
        const rp = rewritePlayers(row.players);
        if (rp.n) {
          row.players = rp.players;
          n += rp.n;
        }
        const re = walkEpisodes(row.episodes);
        if (re.n) {
          row.episodes = re.eps;
          n += re.n;
        }
        out[k] = row;
      }
    } else {
      continue;
    }

    if (n > 0) {
      await writeFile(path, JSON.stringify(out, null, 2) + "\n", "utf8");
    }
    summary.files[name] = n;
    summary.total += n;
  }

  return summary;
}
