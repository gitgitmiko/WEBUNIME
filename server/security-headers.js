/**
 * Header keamanan dasar untuk aplikasi (bukan untuk response proxy player).
 */
export function securityHeadersMiddleware(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

  const path = (req.url || "").split("?")[0] || "/";
  const isProxySurface =
    path.startsWith("/__px__/") ||
    path.startsWith("/__vid__") ||
    path === "/api/resolve" ||
    path === "/api/embed";

  // CSP ketat untuk app; proxy player memang membuang CSP sendiri.
  if (!isProxySurface) {
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https:",
        "frame-src 'self'",
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
