import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Router } from "express";
import { getPool } from "./db.js";

const COOKIE = "webunime_sid";
const SESSION_DAYS = 14;
const BCRYPT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
/** Hash valid untuk samakan timing login saat user tidak ada. */
const DUMMY_PASSWORD_HASH =
  "$2b$12$hWkaAYtaJ20nTH/6dnuJguBI3qUcXrOMFw/WCHu/y/VHLbw4Fe2aK";

const ADMIN_USERNAMES = new Set(
  String(process.env.ADMIN_USERNAMES || "gitgitmiko")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);

function isAdminUser(userOrUsername) {
  const username =
    typeof userOrUsername === "string"
      ? userOrUsername
      : userOrUsername?.username;
  return Boolean(username && ADMIN_USERNAMES.has(String(username).toLowerCase()));
}

const rateBuckets = new Map();
let lastRateCleanup = Date.now();

export function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return xf || req.socket?.remoteAddress || "unknown";
}

export function rateLimit(key, limit = 10, windowMs = 60_000) {
  const now = Date.now();
  if (now - lastRateCleanup > 5 * 60_000) {
    lastRateCleanup = now;
    for (const [k, bucket] of rateBuckets) {
      if (now - bucket.start > bucket.windowMs) rateBuckets.delete(k);
    }
  }

  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.start > windowMs) {
    bucket = { start: now, count: 0, windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

function cookieSecure() {
  if (process.env.COOKIE_SECURE === "1") return true;
  if (process.env.COOKIE_SECURE === "0") return false;
  return process.env.NODE_ENV === "production";
}

function publicUser(row) {
  const admin = isAdminUser(row.username);
  return {
    id: Number(row.id),
    email: row.email,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
    canInvite: admin,
    isAdmin: admin,
  };
}

function readSid(req) {
  const auth = String(req.headers.authorization || "");
  if (auth.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    if (/^[a-f0-9]{64}$/i.test(token)) return token.toLowerCase();
  }
  const raw = req.cookies?.[COOKIE];
  if (!raw || typeof raw !== "string") return null;
  if (!/^[a-f0-9]{64}$/i.test(raw)) return null;
  return raw.toLowerCase();
}

function setSessionCookie(res, sid, maxAgeMs) {
  res.cookie(COOKIE, sid, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeMs,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
  });
}

async function createSession(userId) {
  const pool = getPool();
  const sid = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await pool.execute(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (:id, :userId, :expires)`,
    { id: sid, userId, expires }
  );
  return { sid, expires };
}

async function destroySession(sid) {
  if (!sid) return;
  const pool = getPool();
  await pool.execute(`DELETE FROM sessions WHERE id = :id`, { id: sid });
}

async function loadUserFromSession(sid) {
  if (!sid) return null;
  const pool = getPool();
  const [rows] = await pool.execute(
    `SELECT u.id, u.email, u.username, u.display_name, u.created_at, s.expires_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = :id
     LIMIT 1`,
    { id: sid }
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await destroySession(sid);
    return null;
  }
  return publicUser(row);
}

export async function getSessionUser(req) {
  return loadUserFromSession(readSid(req));
}

export function isPublicPath(pathname) {
  const path = pathname.split("?")[0] || "/";
  if (path.startsWith("/api/auth")) return true;
  if (path.startsWith("/api/admin/")) return true; // diverifikasi secret di router admin
  if (path === "/" || path === "/index.html") return true;
  if (path.startsWith("/assets/")) return true;
  if (/\.(css|js|map|ico|png|jpe?g|webp|svg|woff2?|ttf|txt)$/i.test(path)) return true;
  return false;
}

/** Segmen HLS/P2P sangat chatty — jangan ikut kuota anti-abuse HTML/API. */
export function isProxyMediaPath(pathname) {
  const path = pathname.split("?")[0] || "/";
  if (!path.startsWith("/__px__/")) return false;
  return /(\/zzz\/|\/xxx\/|\/docs\/|\.m3u8$|\.ts$|\.m4s$|\.pict$|\.mp4$|\.m4v$)/i.test(path);
}

/** Blokir katalog & player API tanpa sesi login. */
export function createLoginGuard() {
  return async (req, res, next) => {
    try {
      const path = (req.url || "").split("?")[0] || "/";
      if (isPublicPath(path)) return next();

      const user = await getSessionUser(req);
      if (user) {
        req.user = user;
        // Batasi abuse open-proxy setelah login (HTML/API saja; media HLS exempt).
        if (
          path.startsWith("/__px__/") ||
          path.startsWith("/__vid__") ||
          path.startsWith("/__hydrax__") ||
          path === "/api/resolve" ||
          path === "/api/embed"
        ) {
          if (!isProxyMediaPath(path)) {
            const ip = clientIp(req);
            if (!rateLimit(`proxy:${user.id}:${ip}`, 400, 60_000)) {
              res.statusCode = 429;
              res.setHeader("Content-Type", "application/json; charset=utf-8");
              res.setHeader("Cache-Control", "no-store");
              res.end(JSON.stringify({ error: "Terlalu banyak permintaan proxy." }));
              return;
            }
          }
        }
        return next();
      }

      const needsAuth =
        path.startsWith("/data/") ||
        path.startsWith("/api/") ||
        path.startsWith("/__px__/") ||
        path.startsWith("/__vid__") ||
        path.startsWith("/__hydrax__") ||
        path === "/__wu_sw.js";

      if (needsAuth) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify({ error: "Login wajib untuk menonton." }));
        return;
      }
      return next();
    } catch (err) {
      console.error("[login-guard]", err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: "Gagal memverifikasi sesi." }));
    }
  };
}

function parseBody(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

function validateRegister(body) {
  const email = String(body.email || "")
    .trim()
    .toLowerCase();
  const username = String(body.username || "")
    .trim()
    .toLowerCase();
  const password = String(body.password || "");
  const displayName = String(body.displayName || body.display_name || "")
    .trim()
    .slice(0, 64);

  if (!EMAIL_RE.test(email) || email.length > 191) {
    return { error: "Email tidak valid." };
  }
  if (!USERNAME_RE.test(username)) {
    return { error: "Username 3–32 karakter: a-z, 0-9, underscore." };
  }
  if (password.length < 10 || password.length > 128) {
    return { error: "Password minimal 10 karakter." };
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return { error: "Password harus mengandung huruf dan angka." };
  }
  if (!displayName) {
    return { error: "Nama tampilan wajib diisi." };
  }
  return { email, username, password, displayName };
}

async function requireAdmin(req, res) {
  const sid = readSid(req);
  const actor = await loadUserFromSession(sid);
  if (!actor || !isAdminUser(actor)) {
    res.status(403).json({ error: "Khusus admin." });
    return null;
  }
  return actor;
}

export function createAuthRouter() {
  const router = Router();

  router.get("/me", async (req, res) => {
    try {
      const sid = readSid(req);
      const user = await loadUserFromSession(sid);
      if (!user) {
        clearSessionCookie(res);
        return res.status(401).json({ user: null });
      }
      return res.json({ user });
    } catch (err) {
      console.error("[auth/me]", err);
      return res.status(500).json({ error: "Gagal memuat sesi." });
    }
  });

  router.post("/register", async (req, res) => {
    const ip = clientIp(req);
    if (!rateLimit(`reg:${ip}`, 5, 60 * 60_000)) {
      return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi nanti." });
    }

    try {
      const actor = await requireAdmin(req, res);
      if (!actor) return;
      if (!rateLimit(`reg-admin:${actor.id}`, 20, 60 * 60_000)) {
        return res.status(429).json({ error: "Batas undangan admin tercapai. Coba lagi nanti." });
      }

      const parsed = validateRegister(parseBody(req));
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      if (isAdminUser(parsed.username)) {
        return res.status(400).json({ error: "Username admin tidak bisa didaftarkan ulang." });
      }

      const pool = getPool();
      const passwordHash = await bcrypt.hash(parsed.password, BCRYPT_ROUNDS);
      const [result] = await pool.execute(
        `INSERT INTO users (email, username, password_hash, display_name)
         VALUES (:email, :username, :passwordHash, :displayName)`,
        {
          email: parsed.email,
          username: parsed.username,
          passwordHash,
          displayName: parsed.displayName,
        }
      );
      const userId = result.insertId;
      const [rows] = await pool.execute(
        `SELECT id, email, username, display_name, created_at
         FROM users WHERE id = :id LIMIT 1`,
        { id: userId }
      );
      // Jangan ganti sesi admin — akun baru dibuat tanpa auto-login.
      return res.status(201).json({
        ok: true,
        invited: publicUser(rows[0]),
      });
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Email atau username sudah terpakai." });
      }
      console.error("[auth/register]", err);
      return res.status(500).json({ error: "Gagal mendaftar." });
    }
  });

  router.get("/users", async (req, res) => {
    try {
      const actor = await requireAdmin(req, res);
      if (!actor) return;
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT id, email, username, display_name, created_at
         FROM users
         ORDER BY id ASC`
      );
      return res.json({ users: rows.map(publicUser) });
    } catch (err) {
      console.error("[auth/users list]", err);
      return res.status(500).json({ error: "Gagal memuat pengguna." });
    }
  });

  router.post("/users", async (req, res) => {
    const ip = clientIp(req);
    if (!rateLimit(`users-create:${ip}`, 10, 60 * 60_000)) {
      return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi nanti." });
    }
    try {
      const actor = await requireAdmin(req, res);
      if (!actor) return;
      const parsed = validateRegister(parseBody(req));
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      if (isAdminUser(parsed.username)) {
        return res.status(400).json({ error: "Username admin tidak bisa didaftarkan ulang." });
      }
      const pool = getPool();
      const passwordHash = await bcrypt.hash(parsed.password, BCRYPT_ROUNDS);
      const [result] = await pool.execute(
        `INSERT INTO users (email, username, password_hash, display_name)
         VALUES (:email, :username, :passwordHash, :displayName)`,
        {
          email: parsed.email,
          username: parsed.username,
          passwordHash,
          displayName: parsed.displayName,
        }
      );
      const [rows] = await pool.execute(
        `SELECT id, email, username, display_name, created_at
         FROM users WHERE id = :id LIMIT 1`,
        { id: result.insertId }
      );
      return res.status(201).json({ ok: true, user: publicUser(rows[0]) });
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Email atau username sudah terpakai." });
      }
      console.error("[auth/users create]", err);
      return res.status(500).json({ error: "Gagal membuat pengguna." });
    }
  });

  router.patch("/users/:id", async (req, res) => {
    try {
      const actor = await requireAdmin(req, res);
      if (!actor) return;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: "ID tidak valid." });
      }
      const pool = getPool();
      const [found] = await pool.execute(
        `SELECT id, email, username, display_name, created_at FROM users WHERE id = :id LIMIT 1`,
        { id }
      );
      const row = found[0];
      if (!row) return res.status(404).json({ error: "Pengguna tidak ditemukan." });
      if (isAdminUser(row.username) && Number(row.id) !== Number(actor.id)) {
        return res.status(403).json({ error: "Akun admin lain tidak bisa diubah." });
      }

      const body = parseBody(req);
      const displayName = String(body.displayName || body.display_name || "")
        .trim()
        .slice(0, 64);
      const email = String(body.email || "")
        .trim()
        .toLowerCase();
      const password = String(body.password || "");
      if (!displayName) return res.status(400).json({ error: "Nama tampilan wajib diisi." });
      if (!EMAIL_RE.test(email) || email.length > 191) {
        return res.status(400).json({ error: "Email tidak valid." });
      }
      if (password) {
        if (password.length < 10 || password.length > 128) {
          return res.status(400).json({ error: "Password minimal 10 karakter." });
        }
        if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
          return res.status(400).json({ error: "Password harus mengandung huruf dan angka." });
        }
      }

      if (password) {
        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        await pool.execute(
          `UPDATE users
           SET display_name = :displayName, email = :email, password_hash = :passwordHash
           WHERE id = :id`,
          { displayName, email, passwordHash, id }
        );
      } else {
        await pool.execute(
          `UPDATE users SET display_name = :displayName, email = :email WHERE id = :id`,
          { displayName, email, id }
        );
      }
      const [updated] = await pool.execute(
        `SELECT id, email, username, display_name, created_at FROM users WHERE id = :id LIMIT 1`,
        { id }
      );
      return res.json({ ok: true, user: publicUser(updated[0]) });
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY") {
        return res.status(409).json({ error: "Email sudah terpakai." });
      }
      console.error("[auth/users update]", err);
      return res.status(500).json({ error: "Gagal mengubah pengguna." });
    }
  });

  router.delete("/users/:id", async (req, res) => {
    try {
      const actor = await requireAdmin(req, res);
      if (!actor) return;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id < 1) {
        return res.status(400).json({ error: "ID tidak valid." });
      }
      if (id === Number(actor.id)) {
        return res.status(400).json({ error: "Tidak bisa menghapus akun sendiri." });
      }
      const pool = getPool();
      const [found] = await pool.execute(
        `SELECT id, username FROM users WHERE id = :id LIMIT 1`,
        { id }
      );
      const row = found[0];
      if (!row) return res.status(404).json({ error: "Pengguna tidak ditemukan." });
      if (isAdminUser(row.username)) {
        return res.status(403).json({ error: "Akun admin tidak bisa dihapus." });
      }
      await pool.execute(`DELETE FROM users WHERE id = :id`, { id });
      return res.json({ ok: true });
    } catch (err) {
      console.error("[auth/users delete]", err);
      return res.status(500).json({ error: "Gagal menghapus pengguna." });
    }
  });

  router.post("/login", async (req, res) => {
    const ip = clientIp(req);
    if (!rateLimit(`login:${ip}`, 8, 15 * 60_000)) {
      return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi nanti." });
    }

    const body = parseBody(req);
    const login = String(body.login || body.email || body.username || "")
      .trim()
      .toLowerCase();
    const password = String(body.password || "");

    if (!login || !password) {
      return res.status(400).json({ error: "Login dan password wajib diisi." });
    }

    try {
      const pool = getPool();
      const [rows] = await pool.execute(
        `SELECT id, email, username, password_hash, display_name, created_at
         FROM users
         WHERE email = :login OR username = :login
         LIMIT 1`,
        { login }
      );
      const row = rows[0];
      const ok = await bcrypt.compare(password, row?.password_hash || DUMMY_PASSWORD_HASH);

      if (!row || !ok) {
        return res.status(401).json({ error: "Email/username atau password salah." });
      }

      const oldSid = readSid(req);
      if (oldSid) await destroySession(oldSid);

      const { sid, expires } = await createSession(row.id);
      setSessionCookie(res, sid, expires.getTime() - Date.now());
      return res.json({ user: publicUser(row) });
    } catch (err) {
      console.error("[auth/login]", err);
      return res.status(500).json({ error: "Gagal masuk." });
    }
  });

  router.post("/logout", async (req, res) => {
    try {
      const sid = readSid(req);
      await destroySession(sid);
      clearSessionCookie(res);
      return res.json({ ok: true });
    } catch (err) {
      console.error("[auth/logout]", err);
      clearSessionCookie(res);
      return res.status(500).json({ error: "Gagal keluar." });
    }
  });

  router.patch("/profile", async (req, res) => {
    try {
      const ip = clientIp(req);
      if (!rateLimit(`profile:${ip}`, 30, 60_000)) {
        return res.status(429).json({ error: "Terlalu banyak permintaan. Coba lagi nanti." });
      }

      const sid = readSid(req);
      const user = await loadUserFromSession(sid);
      if (!user) {
        clearSessionCookie(res);
        return res.status(401).json({ error: "Belum masuk." });
      }

      const displayName = String(parseBody(req).displayName || parseBody(req).display_name || "")
        .trim()
        .slice(0, 64);
      if (!displayName) {
        return res.status(400).json({ error: "Nama tampilan wajib diisi." });
      }

      const pool = getPool();
      await pool.execute(`UPDATE users SET display_name = :displayName WHERE id = :id`, {
        displayName,
        id: user.id,
      });
      return res.json({
        user: { ...user, displayName },
      });
    } catch (err) {
      console.error("[auth/profile]", err);
      return res.status(500).json({ error: "Gagal memperbarui profil." });
    }
  });

  return router;
}
