/**
 * Film Marvel dari movies.json (LK21 tidak punya field studio/tag Marvel).
 * Deteksi via judul/slug yang dikurasi (MCU + Marvel branded), bukan kata "marvel" mentah.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Pola judul/slug MCU / Marvel Studios (urutan tidak penting). */
const MARVEL_TITLE_PATTERNS = [
  /\biron\s*man\b/i,
  /\bthe\s+incredible\s+hulk\b/i,
  /\bthor\b/i,
  /\bcaptain\s+america\b/i,
  /\bthe\s+avengers\b/i,
  /\bavengers\s*:/i,
  /\bguardians\s+of\s+the\s+galaxy\b/i,
  /\bant[-\s]?man\b/i,
  /\bdoctor\s+strange\b/i,
  /\bspider[-\s]?man\b/i,
  /\bblack\s+panther\b/i,
  /\bcaptain\s+marvel\b/i,
  /\bthe\s+marvels\b/i,
  /\bblack\s+widow\b/i,
  /\bshang[-\s]?chi\b/i,
  /\beternals\b/i,
  /\bdeadpool\b/i,
  /\bthunderbolts\b/i,
  /\bfantastic\s+(four|4)\b/i,
  /\bwolverine\b/i,
  /\blogan\b(?!\s*'?s\s+run)/i,
  /\bx[-\s]?men\b/i,
  /\bmarvel\s+one[-\s]?shot\b/i,
  /\blego\s+marvel\b/i,
  /\bmarvel\s+rising\b/i,
  /\bmarvel\s+studios\b/i,
  /\bmarvel\s+super\s+heroes\b/i,
  /\bms\.?\s*marvel\b/i,
  /\bshe[-\s]?hulk\b/i,
  /\bmoon\s+knight\b/i,
  /\bwanda[-\s]?vision\b/i,
  /\bfalcon\s+and\s+the\s+winter\s+soldier\b/i,
  /\bsecret\s+invasion\b/i,
  /\bagatha\s+all\s+along\b/i,
  /\bwhat\s+if\s*\.{2,}/i, // What If...?
  /\bhawkeye\b/i,
];

/** False positive yang sering kena pola longgar. */
const EXCLUDE_PATTERNS = [
  /\bmarvellous\b/i,
  /\bblack\s+panthers\s+of\b/i,
  /\bthe\s+real\s+black\s+panther\b/i,
  /\bnext\s+avengers\b/i,
  /\bblade\s+of\b/i,
  /\bwar\s+blade\b/i,
  /\bhidden\s+blade\b/i,
  /\bbutchers?\s+blade\b/i,
  /\bwild\s+blade\b/i,
  /\bstrange\s+door\b/i,
  /\bmeyerowitz\b/i,
  /\beasy\s+living\b/i,
  /\bfathers?\s+shadow\b/i,
  /\bla\s+ragazza\b/i,
  /\bchompy\b/i,
  /\bburt\s+wonderstone\b/i,
  /\bspider[-\s]?man\s*:\s*lotus\b/i,
  /\bsuperman\b/i,
  /\bshazam\b/i,
  /\bamityville\b/i,
  /\becho\s*\d\b/i,
  /\becho\s+boomers\b/i,
  /\bearth\s+to\s+echo\b/i,
  /\bdonovan'?s?\s+echo\b/i,
  /\bdouble\s+echo\b/i,
  /\becho\s+effect\b/i,
  /\bst\.?\s*agatha\b/i,
  /\bagatha\s+and\s+the\b/i,
  /\bthe\s+f\s+word\b/i,
];

function normText(item) {
  return [item.judul, item.nama, item.slug]
    .filter(Boolean)
    .join(" ")
    .replace(/[_-]+/g, " ");
}

export function isMarvelMovie(item) {
  if (!item || typeof item !== "object") return false;
  const text = normText(item);
  if (!text.trim()) return false;
  if (EXCLUDE_PATTERNS.some((re) => re.test(text))) return false;
  if (MARVEL_TITLE_PATTERNS.some((re) => re.test(text))) return true;
  // Sinopsis menyebut Marvel Studios (bukan sekadar kata marvel).
  const syn = String(item.sinopsis || "");
  return /marvel\s+studios/i.test(syn);
}

function yearValue(item) {
  const y = Number(String(item.tahun || "").replace(/[^\d]/g, "").slice(0, 4));
  return Number.isFinite(y) ? y : 0;
}

export function pickMarvelMovies(movies) {
  const list = (Array.isArray(movies) ? movies : [])
    .filter(isMarvelMovie)
    .map((m, idx) => ({
      ...m,
      catalog: "marvel",
      id: idx + 1,
    }));
  list.sort((a, b) => {
    const yb = yearValue(b) - yearValue(a);
    if (yb !== 0) return yb;
    return String(a.judul || a.nama || "").localeCompare(
      String(b.judul || b.nama || ""),
      "en",
    );
  });
  list.forEach((m, i) => {
    m.id = i + 1;
  });
  return list;
}

export async function writeMarvelCatalog(dataDir) {
  const src = join(dataDir, "movies.json");
  let movies = [];
  try {
    const raw = JSON.parse(await readFile(src, "utf8"));
    movies = Array.isArray(raw) ? raw : [];
  } catch {
    movies = [];
  }
  const marvel = pickMarvelMovies(movies);
  const dest = join(dataDir, "marvel.json");
  await writeFile(dest, JSON.stringify(marvel, null, 2) + "\n", "utf8");
  return { file: "marvel.json", count: marvel.length };
}
