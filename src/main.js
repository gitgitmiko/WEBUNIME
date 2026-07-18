let movies = [];
let series = [];
let horror = [];
let anime = [];
let animeMovies = [];
let animeLatest = [];
let catalog = [];
let activeMovie = null;
let activeEpisode = null;
let playerTimer = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function loadMovies() {
  const res = await fetch("/data/movies.json");
  if (!res.ok) throw new Error("Gagal memuat data film");
  movies = await res.json();
}

async function loadSeries() {
  try {
    const res = await fetch("/data/series.json");
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
    const res = await fetch("/data/horror.json");
    if (!res.ok) {
      horror = [];
      return;
    }
    horror = await res.json();
  } catch {
    horror = [];
  }
}

async function loadAnime() {
  try {
    const res = await fetch("/data/anime.json");
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
    const res = await fetch("/data/anime-movies.json");
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
    const res = await fetch("/data/anime-latest.json");
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

function metaLine(movie) {
  const genres = (movie.genre || []).join(" · ");
  if (isSeries(movie)) {
    const eps = movie.episodes_count || movie.episodes?.length || "";
    return `${movie.rating ?? "—"} Cocok untukmu · ${movie.tahun} · ${
      movie.durasi || (eps ? `${eps} eps` : "")
    } · ${genres}`.replace(/\s·\s*$/, "");
  }
  return `${movie.rating ?? "—"} Cocok untukmu · ${movie.tahun} · ${movie.durasi ?? ""} · ${genres}`;
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
  fillTrack("trackFeatured", movies);
  fillTrack("trackSeries", series);
  fillLatestTrack("trackAnimeLatest", animeLatest);
  fillTrack("trackAnime", anime);
  fillTrack("trackAnimeMovie", animeMovies);
  fillTrack("trackHorror", horror);
  fillTrack(
    "track2026",
    movies.filter((m) => m.tahun === "2026")
  );
  fillTrack(
    "track2025",
    movies.filter((m) => m.tahun === "2025")
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
 * Hydrax/Abyss → URL absolut langsung (GCS media butuh Referer abyssplayer).
 * Anime Samehadaku (blogger/wibufile/filedon/mega) → embed langsung / proxy.
 * Server LK21 lain → path proxy /__px__/...
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
    // Hydrax: streaming GCS hanya sukses dari origin abyssplayer.com (bukan proxy Node).
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
      : ["hydrax", "cast", "turbovip"];
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
    if ($$(".nf-dropdown.is-open").length) {
      closeNfDropdowns();
      return;
    }
    if (!$("#player").classList.contains("hidden")) closePlayer();
    else closeModal();
  });
}

async function refreshCatalogFromDisk() {
  await Promise.all([
    loadMovies(),
    loadSeries(),
    loadHorror(),
    loadAnime(),
    loadAnimeMovies(),
    loadAnimeLatest(),
  ]);
  catalog = dedupeBySlug([
    ...movies,
    ...horror,
    ...series,
    ...anime,
    ...animeMovies,
  ]);
  if (activeMovie?.slug) {
    activeMovie = catalog.find((c) => c.slug === activeMovie.slug) || activeMovie;
  }
  renderRows();
}

/** Sync halaman 1 (film/series/horor) di background; hanya menambah data baru. */
async function syncCatalogInBackground() {
  try {
    const res = await fetch("/api/sync-catalog");
    if (!res.ok) return;
    const data = await res.json();
    if (data.running || data.skipped) return;
    const changed = (data.added || 0) + (data.updated || 0);
    if (changed > 0) {
      await refreshCatalogFromDisk();
      console.info(
        `[WEBUNIME] Katalog sync: +${data.added || 0} baru, ${data.updated || 0} diupdate`,
        data.results
      );
    }
  } catch (err) {
    console.warn("[WEBUNIME] Sync katalog tidak tersedia:", err.message);
  }
}

async function init() {
  try {
    await Promise.all([
      loadMovies(),
      loadSeries(),
      loadHorror(),
      loadAnime(),
      loadAnimeMovies(),
      loadAnimeLatest(),
    ]);
    catalog = dedupeBySlug([
      ...movies,
      ...horror,
      ...series,
      ...anime,
      ...animeMovies,
    ]);
    setHero(movies[0] || anime[0] || animeMovies[0] || horror[0] || series[0]);
    renderRows();
    bindNav();
    bindRows();
    bindSearch();
    bindActions();
    // Jangan blokir tampilan awal — sync jalan di belakang
    syncCatalogInBackground();
  } catch (err) {
    console.error(err);
    $("#heroTitle").textContent = "Gagal memuat katalog";
    $("#heroDesc").textContent = "Pastikan server berjalan dan file /data/movies.json tersedia.";
  }
}

init();
