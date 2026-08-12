/**
 * Header keamanan dasar untuk aplikasi.
 * Permukaan proxy player (/__px__, /__vid__, dll) dikecualikan dari
 * XFO/CSP ketat agar iframe embed tetap bisa dimuat.
 */
export function securityHeadersMiddleware(req, res, next) {
  const path = (req.url || "").split("?")[0] || "/";
  const isProxySurface =
    path.startsWith("/__px__/") ||
    path.startsWith("/__vid__") ||
    path === "/__hydrax__" ||
    path.startsWith("/__hydrax__") ||
    path === "/api/resolve" ||
    path === "/api/embed" ||
    path === "/__wu_sw.js";

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  if (!isProxySurface) {
    // Cegah situs lain meng-embed WEBUNIME; jangan pakai di /__px__
    // karena player kita sendiri di-iframe dari halaman yang sama.
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

    // frame-src harus mengizinkan embed eksternal (mega/blogger) + proxy same-origin.
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https:",
        "frame-src 'self' https:",
        "connect-src 'self' https:",
        "upgrade-insecure-requests",
      ].join("; ")
    );
  }

  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "");
  if (proto === "https" || process.env.COOKIE_SECURE === "1") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
}
