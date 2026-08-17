import { getPool } from "./db.js";
import { itemMeta, itemSlug, isDocName, isItemCollection } from "./catalog-meta.js";

function payloadJson(value) {
  return JSON.stringify(value);
}

export async function replaceCollection(collection, items) {
  if (!isItemCollection(collection)) {
    throw new Error(`Koleksi tidak dikenal: ${collection}`);
  }
  if (!Array.isArray(items)) {
    throw new Error("items harus array");
  }

  const pool = getPool();
  const conn = await pool.getConnection();
  let upserted = 0;
  // Dedup by slug (entry terakhir menang) — feed latest kadang dobel
  const bySlug = new Map();
  for (const item of items) {
    const slug = itemSlug(item, collection);
    if (!slug) continue;
    bySlug.set(slug, item);
  }

  try {
    await conn.beginTransaction();
    await conn.execute(`DELETE FROM catalog_items WHERE collection = ?`, [collection]);

    for (const [slug, item] of bySlug) {
      const meta = itemMeta(item);
      await conn.execute(
        `INSERT INTO catalog_items
          (collection, slug, title, year, thumbnail, rating, payload)
         VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
        [
          collection,
          slug,
          meta.title,
          meta.year,
          meta.thumbnail,
          meta.rating,
          payloadJson(item),
        ]
      );
      upserted += 1;
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  return { collection, count: upserted };
}

export async function putDoc(name, payload) {
  if (!isDocName(name)) {
    throw new Error(`Dokumen tidak dikenal: ${name}`);
  }
  const pool = getPool();
  await pool.execute(
    `INSERT INTO catalog_docs (name, payload)
     VALUES (?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
    [name, payloadJson(payload)]
  );
  return { name, ok: true };
}

function parsePayload(value) {
  if (value == null) return null;
  return typeof value === "string" ? JSON.parse(value) : value;
}

function shortSinopsis(text, max = 280) {
  if (!text) return undefined;
  const first = String(text).split(/\n\n+/)[0].trim();
  if (!first) return undefined;
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

function extractNegara(item, collection = "") {
  const direct = String(item?.negara || item?.country || "").trim();
  if (direct) return direct;
  const sino = String(item?.sinopsis || "");
  const match = sino.match(/(?:^|\n)\s*(?:Negara|Country)\s*:\s*([^\n]+)/i);
  if (match) {
    const value = match[1]
      .replace(/\s+/g, " ")
      .replace(/^[,\s]+|[,\s]+$/g, "")
      .trim();
    if (value) return value;
  }
  const col = String(collection || item?.catalog || "").toLowerCase();
  if (col === "indonesia") return "Indonesia";
  if (col === "anime" || col === "anime-movies" || col === "anime-latest") return "Japan";
  return undefined;
}

/** Kartu ringan: tanpa players/episodes (dimuat saat modal/player). */
export function toCard(item, collection = "") {
  if (!item || typeof item !== "object") return item;
  const feed = collection === "anime-latest" || collection === "series-latest";
  const card = {
    id: item.id,
    nama: item.nama,
    judul: item.judul,
    tahun: item.tahun,
    thumbnail: item.thumbnail,
    thumbnail_landscape: item.thumbnail_landscape,
    rating: item.rating,
    quality: item.quality,
    durasi: item.durasi,
    genre: Array.isArray(item.genre) ? item.genre : undefined,
    slug: item.slug,
    type: item.type,
    catalog: item.catalog || collection || undefined,
    source: item.source,
    is_new: item.is_new,
    studio: item.studio,
    sumber: item.sumber,
    rilis_iso: item.rilis_iso,
    rilis: item.rilis,
    negara: extractNegara(item, collection),
    bahasa: item.bahasa,
    direksi: item.direksi,
    pemain: item.pemain,
    pendapatan: item.pendapatan,
    anime_slug: item.anime_slug,
    episode: item.episode,
    episode_slug: item.episode_slug,
    episodes_count:
      item.episodes_count ??
      (Array.isArray(item.episodes) ? item.episodes.length : undefined),
    sinopsis: feed ? undefined : shortSinopsis(item.sinopsis),
  };
  return Object.fromEntries(
    Object.entries(card).filter(([, v]) => v != null && v !== "")
  );
}

function parseGenreList(raw) {
  return String(raw || "")
    .split(",")
    .map((g) => g.trim())
    .filter((g) => /^[A-Za-z0-9][A-Za-z0-9 \-]{0,40}$/.test(g))
    .slice(0, 8);
}

function collectionOrderSql(sortKey) {
  const ratingSql = `CAST(REPLACE(IFNULL(rating, '0'), ',', '.') AS DECIMAL(6,2))`;
  const yearSql = `CAST(IFNULL(NULLIF(year, ''), '0') AS UNSIGNED)`;
  if (sortKey === "rating" || sortKey === "top") {
    return `ORDER BY ${ratingSql} DESC, id ASC`;
  }
  if (sortKey === "hot") {
    return `ORDER BY ${yearSql} DESC, ${ratingSql} DESC, id ASC`;
  }
  return `ORDER BY id ASC`;
}

async function payloadsByIds(pool, ids) {
  if (!ids.length) return [];
  const [data] = await pool.query(`SELECT id, payload FROM catalog_items WHERE id IN (?)`, [ids]);
  const byId = new Map(data.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export async function listCollection(
  collection,
  { page = 1, limit = 50, q = "", genre = "", sort = "" } = {}
) {
  if (!isItemCollection(collection)) return null;
  const pool = getPool();
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;
  const query = String(q || "").trim();
  const genres = parseGenreList(genre);
  const sortKey = String(sort || "").toLowerCase();

  const where = ["collection = ?"];
  const params = [collection];
  if (query) {
    where.push("(title LIKE ? OR slug LIKE ?)");
    const like = `%${query}%`;
    params.push(like, like);
  }
  if (genres.length) {
    where.push(
      `(${genres.map(() => "JSON_CONTAINS(JSON_EXTRACT(payload, '$.genre'), ?)").join(" OR ")})`
    );
    params.push(...genres.map((g) => JSON.stringify(g)));
  }
  if (sortKey === "rating" || sortKey === "top") {
    where.push("rating REGEXP '^[0-9]'");
  }
  if (sortKey === "hot") {
    where.push("year REGEXP '^[0-9]{4}'");
    where.push("rating REGEXP '^[0-9]'");
    where.push("CAST(year AS UNSIGNED) BETWEEN 1970 AND (YEAR(CURDATE()) + 1)");
  }
  const whereSql = where.join(" AND ");
  const orderSql = collectionOrderSql(sortKey);

  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS c FROM catalog_items WHERE ${whereSql}`,
    params
  );
  const total = Number(countRows[0]?.c || 0);
  const [idRows] = await pool.query(
    `SELECT id FROM catalog_items
     WHERE ${whereSql}
     ${orderSql}
     LIMIT ? OFFSET ?`,
    [...params, safeLimit, offset]
  );
  const rows = await payloadsByIds(
    pool,
    idRows.map((r) => r.id)
  );
  const items = await attachParentMeta(
    pool,
    collection,
    rows.map((r) => toCard(parsePayload(r.payload), collection))
  );

  return {
    collection,
    page: safePage,
    limit: safeLimit,
    total,
    items,
  };
}

async function attachParentMeta(pool, collection, items) {
  const parent =
    collection === "anime-latest" ? "anime" : collection === "series-latest" ? "series" : null;
  if (!parent || !items.length) return items;
  const slugs = [
    ...new Set(items.map((item) => item.anime_slug || item.slug).filter(Boolean)),
  ];
  if (!slugs.length) return items;
  const [rows] = await pool.query(
    `SELECT slug, rating, year, payload FROM catalog_items
     WHERE collection = ? AND slug IN (?)`,
    [parent, slugs]
  );
  const bySlug = new Map();
  for (const row of rows) {
    const payload = parsePayload(row.payload) || {};
    bySlug.set(row.slug, {
      rating: row.rating || payload.rating,
      tahun: row.year || payload.tahun,
      quality: payload.quality,
    });
  }
  return items.map((item) => {
    const meta = bySlug.get(item.anime_slug || item.slug);
    if (!meta) return item;
    return {
      ...item,
      rating: item.rating || meta.rating,
      tahun: item.tahun || meta.tahun,
      quality: item.quality || meta.quality,
    };
  });
}

export async function searchCatalog({ q = "", limit = 40 } = {}) {
  const query = String(q || "").trim();
  if (!query) return { q: "", total: 0, items: [] };
  const pool = getPool();
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 80);
  const like = `%${query}%`;
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS c FROM catalog_items
     WHERE collection NOT IN ('anime-latest', 'series-latest')
       AND (title LIKE ? OR slug LIKE ?)`,
    [like, like]
  );
  const [idRows] = await pool.query(
    `SELECT id, collection FROM catalog_items
     WHERE collection NOT IN ('anime-latest', 'series-latest')
       AND (title LIKE ? OR slug LIKE ?)
     ORDER BY id ASC
     LIMIT ?`,
    [like, like, safeLimit]
  );
  const rows = await payloadsByIds(
    pool,
    idRows.map((r) => r.id)
  );
  const colById = new Map(idRows.map((r) => [r.id, r.collection]));
  return {
    q: query,
    total: Number(countRows[0]?.c || 0),
    items: rows.map((r) => toCard(parsePayload(r.payload), colById.get(r.id) || "")),
  };
}

export async function listHero({ limit = 10 } = {}) {
  const pool = getPool();
  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 24);
  const [idRows] = await pool.query(
    `SELECT id, collection FROM catalog_items
     WHERE collection IN ('movies', 'series', 'horror', 'indonesia', 'anime', 'anime-movies')
       AND thumbnail IS NOT NULL AND thumbnail <> ''
       AND rating REGEXP '^[0-9]'
       AND CAST(REPLACE(rating, ',', '.') AS DECIMAL(6,2)) > 8
     ORDER BY RAND()
     LIMIT ?`,
    [Math.min(safeLimit * 3, 40)]
  );
  const rows = await payloadsByIds(
    pool,
    idRows.map((r) => r.id)
  );
  const colById = new Map(idRows.map((r) => [r.id, r.collection]));
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    const collection = colById.get(row.id) || "";
    const item = toCard(parsePayload(row.payload), collection);
    const key = String(item.slug || item.nama || "")
      .trim()
      .toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= safeLimit) break;
  }
  return { items };
}

/** Drop-in kompatibel dengan /data/*.json (seluruh array). */
export async function listCollectionAll(collection) {
  if (!isItemCollection(collection)) return null;
  const pool = getPool();
  // Ambil id dulu (sort ringan), lalu payload tanpa ORDER BY blob/JSON
  const [idRows] = await pool.execute(
    `SELECT id FROM catalog_items WHERE collection = ? ORDER BY id ASC`,
    [collection]
  );
  if (!idRows.length) return [];
  const ids = idRows.map((r) => r.id);
  const [rows] = await pool.query(
    `SELECT id, payload FROM catalog_items WHERE id IN (?)`,
    [ids]
  );
  const byId = new Map(
    rows.map((r) => [
      r.id,
      typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    ])
  );
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

export async function getItem(collection, slug) {
  if (!isItemCollection(collection)) return null;
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT payload FROM catalog_items WHERE collection = ? AND slug = ? LIMIT 1`,
    [collection, String(slug).toLowerCase()]
  );
  if (!rows[0]) return null;
  const p = rows[0].payload;
  return typeof p === "string" ? JSON.parse(p) : p;
}

export async function getDoc(name) {
  if (!isDocName(name)) return null;
  const pool = getPool();
  const [rows] = await pool.execute(`SELECT payload FROM catalog_docs WHERE name = ? LIMIT 1`, [
    name,
  ]);
  if (!rows[0]) return null;
  const p = rows[0].payload;
  return typeof p === "string" ? JSON.parse(p) : p;
}
