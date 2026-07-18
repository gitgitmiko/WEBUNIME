let movies = [];
let activeMovie = null;
let playerTimer = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

async function loadMovies() {
  const res = await fetch("/data/movies.json");
  if (!res.ok) throw new Error("Gagal memuat data film");
  movies = await res.json();
}

function hasGenre(movie, names) {
  return movie.genre?.some((g) => names.includes(g));
}

function metaLine(movie) {
  const genres = (movie.genre || []).join(" · ");
  return `${movie.rating ?? "—"} Cocok untukmu · ${movie.tahun} · ${movie.durasi ?? ""} · ${genres}`;
}

function createPoster(movie, index = 0) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "poster";
  btn.style.animationDelay = `${Math.min(index * 40, 400)}ms`;
  btn.setAttribute("aria-label", `Detail ${movie.nama}`);
  btn.innerHTML = `
    <img src="${movie.thumbnail}" alt="${movie.judul}" loading="lazy" width="200" height="300" />
    <p class="poster-label">${movie.nama}</p>
  `;
  btn.addEventListener("click", () => openModal(movie));
  return btn;
}

function fillTrack(id, list) {
  const track = document.getElementById(id);
  if (!track) return;
  track.replaceChildren(...list.map((m, i) => createPoster(m, i)));
}

function renderRows() {
  fillTrack("trackFeatured", movies);
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

function setHero(movie) {
  activeMovie = movie;
  const bg = $("#heroBg");
  bg.style.backgroundImage = `url("${movie.thumbnail}")`;
  $("#heroTitle").textContent = movie.nama;
  $("#heroMeta").textContent = metaLine(movie);
  $("#heroDesc").textContent = movie.sinopsis || "";
}

function openModal(movie) {
  activeMovie = movie;
  const modal = $("#modal");
  $("#modalBanner").style.backgroundImage = `url("${movie.thumbnail}")`;
  $("#modalTitle").textContent = movie.nama;
  $("#modalMeta").textContent = metaLine(movie);
  $("#modalDesc").textContent = movie.sinopsis || "";
  modal.classList.remove("hidden");
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
  const p = (activeMovie?.players || []).find((x) => x.url === url);
  return p ? p.label || p.server : "server";
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
 * Server lain → path proxy /__px__/...
 */
async function resolveEmbedPath(sourceUrl) {
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
  const wrap = $(".player-server");
  const select = $("#playerSelect");
  const players = movie.players || [];

  if (!players.length) {
    wrap.classList.add("hidden");
    select.replaceChildren();
    currentServerUrl = null;
    clearEmbed();
    return false;
  }

  select.replaceChildren(
    ...players.map((p) => {
      const opt = document.createElement("option");
      opt.value = p.url;
      opt.textContent = p.label || p.server;
      opt.dataset.server = p.server || "";
      return opt;
    })
  );

  const preferred = ["hydrax", "cast", "turbovip"];
  const initial =
    preferred.map((s) => players.find((p) => (p.server || "").toLowerCase() === s)).find(Boolean) ||
    players.find((p) => p.default && (p.server || "").toLowerCase() !== "p2p") ||
    players.find((p) => (p.server || "").toLowerCase() !== "p2p") ||
    players.find((p) => p.default) ||
    players[0];
  select.value = initial.url;
  wrap.classList.remove("hidden");
  selectServer(initial.url);
  return true;
}

function openPlayer(movie) {
  activeMovie = movie;
  closeModal();
  const player = $("#player");
  $("#playerTitle").textContent = movie.nama;
  $("#playerPoster").style.backgroundImage = `url("${movie.thumbnail}")`;
  $("#playerPoster").classList.remove("hidden");
  $(".player-overlay", player).classList.remove("hidden");
  $("#playerProgress").classList.remove("hidden");
  $("#playerBar").style.width = "0%";
  player.classList.remove("hidden", "is-playing", "is-embed");
  $(".icon-play", player).classList.remove("hidden");
  $(".icon-pause", player).classList.add("hidden");
  document.body.style.overflow = "hidden";

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

function bindRows() {
  $$(".row-arrow").forEach((btn) => {
    btn.addEventListener("click", () => {
      const track = document.getElementById(btn.dataset.row);
      if (!track) return;
      const delta = Math.round(track.clientWidth * 0.8) * (btn.classList.contains("next") ? 1 : -1);
      track.scrollBy({ left: delta, behavior: "smooth" });
    });
  });
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

    const hits = movies.filter(
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
  $("#modalPlay").addEventListener("click", () => activeMovie && openPlayer(activeMovie));
  $("#playerBack").addEventListener("click", closePlayer);
  $("#playerToggle").addEventListener("click", togglePlay);
  $("#playerSelect").addEventListener("change", (e) => selectServer(e.target.value));

  $$("[data-close]").forEach((el) => el.addEventListener("click", closeModal));

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#player").classList.contains("hidden")) closePlayer();
      else closeModal();
    }
  });
}

async function init() {
  try {
    await loadMovies();
    setHero(movies[0]);
    renderRows();
    bindNav();
    bindRows();
    bindSearch();
    bindActions();
  } catch (err) {
    console.error(err);
    $("#heroTitle").textContent = "Gagal memuat katalog";
    $("#heroDesc").textContent = "Pastikan server berjalan dan file /data/movies.json tersedia.";
  }
}

init();
