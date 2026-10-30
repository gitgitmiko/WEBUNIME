import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { rateLimit } from "./auth.js";
import { isItemCollection } from "./catalog-meta.js";
import { getItem } from "./catalog-source.js";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data/watch-rooms.json");
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_RE = /^[A-Z0-9]{8}$/;
const MAX_ROOMS = 200;
const MAX_CONNECTIONS = 60;
const HEARTBEAT_MS = 25_000;
const SWEEP_MS = 10_000;
/** Host hilang selama ini → video penonton dijeda di posisi terakhir. */
const HOST_AWAY_PAUSE_MS = 30_000;
/** Host tidak kembali selama ini → ruang ditutup. */
const HOST_AWAY_CLOSE_MS = 30 * 60_000;
const MAX_TIME_SECONDS = 24 * 60 * 60;

const rooms = new Map();
let saveTimer = null;
let sweepTimer = null;

function newCode() {
  let code;
  do {
    code = "";
    for (let i = 0; i < 8; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  } while (rooms.has(code));
  return code;
}

/** Posisi host sekarang: posisi terakhir + waktu berjalan bila sedang main. */
function currentPosition(room) {
  const { playing, time, updatedAt } = room.playback;
  return playing ? time + (Date.now() - updatedAt) / 1000 : time;
}

function viewerNames(room) {
  const names = new Map();
  for (const conn of room.connections) {
    if (conn.userId !== room.hostId) names.set(conn.userId, conn.name);
  }
  return [...names.values()];
}

function hostOnline(room) {
  for (const conn of room.connections) {
    if (conn.userId === room.hostId) return true;
  }
  return false;
}

function publicPlayback(room) {
  return { playing: room.playback.playing, time: currentPosition(room) };
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    hostName: room.hostName,
    hostOnline: hostOnline(room),
    media: room.media,
    playback: publicPlayback(room),
    viewers: viewerNames(room),
    createdAt: room.createdAt,
  };
}

function send(conn, payload) {
  conn.res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(room, payload) {
  for (const conn of room.connections) send(conn, payload);
}

function broadcastPresence(room) {
  broadcast(room, {
    type: "presence",
    viewers: viewerNames(room),
    hostOnline: hostOnline(room),
  });
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const data = [...rooms.values()].map(({ connections: _c, ...room }) => room);
    try {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(data), "utf8");
    } catch (err) {
      console.error("[watch-party/save]", err);
    }
  }, 2000);
  saveTimer.unref?.();
}

function closeRoom(room, reason) {
  rooms.delete(room.code);
  broadcast(room, { type: "closed", reason });
  for (const conn of room.connections) conn.res.end();
  room.connections.clear();
  scheduleSave();
}

function setPlayback(room, playing, time) {
  room.playback = { playing, time, updatedAt: Date.now() };
  broadcast(room, { type: "playback", playback: publicPlayback(room) });
  scheduleSave();
}

function sweepRooms() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (hostOnline(room)) {
      room.hostLastSeen = now;
      continue;
    }
    const away = now - room.hostLastSeen;
    if (away > HOST_AWAY_CLOSE_MS) {
      closeRoom(room, "host-away");
    } else if (away > HOST_AWAY_PAUSE_MS && room.playback.playing) {
      setPlayback(room, false, currentPosition(room));
    }
  }
}

/** Muat ruang dari disk agar restart server tidak membubarkan tontonan. */
export async function initWatchParty() {
  if (sweepTimer) return;
  sweepTimer = setInterval(sweepRooms, SWEEP_MS);
  sweepTimer.unref?.();
  try {
    const data = JSON.parse(await readFile(file, "utf8"));
    for (const room of Array.isArray(data) ? data : []) {
      if (!room?.code || !room.media || !room.playback) continue;
      rooms.set(room.code, { ...room, hostLastSeen: Date.now(), connections: new Set() });
    }
  } catch (err) {
    if (err?.code !== "ENOENT") console.error("[watch-party/load]", err);
  }
}

/** URL server harus berasal dari katalog — penonton memuatnya di iframe same-origin. */
async function resolveMedia(body = {}) {
  const collection = String(body.collection || "").trim();
  const slug = String(body.slug || "").trim().toLowerCase();
  const episodeSlug = body.episodeSlug ? String(body.episodeSlug) : null;
  const serverUrl = String(body.serverUrl || "");
  if (!isItemCollection(collection) || !slug || slug.length > 191) {
    return { error: "Media tidak valid." };
  }
  const item = await getItem(collection, slug);
  if (!item) return { error: "Media tidak ditemukan." };

  const episode = episodeSlug
    ? (item.episodes || []).find((ep) => ep?.slug === episodeSlug)
    : null;
  if (episodeSlug && !episode) return { error: "Episode tidak ditemukan." };

  const players = episode?.players || item.players || [];
  if (!players.some((p) => p?.url === serverUrl)) {
    return { error: "Server tidak ada di katalog." };
  }
  return {
    media: {
      collection,
      slug,
      episodeSlug,
      serverUrl,
      title: String(item.nama || item.film || item.title || slug).slice(0, 512),
      episodeLabel: episode ? String(episode.episode ?? "").slice(0, 32) : null,
    },
  };
}

function requireUser(req, res) {
  if (!req.user?.id) {
    res.status(401).json({ error: "Login wajib." });
    return null;
  }
  return req.user;
}

function findRoom(req, res) {
  const code = String(req.params.code || "").toUpperCase();
  const room = CODE_RE.test(code) ? rooms.get(code) : null;
  if (!room) res.status(404).json({ error: "Ruang tidak ditemukan atau sudah berakhir." });
  return room || null;
}

/** Hanya host pembuat ruang yang boleh mengendalikan — penonton ditolak di sini. */
function requireHost(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  const room = findRoom(req, res);
  if (!room) return null;
  if (room.hostId !== user.id) {
    res.status(403).json({ error: "Hanya host yang bisa mengontrol." });
    return null;
  }
  return room;
}

/** userId → ruang yang sedang ditonton, untuk monitoring admin. */
export function roomActivity() {
  const activity = new Map();
  for (const room of rooms.values()) {
    for (const conn of room.connections) {
      activity.set(conn.userId, {
        code: room.code,
        title: room.media.title,
        role: conn.userId === room.hostId ? "host" : "viewer",
      });
    }
  }
  return activity;
}

/** Akun dikeluarkan admin: putuskan koneksi; tersambung ulang akan ditolak 401. */
export function kickRoomUser(userId) {
  for (const room of rooms.values()) {
    for (const conn of [...room.connections]) {
      if (conn.userId === userId) conn.res.end();
    }
  }
}

export function createWatchPartyRouter() {
  const router = Router();

  router.get("/rooms", (req, res) => {
    if (!requireUser(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    return res.json({
      rooms: [...rooms.values()]
        .filter(hostOnline)
        .map(publicRoom)
        .sort((a, b) => b.createdAt - a.createdAt),
    });
  });

  router.post("/rooms", async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!rateLimit(`room-create:${user.id}`, 20, 60 * 60_000)) {
      return res.status(429).json({ error: "Terlalu sering membuat ruang. Coba lagi nanti." });
    }
    try {
      const parsed = await resolveMedia(req.body);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      // Satu host satu ruang: ruang lama ditutup.
      for (const old of rooms.values()) {
        if (old.hostId === user.id) closeRoom(old, "replaced");
      }
      if (rooms.size >= MAX_ROOMS) {
        return res.status(503).json({ error: "Ruang penuh. Coba lagi nanti." });
      }
      const now = Date.now();
      const room = {
        code: newCode(),
        hostId: user.id,
        hostName: user.displayName || user.username,
        media: parsed.media,
        playback: { playing: false, time: 0, updatedAt: now },
        createdAt: now,
        hostLastSeen: now,
        connections: new Set(),
      };
      rooms.set(room.code, room);
      scheduleSave();
      return res.status(201).json({ room: publicRoom(room) });
    } catch (err) {
      console.error("[watch-party/create]", err);
      return res.status(500).json({ error: "Gagal membuat ruang." });
    }
  });

  router.get("/rooms/:code", (req, res) => {
    if (!requireUser(req, res)) return;
    const room = findRoom(req, res);
    if (!room) return;
    res.setHeader("Cache-Control", "no-store");
    return res.json({ room: publicRoom(room) });
  });

  router.get("/rooms/:code/events", (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const room = findRoom(req, res);
    if (!room) return;
    if (room.connections.size >= MAX_CONNECTIONS) {
      return res.status(503).json({ error: "Ruang penuh." });
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const conn = { res, userId: user.id, name: user.displayName || user.username };
    room.connections.add(conn);
    if (user.id === room.hostId) room.hostLastSeen = Date.now();
    send(conn, { type: "state", room: publicRoom(room) });
    broadcastPresence(room);

    // Cloudflare memutus koneksi diam ±100 detik.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    req.on("close", () => {
      clearInterval(heartbeat);
      if (!room.connections.delete(conn)) return;
      if (user.id === room.hostId) room.hostLastSeen = Date.now();
      broadcastPresence(room);
    });
  });

  router.post("/rooms/:code/playback", (req, res) => {
    const room = requireHost(req, res);
    if (!room) return;
    if (!rateLimit(`room-playback:${room.hostId}`, 240, 60_000)) {
      return res.status(429).json({ error: "Terlalu banyak permintaan." });
    }
    const time = Number(req.body?.time);
    if (!Number.isFinite(time) || time < 0 || time > MAX_TIME_SECONDS) {
      return res.status(400).json({ error: "Posisi tidak valid." });
    }
    setPlayback(room, Boolean(req.body?.playing), time);
    return res.json({ ok: true });
  });

  router.post("/rooms/:code/media", async (req, res) => {
    const room = requireHost(req, res);
    if (!room) return;
    if (!rateLimit(`room-media:${room.hostId}`, 60, 60_000)) {
      return res.status(429).json({ error: "Terlalu banyak permintaan." });
    }
    try {
      const parsed = await resolveMedia(req.body);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      // Item bisa berubah selama await; pastikan ruang masih hidup.
      if (rooms.get(room.code) !== room) {
        return res.status(404).json({ error: "Ruang sudah berakhir." });
      }
      const sameEpisode =
        parsed.media.slug === room.media.slug &&
        parsed.media.collection === room.media.collection &&
        parsed.media.episodeSlug === room.media.episodeSlug;
      room.media = parsed.media;
      // Ganti server di episode yang sama → lanjut dari posisi sekarang.
      room.playback = {
        playing: room.playback.playing,
        time: sameEpisode ? currentPosition(room) : 0,
        updatedAt: Date.now(),
      };
      broadcast(room, { type: "media", media: room.media, playback: publicPlayback(room) });
      scheduleSave();
      return res.json({ ok: true });
    } catch (err) {
      console.error("[watch-party/media]", err);
      return res.status(500).json({ error: "Gagal mengganti media." });
    }
  });

  router.delete("/rooms/:code", (req, res) => {
    const room = requireHost(req, res);
    if (!room) return;
    closeRoom(room, "ended");
    return res.json({ ok: true });
  });

  return router;
}
