import { createAuthRouter } from "../server/auth.js";
import cookieParser from "cookie-parser";
import express from "express";

/**
 * Mount /api/auth on Vite dev/preview so local UI matches production paths.
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

  middlewares.use((req, res, next) => {
    const path = req.url?.split("?")[0] || "";
    if (!path.startsWith("/api/auth")) return next();
    cookies(req, res, (err) => {
      if (err) return next(err);
      json(req, res, (err2) => {
        if (err2) return next(err2);
        // Express router expects relative url under mount
        const prev = req.url;
        req.url = prev.slice("/api/auth".length) || "/";
        auth(req, res, (err3) => {
          req.url = prev;
          next(err3);
        });
      });
    });
  });
}
