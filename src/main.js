let movies = [];
let series = [];
let horror = [];
let indonesia = [];
let anime = [];
let animeMovies = [];
let animeLatest = [];
let catalog = [];
let favorites = [];
let watchHistory = [];
let activeMovie = null;
let activeEpisode = null;
let playerTimer = null;
let modalIsFavorite = false;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function loadMovies() {
  const res = await fetch("/api/v1/catalog/movies/all", { credentials: "include" });
  if (!res.ok) throw new Error("Gagal memuat data film");
  movies = await res.json();
}

async function loadSeries() {
  try {
    const res = await fetch("/api/v1/catalog/series/all", { credentials: "include" });
    if (!res.ok) {
      series = [];
      return;
    }
    series = await res.json();
  } catch {
    series = [];
  }
}

async function loadHorror() {
  try {
    const res = await fetch("/api/v1/catalog/horror/all", { credentials: "include" });
    if (!res.ok) {
      horror = [];
      return;
    }
    horror = await res.json();
  } catch {
    horror = [];
  }
}

async function loadIndonesia() {
  try {
    const res = await fetch("/api/v1/catalog/indonesia/all", { credentials: "include" });
    if (!res.ok) {
      indonesia = [];
      return;
    }
    indonesia = await res.json();
  } catch {
    indonesia = [];
  }
}

async function loadAnime() {
  try {
    const res = await fetch("/api/v1/catalog/anime/all", { credentials: "include" });
    if (!res.ok) {
      anime = [];
      return;
    }
    anime = await res.json();
  } catch {
    anime = [];
  }
}

async function loadAnimeMovies() {
  try {
    const res = await fetch("/api/v1/catalog/anime-movies/all", { credentials: "include" });
    if (!res.ok) {
      animeMovies = [];
      return;
    }
    animeMovies = await res.json();
  } catch {
    animeMovies = [];
  }
}

async function loadAnimeLatest() {
  try {
    const res = await fetch("/api/v1/catalog/anime-latest/all", { credentials: "include" });
    if (!res.ok) {
      animeLatest = [];
      return;
    }
    animeLatest = await res.json();
  } catch {
    animeLatest = [];
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
  if (movie.type === "series") return "series";
  if (movie.type === "anime") return "anime";
  if (movie.type === "anime-movie") return "anime-movies";
  const cat = String(movie.catalog || "").toLowerCase();
  if (cat.includes("horror") || cat === "horor") return "horror";
  if (cat.includes("indonesia")) return "indonesia";
  const slug = movie.slug;
  if (slug && horror.some((h) => h.slug === slug)) return "horror";
  if (slug && indonesia.some((i) => i.slug === slug)) return "indonesia";
  if (slug && series.some((s) => s.slug === slug)) return "series";
  if (slug && anime.some((a) => a.slug === slug)) return "anime";
  if (slug && animeMovies.some((a) => a.slug === slug)) return "anime-movies";
  return "movies";
}

function findInCatalog(collection, slug) {
  const lists = {
    movies,
    series,
    horror,
    indonesia,
    anime,
    "anime-movies": animeMovies,
  };
  const list = lists[collection] || [];
  return list.find((x) => x.slug === slug) || null;
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

function createLibraryPoster(entry, index = 0) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "poster";
  btn.style.animationDelay = `${Math.min(index * 40, 400)}ms`;
  const title = entry.title || entry.slug;
  btn.setAttribute("aria-label", `Buka ${title}`);
  const ep =
    entry.episodeSlug != null
      ? `<span class="poster-ep-continue">Lanjut</span>`
      : "";
  btn.innerHTML = `
    ${ep}
    <img src="${entry.thumbnail || ""}" alt="${title}" loading="lazy" width="200" height="300" />
    <p class="poster-label">${title}</p>
  `;
  btn.addEventListener("click", () => {
    const movie = findInCatalog(entry.collection, entry.slug);
    if (!movie) {
      openModal({
        nama: title,
        judul: title,
        slug: entry.slug,
        thumbnail: entry.thumbnail,
        type:
          entry.collection === "series"
            ? "series"
            : entry.collection === "anime"
              ? "anime"
              : entry.collection === "anime-movies"
                ? "anime-movie"
                : undefined,
        catalog: entry.collection,
        sinopsis: "Item tidak ada di katalog lokal. Coba sync ulang.",
        episodes: [],
      });
      return;
    }
    openModal(movie, { episodeSlug: entry.episodeSlug || null });
  });
  return btn;
}

function renderLibraryRows() {
  const continueRow = $("#rowContinue");
  const favRow = $("#rowFavorites");
  const continueTrack = $("#trackContinue");
  const favTrack = $("#trackFavorites");

  if (continueTrack) {
    continueTrack.replaceChildren(
      ...watchHistory.map((e, i) => createLibraryPoster(e, i))
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

function metaLine(movie) {
  const genres = (movie.genre || []).join(" · ");
  const quality = movie.quality ? ` · ${movie.quality}` : "";
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
    <p class="poster-label">${movie.nama}</p>
  `;
  btn.addEventListener("click", () => openModal(movie));
  return btn;
}

/** Poster episode rilis terbaru (Anime Terbaru). */
function createLatestEpisodePoster(item, index = 0) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "poster poster--episode";
  btn.style.animationDelay = `${Math.min(index * 40, 400)}ms`;
  const epLabel =
    item.episode != null ? `Episode ${item.episode}` : "Episode baru";
  btn.setAttribute("aria-label", `${item.nama} ${epLabel}`);
  btn.innerHTML = `
    <img src="${item.thumbnail}" alt="${item.nama}" loading="lazy" width="200" height="300" />
    <span class="poster-ep">${epLabel}</span>
    <p class="poster-label">${item.nama}</p>
  `;
  btn.addEventListener("click", () => {
    const show = anime.find((a) => a.slug === item.anime_slug);
    if (!show) {
      openModal({
        type: "anime",
        nama: item.nama,
        judul: item.judul || item.nama,
        thumbnail: item.thumbnail,
        slug: item.anime_slug,
        source: item.source,
        episodes: [],
        sinopsis: "Data anime belum lengkap. Tunggu sync katalog.",
      });
      return;
    }
    const epSlug =
      item.episode_slug ||
      `${item.anime_slug}-episode-${item.episode}`;
    openModal(show, { episodeSlug: epSlug });
  });
  return btn;
}

function fillTrack(id, list) {
  const track = document.getElementById(id);
  if (!track) return;
  track.replaceChildren(...list.map((m, i) => createPoster(m, i)));
  requestAnimationFrame(() => syncRowArrows(track));
}

function fillLatestTrack(id, list) {
  const track = document.getElementById(id);
  if (!track) return;
  track.replaceChildren(...list.map((m, i) => createLatestEpisodePoster(m, i)));
  requestAnimationFrame(() => syncRowArrows(track));
}

function renderRows() {
  renderLibraryRows();
  fillTrack("trackFeatured", movies);
  fillTrack("trackSeries", series);
  fillLatestTrack("trackAnimeLatest", animeLatest);
  fillTrack("trackAnime", anime);
  fillTrack("trackAnimeMovie", animeMovies);
  fillTrack("trackHorror", horror);
  fillTrack(
    "trackIndonesia",
    [...indonesia].sort((a, b) => {
      const key = (m) => {
        const iso = String(m.rilis_iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
        const y = Number(m.tahun) || 0;
        return String(y * 10000).padStart(8, "0");
      };
      const d = key(b).localeCompare(key(a));
      if (d) return d;
      return String(a.nama || "").localeCompare(String(b.nama || ""), "id");
    })
  );
  // Tahun berjalan (mengikuti jam perangkat), bukan angka hardcode.
  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;
  const title2026 = document.getElementById("title2026");
  const title2025 = document.getElementById("title2025");
  if (title2026) title2026.textContent = `Film ${currentYear}`;
  if (title2025) title2025.textContent = `Film ${prevYear}`;
  fillTrack(
    "track2026",
    movies.filter((m) => Number(m.tahun) === currentYear)
  );
  fillTrack(
    "track2025",
    movies.filter((m) => Number(m.tahun) === prevYear)
  );
  fillTrack(
    "trackAction",
    movies.filter((m) => hasGenre(m, ["Action", "Adventure", "Thriller", "Horror"]))
  );
  fillTrack(
    "trackDrama",
    movies.filter((m) => hasGenre(m, ["Drama", "Romance", "Comedy"]))
  );
  fillTrack(
    "trackClassic",
    movies.filter((m) => Number(m.tahun) <= 2022)
  );
}

function shortSinopsis(text) {
  if (!text) return "";
  const first = String(text).split(/\n\n+/)[0].trim();
  return first.length > 360 ? `${first.slice(0, 357)}…` : first;
}

function parseSinopsisDetail(sinopsis) {
  const blocks = String(sinopsis || "")
    .split(/\n\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const facts = {};
  const story = [];
  for (const block of blocks) {
    const m = block.match(
      /^(Subtitle|Sutradara|Bintang Film|Negara|Votes|Release|Updated|Worldwide Gross):\s*([\s\S]+)$/i
    );
    if (m) {
      facts[m[1].toLowerCase()] = m[2].trim();
    } else {
      story.push(block);
    }
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

function setHero(movie) {
  activeMovie = movie;
  const bg = $("#heroBg");
  bg.style.backgroundImage = `url("${movie.thumbnail}")`;
  $("#heroTitle").textContent = movie.nama;
  $("#heroMeta").textContent = metaLine(movie);
  $("#heroDesc").textContent = shortSinopsis(movie.sinopsis);
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

function openModal(movie, opts = {}) {
  if (!currentUser) {
    enterAuthGate("login");
    return;
  }
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

  setModalFact("factCast", "modalCast", facts["bintang film"]);
  setModalFact("factDirector", "modalDirector", facts.sutradara);
  setModalFact("factSubtitle", "modalSubtitle", facts.subtitle);
  setModalFact("factCountry", "modalCountry", facts.negara);
  setModalFact("factGross", "modalGross", facts["worldwide gross"]);
  setModalFact("factRelease", "modalRelease", facts.release);

  const epWrap = $("#modalEpisodes");
  const epSelect = $("#modalEpisodeSelect");
  if (isSeries(movie) && episodeOptions(movie).length) {
    activeEpisode = fillEpisodeSelect(epSelect, movie, opts.episodeSlug || null);
    epWrap.classList.remove("hidden");
  } else {
    epSelect.replaceChildren();
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
    // Hydrax: wajib origin abyssplayer.com — proxy → "No playable sources found"
    if (/abyssplayer|abyss\.to|short\.icu|abysscdn/i.test(host)) {
      return play;
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

/** Cast/Turbo: sandbox tanpa allow-popups (blokir clickunder). Hydrax: tanpa sandbox. */
function applyPlayerFramePolicy(embedPath) {
  const frame = $("#playerFrame");
  if (!frame) return;
  const path = String(embedPath || "");
  const needsSandbox = /gn1r5n|turbo|emturbovid|turbovid|turboviplay/i.test(path);
  if (needsSandbox) {
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-presentation allow-downloads"
    );
  } else {
    frame.removeAttribute("sandbox");
  }
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

function setupServers(movie) {
  const wrap = $("#playerServerDropdown");
  const players = currentPlayers(movie);

  if (!players.length) {
    wrap.classList.add("hidden");
    currentServerUrl = null;
    clearEmbed();
    return false;
  }

  const preferred =
    isSeries(movie) && (movie?.type === "anime" || movie?.type === "anime-movie")
      ? ["blogspot", "wibufile", "vip-streaming", "vip"]
      : ["turbovip", "cast", "hydrax"];
  const initial =
    preferred
      .map((s) =>
        players.find(
          (p) =>
            (p.server || "").toLowerCase().includes(s) ||
            (p.label || "").toLowerCase().includes(s)
        )
      )
      .find(Boolean) ||
    players.find((p) => p.default && (p.server || "").toLowerCase() !== "p2p") ||
    players.find((p) => (p.server || "").toLowerCase() !== "p2p") ||
    players.find((p) => p.default) ||
    players[0];

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
      activeEpisode = getEpisodeBySlug(activeMovie, slug);
      $("#playerTitle").textContent = `${activeMovie.nama}${playerEpisodeSuffix(activeEpisode)}`;
      setupServers(activeMovie);
    },
  });

  wrap.classList.remove("hidden");
}

function openPlayer(movie) {
  if (!currentUser) {
    enterAuthGate("login");
    return;
  }
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

function bindNav() {
  const nav = $("#nav");
  const onScroll = () => nav.classList.toggle("is-solid", window.scrollY > 40);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
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

  if (prev) prev.classList.toggle("is-hidden", !canScroll || atStart);
  // Tombol kanan: tampilkan jika bisa scroll (atau paksa tampil saat overflow)
  if (next) next.classList.toggle("is-hidden", !canScroll || atEnd);
}

function bindRows() {
  $$(".row-track").forEach((track) => {
    const update = () => syncRowArrows(track);
    track.addEventListener("scroll", update, { passive: true });
    track.addEventListener("load", update, true);

    update();
    requestAnimationFrame(update);
    setTimeout(update, 100);
    setTimeout(update, 500);
    setTimeout(update, 1500);
  });

  $$(".row-arrow").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const track = document.getElementById(btn.dataset.row);
      if (!track) return;
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

  input.addEventListener("input", () => {
    const q = input.value.trim().toLowerCase();
    if (!q) {
      section.classList.add("hidden");
      rows.classList.remove("hidden");
      return;
    }

    const hits = catalog.filter(
      (m) =>
        m.nama.toLowerCase().includes(q) ||
        m.judul.toLowerCase().includes(q) ||
        (m.genre || []).some((g) => g.toLowerCase().includes(q))
    );

    grid.replaceChildren(...hits.map((m, i) => createPoster(m, i)));
    section.classList.remove("hidden");
    rows.classList.add("hidden");
  });
}

function bindActions() {
  $("#heroPlay").addEventListener("click", () => activeMovie && openPlayer(activeMovie));
  $("#heroInfo").addEventListener("click", () => activeMovie && openModal(activeMovie));
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
  });
  $("#playerBack").addEventListener("click", closePlayer);
  $("#playerToggle").addEventListener("click", togglePlay);

  bindNfDropdown($("#playerEpisodeDropdown"));
  bindNfDropdown($("#playerServerDropdown"));
  document.addEventListener("click", () => closeNfDropdowns());

  $$("[data-close]").forEach((el) => el.addEventListener("click", closeModal));

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#authModal")?.classList.contains("hidden")) {
      closeAuthModal();
      return;
    }
    if ($$(".nf-dropdown.is-open").length) {
      closeNfDropdowns();
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
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
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
    lead.textContent = "Masuk atau daftar untuk mulai menonton";
  }
}

function endAuthBoot() {
  document.body.classList.remove("is-auth-checking");
  const boot = $("#authBoot");
  if (boot) {
    boot.setAttribute("aria-busy", "false");
    boot.classList.add("hidden");
  }
}

function enterAuthGate(mode = "login") {
  closePlayer();
  closeModal();
  endAuthBoot();
  showAuthPane(mode);
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
  const chip = $("#authChip");
  const name = $("#authChipName");
  const avatar = $("#authAvatar");
  const tabLogin = $("#authTabLogin");
  const tabRegister = $("#authTabRegister");
  const tabProfile = $("#authTabProfile");

  if (currentUser) {
    openBtn.classList.add("hidden");
    chip.classList.remove("hidden");
    name.textContent = currentUser.displayName || currentUser.username;
    avatar.textContent = (currentUser.displayName || currentUser.username || "?").slice(0, 1).toUpperCase();
    tabLogin?.classList.add("hidden");
    tabRegister?.classList.add("hidden");
    tabProfile.classList.remove("hidden");
  } else {
    openBtn.classList.remove("hidden");
    chip.classList.add("hidden");
    tabLogin?.classList.remove("hidden");
    tabRegister?.classList.remove("hidden");
    tabProfile.classList.add("hidden");
  }
  syncAuthGateChrome();
}

function showAuthPane(mode) {
  const login = $("#authLoginForm");
  const register = $("#authRegisterForm");
  const profile = $("#authProfileForm");
  const title = $("#authModalTitle");
  const lead = $("#authLead");
  const tabs = {
    login: $("#authTabLogin"),
    register: $("#authTabRegister"),
    profile: $("#authTabProfile"),
  };

  login.classList.toggle("hidden", mode !== "login");
  register.classList.toggle("hidden", mode !== "register");
  profile.classList.toggle("hidden", mode !== "profile");

  Object.entries(tabs).forEach(([key, el]) => {
    el.classList.toggle("is-active", key === mode);
    el.setAttribute("aria-selected", key === mode ? "true" : "false");
  });

  if (mode === "login") title.textContent = "Masuk ke WEBUNIME";
  else if (mode === "register") title.textContent = "Daftar akun";
  else title.textContent = "Profil saya";

  if (lead) {
    if (!currentUser) {
      lead.classList.remove("hidden");
      lead.textContent = "Masuk atau daftar untuk mulai menonton";
    } else if (mode === "profile") {
      lead.classList.remove("hidden");
      lead.textContent = "Kelola profil akun Anda";
    } else {
      lead.classList.add("hidden");
    }
  }

  if (mode === "profile" && currentUser) {
    $("#authProfileMeta").textContent = `@${currentUser.username} · ${currentUser.email}`;
    const input = $("#authProfileForm")?.querySelector('[name="displayName"]');
    if (input) input.value = currentUser.displayName || "";
  }
  setAuthError("");
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
  await Promise.all([
    loadMovies(),
    loadSeries(),
    loadHorror(),
    loadIndonesia(),
    loadAnime(),
    loadAnimeMovies(),
    loadAnimeLatest(),
  ]);
  catalog = dedupeBySlug([
    ...movies,
    ...horror,
    ...indonesia,
    ...series,
    ...anime,
    ...animeMovies,
  ]);
  setHero(
    movies[0] ||
      indonesia[0] ||
      anime[0] ||
      animeMovies[0] ||
      horror[0] ||
      series[0]
  );
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

async function onAuthSuccess(user) {
  currentUser = user;
  renderAuthChrome();
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
  $("#authTabRegister")?.addEventListener("click", () => showAuthPane("register"));
  $("#authTabProfile")?.addEventListener("click", () => {
    if (currentUser) showAuthPane("profile");
  });

  $("#authLoginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { res, data } = await authFetch("/login", {
      method: "POST",
      body: JSON.stringify({
        login: String(fd.get("login") || ""),
        password: String(fd.get("password") || ""),
      }),
    });
    if (!res.ok) {
      setAuthError(data?.error || "Gagal masuk.");
      return;
    }
    await onAuthSuccess(data.user);
  });

  $("#authRegisterForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const { res, data } = await authFetch("/register", {
      method: "POST",
      body: JSON.stringify({
        displayName: String(fd.get("displayName") || ""),
        username: String(fd.get("username") || "").toLowerCase(),
        email: String(fd.get("email") || "").toLowerCase(),
        password: String(fd.get("password") || ""),
      }),
    });
    if (!res.ok) {
      setAuthError(data?.error || "Gagal mendaftar.");
      return;
    }
    await onAuthSuccess(data.user);
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
