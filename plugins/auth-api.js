import { createAuthRouter, createLoginGuard } from "../server/auth.js";
import { createCatalogAdminRouter } from "../server/catalog-admin.js";
import { createCatalogReadRouter } from "../server/catalog-api.js";
import cookieParser from "cookie-parser";
import express from "express";

/**
 * Mount auth + katalog API on Vite dev/preview.
 */
export function authApiPlugin() {
  return {
    name: "webunime-auth-api",
    configureServer(server) {
      mountApi(server.middlewares);
    },
    configurePreviewServer(server) {
      mountApi(server.middlewares);
    },
  };
}

function mountApi(middlewares) {
  const cookies = cookieParser();
  const jsonSmall = express.json({ limit: "32kb" });
  const jsonLarge = express.json({ limit: "120mb" });
  const auth = createAuthRouter();
  const admin = createCatalogAdminRouter();
  const v1 = createCatalogReadRouter();
  const guard = createLoginGuard();

  middlewares.use((req, res, next) => {
    cookies(req, res, (err) => {
      if (err) return next(err);
      const path = req.url?.split("?")[0] || "";

      if (path.startsWith("/api/auth")) {
        return jsonSmall(req, res, (err2) => {
          if (err2) return next(err2);
          const prev = req.url;
          req.url = prev.slice("/api/auth".length) || "/";
          auth(req, res, (err3) => {
            req.url = prev;
            next(err3);
          });
        });
      }

      if (path.startsWith("/api/admin/catalog")) {
        return jsonLarge(req, res, (err2) => {
          if (err2) return next(err2);
          const prev = req.url;
          req.url = prev.slice("/api/admin/catalog".length) || "/";
          admin(req, res, (err3) => {
            req.url = prev;
            next(err3);
          });
        });
      }

      return guard(req, res, (err2) => {
        if (err2) return next(err2);
        if (path.startsWith("/api/v1")) {
          const prev = req.url;
          req.url = prev.slice("/api/v1".length) || "/";
          return v1(req, res, (err3) => {
            req.url = prev;
            next(err3);
          });
        }
        return next();
      });
    });
  });
}
