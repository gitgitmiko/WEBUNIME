import mysql from "mysql2/promise";

let pool;

export function getPool() {
  if (pool) return pool;
  const {
    DB_HOST = "127.0.0.1",
    DB_PORT = "3306",
    DB_USER,
    DB_PASS,
    DB_NAME = "webunime",
  } = process.env;

  if (!DB_USER || !DB_PASS) {
    throw new Error("DB_USER dan DB_PASS wajib di .env");
  }

  pool = mysql.createPool({
    host: DB_HOST,
    port: Number(DB_PORT) || 3306,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    namedPlaceholders: true,
  });
  return pool;
}
