/**
 * Domain Anoboy sering pindah (anoboy.xyz → anoboy.quest → anoboy.at → …).
 * Wrapper tipis di atas resolver generik (lihat site-domain.js / source-domains.js).
 */
import { anoboyDomain } from "./source-domains.js";

/** Domain aktif saat ini (sinkron; panggil resolveAnoboyBase() dulu). */
export const anoboyBase = () => anoboyDomain.base();
export const resolveAnoboyBase = () => anoboyDomain.resolve();
/** URL di host anoboy mana pun → host aktif. */
export const rewriteAnoboyHost = (url, base) => anoboyDomain.rewrite(url, base);
export const isAnoboyUrl = (url) => anoboyDomain.isSiteUrl(url);
/** Path saja (tanpa host) — untuk membandingkan URL lintas domain. */
export const anoboyPathKey = (url) => anoboyDomain.pathKey(url);

/** Ganti host anoboy lama di file JSON katalog → host aktif. */
export function migrateAnoboyHosts(dirs, files) {
  return anoboyDomain.migrate(
    dirs,
    files || ["anime.json", "anime-index.json", "anime-movies.json", "anoboy-movies-skipped.json"],
  );
}
