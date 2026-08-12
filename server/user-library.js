import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let schemaReady = false;

export async function ensureUserLibrarySchema() {
  if (schemaReady) return;
  const sql = fs.readFileSync(path.join(__dirname, "sql/user-library.sql"), "utf8");
  const pool = getPool();
  for (const stmt of sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)) {
    await pool.query(stmt);
  }
  schemaReady = true;
}

function cleanStr(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
}

export async function listFavorites(userId, limit = 100) {
  await ensureUserLibrarySchema();
  const pool = getPool();
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const [rows] = await pool.query(
    `SELECT collection, slug, title, thumbnail, created_at AS createdAt
     FROM favorites
     WHERE user_id = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, safeLimit]
  );
  return rows;
}

export async function isFavorite(userId, collection, slug) {
  await ensureUserLibrarySchema();
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT 1 AS ok FROM favorites
     WHERE user_id = :userId AND collection = :collection AND slug = :slug
     LIMIT 1`,
    { userId, collection, slug }
  );
  return Boolean(rows[0]);
}

export async function addFavorite(userId, { collection, slug, title, thumbnail }) {
  await ensureUserLibrarySchema();
  const pool = getPool();
  await pool.execute(
    `INSERT INTO favorites (user_id, collection, slug, title, thumbnail)
     VALUES (:userId, :collection, :slug, :title, :thumbnail)
     ON DUPLICATE KEY UPDATE
       title = VALUES(title),
       thumbnail = VALUES(thumbnail)`,
    {
      userId,
      collection: cleanStr(collection, 32),
      slug: cleanStr(slug, 191)?.toLowerCase(),
      title: cleanStr(title, 512),
      thumbnail: cleanStr(thumbnail, 2000),
    }
  );
}

export async function removeFavorite(userId, collection, slug) {
  await ensureUserLibrarySchema();
  const pool = getPool();
  await pool.execute(
    `DELETE FROM favorites
     WHERE user_id = :userId AND collection = :collection AND slug = :slug`,
    { userId, collection, slug: String(slug).toLowerCase() }
  );
}

export async function listHistory(userId, limit = 40) {
  await ensureUserLibrarySchema();
  const pool = getPool();
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const [rows] = await pool.query(
    `SELECT collection, slug, episode_slug AS episodeSlug, title, thumbnail,
            progress_seconds AS progressSeconds, last_watched_at AS lastWatchedAt
     FROM watch_history
     WHERE user_id = ?
     ORDER BY last_watched_at DESC
     LIMIT ?`,
    [userId, safeLimit]
  );
  return rows;
}

export async function upsertHistory(
  userId,
  { collection, slug, episodeSlug, title, thumbnail, progressSeconds }
) {
  await ensureUserLibrarySchema();
  const pool = getPool();
  await pool.execute(
    `INSERT INTO watch_history
       (user_id, collection, slug, episode_slug, title, thumbnail, progress_seconds)
     VALUES
       (:userId, :collection, :slug, :episodeSlug, :title, :thumbnail, :progressSeconds)
     ON DUPLICATE KEY UPDATE
       episode_slug = VALUES(episode_slug),
       title = VALUES(title),
       thumbnail = VALUES(thumbnail),
       progress_seconds = VALUES(progress_seconds),
       last_watched_at = CURRENT_TIMESTAMP`,
    {
      userId,
      collection: cleanStr(collection, 32),
      slug: cleanStr(slug, 191)?.toLowerCase(),
      episodeSlug: cleanStr(episodeSlug, 191),
      title: cleanStr(title, 512),
      thumbnail: cleanStr(thumbnail, 2000),
      progressSeconds: Math.max(0, Number(progressSeconds) || 0),
    }
  );
}

export async function removeHistory(userId, collection, slug) {
  await ensureUserLibrarySchema();
  const pool = getPool();
  await pool.execute(
    `DELETE FROM watch_history
     WHERE user_id = :userId AND collection = :collection AND slug = :slug`,
    { userId, collection, slug: String(slug).toLowerCase() }
  );
}
