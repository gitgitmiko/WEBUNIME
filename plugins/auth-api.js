import { createAuthRouter, createLoginGuard } from "../server/auth.js";
import cookieParser from "cookie-parser";
import express from "express";

/**
 * Mount /api/auth + login guard on Vite dev/preview.
 */
export function authApiPlugin() {
  return {
    name: "webunime-auth-api",
    configureServer(server) {
      mountAuth(server.middlewares);
    },
    configurePreviewServer(server) {
      mountAuth(server.middlewares);
    },
  };
}

function mountAuth(middlewares) {
  const json = express.json({ limit: "32kb" });
  const cookies = cookieParser();
  const auth = createAuthRouter();
  const guard = createLoginGuard();

  middlewares.use((req, res, next) => {
    cookies(req, res, (err) => {
      if (err) return next(err);
      const path = req.url?.split("?")[0] || "";
      if (path.startsWith("/api/auth")) {
        return json(req, res, (err2) => {
          if (err2) return next(err2);
          const prev = req.url;
          req.url = prev.slice("/api/auth".length) || "/";
          auth(req, res, (err3) => {
            req.url = prev;
            next(err3);
          });
        });
      }
      return guard(req, res, next);
    });
  });
}
