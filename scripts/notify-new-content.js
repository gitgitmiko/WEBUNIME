#!/usr/bin/env node
/**
 * Kirim push FCM ke app mobile saat ada film/series/anime baru di katalog.
 * Bandingkan slug katalog sekarang dengan daftar yang sudah pernah diumumkan
 * (data/notify-state.json). Run pertama hanya mencatat patokan, tanpa push.
 *
 *   node scripts/notify-new-content.js            # kirim
 *   node scripts/notify-new-content.js --dry-run  # tampilkan saja
 *
 * Kunci service account Firebase (project myproject-fbbb9): path di env
 * FIREBASE_SERVICE_ACCOUNT, default data/firebase-service-account.json.
 * Tanpa kunci, push ditunda (patokan tidak digeser) sampai kunci dipasang.
 */
import "dotenv/config";
import { createSign } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public/data");
const STATE = join(ROOT, "data/notify-state.json");
const KEY = resolve(ROOT, process.env.FIREBASE_SERVICE_ACCOUNT || "data/firebase-service-account.json");
const DRY = process.argv.includes("--dry-run");

/** Topic = jenis konten; app subscribe sesuai pilihan di pengaturan. */
const KINDS = [
  { kind: "film", label: "Film", topic: "konten-baru-film", files: [["movies.json", "movies"], ["horror.json", "horror"]] },
  { kind: "series", label: "Series", topic: "konten-baru-series", files: [["series-index.json", "series"]] },
  { kind: "anime", label: "Anime", topic: "konten-baru-anime", files: [["anime-index.json", "anime"], ["anime-movies.json", "anime"]] },
];
const MAX_REMEMBERED = 20000;

const log = (...a) => console.log("[notify]", ...a);

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function titleOf(item) {
  return String(item.judul || item.nama || item.slug || "").trim();
}

/** Item katalog per jenis, urut sesuai file (terbaru di depan), unik per slug. */
function catalogItems(spec) {
  const seen = new Set();
  const items = [];
  for (const [file, collection] of spec.files) {
    const arr = readJson(join(DATA, file), null);
    if (!Array.isArray(arr)) continue;
    for (const it of arr) {
      const slug = String(it?.slug || "").trim().toLowerCase();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      items.push({ slug, collection, title: titleOf(it), thumbnail: it.thumbnail || "" });
    }
  }
  return items;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

async function accessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${signer.sign(sa.private_key, "base64url")}`;
  const res = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

/** Payload data-only: app yang menyusun notifikasi (channel & tujuan tap). */
function buildMessage(spec, fresh) {
  const first = fresh[0];
  const single = fresh.length === 1;
  const title = single ? `${spec.label} baru` : `${fresh.length} ${spec.label.toLowerCase()} baru`;
  const names = fresh.slice(0, 3).map((f) => f.title);
  const body = single
    ? first.title
    : names.join(", ") + (fresh.length > names.length ? `, dan ${fresh.length - names.length} lainnya` : "");
  const data = { type: "new_content", kind: spec.kind, title, body, count: String(fresh.length) };
  if (first.thumbnail) data.image = first.thumbnail;
  if (single) {
    data.collection = first.collection;
    data.slug = first.slug;
  }
  return { topic: spec.topic, data, android: { priority: "high", ttl: "86400s" } };
}

async function send(sa, token, message) {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) throw new Error(`fcm ${res.status}: ${await res.text()}`);
}

const state = readJson(STATE, {});
const sa = existsSync(KEY) ? readJson(KEY, null) : null;

let token = null;
let failed = false;
const next = { ...state };
for (const spec of KINDS) {
  const items = catalogItems(spec);
  if (items.length === 0) {
    log(`${spec.kind}: katalog kosong/rusak, lewati`);
    continue;
  }
  const known = state[spec.kind];
  if (!Array.isArray(known)) {
    log(`${spec.kind}: patokan awal ${items.length} judul (tanpa push)`);
    next[spec.kind] = items.map((i) => i.slug).slice(0, MAX_REMEMBERED);
    continue;
  }
  const knownSet = new Set(known);
  const fresh = items.filter((i) => !knownSet.has(i.slug));
  if (fresh.length === 0) continue;

  const message = buildMessage(spec, fresh);
  log(`${spec.kind}: ${fresh.length} baru → ${message.data.title}: ${message.data.body}`);
  if (!DRY && !sa) {
    log(`${spec.kind}: kunci service account tidak ada (${KEY}), push ditunda`);
    continue;
  }
  if (!DRY) {
    try {
      token ??= await accessToken(sa);
      await send(sa, token, message);
    } catch (e) {
      // Patokan tidak digeser supaya dicoba lagi di run berikutnya.
      log(`${spec.kind}: gagal kirim: ${e.message}`);
      failed = true;
      continue;
    }
  }
  next[spec.kind] = [...fresh.map((f) => f.slug), ...known].slice(0, MAX_REMEMBERED);
}

if (!DRY) {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(`${STATE}.tmp`, JSON.stringify(next));
  renameSync(`${STATE}.tmp`, STATE);
}
process.exit(failed ? 1 : 0);
