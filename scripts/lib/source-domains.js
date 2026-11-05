/**
 * Domain situs sumber katalog. Domain baru yang sudah diketahui → taruh di depan
 * knownBases. Override sementara lewat env (lihat envVar).
 */
import {
  createSiteDomain,
  numberedGuesses,
  pageTitle,
  tldGuesses,
} from "./site-domain.js";

export const anoboyDomain = createSiteDomain({
  name: "anoboy",
  envVar: "ANOBOY_BASE",
  knownBases: ["https://anoboy.at", "https://anoboy.quest"],
  host: "(?:www\\.)?anoboy\\.[a-z]{2,10}(?:\\.[a-z]{2,4})?",
  looksLikeSite: (html) =>
    /anoboy/i.test(pageTitle(html)) && /\/anime-movie\/|home_index|wp-pagenavi/i.test(html),
  guesses: () => tldGuesses("anoboy"),
  searchQuery: "anoboy nonton anime subtitle indonesia",
});

export const lk21Domain = createSiteDomain({
  name: "lk21",
  envVar: "LK21_BASE_URL",
  knownBases: [
    "https://tv12.lk21official.cc",
    "https://tv13.lk21official.cc",
    "https://tv14.lk21official.cc",
  ],
  host: "(?:tv\\d*\\.)?lk21official\\.[a-z]{2,10}(?:\\.[a-z]{2,4})?",
  // Judul nontondrama juga mengandung "Lk21" → bedakan.
  looksLikeSite: (html) => {
    const title = pageTitle(html);
    return /lk21/i.test(title) && !/nonton drama/i.test(title);
  },
  guesses: () => [
    ...numberedGuesses("tv", "lk21official.cc", 30),
    ...tldGuesses("lk21official"),
    ...tldGuesses("tv12.lk21official"),
  ],
  searchQuery: "lk21official nonton film",
});

export const nontondramaDomain = createSiteDomain({
  name: "nontondrama",
  envVar: "NONTONDRAMA_BASE_URL",
  knownBases: ["https://tv.nontondrama.vip", "https://tv5.nontondrama.my"],
  host: "(?:tv\\d*\\.)?nontondrama\\.[a-z]{2,10}(?:\\.[a-z]{2,4})?",
  looksLikeSite: (html) => /nonton drama/i.test(pageTitle(html)),
  guesses: () => [
    ...numberedGuesses("tv", "nontondrama.vip", 15),
    ...numberedGuesses("tv", "nontondrama.my", 15),
    ...tldGuesses("tv.nontondrama"),
    ...tldGuesses("nontondrama"),
  ],
  searchQuery: "nontondrama lk21 drama series",
});

export const samehadakuDomain = createSiteDomain({
  name: "samehadaku",
  envVar: "SAMEHADAKU_BASE_URL",
  knownBases: ["https://v2.samehadaku.how"],
  host: "(?:v\\d+\\.)?samehadaku\\.[a-z]{2,10}(?:\\.[a-z]{2,4})?",
  // Hampir selalu tertahan Cloudflare → kepastian lewat verify (Playwright).
  looksLikeSite: (html) => /samehadaku/i.test(pageTitle(html)) && /anime-terbaru/i.test(html),
  guesses: () => [
    ...Array.from({ length: 10 }, (_, i) => `https://v${i + 1}.samehadaku.how`),
    ...tldGuesses("samehadaku"),
    ...tldGuesses("v2.samehadaku"),
  ],
  searchQuery: "samehadaku nonton anime subtitle indonesia",
});
