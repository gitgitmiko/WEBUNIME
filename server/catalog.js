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

export async function listCollection(collection, { page = 1, limit = 50, q = "" } = {}) {
  if (!isItemCollection(collection)) return null;
  const pool = getPool();
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;
  const query = String(q || "").trim();

  let total;
  let rows;
  if (query) {
    const like = `%${query}%`;
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM catalog_items
       WHERE collection = ? AND (title LIKE ? OR slug LIKE ?)`,
      [collection, like, like]
    );
    total = Number(countRows[0].c);
    const [idRows] = await pool.query(
      `SELECT id FROM catalog_items
       WHERE collection = ? AND (title LIKE ? OR slug LIKE ?)
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
      [collection, like, like, safeLimit, offset]
    );
    const ids = idRows.map((r) => r.id);
    if (!ids.length) {
      rows = [];
    } else {
      const [data] = await pool.query(`SELECT id, payload FROM catalog_items WHERE id IN (?)`, [
        ids,
      ]);
      const byId = new Map(data.map((r) => [r.id, r]));
      rows = ids.map((id) => byId.get(id)).filter(Boolean);
    }
  } else {
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) AS c FROM catalog_items WHERE collection = ?`,
      [collection]
    );
    total = Number(countRows[0].c);
    const [idRows] = await pool.query(
      `SELECT id FROM catalog_items
       WHERE collection = ?
       ORDER BY id ASC
       LIMIT ? OFFSET ?`,
      [collection, safeLimit, offset]
    );
    const ids = idRows.map((r) => r.id);
    if (!ids.length) {
      rows = [];
    } else {
      const [data] = await pool.query(`SELECT id, payload FROM catalog_items WHERE id IN (?)`, [
        ids,
      ]);
      const byId = new Map(data.map((r) => [r.id, r]));
      rows = ids.map((id) => byId.get(id)).filter(Boolean);
    }
  }

  return {
    collection,
    page: safePage,
    limit: safeLimit,
    total,
    items: rows.map((r) => (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload)),
  };
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
