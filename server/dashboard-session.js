import { createHmac, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const DASHBOARD_CONFIG = "/home/gitgitmiko/harga-hbar/config.json";

export function dashboardUser() {
  return {
    id: 1,
    email: "dasbor@gitgitmiko.my.id",
    username: "dasbor",
    displayName: "Dasbor",
    createdAt: null,
    isActive: true,
    canInvite: false,
    isAdmin: false,
  };
}

function sessionSecret() {
  return process.env.SESSION_SECRET || "webunime-local";
}

export function signSession() {
  const exp = Date.now() + 14 * 24 * 60 * 60 * 1000;
  const payload = Buffer.from(JSON.stringify({ exp, id: 1 })).toString("base64url");
  const sig = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `v1.${payload}.${sig}`;
}

export function sessionUser(token) {
  if (!token || !String(token).startsWith("v1.")) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const payload = parts[1];
  const sig = parts[2];
  const expected = createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!data?.exp || data.exp < Date.now()) return null;
  return dashboardUser();
}

export async function dashboardPasswordOk(password) {
  let stored = "";
  try {
    const cfg = JSON.parse(readFileSync(DASHBOARD_CONFIG, "utf8"));
    stored = String(cfg.password_hash || "");
  } catch {
    return false;
  }
  const [scheme, saltHex, digestHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !digestHex) return false;
  let expected;
  let digest;
  try {
    expected = Buffer.from(digestHex, "hex");
    digest = await scrypt(Buffer.from(String(password || ""), "utf8"), Buffer.from(saltHex, "hex"), 32, {
      N: 16384,
      r: 8,
      p: 1,
    });
  } catch {
    return false;
  }
  if (digest.length !== expected.length) return false;
  return timingSafeEqual(digest, expected);
}
