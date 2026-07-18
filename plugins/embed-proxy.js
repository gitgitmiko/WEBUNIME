/**
 * Reverse-proxy player agar playback jalan di WEBUNIME.
 *
 * URL: /__px__/<host>/<path>?<query>
 * Contoh: /__px__/abyssplayer.com/KZ32mX8At
 *
 * - Membuang CSP / X-Frame-Options
 * - <base> + rewrite URL root-relative ke prefix proxy (agar modul/CSS/JS same-origin)
 * - history.replaceState ke path asli + patch fetch/XHR (agar slug & API player benar)
 * - Endpoint /api/resolve?url=... mengekstrak iframe dalam dari playeriframe (hindari iklan dobel)
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const STRIP_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "frame-options",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

function isPrivateHost(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const [a, b] = h.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

function parseHttpUrl(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (isPrivateHost(url.hostname)) return null;
  return url;
}

/** /__px__/host/path?q → https://host/path?q */
function parseProxyPath(reqUrl) {
  const u = new URL(reqUrl, "http://127.0.0.1");
  if (!u.pathname.startsWith("/__px__/")) return null;
  const rest = u.pathname.slice("/__px__/".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const host = decodeURIComponent(rest.slice(0, slash));
  const path = rest.slice(slash) || "/";
  if (!host || isPrivateHost(host)) return null;
  try {
    const target = new URL(`https://${host}${path}`);
    target.search = u.search;
    target.hash = u.hash;
    return target;
  } catch {
    return null;
  }
}

function toProxyPath(absoluteUrl) {
  const u = new URL(absoluteUrl);
  return `/__px__/${u.host}${u.pathname}${u.search}${u.hash}`;
}

function pickReferer(target) {
  const host = target.hostname.toLowerCase();
  if (host.includes("playeriframe")) return "https://tv12.lk21official.cc/";
  if (host.includes("gn1r5n")) return "https://gn1r5n.org/";
  if (host.includes("hownetwork")) return "https://playeriframe.sbs/";
  if (host.includes("abyss") || host.includes("iamcdn") || host.includes("short.icu")) {
    return "https://abyssplayer.com/";
  }
  if (
    host.includes("turbovid") ||
    host.includes("emturbo") ||
    host.includes("turboviplay") ||
    host.includes("turbosplayer") ||
    host.includes("tiktokcdn") ||
    host.includes("sptvp") ||
    host.includes("googleusercontent")
  ) {
    return "https://turbovidhls.com/";
  }
  return "https://playeriframe.sbs/";
}

/** Header upstream; khusus Cast wajib X-Embed-* = playeriframe.sbs */
function buildUpstreamHeaders(target, req) {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: req?.headers?.accept || "*/*",
    Referer: pickReferer(target),
    "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
  };

  if (req?.headers?.range) headers.Range = req.headers.range;
  if (req?.headers?.["content-type"]) headers["Content-Type"] = req.headers["content-type"];
  if (req?.headers?.authorization) headers.Authorization = req.headers.authorization;
  if (req?.headers?.cookie) headers.Cookie = req.headers.cookie;

  // Teruskan header khusus provider (Hydrax/Cast)
  for (const [key, value] of Object.entries(req?.headers || {})) {
    const k = key.toLowerCase();
    if (k.startsWith("x-") || k === "if-range" || k === "if-none-match" || k === "if-modified-since") {
      headers[key] = value;
    }
  }

  if (/gn1r5n/i.test(target.hostname)) {
    // Cast memvalidasi embed lewat X-Embed-* (bukan Origin browser)
    headers.Origin = "https://gn1r5n.org";
    headers.Referer = "https://playeriframe.sbs/";
    headers["X-Embed-Origin"] = "playeriframe.sbs";
    headers["X-Embed-Referer"] = "https://playeriframe.sbs/";
    headers["X-Embed-Parent"] = "https://playeriframe.sbs/";
  }

  if (/abyss|iamcdn|short\.icu/i.test(target.hostname)) {
    headers.Origin = "https://abyssplayer.com";
    headers.Referer = "https://abyssplayer.com/";
  }

  // GCS Hydrax: sering menolak Referer asing — coba tanpa Referer / Origin browser
  if (/storage\.googleapis\.com/i.test(target.hostname)) {
    delete headers.Referer;
    delete headers.Origin;
    headers.Referer = "https://abyssplayer.com/";
    headers.Origin = "https://abyssplayer.com";
  }

  return headers;
}

function injectClientShim(pageUrl) {
  const real = pageUrl.href;
  const host = pageUrl.host;
  const prefix = `/__px__/${host}`;
  const realPath = pageUrl.pathname + pageUrl.search + pageUrl.hash;
  const isAbyss = /abyss/i.test(host);
  const isCast = /gn1r5n/i.test(host);
  const isTurbo = /turbo/i.test(host);

  return `<script data-webunime-shim>
(function(){
  var HOST=${JSON.stringify(host)};
  var PREFIX=${JSON.stringify(prefix)};
  var REAL=${JSON.stringify(real)};
  var REAL_PATH=${JSON.stringify(realPath)};
  var IS_ABYSS=${isAbyss ? "true" : "false"};
  var IS_CAST=${isCast ? "true" : "false"};
  var IS_TURBO=${isTurbo ? "true" : "false"};
  var CDN_RE=/(?:iamcdn|abysscdn|abyss\\.to|short\\.icu|morphify|turboviplay|turbosplayer|turbovid|emturbovid|tiktokcdn|sptvp|googleusercontent|storage\\.googleapis\\.com|img-place|gn1r5n)/i;

  // Path harus mirip aslinya (slug Hydrax = /KZ32..., Cast = /e/...)
  try { history.replaceState(null, "", REAL_PATH); } catch (e) {}

  // Cast + TurboVIP: tipu deteksi parent / referrer (wajib playeriframe.sbs)
  if (IS_CAST || IS_TURBO) {
    try {
      Object.defineProperty(Document.prototype, "referrer", {
        configurable: true,
        get: function () { return "https://playeriframe.sbs/"; }
      });
    } catch (e) {}
    try {
      Object.defineProperty(location, "ancestorOrigins", {
        configurable: true,
        get: function () {
          return { length: 1, 0: "https://playeriframe.sbs/", item: function(){ return "https://playeriframe.sbs/"; } };
        }
      });
    } catch (e) {}
  }

  function toProxy(url) {
    try {
      var abs = new URL(String(url), location.href);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") return url;

      if (abs.origin === location.origin) {
        var p = abs.pathname || "";
        if (
          p.startsWith("/api/") ||
          p.startsWith("/ws/") ||
          p.startsWith("/assets/") ||
          p.startsWith("/e/") ||
          p.startsWith("/d/") ||
          p.startsWith("/static/") ||
          p.startsWith("/player/") ||
          p.startsWith("/cdn-cgi/") ||
          p.startsWith("/fingerprint-sw")
        ) {
          return location.origin + PREFIX + p + abs.search + abs.hash;
        }
      }

      if (abs.host === HOST || abs.host.endsWith("." + HOST) || CDN_RE.test(abs.hostname)) {
        return location.origin + "/__px__/" + abs.host + abs.pathname + abs.search + abs.hash;
      }
    } catch (e) {}
    return url;
  }

  function withCastHeaders(init) {
    init = init ? Object.assign({}, init) : {};
    var headers = new Headers(init.headers || {});
    if (IS_CAST) {
      headers.set("X-Embed-Origin", "playeriframe.sbs");
      headers.set("X-Embed-Referer", "https://playeriframe.sbs/");
      headers.set("X-Embed-Parent", "https://playeriframe.sbs/");
    }
    init.headers = headers;
    return init;
  }

  var ofetch = window.fetch.bind(window);
  function patchedFetch(input, init) {
    try {
      if (typeof input === "string") input = toProxy(input);
      else if (input && typeof input.url === "string") input = new Request(toProxy(input.url), input);
      init = withCastHeaders(init);
    } catch (e) {}
    return ofetch(input, init);
  }
  patchedFetch.toString = function(){ return "function fetch() { [native code] }"; };
  window.fetch = patchedFetch;

  var oopen = XMLHttpRequest.prototype.open;
  var oset = XMLHttpRequest.prototype.setRequestHeader;
  function patchedOpen(method, url) {
    var args = Array.prototype.slice.call(arguments, 2);
    try { url = toProxy(url); } catch (e) {}
    this.__wuCast = IS_CAST;
    return oopen.apply(this, [method, url].concat(args));
  }
  patchedOpen.toString = function(){ return "function open() { [native code] }"; };
  XMLHttpRequest.prototype.open = patchedOpen;
  XMLHttpRequest.prototype.setRequestHeader = function(k, v) {
    if (this.__wuCast && /^X-Embed-/i.test(String(k))) {
      if (/Origin/i.test(k)) v = "playeriframe.sbs";
      if (/Referer/i.test(k)) v = "https://playeriframe.sbs/";
      if (/Parent/i.test(k)) v = "https://playeriframe.sbs/";
    }
    return oset.call(this, k, v);
  };

  function patchAttr(proto, attr) {
    var desc = Object.getOwnPropertyDescriptor(proto, attr);
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, attr, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function(v) {
        try { v = toProxy(v); } catch (e) {}
        return desc.set.call(this, v);
      }
    });
  }
  try {
    patchAttr(HTMLScriptElement.prototype, "src");
    patchAttr(HTMLImageElement.prototype, "src");
    patchAttr(HTMLIFrameElement.prototype, "src");
    patchAttr(HTMLSourceElement.prototype, "src");
    patchAttr(HTMLLinkElement.prototype, "href");
    patchAttr(HTMLVideoElement.prototype, "src");
    patchAttr(HTMLAudioElement.prototype, "src");
    if (typeof HTMLMediaElement !== "undefined") patchAttr(HTMLMediaElement.prototype, "src");
  } catch (e) {}

  // setAttribute bypass property setters — wajib untuk JWPlayer/Hydrax
  try {
    var osa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        if (/^(src|href)$/i.test(String(name))) value = toProxy(value);
      } catch (e) {}
      return osa.call(this, name, value);
    };
  } catch (e) {}

  // SW: proxy CDN same-origin (Hydrax GCS / TurboVIP tiktokcdn segments)
  if ((IS_ABYSS || IS_TURBO) && "serviceWorker" in navigator) {
    try {
      navigator.serviceWorker.register("/__wu_sw.js", { scope: "/" }).then(function () {
        if (!navigator.serviceWorker.controller && !sessionStorage.getItem("__wu_sw_ready")) {
          sessionStorage.setItem("__wu_sw_ready", "1");
          // Reload ke URL proxy (bukan path slug hasil replaceState)
          location.replace(location.origin + PREFIX + REAL_PATH);
        }
      }).catch(function () {});
    } catch (e) {}
  }

  function stripOuterAd() {
    try {
      var a = document.getElementById("uyeouyeo");
      if (a) a.remove();
    } catch (e) {}
  }
  document.addEventListener("DOMContentLoaded", stripOuterAd);
  setTimeout(stripOuterAd, 500);

  // Hydrax: lewati popup iklan yang menghancurkan player
  if (IS_ABYSS) {
    // Fake window.open agar klik overlay tidak dihitung gagal (track.window++)
    var fakeWin = {
      closed: false,
      close: function () { this.closed = true; },
      focus: function () {},
      blur: function () {},
      location: { href: "about:blank", replace: function () {} },
      document: { write: function () {}, close: function () {} }
    };
    try {
      window.open = function () {
        try { fakeWin.closed = false; } catch (e) {}
        setTimeout(function () { try { fakeWin.closed = true; } catch (e) {} }, 800);
        return fakeWin;
      };
    } catch (e) {}

    // Matikan fuckAdBlock supaya urls popup tidak dipaksa
    try {
      Object.defineProperty(window, "fuckAdBlock", {
        configurable: true,
        get: function () {
          return { onDetected: function () {}, onNotDetected: function (cb) { try { cb && cb(); } catch (e) {} } };
        },
        set: function () {}
      });
      Object.defineProperty(window, "FuckAdBlock", {
        configurable: true,
        get: function () { return function () {}; },
        set: function () {}
      });
    } catch (e) {}

    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      try {
        if (window.abyssConfig) window.abyssConfig.popups = [];
        var overlay = document.getElementById("overlay");
        if (overlay) {
          overlay.onclick = function (ev) {
            try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
            try { overlay.remove(); } catch (e) {}
            try { if (window.jwplayer) window.jwplayer().play(); } catch (e) {}
          };
          overlay.ontouchend = overlay.onclick;
        }
        if (typeof window.jwplayer === "function") {
          var p = window.jwplayer();
          if (p && typeof p.getState === "function") {
            // Jangan auto-play berulang; biarkan user/klik overlay
            if (overlay && tries > 8) {
              try { overlay.click(); } catch (e) {}
            }
            if (tries > 20) clearInterval(iv);
          }
        }
      } catch (e) {}
      if (tries > 80) clearInterval(iv);
    }, 250);
  }

  // TurboVIP: gate loadPlayer butuh iframe + referrer playeriframe (sudah di-spoof).
  // Paksa init jika preloader masih stuck.
  if (IS_TURBO) {
    var tt = 0;
    var tiv = setInterval(function () {
      tt++;
      try {
        if (typeof enablePlay !== "undefined") enablePlay = "yes";
        if (typeof checkDomain !== "undefined") checkDomain = true;
        if (typeof iframePlay !== "undefined") iframePlay = false;

        var pre = document.querySelector(".preloader");
        var ready = false;
        try {
          if (typeof jwplayer === "function") {
            var jp = jwplayer("video_player");
            if (jp && typeof jp.getState === "function") {
              var st = jp.getState();
              if (st && st !== "idle") ready = true;
            }
          }
        } catch (e) {}

        if (!ready && typeof loadPlayer === "function" && typeof urlPlay === "string" && urlPlay) {
          try { loadPlayer(urlPlay); } catch (e) {}
          if (pre) {
            try { pre.style.display = "none"; } catch (e) {}
          }
        }

        if (ready || (document.querySelector("video") && document.querySelector("video").readyState >= 2)) {
          if (pre) pre.style.display = "none";
          try { if (typeof jwplayer === "function") jwplayer("video_player").play(); } catch (e) {}
          clearInterval(tiv);
          return;
        }

        if (typeof play === "function" && tt > 6) {
          try { play(); } catch (e) {}
        }
      } catch (e) {}
      if (tt > 40) clearInterval(tiv);
    }, 500);
  }
})();
</script>`;
}

function rewriteHtmlUrls(html, pageUrl) {
  let out = html;

  // root-relative → proxy path (penting untuk <script src="/assets/...">)
  out = out.replace(
    /\b(href|src|action|data)\s*=\s*(["'])\/(?!\/)([^"']*)\2/gi,
    (full, attr, quote, path) => {
      if (path.startsWith("__px__/")) return full;
      return `${attr}=${quote}/__px__/${pageUrl.host}/${path}${quote}`;
    }
  );

  // absolute URL ke host yang sama → proxy
  const hostRe = new RegExp(
    `\\b(href|src|action|data)\\s*=\\s*(["'])https?:\\/\\/${pageUrl.host.replace(/\./g, "\\.")}([^"']*)\\2`,
    "gi"
  );
  out = out.replace(hostRe, (full, attr, quote, pathQuery) => {
    return `${attr}=${quote}/__px__/${pageUrl.host}${pathQuery}${quote}`;
  });

  // iframe ke host lain juga lewat proxy
  out = out.replace(
    /(<(?:iframe|frame|embed)\b[^>]*?\bsrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi,
    (full, prefix, quote, url) => {
      try {
        const abs = new URL(url);
        if (isPrivateHost(abs.hostname)) return full;
        return `${prefix}${quote}${toProxyPath(abs.href)}${quote}`;
      } catch {
        return full;
      }
    }
  );

  return out;
}

function buildHlsPlayerPage(m3u8Url, title = "WEBUNIME Player", origin = "") {
  let playUrl = m3u8Url;
  try {
    const u = new URL(m3u8Url);
    playUrl = `${origin}/__px__/${u.host}${u.pathname}${u.search}`;
  } catch {
    /* keep */
  }

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #000; }
    video { width: 100%; height: 100%; object-fit: contain; background: #000; }
    .err { color: #fff; font-family: system-ui, sans-serif; padding: 1.5rem; text-align: center; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"></script>
</head>
<body>
  <video id="v" controls autoplay playsinline></video>
  <script>
    (function () {
      var src = ${JSON.stringify(playUrl)};
      var video = document.getElementById("v");
      function fail(msg) {
        document.body.innerHTML = '<p class="err">' + msg + '</p>';
      }
      if (window.Hls && Hls.isSupported()) {
        var hls = new Hls({ enableWorker: true });
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, function (_e, data) {
          if (data && data.fatal) fail("Gagal memutar stream. Coba ganti server.");
        });
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
      } else {
        fail("Browser tidak mendukung HLS.");
      }
    })();
  </script>
</body>
</html>`;
}

/** Jika halaman provider menyimpan URL .m3u8, putar langsung (lebih stabil dari JWPlayer mereka). */
function extractM3u8(html) {
  const patterns = [
    /data-hash=["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /source\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
    /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

function buildMessagePage(title, message) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #0a0a0a; color: #f4f4f5;
      font-family: system-ui, sans-serif; display: grid; place-items: center; text-align: center; }
    h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
    p { margin: 0; opacity: .75; max-width: 28rem; line-height: 1.5; }
  </style>
</head>
<body>
  <div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}

function sanitizeHtml(html, pageUrl, origin = "") {
  // P2P sering maintenance
  if (
    /hownetwork/i.test(pageUrl.hostname) &&
    /Player P2P Maintenance|maintenance/i.test(html)
  ) {
    return buildMessagePage(
      "Server P2P maintenance",
      "Server ini sedang tidak tersedia. Ganti ke Hydrax, TurboVIP, atau Cast lewat dropdown Server."
    );
  }

  // Jangan pakai HLS shortcut untuk Turbo — playlist mereka memakai segmen non-standar (bukan TS/fMP4).
  // Biarkan JWPlayer asli yang memutar.
  if (!/turbo/i.test(pageUrl.hostname)) {
    const m3u8 = extractM3u8(html);
    if (m3u8) {
      return buildHlsPlayerPage(m3u8, pageUrl.hostname, origin);
    }
  }

  let out = html;

  out = out.replace(
    /<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi,
    ""
  );
  out = out.replace(
    /if\s*\(\s*window\.self\s*===\s*window\.top\s*\)\s*\{[\s\S]*?\}/gi,
    "/* top-check disabled */"
  );
  out = out.replace(/top\.location\s*==\s*self\.location/g, "false");
  out = out.replace(/self\.location\s*==\s*top\.location/g, "false");
  out = out.replace(
    /function\s+devtoolIsOpening\s*\(\s*\)\s*\{[\s\S]*?\}\s*devtoolIsOpening\s*\(\s*\)\s*;?/gi,
    "/* anti-devtools disabled */"
  );

  // Cast SPA: path harus mengandung /e/
  out = out.replace(
    /path\.indexOf\(\s*['"]\/e\/['"]\s*\)\s*!==\s*0/g,
    "path.indexOf('/e/') < 0"
  );

  // Hapus overlay iklan klik-untuk-mulai di wrapper playeriframe
  out = out.replace(/<a\b[^>]*\bid=["']uyeouyeo["'][^>]*>[\s\S]*?<\/a>/gi, "");

  // Hydrax: cegah hukuman adblock yang menghancurkan JWPlayer
  out = out.replace(/jwplayer\s*\(\s*\)\s*\.\s*remove\s*\(\s*\)/gi, "void 0");
  out = out.replace(/track\.window\s*>=\s*2/g, "false");
  out = out.replace(/track\.window\s*>\s*1/g, "false");
  // Kosongkan daftar popup agar overlay click langsung play
  out = out.replace(/window\.abyssConfig\s*=\s*\{popups:\s*\[[^\]]*\]\}/g, "window.abyssConfig={popups:[]}");
  out = out.replace(/urls\s*=\s*\[[^\]]*decafeligiblyhad[^\]]*\]/gi, "urls=[]");
  out = out.replace(/if\s*\(\s*urls\.length\s*\)\s*return;/g, "/* urls bypass */");

  // Buang beacon Cloudflare yang nembak /cdn-cgi/rum ke localhost
  out = out.replace(/<script[^>]*cloudflareinsights[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/\/cdn-cgi\/rum[^"'\s]*/gi, "#");
  out = out.replace(
    /<script[^>]*\/cdn-cgi\/challenge-platform[^>]*>[\s\S]*?<\/script>/gi,
    ""
  );

  const dir = pageUrl.pathname.replace(/[^/]*$/, "") || "/";
  const baseHref = `/__px__/${pageUrl.host}${dir}`;
  const shim = injectClientShim(pageUrl);
  const baseTag = `<base href="${baseHref}">`;

  if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}\n${shim}`);
  } else {
    out = `${baseTag}\n${shim}\n${out}`;
  }

  out = rewriteHtmlUrls(out, pageUrl);
  return out;
}

async function readRequestBody(req) {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function fetchUpstream(target, { redirect = "follow", req = null, method = "GET", body = null } = {}) {
  const headers = buildUpstreamHeaders(target, req);
  if (req?.headers?.["content-type"]) {
    headers["Content-Type"] = req.headers["content-type"];
  }
  const init = {
    method,
    redirect,
    signal: AbortSignal.timeout(90000),
    headers,
  };
  if (body && method !== "GET" && method !== "HEAD") {
    init.body = body;
  }
  return fetch(target.href, init);
}

function requestOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || "127.0.0.1:5173";
  return `${proto}://${host}`;
}

function copySafeHeaders(upstream, res) {
  for (const [key, value] of upstream.headers) {
    if (STRIP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "set-cookie") continue;
    try {
      res.setHeader(key, value);
    } catch {
      /* ignore */
    }
  }
  res.setHeader("Cache-Control", "no-store");
  res.removeHeader?.("Content-Security-Policy");
  res.removeHeader?.("X-Frame-Options");
}

async function handleProxy(req, res) {
  const target = parseProxyPath(req.url);
  if (!target) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Proxy path tidak valid");
    return;
  }

  const origin = requestOrigin(req);
  const method = (req.method || "GET").toUpperCase();

  // CORS preflight (Cast fingerprint/captcha)
  if (method === "OPTIONS") {
    res.statusCode = 204;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.end();
    return;
  }

  try {
    const body = await readRequestBody(req);
    const upstream = await fetchUpstream(target, {
      redirect: "manual",
      req,
      method,
      body,
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      const loc = upstream.headers.get("location");
      if (loc) {
        const next = new URL(loc, target);
        res.statusCode = 302;
        res.setHeader("Location", toProxyPath(next.href));
        res.setHeader("Cache-Control", "no-store");
        res.end();
        return;
      }
    }

    const finalUrl = target;
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await upstream.arrayBuffer());

    // Provider down / Cloudflare 5xx → jangan tampilkan halaman kosong
    if (upstream.status >= 500 && /text\/html/i.test(contentType)) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(
        buildMessagePage(
          `Server ${finalUrl.hostname} bermasalah (${upstream.status})`,
          "Provider sedang error atau overload. Ganti server lewat dropdown."
        )
      );
      return;
    }

    res.statusCode = upstream.status;
    copySafeHeaders(upstream, res);
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (/text\/html/i.test(contentType)) {
      const html = sanitizeHtml(buf.toString("utf8"), finalUrl, origin);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
      return;
    }

    const isM3u8 =
      /mpegurl|m3u8/i.test(contentType) ||
      finalUrl.pathname.toLowerCase().endsWith(".m3u8");

    if (isM3u8) {
      let text = buf.toString("utf8");
      text = text.replace(/(https?:\/\/[^\s"']+)/g, (url) => {
        try {
          const abs = new URL(url);
          if (isPrivateHost(abs.hostname)) return url;
          return `${origin}/__px__/${abs.host}${abs.pathname}${abs.search}`;
        } catch {
          return url;
        }
      });
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      res.end(text);
      return;
    }

    res.setHeader("Content-Type", contentType);
    res.end(buf);
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`Gagal memuat proxy: ${err.message}`);
  }
}

/** Ambil URL iframe dalam dari halaman playeriframe (skip iklan wrapper). */
async function handleResolve(req, res) {
  const incoming = new URL(req.url, "http://127.0.0.1");
  const target = parseHttpUrl(incoming.searchParams.get("url"));
  if (!target) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "URL tidak valid" }));
    return;
  }

  try {
    let playUrl = target.href;
    if (/playeriframe\./i.test(target.hostname)) {
      const upstream = await fetchUpstream(target);
      const html = await upstream.text();
      const m = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      if (m?.[1]) {
        playUrl = new URL(m[1], upstream.url).href;
      }
    }

    // Ikuti redirect singkat (mis. emturbovid → turbovidhls) tanpa unduh body penuh
    try {
      const head = await fetch(playUrl, {
        method: "HEAD",
        redirect: "follow",
        headers: {
          "User-Agent": USER_AGENT,
          Referer: pickReferer(new URL(playUrl)),
        },
      });
      if (head.url) playUrl = head.url;
    } catch {
      /* HEAD bisa ditolak; biarkan URL asli */
    }

    const proxied = toProxyPath(playUrl);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ source: target.href, play: playUrl, embed: proxied }));
  } catch (err) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: err.message }));
  }
}

/** Kompatibilitas lama: /api/embed?url= → redirect ke /__px__/... */
async function handleLegacyEmbed(req, res) {
  const incoming = new URL(req.url, "http://127.0.0.1");
  const target = parseHttpUrl(incoming.searchParams.get("url"));
  if (!target) {
    res.statusCode = 400;
    res.end("URL embed tidak valid");
    return;
  }
  res.statusCode = 302;
  res.setHeader("Location", toProxyPath(target.href));
  res.end();
}

const PROXY_SW = `/* webunime media proxy SW */
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
var CDN = /(?:storage\\.googleapis\\.com|iamcdn\\.net|abysscdn|short\\.icu|morphify\\.net|googleusercontent\\.com|turboviplay\\.com|turbosplayer\\.com|tiktokcdn\\.com|sptvp\\.com)/i;
self.addEventListener("fetch", function (event) {
  try {
    var url = new URL(event.request.url);
    if (url.origin === self.location.origin) return;
    if (!CDN.test(url.hostname)) return;
    var proxied = self.location.origin + "/__px__/" + url.host + url.pathname + url.search;
    event.respondWith(
      fetch(proxied, {
        method: event.request.method,
        headers: event.request.headers,
        redirect: "follow",
        credentials: "omit",
      })
    );
  } catch (e) {}
});
`;

function middleware(req, res, next) {
  const path = req.url?.split("?")[0] || "";

  if (path === "/__wu_sw.js") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Service-Worker-Allowed", "/");
    res.setHeader("Cache-Control", "no-store");
    res.end(PROXY_SW);
    return;
  }

  if (path.startsWith("/__px__/")) return handleProxy(req, res);
  if (path === "/api/resolve") return handleResolve(req, res);
  if (path === "/api/embed") return handleLegacyEmbed(req, res);

  // Beacon CF: jangan ganggu console dengan 404 Vite
  if (path.startsWith("/cdn-cgi/rum")) {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Setelah replaceState, request relatif mengarah ke localhost (bukan /__px__/...)
  if (
    path === "/fingerprint-sw.js" ||
    path.startsWith("/cdn-cgi/") ||
    path.startsWith("/api/") ||
    path.startsWith("/ws/") ||
    path.startsWith("/assets/") ||
    path.startsWith("/player/")
  ) {
    let host = null;
    try {
      const ref = String(req.headers.referer || "");
      const px = ref.match(/\/__px__\/([^/]+)/);
      if (px) host = decodeURIComponent(px[1]);
      else if (/\/e\//.test(ref) || /gn1r5n/i.test(ref) || path.startsWith("/player/")) host = "gn1r5n.org";
      else if (/turbo/i.test(ref)) host = "turbovidhls.com";
      else if (path.startsWith("/cdn-cgi/")) host = "abyssplayer.com";
      else if (
        path === "/fingerprint-sw.js" ||
        path.startsWith("/api/") ||
        path.startsWith("/ws/") ||
        path.startsWith("/assets/")
      ) {
        host = "gn1r5n.org";
      }
    } catch {
      /* keep null */
    }
    if (!host) return next();
    const u = new URL(req.url, "http://local");
    req.url = `/__px__/${host}${u.pathname}${u.search}`;
    return handleProxy(req, res);
  }

  return next();
}

export function embedProxyPlugin() {
  return {
    name: "webunime-embed-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
