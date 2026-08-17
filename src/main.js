let movies = [];
let moviesAction = [];
let moviesDrama = [];
let series = [];
let horror = [];
let indonesia = [];
let anime = [];
let animeTop = [];
let animeHot = [];
let animeMovies = [];
let animeLatest = [];
let catalog = [];
let favorites = [];
let watchHistory = [];
let activeMovie = null;
/** Slide hero terpisah — jangan timpa activeMovie saat carousel berputar (bisa buka player/modal). */
let heroMovie = null;
let activeEpisode = null;
let playerTimer = null;
let modalIsFavorite = false;
let heroSlides = [];
let heroSlideIndex = 0;
let heroTimer = null;

const PAGE_SIZE = 10;
const itemCache = new Map();
const rowState = {};

function cacheKey(collection, slug) {
  return `${collection}:${String(slug || "").toLowerCase()}`;
}

function rememberItems(collection, items) {
  for (const item of items || []) {
    const slug = item?.slug || item?.anime_slug;
    if (!slug) continue;
    const key = cacheKey(collection, slug);
    const prev = itemCache.get(key) || {};
    itemCache.set(key, { ...prev, ...item, catalog: item.catalog || collection });
  }
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function fetchCatalogPage(
  collection,
  { page = 1, limit = PAGE_SIZE, q = "", genre = "", sort = "" } = {}
) {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
  });
  if (q) params.set("q", q);
  if (genre) params.set("genre", genre);
  if (sort) params.set("sort", sort);
  const res = await fetch(`/api/v1/catalog/${encodeURIComponent(collection)}?${params}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Gagal memuat ${collection}`);
  return res.json();
}

async function loadCollectionPage(collection, target, { page = 1, genre = "", sort = "" } = {}) {
  const data = await fetchCatalogPage(collection, { page, genre, sort });
  const items = Array.isArray(data?.items) ? data.items : [];
  rememberItems(collection, items);
  if (page <= 1) {
    target.length = 0;
    target.push(...items);
  } else {
    const seen = new Set(target.map((x) => x.slug || x.anime_slug));
    for (const item of items) {
      const key = item.slug || item.anime_slug;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      target.push(item);
    }
  }
  return {
    items,
    page: Number(data?.page) || page,
    total: Number(data?.total) || target.length,
  };
}

function listForKey(key) {
  const lists = {
    movies,
    moviesAction,
    moviesDrama,
    series,
    horror,
    indonesia,
    anime,
    animeTop,
    animeHot,
    animeMovies,
    animeLatest,
  };
  return lists[key];
}

const ROW_CONFIG = {
  trackFeatured: { collection: "movies", listKey: "movies" },
  trackHorror: { collection: "horror", listKey: "horror" },
  trackAction: {
    collection: "movies",
    listKey: "moviesAction",
    genre: "Action,Adventure,Thriller",
  },
  trackDrama: { collection: "movies", listKey: "moviesDrama", genre: "Drama,Romance" },
  trackSeries: { collection: "series", listKey: "series" },
  trackIndonesia: { collection: "indonesia", listKey: "indonesia" },
  trackAnime: { collection: "anime", listKey: "anime" },
  trackAnimeTop: { collection: "anime", listKey: "animeTop", sort: "rating" },
  trackAnimeHot: { collection: "anime", listKey: "animeHot", sort: "hot" },
  trackAnimeMovie: { collection: "anime-movies", listKey: "animeMovies" },
  trackAnimeLatest: { collection: "anime-latest", listKey: "animeLatest", kind: "episode" },
};

async function loadHomeCatalog() {
  const entries = Object.entries(ROW_CONFIG);
  await Promise.all(
    entries.map(async ([trackId, cfg]) => {
      const list = listForKey(cfg.listKey);
      try {
        const data = await loadCollectionPage(cfg.collection, list, {
          page: 1,
          genre: cfg.genre || "",
          sort: cfg.sort || "",
        });
        rowState[trackId] = {
          page: 1,
          total: data.total,
          loading: false,
          done: list.length >= data.total || data.items.length < PAGE_SIZE,
        };
      } catch (err) {
        console.warn(`[catalog] ${cfg.collection}`, err);
        list.length = 0;
        rowState[trackId] = { page: 1, total: 0, loading: false, done: true };
      }
    })
  );
  catalog = dedupeBySlug([
    ...movies,
    ...horror,
    ...indonesia,
    ...series,
    ...anime,
    ...animeTop,
    ...animeHot,
    ...animeMovies,
  ]);
}

async function hydrateItem(movie, fallbackCollection) {
  if (!movie) return movie;
  const collection =
    fallbackCollection ||
    (movie.type === "anime" || movie.anime_slug ? "anime" : resolveCollection(movie));
  const slug = movie.anime_slug && collection === "anime" ? movie.anime_slug : movie.slug;
  if (!slug) return movie;
  const key = cacheKey(collection, slug);
  const cached = itemCache.get(key);
  const rich =
    cached &&
    ((Array.isArray(cached.players) && cached.players.length) ||
      (Array.isArray(cached.episodes) && cached.episodes.length) ||
      (typeof cached.sinopsis === "string" && cached.sinopsis.length > 320));
  if (rich) return cached;
  try {
    const res = await fetch(
      `/api/v1/catalog/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}`,
      { credentials: "include" }
    );
    if (!res.ok) return cached || movie;
    const full = await res.json();
    rememberItems(collection, [full]);
    return itemCache.get(key) || full;
  } catch {
    return cached || movie;
  }
}

function dedupeBySlug(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item?.slug || `${item?.type || "movie"}:${item?.nama}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isSeries(item) {
  return (
    item?.type === "series" ||
    item?.type === "anime" ||
    item?.type === "anime-movie" ||
    Array.isArray(item?.episodes)
  );
}

function resolveCollection(movie) {
  if (!movie) return "movies";
  const cat = String(movie.catalog || "").toLowerCase();
  if (["movies", "series", "horror", "indonesia", "anime", "anime-movies", "anime-latest"].includes(cat)) {
    return cat;
  }
  if (movie.type === "series") return "series";
  if (movie.type === "anime") return "anime";
  if (movie.type === "anime-movie") return "anime-movies";
  if (cat.includes("horror") || cat === "horor") return "horror";
  if (cat.includes("indonesia")) return "indonesia";
  const slug = movie.slug;
  if (slug && itemCache.get(cacheKey("horror", slug))) return "horror";
  if (slug && itemCache.get(cacheKey("indonesia", slug))) return "indonesia";
  if (slug && itemCache.get(cacheKey("series", slug))) return "series";
  if (slug && itemCache.get(cacheKey("anime", slug))) return "anime";
  if (slug && itemCache.get(cacheKey("anime-movies", slug))) return "anime-movies";
  return "movies";
}

function findInCatalog(collection, slug) {
  if (!slug) return null;
  return (
    itemCache.get(cacheKey(collection, slug)) ||
    listForKey(
      collection === "anime-movies"
        ? "animeMovies"
        : collection === "movies"
          ? "movies"
          : collection
    )?.find((x) => x.slug === slug) ||
    null
  );
}

async function libraryFetch(path, options = {}) {
  const res = await fetch(`/api/v1/me${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { res, data };
}

async function loadUserLibrary() {
  if (!currentUser) {
    favorites = [];
    watchHistory = [];
    return;
  }
  try {
    const [fav, hist] = await Promise.all([
      libraryFetch("/favorites"),
      libraryFetch("/history"),
    ]);
    favorites = fav.res.ok ? fav.data?.items || [] : [];
    watchHistory = hist.res.ok ? hist.data?.items || [] : [];
  } catch {
    favorites = [];
    watchHistory = [];
  }
}

function setFavButtonState(on) {
  modalIsFavorite = Boolean(on);
  const btn = $("#modalFav");
  if (!btn) return;
  btn.classList.toggle("is-on", modalIsFavorite);
  btn.setAttribute("aria-pressed", modalIsFavorite ? "true" : "false");
  const icon = $(".btn-fav-icon", btn);
  const text = $(".btn-fav-text", btn);
  if (icon) icon.textContent = modalIsFavorite ? "♥" : "♡";
  if (text) text.textContent = modalIsFavorite ? "Dalam Favorit" : "Favorit";
}

function createLibraryPoster(entry, index = 0, options = {}) {
  const removable = Boolean(options.removable);
  const wrap = document.createElement("div");
  wrap.className = `poster-wrap${removable ? " poster-wrap--continue" : ""}`;
  wrap.style.animationDelay = `${Math.min(index * 40, 400)}ms`;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "poster";
  const title = entry.title || entry.slug;
  btn.setAttribute("aria-label", `Buka ${title}`);
  const ep =
    entry.episodeSlug != null
      ? `<span class="poster-ep-continue">Lanjut</span>`
      : "";
  const movie = findInCatalog(entry.collection, entry.slug);
  btn.innerHTML = `
    ${ep}
    <img src="${entry.thumbnail || ""}" alt="${title}" loading="lazy" width="200" height="300" />
    ${posterBadgesHtml(movie || { rating: null, quality: null })}
    ${posterDurationHtml(movie || {})}
    <div class="poster-foot">
      <p class="poster-label">${title}</p>
      ${posterYearHtml(movie || {})}
    </div>
  `;
  btn.addEventListener("click", async () => {
    const full = await hydrateItem(
      {
        nama: title,
        judul: title,
        slug: entry.slug,
        thumbnail: entry.thumbnail,
        catalog: entry.collection,
        type:
          entry.collection === "series"
            ? "series"
            : entry.collection === "anime"
              ? "anime"
              : entry.collection === "anime-movies"
                ? "anime-movie"
                : undefined,
      },
      entry.collection
    );
    openModal(full || movie || {
      nama: title,
      judul: title,
      slug: entry.slug,
      thumbnail: entry.thumbnail,
      catalog: entry.collection,
      sinopsis: "Item tidak ada di katalog. Coba sync ulang.",
      episodes: [],
    }, { episodeSlug: entry.episodeSlug || null });
  });

  wrap.appendChild(btn);

  if (removable) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "poster-remove";
    removeBtn.setAttribute("aria-label", `Hapus ${title} dari Lanjut Menonton`);
    removeBtn.title = "Hapus dari Lanjut Menonton";
    removeBtn.innerHTML = `<span aria-hidden="true">×</span>`;
    removeBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (removeBtn.disabled) return;
      removeBtn.disabled = true;
      wrap.classList.add("is-removing");
      try {
        const ok = await removeWatchHistory(entry);
        if (!ok) {
          wrap.classList.remove("is-removing");
          removeBtn.disabled = false;
        }
      } catch {
        wrap.classList.remove("is-removing");
        removeBtn.disabled = false;
      }
    });
    wrap.appendChild(removeBtn);
  }

  return wrap;
}

async function removeWatchHistory(entry) {
  if (!currentUser || !entry?.collection || !entry?.slug) return false;
  const { res } = await libraryFetch(
    `/history/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.slug)}`,
    { method: "DELETE" }
  );
  if (!res.ok) return false;
  watchHistory = watchHistory.filter(
    (item) =>
      !(item.collection === entry.collection && item.slug === entry.slug)
  );
  renderLibraryRows();
  return true;
}

function renderLibraryRows() {
  const continueRow = $("#rowContinue");
  const favRow = $("#rowFavorites");
  const continueTrack = $("#trackContinue");
  const favTrack = $("#trackFavorites");

  if (continueTrack) {
    continueTrack.replaceChildren(
      ...watchHistory.map((e, i) => createLibraryPoster(e, i, { removable: true }))
    );
    requestAnimationFrame(() => syncRowArrows(continueTrack));
  }
  if (favTrack) {
    favTrack.replaceChildren(...favorites.map((e, i) => createLibraryPoster(e, i)));
    requestAnimationFrame(() => syncRowArrows(favTrack));
  }
  continueRow?.classList.toggle("hidden", !watchHistory.length);
  favRow?.classList.toggle("hidden", !favorites.length);
}

async function recordWatchHistory(movie) {
  if (!currentUser || !movie?.slug) return;
  const collection = resolveCollection(movie);
  try {
    await libraryFetch("/history", {
      method: "POST",
      body: JSON.stringify({
        collection,
        slug: movie.slug,
        episodeSlug: activeEpisode?.slug || null,
        title: movie.nama || movie.judul || movie.slug,
        thumbnail: movie.thumbnail || null,
      }),
    });
    await loadUserLibrary();
    renderLibraryRows();
  } catch (err) {
    console.warn("history save failed", err);
  }
}

function parseRating(value) {
  const raw = String(value ?? "")
    .trim()
    .replace(",", ".");
  if (!raw || !/\d/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function formatQuality(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  const key = value.toLowerCase().replace(/_/g, "-");
  const map = {
    hd: "HD",
    hdtv: "HDTV",
    fullhd: "FHD",
    "full-hd": "FHD",
    fhd: "FHD",
    cam: "CAM",
    hdcam: "HDCAM",
    ts: "TS",
    sd: "SD",
    bluray: "BluRay",
    "blu-ray": "BluRay",
    webdl: "WEB-DL",
    "web-dl": "WEB-DL",
  };
  return map[key] || value.toUpperCase();
}

function posterBadgesHtml(movie) {
  const rating = parseRating(movie?.rating);
  const quality = formatQuality(movie?.quality);
  const ratingHtml =
    rating != null
      ? `<span class="poster-badge poster-badge--rating" title="Rating"><span class="poster-star" aria-hidden="true">★</span>${rating}</span>`
      : "";
  const qualityHtml = quality
    ? `<span class="poster-badge poster-badge--quality${
        /cam/i.test(quality) ? " is-cam" : ""
      }" title="Kualitas">${quality}</span>`
    : "";
  if (!ratingHtml && !qualityHtml) return "";
  return `<div class="poster-badges">${ratingHtml}${qualityHtml}</div>`;
}

function posterYearHtml(movie) {
  if (!movie?.tahun) return "";
  return `<p class="poster-year">${movie.tahun}</p>`;
}

function posterDurationHtml(movie) {
  if (!movie?.durasi) return "";
  return `<span class="poster-duration" title="Durasi">${movie.durasi}</span>`;
}

function metaLine(movie) {
  const genres = (movie.genre || []).join(" · ");
  const quality = movie.quality ? ` · ${formatQuality(movie.quality)}` : "";
  if (isSeries(movie)) {
    const eps = movie.episodes_count || movie.episodes?.length || "";
    return `${movie.rating ?? "—"} Cocok untukmu · ${movie.tahun}${quality} · ${
      movie.durasi || (eps ? `${eps} eps` : "")
    } · ${genres}`.replace(/\s·\s*$/, "");
  }
  return `${movie.rating ?? "—"} Cocok untukmu · ${movie.tahun}${quality} · ${movie.durasi ?? ""} · ${genres}`;
}

function hasGenre(movie, names) {
  return movie.genre?.some((g) => names.includes(g));
}

function createPoster(movie, index = 0) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "poster";
  btn.style.animationDelay = `${Math.min(index * 40, 400)}ms`;
  btn.setAttribute("aria-label", `Detail ${movie.nama}`);
  btn.innerHTML = `
    <img src="${movie.thumbnail}" alt="${movie.judul || movie.nama}" loading="lazy" width="200" height="300" />
    ${posterBadgesHtml(movie)}
    ${posterDurationHtml(movie)}
    <div class="poster-foot">
      <p class="poster-label">${movie.nama}</p>
      ${posterYearHtml(movie)}
    </div>
  `;
  btn.addEventListener("click", () => openModal(movie));
  return btn;
}

/** Poster episode rilis terbaru (Anime). */
function createLatestEpisodePoster(item, index = 0) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "poster poster--episode";
  btn.style.animationDelay = `${Math.min(index * 40, 400)}ms`;
  const epLabel =
    item.episode != null ? `Episode ${item.episode}` : "Episode baru";
  btn.setAttribute("aria-label", `${item.nama} ${epLabel}`);
  const show = item.anime_slug ? itemCache.get(cacheKey("anime", item.anime_slug)) : null;
  const metaSource = {
    rating: show?.rating || item.rating,
    quality: show?.quality || item.quality,
    tahun: show?.tahun || item.tahun,
    durasi: item.episode != null ? `E${item.episode}` : show?.durasi || item.durasi,
  };
  btn.innerHTML = `
    <img src="${item.thumbnail}" alt="${item.nama}" loading="lazy" width="200" height="300" />
    <span class="poster-ep">${epLabel}</span>
    ${posterBadgesHtml(metaSource)}
    ${posterDurationHtml(metaSource)}
    <div class="poster-foot">
      <p class="poster-label">${item.nama}</p>
      ${posterYearHtml(metaSource)}
    </div>
  `;
  btn.addEventListener("click", async () => {
    const show = await hydrateItem(
      {
        type: "anime",
        nama: item.nama,
        judul: item.judul || item.nama,
        thumbnail: item.thumbnail,
        slug: item.anime_slug,
        anime_slug: item.anime_slug,
        source: item.source,
        catalog: "anime",
      },
      "anime"
    );
    const epSlug =
      item.episode_slug ||
      `${item.anime_slug}-episode-${item.episode}`;
    openModal(show, { episodeSlug: epSlug });
  });
  return btn;
}

function fillTrack(id, list, { append = false, startIndex = 0 } = {}) {
  const track = document.getElementById(id);
  if (!track) return;
  const makePoster =
    ROW_CONFIG[id]?.kind === "episode" ? createLatestEpisodePoster : createPoster;
  const nodes = list.map((m, i) => makePoster(m, startIndex + i));
  if (append) track.append(...nodes);
  else track.replaceChildren(...nodes);
  requestAnimationFrame(() => syncRowArrows(track));
}

function renderRows() {
  renderLibraryRows();
  fillTrack("trackAnime", anime);
  fillTrack("trackAnimeTop", animeTop);
  fillTrack("trackAnimeHot", animeHot);
  fillTrack("trackAnimeLatest", animeLatest);
  fillTrack("trackAnimeMovie", animeMovies);
  fillTrack("trackFeatured", movies);
  fillTrack("trackHorror", horror);
  fillTrack("trackAction", moviesAction);
  fillTrack("trackDrama", moviesDrama);
  fillTrack("trackSeries", series);
  fillTrack("trackIndonesia", indonesia);
}

function shortSinopsis(text) {
  if (!text) return "";
  const first = String(text).split(/\n\n+/)[0].trim();
  return first.length > 360 ? `${first.slice(0, 357)}…` : first;
}

function cleanFactValue(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,(\s*,)+/g, ",")
    .replace(/^[,\s]+|[,\s]+$/g, "")
    .trim();
}

function parseSinopsisDetail(sinopsis) {
  const blocks = String(sinopsis || "")
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const facts = {};
  const story = [];
  const canonical = {
    subtitle: "subtitle",
    sutradara: "sutradara",
    direksi: "sutradara",
    "bintang film": "bintang film",
    pemain: "bintang film",
    negara: "negara",
    votes: "votes",
    release: "release",
    rilis: "release",
    updated: "updated",
    "worldwide gross": "worldwide gross",
    pendapatan: "worldwide gross",
    bahasa: "bahasa",
  };
  const stripOnly = new Set([
    "oleh",
    "diposting pada",
    "genre",
    "tahun",
    "durasi",
    "rating",
    "anggaran",
  ]);
  const labelRe =
    /^(Subtitle|Sutradara|Direksi|Bintang Film|Pemain|Negara|Votes|Release|Rilis|Updated|Worldwide Gross|Pendapatan|Bahasa|Oleh|Diposting pada|Genre|Tahun|Durasi|Rating|Anggaran):\s*([\s\S]+)$/i;

  for (const block of blocks) {
    const m = block.match(labelRe);
    if (!m) {
      story.push(block);
      continue;
    }
    const rawKey = m[1].toLowerCase();
    if (stripOnly.has(rawKey)) continue;
    const key = canonical[rawKey];
    const value = cleanFactValue(m[2]);
    if (key && value) facts[key] = value;
  }
  return { story: story.join("\n\n"), facts };
}

function setModalFact(rowId, valueId, value) {
  const row = $(`#${rowId}`);
  const valueEl = $(`#${valueId}`);
  if (!row || !valueEl) return;
  if (value) {
    valueEl.textContent = value;
    row.hidden = false;
  } else {
    valueEl.textContent = "";
    row.hidden = true;
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function genreTone(genre) {
  const g = String(genre || "").toLowerCase();
  if (/horror|horor|slasher/.test(g)) return "horror";
  if (/romance|romantic|romantis/.test(g)) return "romance";
  if (/action|aksi/.test(g)) return "action";
  if (/adventure|petualangan/.test(g)) return "adventure";
  if (/comedy|komedi/.test(g)) return "comedy";
  if (/thriller|suspense/.test(g)) return "thriller";
  if (/drama/.test(g)) return "drama";
  if (/sci-?fi|science fiction|fiksi ilmiah/.test(g)) return "scifi";
  if (/fantasy|fantasi/.test(g)) return "fantasy";
  if (/animation|anime|animasi/.test(g)) return "animation";
  if (/crime|kriminal/.test(g)) return "crime";
  if (/mystery|misteri/.test(g)) return "mystery";
  if (/family|keluarga/.test(g)) return "family";
  if (/music|musik|musical/.test(g)) return "music";
  if (/war|perang/.test(g)) return "war";
  if (/documentary|dokumenter/.test(g)) return "documentary";
  if (/sport|olahraga/.test(g)) return "sport";
  if (/western/.test(g)) return "western";
  return "default";
}

function qualityTone(quality) {
  if (/cam|ts|sd/i.test(quality)) return "cam";
  if (/blu|web|fhd|hd|uhd|4k/i.test(quality)) return "hd";
  return "default";
}

function heroMetaHtml(movie) {
  if (!movie) return "";
  const chips = [];
  const rating = parseRating(movie.rating);
  if (rating != null) {
    chips.push(
      `<span class="hero-chip hero-chip--rating"><span class="poster-star" aria-hidden="true">★</span>${escapeHtml(rating)}</span>`
    );
  }
  const quality = formatQuality(movie.quality);
  if (quality) {
    chips.push(
      `<span class="hero-chip hero-chip--quality is-${qualityTone(quality)}">${escapeHtml(quality)}</span>`
    );
  }
  if (movie.tahun) {
    chips.push(
      `<span class="hero-chip hero-chip--year">${escapeHtml(movie.tahun)}</span>`
    );
  }
  if (movie.durasi) {
    chips.push(
      `<span class="hero-chip hero-chip--duration">${escapeHtml(movie.durasi)}</span>`
    );
  }
  for (const genre of movie.genre || []) {
    if (!genre) continue;
    chips.push(
      `<span class="hero-chip hero-chip--genre is-${genreTone(genre)}">${escapeHtml(genre)}</span>`
    );
  }
  return chips.join("");
}

function setHero(movie) {
  if (!movie) return;
  heroMovie = movie;
  const bg = $("#heroBg");
  const art = movie.thumbnail_landscape || movie.thumbnail;
  bg.style.backgroundImage = art ? `url("${art}")` : "";
  $("#heroTitle").textContent = movie.nama;
  const meta = $("#heroMeta");
  if (meta) meta.innerHTML = heroMetaHtml(movie);
  $("#heroDesc").textContent = shortSinopsis(movie.sinopsis);
}

function shuffleCopy(list) {
  const arr = [...list];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickHeroSlides(pool, limit = 10) {
  const eligible = pool.filter((item) => {
    const rating = parseRating(item?.rating);
    return rating != null && rating >= 7 && (item.thumbnail || item.thumbnail_landscape);
  });
  const preferred = eligible.filter((item) => item.thumbnail_landscape);
  const source = preferred.length >= limit ? preferred : eligible;
  return shuffleCopy(source).slice(0, limit);
}

function renderHeroDots() {
  const dots = $("#heroDots");
  if (!dots) return;
  dots.replaceChildren(
    ...heroSlides.map((_, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `hero-dot${i === heroSlideIndex ? " is-active" : ""}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-label", `Slide ${i + 1}`);
      btn.setAttribute("aria-selected", i === heroSlideIndex ? "true" : "false");
      btn.addEventListener("click", () => showHeroSlide(i, true));
      return btn;
    })
  );
}

function showHeroSlide(index, userTriggered = false) {
  if (!heroSlides.length) return;
  heroSlideIndex = ((index % heroSlides.length) + heroSlides.length) % heroSlides.length;
  setHero(heroSlides[heroSlideIndex]);
  renderHeroDots();
  if (userTriggered) startHeroCarousel();
}

function stopHeroCarousel() {
  if (heroTimer) {
    clearInterval(heroTimer);
    heroTimer = null;
  }
}

function startHeroCarousel() {
  stopHeroCarousel();
  if (heroSlides.length < 2) return;
  heroTimer = setInterval(() => {
    showHeroSlide(heroSlideIndex + 1);
  }, 7000);
}

async function initHeroCarousel() {
  let pool = catalog;
  try {
    const res = await fetch("/api/v1/hero?limit=12", { credentials: "include" });
    if (res.ok) {
      const data = await res.json();
      const items = Array.isArray(data?.items) ? data.items : [];
      if (items.length) {
        for (const item of items) {
          rememberItems(item.catalog || resolveCollection(item), [item]);
        }
        pool = items;
      }
    }
  } catch {
    /* pakai katalog halaman 1 */
  }
  heroSlides = pickHeroSlides(pool, 10);
  if (!heroSlides.length) {
    heroSlides = pickHeroSlides(
      pool.filter((item) => item.thumbnail || item.thumbnail_landscape),
      10
    );
  }
  if (!heroSlides.length) {
    const fallback =
      movies[0] ||
      anime[0] ||
      animeMovies[0] ||
      indonesia[0] ||
      horror[0] ||
      series[0];
    if (fallback) heroSlides = [fallback];
  }
  heroSlideIndex = 0;
  showHeroSlide(0);
  startHeroCarousel();
  const hero = $("#hero");
  if (hero && !hero.dataset.carouselBound) {
    hero.dataset.carouselBound = "1";
    hero.addEventListener("mouseenter", stopHeroCarousel);
    hero.addEventListener("mouseleave", startHeroCarousel);
    hero.addEventListener("focusin", stopHeroCarousel);
    hero.addEventListener("focusout", (e) => {
      if (!hero.contains(e.relatedTarget)) startHeroCarousel();
    });
    $("#heroPrev")?.addEventListener("click", () => showHeroSlide(heroSlideIndex - 1, true));
    $("#heroNext")?.addEventListener("click", () => showHeroSlide(heroSlideIndex + 1, true));
    document.addEventListener("keydown", (e) => {
      if (!$("#hero") || document.body.classList.contains("is-modal-open")) return;
      const tag = String(e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "ArrowLeft") showHeroSlide(heroSlideIndex - 1, true);
      if (e.key === "ArrowRight") showHeroSlide(heroSlideIndex + 1, true);
    });
  }
}

function episodeOptions(item) {
  return (item?.episodes || []).filter((e) => e?.slug);
}

function episodeLabel(ep) {
  if (!ep) return "—";
  if (ep.title) return ep.title;
  if (ep.season != null && ep.season !== "") {
    return `S${ep.season} E${ep.episode}`;
  }
  return ep.episode != null ? `Episode ${ep.episode}` : "—";
}

/** Suffix judul player: series LK21 pakai SxEy; anime tanpa season. */
function playerEpisodeSuffix(ep, item = activeMovie) {
  if (!ep) return "";
  if (item?.type === "anime-movie") return "";
  if (item?.type === "anime") {
    return ep.episode != null ? ` · E${ep.episode}` : "";
  }
  if (ep.season != null && ep.season !== "" && ep.episode != null) {
    return ` · S${ep.season}E${ep.episode}`;
  }
  if (ep.episode != null) return ` · E${ep.episode}`;
  return ep.title ? ` · ${ep.title}` : "";
}

function episodeListCopy(ep) {
  const primary = ep.episode != null ? `Episode ${ep.episode}` : episodeLabel(ep);
  const raw = String(ep.title || "")
    .replace(/\s*\[end\]\s*$/i, "")
    .trim();
  if (!raw) return { primary, secondary: "" };
  const generic = new RegExp(
    `^(?:.*\\s)?episode\\s*${ep.episode != null ? ep.episode : ""}\\s*$`,
    "i"
  );
  if (!ep.episode || generic.test(raw) || raw === primary) {
    return { primary, secondary: "" };
  }
  return { primary, secondary: raw };
}

function syncEpisodeListActive(slug) {
  $$("#modalEpisodeList .episode-row").forEach((row) => {
    const on = row.dataset.slug === slug;
    row.classList.toggle("is-active", on);
    row.setAttribute("aria-selected", on ? "true" : "false");
  });
}

function renderEpisodeList(item, selectedSlug) {
  const list = $("#modalEpisodeList");
  const count = $("#modalEpisodeCount");
  const eps = episodeOptions(item);
  if (count) count.textContent = `${eps.length} Episode`;
  if (!list) return;
  list.replaceChildren(
    ...eps.map((ep) => {
      const { primary, secondary } = episodeListCopy(ep);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "episode-row";
      btn.dataset.slug = ep.slug;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", ep.slug === selectedSlug ? "true" : "false");
      btn.innerHTML = `
        <span class="episode-row-num">${ep.episode ?? "–"}</span>
        <span class="episode-row-copy">
          <span class="episode-row-title"></span>
          ${secondary ? `<span class="episode-row-sub"></span>` : ""}
        </span>
        <span class="episode-row-play" title="Putar episode" aria-label="Putar episode">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>
        </span>
      `;
      $(".episode-row-title", btn).textContent = primary;
      const sub = $(".episode-row-sub", btn);
      if (sub) sub.textContent = secondary;
      if (ep.slug === selectedSlug) btn.classList.add("is-active");
      return btn;
    })
  );
  const active = [...list.querySelectorAll(".episode-row")].find(
    (row) => row.dataset.slug === selectedSlug
  );
  active?.scrollIntoView({ block: "nearest" });
}

function fillEpisodeSelect(selectEl, item, selectedSlug = null) {
  const eps = episodeOptions(item);
  selectEl.replaceChildren(
    ...eps.map((ep) => {
      const opt = document.createElement("option");
      opt.value = ep.slug;
      opt.textContent = episodeLabel(ep);
      return opt;
    })
  );
  if (!eps.length) return null;
  const pick =
    eps.find((e) => e.slug === selectedSlug) ||
    [...eps].reverse().find((e) => e.players?.length) ||
    eps[eps.length - 1];
  selectEl.value = pick.slug;
  renderEpisodeList(item, pick.slug);
  return pick;
}

function getEpisodeBySlug(item, slug) {
  return episodeOptions(item).find((e) => e.slug === slug) || null;
}

function currentPlayers(item = activeMovie) {
  if (isSeries(item) && activeEpisode?.players?.length) {
    return activeEpisode.players;
  }
  if (isSeries(item)) {
    const latest = [...episodeOptions(item)]
      .reverse()
      .find((e) => e.players?.length);
    if (latest) return latest.players;
  }
  return item?.players || [];
}

function closeNfDropdowns(except = null) {
  $$(".nf-dropdown.is-open").forEach((root) => {
    if (except && root === except) return;
    root.classList.remove("is-open");
    const btn = $(".nf-dropdown-toggle", root);
    const menu = $(".nf-dropdown-menu", root);
    if (btn) btn.setAttribute("aria-expanded", "false");
    if (menu) menu.hidden = true;
  });
}

function setNfDropdownValue(root, valueId, items, selectedValue) {
  const valueEl = $(`#${valueId}`);
  const menu = $(".nf-dropdown-menu", root);
  if (valueEl) {
    const selected = items.find((i) => i.value === selectedValue) || items[0];
    valueEl.textContent = selected?.label || "—";
  }
  if (menu) {
    $$(".nf-dropdown-option", menu).forEach((opt) => {
      opt.classList.toggle("is-active", opt.dataset.value === selectedValue);
    });
  }
}

function populateNfDropdown(root, { valueId, items, selectedValue, onSelect }) {
  const menu = $(".nf-dropdown-menu", root);
  const valueEl = $(`#${valueId}`);
  if (!menu || !valueEl) return;

  root._nfItems = items;
  root._nfValueId = valueId;
  root._nfOnSelect = onSelect;

  menu.replaceChildren(
    ...items.map((item) => {
      const li = document.createElement("li");
      li.setAttribute("role", "none");
      const option = document.createElement("button");
      option.type = "button";
      option.className = "nf-dropdown-option";
      option.setAttribute("role", "option");
      option.dataset.value = item.value;
      if (item.value === selectedValue) option.classList.add("is-active");
      option.innerHTML = `<span></span><svg class="nf-dropdown-check" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>`;
      option.querySelector("span").textContent = item.label;
      option.addEventListener("click", (e) => {
        e.stopPropagation();
        closeNfDropdowns();
        setNfDropdownValue(root, valueId, items, item.value);
        onSelect?.(item.value, item);
      });
      li.appendChild(option);
      return li;
    })
  );

  setNfDropdownValue(root, valueId, items, selectedValue);
}

function bindNfDropdown(root) {
  if (!root || root.dataset.bound === "1") return;
  root.dataset.bound = "1";
  const btn = $(".nf-dropdown-toggle", root);
  const menu = $(".nf-dropdown-menu", root);
  if (!btn || !menu) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !root.classList.contains("is-open");
    closeNfDropdowns();
    if (willOpen) {
      root.classList.add("is-open");
      btn.setAttribute("aria-expanded", "true");
      menu.hidden = false;
    }
  });
}

async function openModal(movie, opts = {}) {
  if (!currentUser) {
    enterAuthGate("login");
    return;
  }
  movie = (await hydrateItem(movie)) || movie;
  activeMovie = movie;
  activeEpisode = null;
  const modal = $("#modal");
  const { story, facts } = parseSinopsisDetail(movie.sinopsis);

  $("#modalBanner").style.backgroundImage = `url("${movie.thumbnail}")`;
  $("#modalTitle").textContent = movie.nama;
  $("#modalMatch").textContent = `${movie.rating ?? "—"} Cocok untukmu`;
  $("#modalYear").textContent = movie.tahun || "";
  $("#modalDuration").textContent = movie.durasi || "";
  $("#modalDesc").textContent = story || shortSinopsis(movie.sinopsis) || "";
  $("#modalGenres").textContent = (movie.genre || []).join(", ") || "—";

  setModalFact("factCast", "modalCast", movie.pemain || facts["bintang film"]);
  setModalFact("factDirector", "modalDirector", movie.direksi || facts.sutradara);
  setModalFact("factStudio", "modalStudio", movie.studio);
  setModalFact("factSumber", "modalSumber", movie.sumber);
  setModalFact("factSubtitle", "modalSubtitle", facts.subtitle);
  setModalFact("factCountry", "modalCountry", movie.negara || facts.negara);
  setModalFact("factLanguage", "modalLanguage", cleanFactValue(movie.bahasa || facts.bahasa));
  setModalFact("factGross", "modalGross", movie.pendapatan || facts["worldwide gross"]);
  setModalFact("factRelease", "modalRelease", movie.rilis || facts.release);

  const epWrap = $("#modalEpisodes");
  const epSelect = $("#modalEpisodeSelect");
  if (isSeries(movie) && episodeOptions(movie).length) {
    activeEpisode = fillEpisodeSelect(epSelect, movie, opts.episodeSlug || null);
    epWrap.classList.remove("hidden");
  } else {
    epSelect.replaceChildren();
    $("#modalEpisodeList")?.replaceChildren();
    const count = $("#modalEpisodeCount");
    if (count) count.textContent = "";
    epWrap.classList.add("hidden");
  }

  const collection = resolveCollection(movie);
  const favored = favorites.some(
    (f) => f.collection === collection && f.slug === movie.slug
  );
  setFavButtonState(favored);
  // refresh from server in background
  libraryFetch(
    `/favorites/check?collection=${encodeURIComponent(collection)}&slug=${encodeURIComponent(movie.slug || "")}`
  ).then(({ res, data }) => {
    if (res.ok && activeMovie?.slug === movie.slug) {
      setFavButtonState(Boolean(data?.favorite));
    }
  });

  modal.classList.remove("hidden");
  modal.scrollTop = 0;
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("#modal").classList.add("hidden");
  if ($("#player").classList.contains("hidden")) {
    document.body.style.overflow = "";
  }
}

let currentServerUrl = null;
let embedRequestId = 0;

function serverLabel(url) {
  const p = currentPlayers().find((x) => x.url === url);
  return p ? formatServerName(p) : "server";
}

/** Label server untuk dropdown (LK21: tanpa GANTI PLAYER; anime: label asli). */
function formatServerName(player) {
  const label = String(player?.label || "").trim();
  if (label && !/^ganti\s*player/i.test(label)) {
    return label.replace(/\s+/g, " ").trim();
  }
  const raw = String(player?.server || label || "Server");
  const cleaned = raw
    .replace(/^ganti\s*player\s*/i, "")
    .replace(/^player\s*/i, "")
    .trim();
  const name = cleaned || raw;
  return name.toUpperCase();
}

/** Bangun path reverse-proxy /__px__/host/path dari URL absolut. */
function toProxyPath(absoluteUrl) {
  try {
    const u = new URL(absoluteUrl);
    return `/__px__/${u.host}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

/**
 * Resolve URL player iframe dalam (skip wrapper playeriframe + iklan dobel).
 * Hydrax/Abyss → URL absolut langsung (GCS + hostname check hanya jalan di abyssplayer).
 * Anime Samehadaku (blogger/wibufile/filedon/mega) → embed langsung / proxy.
 * Cast/Turbo → path proxy /__px__/...
 */
async function resolveEmbedPath(sourceUrl) {
  try {
    const u = new URL(sourceUrl);
    const host = u.hostname;
    // Embed anime Samehadaku — sudah URL player akhir
    if (/blogger\.com|wibufile\.com|filedon\.co|mega\.nz/i.test(host)) {
      if (/mega\.nz|blogger\.com/i.test(host)) return sourceUrl;
      // MP4 langsung (Wibufile 720/1080) → halaman <video>, bukan iframe ke file mentah
      if (/\.(mp4|webm)(\?|$)/i.test(u.pathname)) {
        return `/__vid__?u=${encodeURIComponent(u.href)}`;
      }
      return toProxyPath(sourceUrl) || sourceUrl;
    }
    // Film Indonesia (p2pplay/barplay): SPA baca video id dari hash (#...).
    // Hash tidak dikirim ke server, jadi /__px__/ menghapus id → "no videoid found".
    if (/p2pplay\.|barplay\.|p2pstream\./i.test(host)) {
      return sourceUrl;
    }
  } catch {
    /* lanjut resolve */
  }

  const res = await fetch(`/api/resolve?url=${encodeURIComponent(sourceUrl)}`);
  if (!res.ok) throw new Error(`Resolve gagal (${res.status})`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const play = data.play || sourceUrl;
  try {
    const host = new URL(play).hostname;
    // Hydrax: wrapper nested iframe + /__px__ (sanitasi AdBlock/Sandbox).
    // Media sssrr butuh Referer abyss tanpa Origin (Origin → 404).
    if (/abyssplayer|abyss\.to|short\.icu|abysscdn/i.test(host)) {
      return `/__hydrax__?u=${encodeURIComponent(play)}`;
    }
  } catch {
    /* fallback proxy */
  }
  return data.embed || toProxyPath(play);
}

function clearEmbed() {
  const frame = $("#playerFrame");
  if (!frame) return;
  frame.src = "about:blank";
  frame.classList.add("hidden");
}

/** Sandbox iframe dimatikan: memicu error TurboVIP/Cast/P2P (klik play & kode 233429).
 *  Clickunder tetap diblokir oleh shim window.open di dalam proxy. */
function applyPlayerFramePolicy(embedPath) {
  const frame = $("#playerFrame");
  if (!frame) return;
  frame.removeAttribute("sandbox");
}

async function showEmbed(url) {
  const reqId = ++embedRequestId;
  const player = $("#player");
  const frame = $("#playerFrame");
  const overlay = $(".player-overlay", player);
  const progress = $("#playerProgress");

  $("#playerHint").textContent = `Memuat server: ${serverLabel(url)}…`;
  $("#playerPoster").classList.remove("hidden");
  overlay.classList.remove("hidden");
  progress.classList.add("hidden");
  frame.classList.add("hidden");
  frame.src = "about:blank";

  try {
    const embedPath = await resolveEmbedPath(url);
    if (reqId !== embedRequestId || currentServerUrl !== url) return;

    applyPlayerFramePolicy(embedPath);
    frame.src = embedPath;
    frame.classList.remove("hidden");
    $("#playerPoster").classList.add("hidden");
    overlay.classList.add("hidden");
    player.classList.add("is-playing", "is-embed");
    $("#playerHint").textContent = `Server: ${serverLabel(url)}`;
  } catch (err) {
    if (reqId !== embedRequestId) return;
    console.error(err);
    $("#playerHint").textContent = `Gagal memuat player — coba ganti server. (${err.message})`;
    overlay.classList.remove("hidden");
    frame.classList.add("hidden");
  }
}

function selectServer(url) {
  currentServerUrl = url || null;
  if (!url) {
    clearEmbed();
    $("#playerHint").textContent = "Mode demo — preview poster cinematic";
    return;
  }
  showEmbed(url);
}

function playerMatchText(player) {
  return `${player?.server || ""} ${player?.label || ""} ${player?.url || ""}`.toLowerCase();
}

/** Pilih server awal: film→Hydrax; anime→Wibufile 1080p. */
function pickPreferredPlayer(movie, players) {
  if (!players?.length) return null;
  const isAnimeType =
    movie?.type === "anime" || movie?.type === "anime-movie";
  const prefer = (preds) => {
    for (const pred of preds) {
      const hit = players.find(pred);
      if (hit) return hit;
    }
    return null;
  };

  let picked = null;
  if (isAnimeType) {
    picked = prefer([
      (p) => /wibufile/.test(playerMatchText(p)) && /1080/.test(playerMatchText(p)),
      (p) => /wibufile/.test(playerMatchText(p)) && /720/.test(playerMatchText(p)),
      (p) => /wibufile/.test(playerMatchText(p)),
      (p) => /1080/.test(String(p.label || "")),
      (p) => /blogspot|blogger/.test(playerMatchText(p)),
      (p) => /vip/.test(playerMatchText(p)),
    ]);
  } else {
    picked = prefer([
      (p) => /hydrax|abyss/.test(playerMatchText(p)),
      (p) => /turbovip/.test(playerMatchText(p)),
      (p) => /cast/.test(playerMatchText(p)),
    ]);
  }

  return (
    picked ||
    players.find(
      (p) => p.default && (p.server || "").toLowerCase() !== "p2p"
    ) ||
    players.find((p) => (p.server || "").toLowerCase() !== "p2p") ||
    players.find((p) => p.default) ||
    players[0]
  );
}

function setupServers(movie) {
  const wrap = $("#playerServerDropdown");
  const players = currentPlayers(movie);

  if (!players.length) {
    wrap.classList.add("hidden");
    currentServerUrl = null;
    clearEmbed();
    return false;
  }

  const initial = pickPreferredPlayer(movie, players);

  populateNfDropdown(wrap, {
    valueId: "playerServerValue",
    selectedValue: initial.url,
    items: players.map((p) => ({
      value: p.url,
      label: formatServerName(p),
    })),
    onSelect: (url) => selectServer(url),
  });

  wrap.classList.remove("hidden");
  selectServer(initial.url);
  return true;
}

function setupPlayerEpisodes(movie) {
  const wrap = $("#playerEpisodeDropdown");
  const eps = episodeOptions(movie);
  if (!isSeries(movie) || !eps.length) {
    wrap.classList.add("hidden");
    return;
  }

  const pick =
    eps.find((e) => e.slug === activeEpisode?.slug) ||
    [...eps].reverse().find((e) => e.players?.length) ||
    eps[eps.length - 1];
  activeEpisode = pick;

  populateNfDropdown(wrap, {
    valueId: "playerEpisodeValue",
    selectedValue: pick.slug,
    items: eps.map((ep) => ({
      value: ep.slug,
      label: episodeLabel(ep),
    })),
    onSelect: (slug) => {
      // Pakai `movie` dari closure, bukan activeMovie global (hero carousel bisa menimpa).
      const show = movie || activeMovie;
      activeEpisode = getEpisodeBySlug(show, slug);
      if (!activeEpisode) return;
      $("#playerTitle").textContent = `${show.nama}${playerEpisodeSuffix(activeEpisode, show)}`;
      setupServers(show);
    },
  });

  wrap.classList.remove("hidden");
}

async function openPlayer(movie) {
  if (!currentUser) {
    enterAuthGate("login");
    return;
  }
  movie = (await hydrateItem(movie)) || movie;
  activeMovie = movie;
  if (!isSeries(movie)) {
    activeEpisode = null;
  } else if (!activeEpisode) {
    activeEpisode =
      [...episodeOptions(movie)].reverse().find((e) => e.players?.length) ||
      episodeOptions(movie).at(-1) ||
      null;
  }
  closeModal();
  const player = $("#player");
  $("#playerTitle").textContent = `${movie.nama}${playerEpisodeSuffix(activeEpisode, movie)}`;
  $("#playerPoster").style.backgroundImage = `url("${movie.thumbnail}")`;
  $("#playerPoster").classList.remove("hidden");
  $(".player-overlay", player).classList.remove("hidden");
  $("#playerProgress").classList.remove("hidden");
  $("#playerBar").style.width = "0%";
  player.classList.remove("hidden", "is-playing", "is-embed");
  $(".icon-play", player).classList.remove("hidden");
  $(".icon-pause", player).classList.add("hidden");
  document.body.style.overflow = "hidden";

  setupPlayerEpisodes(movie);
  const hasServers = setupServers(movie);
  if (!hasServers) {
    $("#playerHint").textContent = "Mode demo — preview poster cinematic";
  }
  stopHeroCarousel();
  recordWatchHistory(movie);
}

function closePlayer() {
  const player = $("#player");
  player.classList.add("hidden");
  player.classList.remove("is-playing", "is-embed");
  currentServerUrl = null;
  clearEmbed();
  clearInterval(playerTimer);
  closeNfDropdowns();
  document.body.style.overflow = $("#modal").classList.contains("hidden") ? "" : "hidden";
  startHeroCarousel();
}

function togglePlay() {
  // Film dengan server nyata sudah auto-play via iframe embed.
  if (currentServerUrl) return;

  const player = $("#player");
  const playing = player.classList.toggle("is-playing");
  $(".icon-play", player).classList.toggle("hidden", playing);
  $(".icon-pause", player).classList.toggle("hidden", !playing);
  $("#playerHint").textContent = playing
    ? `Memutar ${activeMovie?.nama ?? "film"}…`
    : "Dijeda — ketuk lagi untuk lanjut";
}

function clearSearchUi() {
  const input = $("#searchInput");
  const section = $("#searchResults");
  const rows = $("#koleksi");
  if (input) input.value = "";
  section?.classList.add("hidden");
  rows?.classList.remove("hidden");
}

function setActiveNavLink(hash) {
  const target = hash || "#hero";
  $$("#navMenu a").forEach((link) => {
    const href = link.getAttribute("href") || "";
    link.classList.toggle("is-active", href === target);
  });
  $$(".nav-group").forEach((group) => {
    const on = Boolean($(".nav-group-menu a.is-active", group));
    group.classList.toggle("is-active", on);
  });
}

function isMobileNav() {
  return window.matchMedia("(max-width: 720px)").matches;
}

function closeNavGroup(group) {
  if (!group) return;
  group.classList.remove("is-open");
  const btn = $(".nav-group-btn", group);
  btn?.setAttribute("aria-expanded", "false");
  btn?.blur();
}

function closeNavMenus() {
  $("#nav")?.classList.remove("is-menu-open");
  const toggle = $("#navToggle");
  if (toggle) {
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Buka menu");
  }
  $$(".nav-group").forEach((group) => closeNavGroup(group));
}

function scrollToNavTarget(hash) {
  const id = String(hash || "").replace(/^#/, "");
  if (!id || id === "beranda" || id === "hero") {
    window.scrollTo({ top: 0, behavior: "smooth" });
    setActiveNavLink("#hero");
    return true;
  }
  const el = document.getElementById(id);
  if (!el) return false;
  clearSearchUi();
  const nav = $("#nav");
  const navH = nav ? nav.getBoundingClientRect().height : 84;
  const top = window.scrollY + el.getBoundingClientRect().top - navH - 12;
  window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  setActiveNavLink(`#${id}`);
  return true;
}

function bindNav() {
  const nav = $("#nav");
  const toggle = $("#navToggle");
  const onScroll = () => nav.classList.toggle("is-solid", window.scrollY > 40);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  toggle?.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !nav.classList.contains("is-menu-open");
    if (!open) {
      closeNavMenus();
      return;
    }
    nav.classList.add("is-menu-open");
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Tutup menu");
  });

  $$(".nav-group-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const group = btn.closest(".nav-group");
      if (!group) return;
      if (!isMobileNav()) {
        closeNavGroup(group);
        return;
      }
      const willOpen = !group.classList.contains("is-open");
      $$(".nav-group").forEach((other) => {
        if (other === group) return;
        closeNavGroup(other);
      });
      group.classList.toggle("is-open", willOpen);
      btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });
  });

  $$(".nav-group").forEach((group) => {
    group.addEventListener("mouseleave", () => {
      if (!isMobileNav()) closeNavGroup(group);
    });
  });

  $$("#navMenu a").forEach((link) => {
    link.addEventListener("click", (e) => {
      const href = link.getAttribute("href") || "";
      if (!href.startsWith("#")) return;
      e.preventDefault();
      closeNavMenus();
      scrollToNavTarget(href);
      history.replaceState(null, "", href === "#hero" ? location.pathname : href);
    });
  });

  document.addEventListener("click", (e) => {
    if (!nav.contains(e.target)) closeNavMenus();
  });

  const sectionIds = [
    "anime",
    "top-anime",
    "hot-anime",
    "series-anime",
    "anime-movie",
    "film-terbaru",
    "horor",
    "aksi",
    "drama",
    "series",
    "indonesia",
  ];
  const sections = sectionIds
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  if (sections.length && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (!visible.length) {
          if (window.scrollY < 180) setActiveNavLink("#hero");
          return;
        }
        setActiveNavLink(`#${visible[0].target.id}`);
      },
      {
        rootMargin: "-20% 0px -55% 0px",
        threshold: [0.15, 0.35, 0.55],
      }
    );
    sections.forEach((section) => observer.observe(section));
  }

  if (location.hash) {
    requestAnimationFrame(() => scrollToNavTarget(location.hash));
  }
}

function syncRowArrows(track) {
  if (!track) return;
  const wrap = track.closest(".row-track-wrap");
  if (!wrap) return;
  const prev = wrap.querySelector(".row-arrow.prev");
  const next = wrap.querySelector(".row-arrow.next");
  const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
  const canScroll = maxScroll > 12;
  const atStart = track.scrollLeft <= 12;
  const atEnd = track.scrollLeft >= maxScroll - 12;
  const more = Boolean(rowState[track.id] && !rowState[track.id].done);

  if (prev) prev.classList.toggle("is-hidden", !canScroll || atStart);
  if (next) next.classList.toggle("is-hidden", (!canScroll && !more) || (atEnd && !more));
}

async function loadMoreTrack(trackId) {
  const cfg = ROW_CONFIG[trackId];
  const state = rowState[trackId];
  if (!cfg || !state || state.loading || state.done) return false;
  const list = listForKey(cfg.listKey);
  if (!list) return false;
  state.loading = true;
  try {
    const nextPage = state.page + 1;
    const before = list.length;
    const data = await loadCollectionPage(cfg.collection, list, {
      page: nextPage,
      genre: cfg.genre || "",
      sort: cfg.sort || "",
    });
    const added = list.slice(before);
    state.page = nextPage;
    state.total = data.total;
    if (!data.items.length || list.length >= data.total) state.done = true;
    if (added.length) fillTrack(trackId, added, { append: true, startIndex: before });
    return added.length > 0;
  } catch (err) {
    console.warn(`[catalog] load more ${trackId}`, err);
    return false;
  } finally {
    state.loading = false;
    syncRowArrows(document.getElementById(trackId));
  }
}

function bindRows() {
  $$(".row-track").forEach((track) => {
    const updateArrows = () => syncRowArrows(track);
    track.addEventListener(
      "scroll",
      () => {
        updateArrows();
        const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
        // Hanya prefetch jika baris memang overflow dan user sudah geser ke ujung.
        if (maxScroll > 12 && track.scrollLeft >= maxScroll - 80) {
          loadMoreTrack(track.id);
        }
      },
      { passive: true }
    );

    updateArrows();
    requestAnimationFrame(updateArrows);
    setTimeout(updateArrows, 100);
    setTimeout(updateArrows, 500);
  });

  $$(".row-arrow").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const track = document.getElementById(btn.dataset.row);
      if (!track) return;
      if (btn.classList.contains("next")) {
        const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
        if (track.scrollLeft >= maxScroll - 12 || maxScroll <= 12) {
          await loadMoreTrack(track.id);
        }
      }
      const delta =
        Math.max(240, Math.round(track.clientWidth * 0.85)) *
        (btn.classList.contains("next") ? 1 : -1);
      track.scrollBy({ left: delta, behavior: "smooth" });
      requestAnimationFrame(() => syncRowArrows(track));
      setTimeout(() => syncRowArrows(track), 400);
    });
  });

  window.addEventListener(
    "resize",
    () => $$(".row-track").forEach((track) => syncRowArrows(track)),
    { passive: true }
  );
}

function bindSearch() {
  const input = $("#searchInput");
  const section = $("#searchResults");
  const grid = $("#searchGrid");
  const rows = $("#koleksi");
  let timer = 0;
  let seq = 0;

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (!q) {
      section.classList.add("hidden");
      rows.classList.remove("hidden");
      return;
    }
    timer = setTimeout(async () => {
      const n = ++seq;
      try {
        const res = await fetch(`/api/v1/search?q=${encodeURIComponent(q)}&limit=40`, {
          credentials: "include",
        });
        if (!res.ok || n !== seq) return;
        const data = await res.json();
        const hits = Array.isArray(data?.items) ? data.items : [];
        for (const item of hits) {
          rememberItems(item.catalog || resolveCollection(item), [item]);
        }
        if (n !== seq) return;
        grid.replaceChildren(...hits.map((m, i) => createPoster(m, i)));
        section.classList.remove("hidden");
        rows.classList.add("hidden");
      } catch {
        if (n !== seq) return;
        grid.replaceChildren();
        section.classList.remove("hidden");
        rows.classList.add("hidden");
      }
    }, 250);
  });
}

function bindActions() {
  $("#heroPlay").addEventListener("click", () => heroMovie && openPlayer(heroMovie));
  $("#heroInfo").addEventListener("click", () => heroMovie && openModal(heroMovie));
  $("#modalPlay").addEventListener("click", () => {
    if (!activeMovie) return;
    if (isSeries(activeMovie)) {
      const slug = $("#modalEpisodeSelect")?.value;
      activeEpisode = getEpisodeBySlug(activeMovie, slug) || activeEpisode;
    }
    openPlayer(activeMovie);
  });
  $("#modalFav")?.addEventListener("click", async () => {
    if (!currentUser || !activeMovie?.slug) return;
    const collection = resolveCollection(activeMovie);
    const slug = activeMovie.slug;
    const btn = $("#modalFav");
    if (btn) btn.disabled = true;
    try {
      if (modalIsFavorite) {
        const { res } = await libraryFetch(
          `/favorites/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}`,
          { method: "DELETE" }
        );
        if (res.ok) setFavButtonState(false);
      } else {
        const { res } = await libraryFetch("/favorites", {
          method: "POST",
          body: JSON.stringify({
            collection,
            slug,
            title: activeMovie.nama || activeMovie.judul || slug,
            thumbnail: activeMovie.thumbnail || null,
          }),
        });
        if (res.ok) setFavButtonState(true);
      }
      await loadUserLibrary();
      renderLibraryRows();
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  $("#modalEpisodeSelect")?.addEventListener("change", (e) => {
    if (!activeMovie) return;
    activeEpisode = getEpisodeBySlug(activeMovie, e.target.value);
    syncEpisodeListActive(e.target.value);
  });
  $("#modalEpisodeList")?.addEventListener("click", (e) => {
    const row = e.target.closest(".episode-row");
    if (!row || !activeMovie) return;
    const select = $("#modalEpisodeSelect");
    if (!select) return;
    select.value = row.dataset.slug || "";
    select.dispatchEvent(new Event("change"));
    if (e.target.closest(".episode-row-play")) {
      openPlayer(activeMovie);
    }
  });
  $("#playerBack").addEventListener("click", closePlayer);
  $("#playerToggle").addEventListener("click", togglePlay);

  bindNfDropdown($("#playerEpisodeDropdown"));
  bindNfDropdown($("#playerServerDropdown"));
  document.addEventListener("click", () => closeNfDropdowns());

  $$("[data-close]").forEach((el) => el.addEventListener("click", closeModal));

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#usersModal")?.classList.contains("hidden")) {
      if (isUsersSheetOpen()) closeUsersSheet();
      else closeUsersModal();
      return;
    }
    if (!$("#authModal")?.classList.contains("hidden")) {
      closeAuthModal();
      return;
    }
    if ($$(".nf-dropdown.is-open").length) {
      closeNfDropdowns();
      return;
    }
    if ($("#nav")?.classList.contains("is-menu-open")) {
      closeNavMenus();
      return;
    }
    if (!$("#player").classList.contains("hidden")) closePlayer();
    else closeModal();
  });
}

let currentUser = null;
let appBooted = false;
let authBindingsReady = false;

async function authFetch(path, options = {}) {
  const res = await fetch(`/api/auth${path}`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { res, data };
}

function setAuthError(msg) {
  const el = $("#authError");
  const ok = $("#authSuccess");
  ok?.classList.add("hidden");
  if (ok) ok.textContent = "";
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function setAuthSuccess(msg) {
  const el = $("#authSuccess");
  const err = $("#authError");
  err?.classList.add("hidden");
  if (err) err.textContent = "";
  if (!el) return;
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function canInviteUsers() {
  return Boolean(currentUser?.isAdmin || currentUser?.canInvite);
}

function setUsersError(msg) {
  const el = $("#usersError");
  if (!el) return;
  if (!msg) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function setUsersSuccess(msg) {
  const el = $("#usersSuccess");
  if (!el) return;
  if (!msg) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function setUsersSheetError(msg) {
  const el = $("#usersSheetError");
  if (!el) return;
  if (!msg) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function resetUsersForm() {
  const form = $("#usersForm");
  if (!form) return;
  form.reset();
  form.elements.id.value = "";
  const userInput = form.elements.username;
  if (userInput) userInput.disabled = false;
  const pass = form.elements.password;
  if (pass) pass.required = true;
  const label = $("#usersPasswordLabel");
  if (label) label.textContent = "Password (min. 10, huruf + angka)";
  const submitLabel = $("#usersSubmit .auth-submit-label");
  if (submitLabel) submitLabel.textContent = "Simpan";
  const title = $("#usersSheetTitle");
  if (title) title.textContent = "Tambah pengguna";
  setAuthFormLoading(form, false, "Simpan");
  setUsersSheetError("");
}

function fillUsersForm(user) {
  const form = $("#usersForm");
  if (!form || !user) return;
  form.elements.id.value = String(user.id || "");
  form.elements.displayName.value = user.displayName || "";
  form.elements.username.value = user.username || "";
  form.elements.username.disabled = true;
  form.elements.email.value = user.email || "";
  form.elements.password.value = "";
  form.elements.password.required = false;
  const label = $("#usersPasswordLabel");
  if (label) label.textContent = "Password baru (kosongkan jika tidak diubah)";
  const submitLabel = $("#usersSubmit .auth-submit-label");
  if (submitLabel) submitLabel.textContent = "Simpan perubahan";
  const title = $("#usersSheetTitle");
  if (title) title.textContent = "Ubah pengguna";
}

function isUsersSheetOpen() {
  return Boolean($("#usersSheet") && !$("#usersSheet").classList.contains("hidden"));
}

function openUsersSheet() {
  $("#usersSheet")?.classList.remove("hidden");
  requestAnimationFrame(() => {
    $("#usersForm")?.elements.displayName?.focus();
  });
}

function closeUsersSheet() {
  $("#usersSheet")?.classList.add("hidden");
  resetUsersForm();
  setUsersSheetError("");
}

function formatUserDate(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleDateString("id-ID", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(value);
  }
}

function renderUsersTable(users) {
  const body = $("#usersTableBody");
  if (!body) return;
  if (!users.length) {
    body.replaceChildren();
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="3">Belum ada pengguna.</td>`;
    body.append(tr);
    return;
  }
  body.replaceChildren(
    ...users.map((user) => {
      const tr = document.createElement("tr");
      tr.dataset.id = String(user.id);
      tr.dataset.username = user.username || "";
      tr.dataset.email = user.email || "";
      tr.dataset.displayName = user.displayName || "";
      const locked = Boolean(user.isAdmin);
      tr.innerHTML = `
        <td>
          <span class="users-name"></span>
          <span class="users-handle"></span>
        </td>
        <td></td>
        <td class="users-row-actions"></td>
      `;
      $(".users-name", tr).textContent = user.displayName || user.username;
      if (locked) {
        const badge = document.createElement("span");
        badge.className = "users-badge";
        badge.textContent = "Admin";
        $(".users-name", tr).append(badge);
      }
      $(".users-handle", tr).textContent = `@${user.username} · ${formatUserDate(user.createdAt)}`;
      tr.children[1].textContent = user.email || "";
      const actions = $(".users-row-actions", tr);
      if (!locked) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "btn-user";
        edit.dataset.userAction = "edit";
        edit.textContent = "Ubah";
        const del = document.createElement("button");
        del.type = "button";
        del.className = "btn-user is-danger";
        del.dataset.userAction = "delete";
        del.textContent = "Hapus";
        actions.append(edit, del);
      }
      return tr;
    })
  );
}

async function loadAdminUsers() {
  if (!canInviteUsers()) return;
  const { res, data } = await authFetch("/users");
  if (!res.ok) {
    setUsersError(data?.error || "Gagal memuat pengguna.");
    return;
  }
  renderUsersTable(Array.isArray(data?.users) ? data.users : []);
}

async function openUsersModal() {
  if (!canInviteUsers()) return;
  closeAuthModal();
  closeUsersSheet();
  setUsersError("");
  setUsersSuccess("");
  $("#usersModal")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
  try {
    await loadAdminUsers();
  } catch (err) {
    console.error(err);
    setUsersError("Gagal memuat pengguna.");
  }
}

function closeUsersModal() {
  const modal = $("#usersModal");
  if (!modal || modal.classList.contains("hidden")) return;
  modal.classList.add("hidden");
  closeUsersSheet();
  setUsersError("");
  setUsersSuccess("");
  if (
    $("#authModal")?.classList.contains("hidden") &&
    $("#modal")?.classList.contains("hidden") &&
    $("#player")?.classList.contains("hidden")
  ) {
    document.body.style.overflow = "";
  }
}

function syncAuthGateChrome() {
  const modal = $("#authModal");
  const closeBtn = $("#authCloseBtn");
  const lead = $("#authLead");
  const checking = document.body.classList.contains("is-auth-checking");
  const locked = !currentUser && !checking;

  document.body.classList.toggle("is-auth-locked", locked);
  modal?.classList.toggle("is-gate", locked && !modal.classList.contains("hidden"));
  closeBtn?.classList.toggle("hidden", locked || checking);
  if (lead && locked) {
    lead.classList.remove("hidden");
    lead.textContent = "Login untuk mulai menonton";
  }
}

function endAuthBoot() {
  document.body.classList.remove("is-auth-checking");
  const boot = $("#authBoot");
  if (boot) {
    boot.setAttribute("aria-busy", "false");
    boot.classList.remove("is-visible");
    boot.classList.add("hidden");
  }
}

function showAuthBoot(message = "Memuat…") {
  const boot = $("#authBoot");
  const msg = $("#authBootMsg");
  if (msg) msg.textContent = message;
  if (boot) {
    boot.classList.remove("hidden");
    boot.classList.add("is-visible");
    boot.setAttribute("aria-busy", "true");
  }
  document.body.classList.add("is-auth-checking");
}

function setAuthFormLoading(form, loading, labelWhenIdle) {
  if (!form) return;
  const btn = form.querySelector(".auth-submit");
  const label = btn?.querySelector(".auth-submit-label");
  const spin = btn?.querySelector(".auth-submit-spinner");
  form.classList.toggle("is-loading", loading);
  btn?.classList.toggle("is-loading", loading);
  if (btn) btn.disabled = Boolean(loading);
  spin?.classList.toggle("hidden", !loading);
  if (label && loading) label.textContent = "Memuat…";
  if (label && !loading && labelWhenIdle) label.textContent = labelWhenIdle;
}

function resetAuthForms() {
  const login = $("#authLoginForm");
  login?.reset();
  setAuthFormLoading(login, false, "Login");
  resetUsersForm();
}

function enterAuthGate(mode = "login") {
  closePlayer();
  closeModal();
  endAuthBoot();
  resetAuthForms();
  showAuthPane(mode === "register" ? "login" : mode);
  const modal = $("#authModal");
  modal.classList.remove("hidden");
  modal.classList.add("is-gate");
  document.body.classList.add("is-auth-locked");
  document.body.style.overflow = "hidden";
  $("#authCloseBtn")?.classList.add("hidden");
  syncAuthGateChrome();
}

function leaveAuthGate() {
  endAuthBoot();
  document.body.classList.remove("is-auth-locked");
  $("#authModal").classList.remove("is-gate");
  $("#authCloseBtn")?.classList.remove("hidden");
}

function renderAuthChrome() {
  const openBtn = $("#authOpenBtn");
  const usersBtn = $("#authUsersBtn");
  const chip = $("#authChip");
  const name = $("#authChipName");
  const avatar = $("#authAvatar");
  const tabLogin = $("#authTabLogin");
  const tabProfile = $("#authTabProfile");

  if (currentUser) {
    openBtn.classList.add("hidden");
    chip.classList.remove("hidden");
    name.textContent = currentUser.displayName || currentUser.username;
    avatar.textContent = (currentUser.displayName || currentUser.username || "?").slice(0, 1).toUpperCase();
    tabLogin?.classList.add("hidden");
    tabProfile.classList.remove("hidden");
    usersBtn?.classList.toggle("hidden", !canInviteUsers());
  } else {
    openBtn.classList.remove("hidden");
    chip.classList.add("hidden");
    usersBtn?.classList.add("hidden");
    tabLogin?.classList.remove("hidden");
    tabProfile.classList.add("hidden");
    closeUsersModal();
  }
  syncAuthGateChrome();
}

function showAuthPane(mode) {
  let nextMode = mode === "register" ? (currentUser ? "profile" : "login") : mode;

  const login = $("#authLoginForm");
  const profile = $("#authProfileForm");
  const title = $("#authModalTitle");
  const lead = $("#authLead");
  const tabs = {
    login: $("#authTabLogin"),
    profile: $("#authTabProfile"),
  };

  login.classList.toggle("hidden", nextMode !== "login");
  profile.classList.toggle("hidden", nextMode !== "profile");

  Object.entries(tabs).forEach(([key, el]) => {
    if (!el) return;
    const visible =
      (key === "login" && !currentUser) ||
      (key === "profile" && Boolean(currentUser));
    el.classList.toggle("hidden", !visible);
    el.classList.toggle("is-active", key === nextMode);
    el.setAttribute("aria-selected", key === nextMode ? "true" : "false");
  });

  if (nextMode === "login") title.textContent = "Login ke WEBUNIME";
  else title.textContent = "Profil saya";

  if (lead) {
    if (!currentUser) {
      lead.classList.remove("hidden");
      lead.textContent = "Login untuk mulai menonton";
    } else if (nextMode === "profile") {
      lead.classList.remove("hidden");
      lead.textContent = "Kelola profil akun Anda";
    } else {
      lead.classList.add("hidden");
    }
  }

  if (nextMode === "profile" && currentUser) {
    $("#authProfileMeta").textContent = `@${currentUser.username} · ${currentUser.email}`;
    const input = $("#authProfileForm")?.querySelector('[name="displayName"]');
    if (input) input.value = currentUser.displayName || "";
  }
  setAuthError("");
  setAuthSuccess("");
}

function openAuthModal(mode = currentUser ? "profile" : "login") {
  if (!currentUser) {
    enterAuthGate(mode === "profile" ? "login" : mode);
    return;
  }
  showAuthPane(mode);
  $("#authModal").classList.remove("hidden");
  $("#authModal").classList.remove("is-gate");
  $("#authCloseBtn")?.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeAuthModal() {
  if (!currentUser) return;
  $("#authModal").classList.add("hidden");
  $("#authModal").classList.remove("is-gate");
  setAuthError("");
  if ($("#modal").classList.contains("hidden") && $("#player").classList.contains("hidden")) {
    document.body.style.overflow = "";
  }
}

async function refreshAuthSession() {
  try {
    const { res, data } = await authFetch("/me");
    currentUser = res.ok ? data?.user || null : null;
  } catch {
    currentUser = null;
  }
  renderAuthChrome();
}

async function bootApp() {
  if (appBooted) {
    await loadUserLibrary();
    renderLibraryRows();
    leaveAuthGate();
    closeAuthModal();
    return;
  }
  await loadHomeCatalog();
  await initHeroCarousel();
  bindNav();
  bindRows();
  bindSearch();
  bindActions();
  await loadUserLibrary();
  renderRows();
  appBooted = true;
  leaveAuthGate();
  closeAuthModal();
}

async function onAuthSuccess(user, bootMessage = "Menyiapkan beranda…") {
  currentUser = user;
  renderAuthChrome();
  showAuthBoot(bootMessage);
  $("#authModal")?.classList.add("hidden");
  try {
    await bootApp();
  } catch (err) {
    console.error(err);
    setAuthError("Login berhasil, tetapi katalog gagal dimuat. Muat ulang halaman.");
    enterAuthGate("login");
  }
}

function bindAuth() {
  if (authBindingsReady) return;
  authBindingsReady = true;

  $("#authOpenBtn")?.addEventListener("click", () => openAuthModal("login"));
  $("#authAccountBtn")?.addEventListener("click", () => openAuthModal("profile"));
  $$("[data-auth-close]").forEach((el) =>
    el.addEventListener("click", () => {
      if (!currentUser) return;
      closeAuthModal();
    })
  );
  $("#authTabLogin")?.addEventListener("click", () => showAuthPane("login"));
  $("#authTabProfile")?.addEventListener("click", () => {
    if (currentUser) showAuthPane("profile");
  });
  $("#authUsersBtn")?.addEventListener("click", () => {
    if (!canInviteUsers()) return;
    openUsersModal();
  });
  $$("[data-users-close]").forEach((el) =>
    el.addEventListener("click", () => {
      if (el.classList.contains("auth-modal-backdrop") && isUsersSheetOpen()) {
        closeUsersSheet();
        return;
      }
      closeUsersModal();
    })
  );
  $("#usersAddBtn")?.addEventListener("click", () => {
    setUsersError("");
    setUsersSuccess("");
    resetUsersForm();
    openUsersSheet();
  });
  $$("[data-users-sheet-close]").forEach((el) =>
    el.addEventListener("click", () => closeUsersSheet())
  );

  $("#authLoginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    setAuthError("");
    setAuthSuccess("");
    setAuthFormLoading(form, true, "Login");
    try {
      const fd = new FormData(form);
      const { res, data } = await authFetch("/login", {
        method: "POST",
        body: JSON.stringify({
          login: String(fd.get("login") || ""),
          password: String(fd.get("password") || ""),
        }),
      });
      if (!res.ok) {
        setAuthError(data?.error || "Gagal login.");
        return;
      }
      await onAuthSuccess(data.user, "Login berhasil, memuat katalog…");
    } catch (err) {
      console.error(err);
      setAuthError("Gagal login. Coba lagi.");
    } finally {
      setAuthFormLoading(form, false, "Login");
    }
  });

  $("#usersForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    setUsersSheetError("");
    setUsersSuccess("");
    if (!canInviteUsers()) {
      setUsersSheetError("Khusus admin.");
      return;
    }
    const fd = new FormData(form);
    const editingId = String(fd.get("id") || "").trim();
    const payload = {
      displayName: String(fd.get("displayName") || ""),
      username: String(fd.get("username") || "").toLowerCase(),
      email: String(fd.get("email") || "").toLowerCase(),
      password: String(fd.get("password") || ""),
    };
    const idleLabel = editingId ? "Simpan perubahan" : "Simpan";
    setAuthFormLoading(form, true, idleLabel);
    try {
      const { res, data } = editingId
        ? await authFetch(`/users/${encodeURIComponent(editingId)}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          })
        : await authFetch("/users", {
            method: "POST",
            body: JSON.stringify(payload),
          });
      if (!res.ok) {
        setUsersSheetError(data?.error || "Gagal menyimpan pengguna.");
        return;
      }
      closeUsersSheet();
      setUsersSuccess(
        editingId ? "Perubahan pengguna disimpan." : `Akun @${payload.username} berhasil dibuat.`
      );
      await loadAdminUsers();
    } catch (err) {
      console.error(err);
      setUsersSheetError("Gagal menyimpan pengguna.");
    } finally {
      const idle = String(form.elements.id.value || "") ? "Simpan perubahan" : "Simpan";
      setAuthFormLoading(form, false, idle);
    }
  });

  $("#usersTableBody")?.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-user-action]");
    if (!btn) return;
    const row = btn.closest("tr");
    const id = row?.dataset.id;
    if (!id || !canInviteUsers()) return;
    const action = btn.dataset.userAction;
    if (action === "edit") {
      fillUsersForm({
        id,
        displayName: row.dataset.displayName || "",
        username: row.dataset.username || "",
        email: row.dataset.email || "",
      });
      setUsersError("");
      setUsersSuccess("");
      openUsersSheet();
      return;
    }
    if (action === "delete") {
      const handle = row.dataset.username || "";
      if (!window.confirm(`Hapus akun @${handle}? Sesi login pengguna itu juga berakhir.`)) return;
      setUsersError("");
      setUsersSuccess("");
      try {
        const { res, data } = await authFetch(`/users/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          setUsersError(data?.error || "Gagal menghapus pengguna.");
          return;
        }
        closeUsersSheet();
        setUsersSuccess(`Akun @${handle} dihapus.`);
        await loadAdminUsers();
      } catch (err) {
        console.error(err);
        setUsersError("Gagal menghapus pengguna.");
      }
    }
  });

  $("#authProfileForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { res, data } = await authFetch("/profile", {
      method: "PATCH",
      body: JSON.stringify({ displayName: String(fd.get("displayName") || "") }),
    });
    if (!res.ok) {
      setAuthError(data?.error || "Gagal menyimpan profil.");
      return;
    }
    currentUser = data.user;
    renderAuthChrome();
    setAuthError("");
    showAuthPane("profile");
  });

  $("#authLogoutBtn")?.addEventListener("click", async () => {
    await authFetch("/logout", { method: "POST", body: "{}" });
    currentUser = null;
    favorites = [];
    watchHistory = [];
    renderLibraryRows();
    renderAuthChrome();
    enterAuthGate("login");
  });
}

async function init() {
  try {
    bindAuth();
    await refreshAuthSession();
    if (!currentUser) {
      enterAuthGate("login");
      return;
    }
    await bootApp();
  } catch (err) {
    console.error(err);
    enterAuthGate("login");
    setAuthError("Gagal memuat aplikasi. Coba masuk lagi.");
  }
}

init();
