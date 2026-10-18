/**
 * Sumber data katalog untuk REST API /api/v1.
 * MySQL bila DB_USER + DB_PASS ada di .env, selain itu fallback ke public/data/*.json.
 */
import * as mysqlCatalog from "./catalog.js";
import * as jsonCatalog from "./json-catalog.js";

export const catalogBackend =
  process.env.DB_USER && process.env.DB_PASS ? "mysql" : "json";

const source = catalogBackend === "mysql" ? mysqlCatalog : jsonCatalog;

export const {
  getDoc,
  getItem,
  listCollection,
  listCollectionAll,
  listHero,
  searchCatalog,
} = source;
