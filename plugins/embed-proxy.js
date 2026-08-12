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
  const h = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  if (!h) return true;
  if (h === "localhost" || h === "::1" || h === "0.0.0.0") return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
  if (h === "metadata" || h.endsWith(".metadata.google.internal")) return true;

  // IPv6 unique-local / link-local
  if (h.includes(":")) {
    if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
    if (h === "::" || h.startsWith("::ffff:")) {
      const mapped = h.replace(/^::ffff:/, "");
      if (/^\d+\.\d+\.\d+\.\d+$/.test(mapped)) return isPrivateHost(mapped);
    }
    return false;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    const parts = h.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
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
    // Halaman player butuh parent playeriframe; segmen CDN tetap turbovidhls.
    if (/tiktokcdn|sptvp|googleusercontent|turboviplay|turbosplayer/i.test(host)) {
      return "https://turbovidhls.com/";
    }
    return "https://playeriframe.sbs/";
  }
  // Anime Samehadaku embeds (+ CDN Filedon R2)
  if (
    host.includes("filedon") ||
    host.includes("wibufile") ||
    host.includes("r2.cloudflarestorage")
  ) {
    if (host.includes("r2.cloudflarestorage") || host.includes("filedon")) {
      return "https://filedon.co/";
    }
    if (host.includes("wibufile")) {
      return "https://api.wibufile.com/";
    }
    return "https://v2.samehadaku.how/";
  }
  if (host.includes("playcdn") || host.includes("videonode")) {
    return "https://playeriframe.sbs/";
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

  if (/wibufile/i.test(target.hostname)) {
    headers.Origin = "https://api.wibufile.com";
    headers.Referer = "https://api.wibufile.com/";
  }

  if (/filedon|r2\.cloudflarestorage/i.test(target.hostname)) {
    headers.Origin = "https://filedon.co";
    headers.Referer = "https://filedon.co/";
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
  // Pertahankan hash iframe (p2pplay dll) — fragment tidak pernah sampai server.
  // Hydrax/Abyss core.bundle: slug dari query ?v= ATAU href /^https?:\\/\\/host\\/(slug)$/
  // (path /__px__/host/slug DAN hash #... membuat regex gagal → "Slug is not found").
  function abyssSlugFromPath(p) {
    var m = String(p || "").match(/\\/([a-zA-Z0-9_-]{7,17})(?:[/?#]|$)/);
    return m ? m[1] : "";
  }
  function forceAbyssSlugUrl(slug) {
    if (!slug) return;
    // Jangan pakai hash: document.location.href + # mematahkan regex slug.
    history.replaceState(null, "", "/" + slug + "?v=" + encodeURIComponent(slug));
  }
  try {
    var pathOnly = String(REAL_PATH).split("#")[0];
    var hashFromReal = String(REAL_PATH).indexOf("#") >= 0
      ? String(REAL_PATH).slice(String(REAL_PATH).indexOf("#"))
      : "";
    var hash = hashFromReal || location.hash || "";
    if (IS_ABYSS) {
      forceAbyssSlugUrl(abyssSlugFromPath(REAL_PATH));
    } else {
      history.replaceState(null, "", pathOnly + hash);
    }
  } catch (e) {}

  // Hydrax: core.bundle mendaftarkan /sw.import.js di origin app → SW asing merusak
  // player ("Player has been destroyed"). Paksa hanya SW proxy WEBUNIME.
  if (IS_ABYSS && navigator.serviceWorker && navigator.serviceWorker.register) {
    try {
      var __wuReg = navigator.serviceWorker.register.bind(navigator.serviceWorker);
      navigator.serviceWorker.register = function (url, opts) {
        var u = String(url || "");
        if (u.indexOf("__wu_sw") >= 0) return __wuReg(url, opts);
        return __wuReg("/__wu_sw.js", { scope: "/" });
      };
    } catch (e) {}
  }

  // Cast / Turbo saja: tipu deteksi parent / referrer (App TV tidak spoof referrer Hydrax)
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
  // Cast/Turbo: sembunyikan sandbox frameElement. Hydrax biarkan iframe asli.
  if (IS_CAST || IS_TURBO) {
    try {
      Object.defineProperty(window, "frameElement", {
        configurable: true,
        get: function () { return null; }
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

  // Hydrax: jangan patch native API (fetch/XHR/open/setAttribute) — memicu security alert F12.
  // Media GCS tetap lewat Service Worker.
  if (!IS_ABYSS) {
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

  // setAttribute bypass property setters
  try {
    var osa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      try {
        if (/^(src|href)$/i.test(String(name))) value = toProxy(value);
      } catch (e) {}
      return osa.call(this, name, value);
    };
  } catch (e) {}
  } // !IS_ABYSS

  // SW: proxy CDN same-origin (Hydrax GCS / TurboVIP tiktokcdn segments)
  // Hydrax: JANGAN location.replace — reload di tengah setup JWPlayer → "Player has been destroyed".
  // SW di-register dari halaman /__hydrax__ sebelum iframe dimuat.
  if (IS_TURBO && "serviceWorker" in navigator) {
    try {
      navigator.serviceWorker.register("/__wu_sw.js", { scope: "/" }).then(function () {
        if (!navigator.serviceWorker.controller && !sessionStorage.getItem("__wu_sw_ready")) {
          sessionStorage.setItem("__wu_sw_ready", "1");
          location.replace(location.origin + PREFIX + String(REAL_PATH).split("#")[0]);
        }
      }).catch(function () {});
    } catch (e) {}
  } else if (IS_ABYSS && "serviceWorker" in navigator) {
    try { navigator.serviceWorker.register("/__wu_sw.js", { scope: "/" }).catch(function () {}); } catch (e) {}
  }

  function stripOuterAd() {
    try {
      var a = document.getElementById("uyeouyeo");
      if (a) a.remove();
    } catch (e) {}
  }
  document.addEventListener("DOMContentLoaded", stripOuterAd);
  setTimeout(stripOuterAd, 500);

  // Blokir popup/iklan (App TV juga mem-patch open; toString harus native-like)
  (function blockPopups() {
    var fakeWin = {
      closed: false,
      close: function () { this.closed = true; },
      focus: function () {},
      blur: function () {},
      opener: null,
      location: { href: "about:blank", replace: function () {}, assign: function () {} },
      document: { write: function () {}, close: function () {} },
      postMessage: function () {}
    };
    function fakeOpen() {
      try { fakeWin.closed = false; } catch (e) {}
      setTimeout(function () { try { fakeWin.closed = true; } catch (e) {} }, 1200);
      return fakeWin;
    }
    fakeOpen.toString = function () { return "function open() { [native code] }"; };
    try { window.open = fakeOpen; } catch (e) {}
    try {
      Object.defineProperty(window, "open", {
        configurable: true,
        writable: true,
        value: fakeOpen
      });
    } catch (e) {}

    function isBlankNav(a) {
      if (!a) return false;
      var href = a.getAttribute("href") || "";
      var tgt = (a.getAttribute("target") || "").toLowerCase();
      if (tgt === "_blank" || tgt === "_new") return true;
      var mark = (a.id || "") + " " + (a.className || "") + " " + href;
      return /uyeouyeo|popup|clickunder|decafeligiblyhad|doubleclick|exoclick|propeller|adsterra/i.test(mark);
    }

    document.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t) return;
      var a = t.closest ? t.closest("a") : null;
      if (!isBlankNav(a)) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      try { fakeOpen(); } catch (e) {}
    }, true);

    // Hydrax: jangan patch HTMLAnchorElement.click (App TV juga tidak untuk abyss khusus —
    // patch click memicu deteksi extension di beberapa build core.bundle).
    if (!IS_ABYSS) {
      try {
        var oClick = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (isBlankNav(this)) {
            try { fakeOpen(); } catch (e) {}
            return;
          }
          return oClick.apply(this, arguments);
        };
      } catch (e) {}
    }
  })();

  // Hydrax: jaga JWPlayer + blokir security document.write + klik overlay
  if (IS_ABYSS) {
    try {
      var _dw = document.write.bind(document);
      document.write = function (html) {
        var s = String(html || "");
        if (/security concerns|AdBlock\s*\/\s*Sandbox|developer tools|access request has been denied|Kindly close|refrain from opening/i.test(s)) {
          return;
        }
        return _dw(html);
      };
    } catch (e) {}
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

    // Patch media src → proxy CDN (tanpa patch fetch — deteksi extension Hydrax)
    (function patchAbyssMedia() {
      function toPx(url) {
        try {
          var abs = new URL(String(url), location.href);
          if (abs.protocol !== "http:" && abs.protocol !== "https:") return url;
          if (abs.origin === location.origin) return url;
          if (CDN_RE.test(abs.hostname) || /googleapis|abysscdn|short\\.icu|iamcdn|morphify/i.test(abs.hostname)) {
            return location.origin + "/__px__/" + abs.host + abs.pathname + abs.search + abs.hash;
          }
        } catch (e) {}
        return url;
      }
      function patchProto(proto, attr) {
        try {
          var desc = Object.getOwnPropertyDescriptor(proto, attr);
          if (!desc || !desc.set) return;
          Object.defineProperty(proto, attr, {
            configurable: true,
            enumerable: desc.enumerable,
            get: desc.get,
            set: function (v) { return desc.set.call(this, toPx(v)); }
          });
        } catch (e) {}
      }
      try {
        patchProto(HTMLVideoElement.prototype, "src");
        patchProto(HTMLAudioElement.prototype, "src");
        patchProto(HTMLSourceElement.prototype, "src");
        if (typeof HTMLMediaElement !== "undefined") patchProto(HTMLMediaElement.prototype, "src");
      } catch (e) {}
    })();

    // Cegah jwplayer().remove() → "Player has been destroyed" (pasang sebelum setup)
    (function guardJwRemove() {
      function wrapJw(orig) {
        if (!orig || orig.__wuGuard) return orig;
        function wrap() {
          var p = orig.apply(this, arguments);
          try {
            if (p && typeof p.remove === "function" && !p.__wuNoRemove) {
              p.remove = function () { return p; };
              p.__wuNoRemove = true;
            }
          } catch (e) {}
          return p;
        }
        wrap.__wuGuard = true;
        try {
          Object.keys(orig).forEach(function (k) {
            try { wrap[k] = orig[k]; } catch (e) {}
          });
        } catch (e) {}
        return wrap;
      }
      try {
        var cur = typeof window.jwplayer === "function" ? wrapJw(window.jwplayer) : window.jwplayer;
        Object.defineProperty(window, "jwplayer", {
          configurable: true,
          enumerable: true,
          get: function () { return cur; },
          set: function (fn) { cur = wrapJw(fn); }
        });
      } catch (e) {
        var tries = 0;
        var iv = setInterval(function () {
          tries++;
          try {
            if (typeof window.jwplayer === "function" && !window.jwplayer.__wuGuard) {
              window.jwplayer = wrapJw(window.jwplayer);
              clearInterval(iv);
            }
          } catch (err) {}
          if (tries > 40) clearInterval(iv);
        }, 100);
      }
    })();

    // Sembunyikan notifikasi "Player has been destroyed" sisa race
    try {
      var st = document.createElement("style");
      st.textContent = ".jwpl-notif,.jwpl-notification{display:none!important}";
      (document.head || document.documentElement).appendChild(st);
    } catch (e) {}

    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      try {
        if (window.abyssConfig) window.abyssConfig.popups = [];
        try { if (typeof urls !== "undefined") urls.length = 0; } catch (e) {}
        var overlay = document.getElementById("overlay");
        // Tiru App TV: klik overlay sekali (handler sudah di-patch ke play), jangan spam remove+play
        if (overlay && tries === 6) {
          try { overlay.click(); } catch (e) {}
        }
        if (!overlay && typeof window.jwplayer === "function") {
          try {
            var jp = window.jwplayer();
            var stt = jp && typeof jp.getState === "function" ? jp.getState() : "";
            if (stt && stt !== "error" && stt !== "complete") {
              try { jp.play(); } catch (e) {}
            }
          } catch (e) {}
          clearInterval(iv);
        }
      } catch (e) {}
      if (tries > 40) clearInterval(iv);
    }, 250);
  }

  // Cast: bantu 1-klik play (parent spoof sudah di atas)
  if (IS_CAST) {
    var castArmed = false;
    function castTryPlay() {
      try {
        var btn = document.querySelector(
          "button, .vjs-big-play-button, .jw-icon-display, [class*=play], [aria-label*=Play], [aria-label*=play]"
        );
        var vid = document.querySelector("video");
        try { window.open("about:blank"); } catch (e) {}
        try { window.open("about:blank"); } catch (e) {}
        try { if (btn) btn.click(); } catch (e) {}
        try {
          if (vid) {
            vid.muted = false;
            vid.volume = 1;
            vid.play();
          }
        } catch (e) {}
        try { if (typeof jwplayer === "function") jwplayer().play(); } catch (e) {}
      } catch (e) {}
    }

    document.addEventListener("pointerdown", function () {
      if (castArmed) return;
      castArmed = true;
      castTryPlay();
      setTimeout(castTryPlay, 120);
      // Pastikan tidak tertinggal mute setelah gesture user
      setTimeout(function () {
        try {
          var vid = document.querySelector("video");
          if (vid) { vid.muted = false; vid.volume = 1; }
          if (typeof jwplayer === "function") {
            var jp = jwplayer();
            if (jp && typeof jp.setMute === "function") jp.setMute(false);
            if (jp && typeof jp.setVolume === "function") jp.setVolume(100);
          }
        } catch (e) {}
      }, 300);
    }, true);

    var ct = 0;
    var civ = setInterval(function () {
      ct++;
      try {
        var vid = document.querySelector("video");
        if (vid && !vid.paused && vid.readyState >= 2) {
          clearInterval(civ);
          return;
        }
        if (ct === 3 || ct === 8) castTryPlay();
      } catch (e) {}
      if (ct > 25) clearInterval(civ);
    }, 400);
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

/** Ganti arrow fn `const name = () => { ... }` (brace-matching). */
function replaceConstArrowFn(html, name, body) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*\\(\\s*\\)\\s*=>\\s*\\{`);
  const m = re.exec(html);
  if (!m) return html;
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < html.length && depth > 0) {
    const c = html[i++];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  let end = i;
  if (html[end] === ";") end++;
  return `${html.slice(0, m.index)}const ${name} = () => {${body}};${html.slice(end)}`;
}

/**
 * Hydrax mengacak nama handler overlay (sbM / vSRe / …).
 * Deteksi lewat pola `urls.shift()` di dalam arrow function.
 */
function replaceHydraxOverlayHandler(html, body) {
  const re =
    /const\s+(\w+)\s*=\s*\(\s*\)\s*=>\s*\{\s*const\s+url\s*=\s*urls\.shift\(\)/;
  const m = re.exec(html);
  if (!m) return replaceConstArrowFn(html, "sbM", body);
  return replaceConstArrowFn(html, m[1], body);
}

function toProxiedMediaUrl(absoluteUrl, _origin = "") {
  try {
    const u = new URL(absoluteUrl);
    // Relatif agar cocok dengan origin browser (localhost vs 127.0.0.1)
    return `/__px__/${u.host}${u.pathname}${u.search}`;
  } catch {
    return absoluteUrl;
  }
}

/**
 * Patch core/lite.bundle Hydrax: logika iklan memanggil jwplayer().remove()
 * saat popup diblokir → "Player has been destroyed".
 */
function patchAbyssPlayerJs(text) {
  let out = String(text || "");
  out = out.replace(/\['window'\]\s*>=\s*0x2/g, "['window']>=0x7f");
  out = out.replace(/\['window'\]\s*>\s*0x1/g, "['window']>0x7f");
  out = out.replace(/track\.window\s*>=\s*2/g, "false");
  out = out.replace(/track\.window\s*>\s*1/g, "false");
  out = out.replace(/jwplayer\s*\(\s*\)\s*\.\s*remove\s*\(\s*\)/gi, "void 0");
  return out;
}

function buildHtml5VideoPage(mediaUrl, title = "WEBUNIME Player", origin = "") {
  const playUrl = toProxiedMediaUrl(mediaUrl, origin);
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #000; }
    video { width: 100%; height: 100%; object-fit: contain; background: #000; }
    .err { color: #fff; font-family: system-ui, sans-serif; padding: 1.5rem; text-align: center; line-height: 1.5; }
  </style>
</head>
<body>
  <video id="v" controls autoplay playsinline preload="metadata"></video>
  <script>
    (function () {
      var video = document.getElementById("v");
      var src = ${JSON.stringify(playUrl)};
      video.src = src;
      var shown = false;
      function fail(msg) {
        if (shown) return;
        shown = true;
        document.body.innerHTML = '<p class="err">' + msg + '</p>';
      }
      video.addEventListener("error", function () {
        fail("Gagal memutar video. Coba ganti server (Blogspot / Mega / resolusi lain).");
      });
      video.addEventListener("loadeddata", function () { shown = true; });
      // Timeout: kalau 25s masih buffering tanpa frame, beri petunjuk
      setTimeout(function () {
        if (!shown && video.readyState < 2) {
          fail("Loading terlalu lama. Coba Blogspot / Mega, atau resolusi Wibufile lain.");
        }
      }, 25000);
    })();
  </script>
</body>
</html>`;
}

function buildHlsPlayerPage(m3u8Url, title = "WEBUNIME Player", origin = "") {
  const playUrl = toProxiedMediaUrl(m3u8Url, origin);

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

/** Ambil URL .mp4 dari halaman JWPlayer Wibufile. */
function extractMp4(html) {
  const patterns = [
    /"file"\s*:\s*"((?:https?:)?\\\/\\\/[^"]+\.mp4[^"]*)"/i,
    /"file"\s*:\s*"((?:https?:\/\/)[^"]+\.mp4[^"]*)"/i,
    /file\s*:\s*["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i,
    /(https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*)/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m?.[1]) continue;
    let url = m[1].replace(/\\\//g, "/");
    if (url.startsWith("//")) url = `https:${url}`;
    try {
      return new URL(url).href;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Filedon membatasi embed ke domain Samehadaku.
 * Nonaktifkan whitelist di props Inertia agar player bisa jalan di WEBUNIME.
 */
function patchFiledonEmbed(html) {
  // Hanya matikan whitelist — jangan sisipkan domain (bisa rusak JSON bila array kosong)
  return html
    .replace(
      /(&quot;|")domain_whitelist_enabled\1\s*:\s*true/g,
      "$1domain_whitelist_enabled$1:false"
    )
    .replace(
      /"domain_whitelist_enabled"\s*:\s*true/g,
      '"domain_whitelist_enabled":false'
    );
}

function decodeInertiaDataPage(html) {
  const m = html.match(/data-page=(["'])([\s\S]*?)\1/i);
  if (!m) return null;
  try {
    const raw = m[2]
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Ambil URL media Filedon (R2 signed / HLS). */
function extractFiledonMedia(html) {
  const page = decodeInertiaDataPage(html);
  if (page?.props) {
    const direct =
      (typeof page.props.url === "string" &&
      /r2\.cloudflarestorage|\.mp4|\.mkv|\.webm/i.test(page.props.url)
        ? page.props.url
        : null) || null;
    return {
      hlsUrl: page.props.media?.hls_url || null,
      directUrl: direct,
      extension: String(page.props.files?.extension || "").toLowerCase(),
      mime: String(page.props.files?.mime_type || "").toLowerCase(),
    };
  }

  const ext =
    html.match(/&quot;extension&quot;:&quot;([^&]+)&quot;/)?.[1]?.toLowerCase() ||
    html.match(/"extension"\s*:\s*"([^"]+)"/)?.[1]?.toLowerCase() ||
    "";

  // Cari signed URL R2 (bukan ziggy.url)
  const r2 =
    html.match(
      /https?:\\?\/\\?\/[a-z0-9]+\.r2\.cloudflarestorage\.com[^"&\s]*|(?:https?:\/\/)[a-z0-9]+\.r2\.cloudflarestorage\.com[^"&\s]*/i
    )?.[0] ||
    html.match(
      /&quot;(https?:\/\/[^&]*r2\.cloudflarestorage\.com[^&]*)&quot;/i
    )?.[1];

  let directUrl = null;
  if (r2) {
    directUrl = r2
      .replace(/\\\//g, "/")
      .replace(/&amp;/g, "&")
      .replace(/\\u0026/g, "&");
  }

  return {
    hlsUrl: null,
    directUrl,
    extension: ext,
    mime: "",
  };
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

  // Wibufile embed (JWPlayer) → putar MP4 langsung (lebih stabil di iframe proxy)
  if (/wibufile/i.test(pageUrl.hostname)) {
    const mp4 = extractMp4(html);
    if (mp4) return buildHtml5VideoPage(mp4, pageUrl.hostname, origin);
  }

  // Filedon / VIP / Pucuk: bypass whitelist + putar MP4/HLS langsung
  if (/filedon\.co/i.test(pageUrl.hostname)) {
    const patched = patchFiledonEmbed(html);
    const media = extractFiledonMedia(patched);
    if (media.hlsUrl) {
      return buildHlsPlayerPage(media.hlsUrl, "VIP STREAMING", origin);
    }
    const ext = media.extension;
    const isMp4 =
      ext === "mp4" ||
      ext === "webm" ||
      /mp4|webm/i.test(media.mime) ||
      (media.directUrl && /\.mp4(\?|$)/i.test(media.directUrl.split("?")[0]));
    if (media.directUrl && isMp4) {
      return buildHtml5VideoPage(media.directUrl, "VIP STREAMING", origin);
    }
    if (ext === "mkv" || /matroska/i.test(media.mime)) {
      return buildMessagePage(
        "VIP STREAMING belum siap diputar",
        "File di server ini masih MKV tanpa HLS (belum di-transcode). Browser tidak bisa memutar MKV. Pilih Blogspot, Wibufile, atau Mega."
      );
    }
    html = patched;
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

  // Hydrax: matikan deteksi "extension", ganti handler overlay → langsung play
  out = out.replace(
    /const\s+isUseExtension\s*=\s*[^;]+;/g,
    "const isUseExtension = false;"
  );
  out = replaceHydraxOverlayHandler(
    out,
    `try{if(overlay){overlay.onclick=null;overlay.ontouchend=null;overlay.remove();}}catch(e){}` +
      `try{if(typeof jwplayer!="undefined"&&typeof jwplayer().play=="function")jwplayer().play();}catch(e){}`
  );
  out = out.replace(/jwplayer\s*\(\s*\)\s*\.\s*remove\s*\(\s*\)/gi, "void 0");
  out = out.replace(/track\.window\s*>=\s*2/g, "false");
  out = out.replace(/track\.window\s*>\s*1/g, "false");
  out = out.replace(
    /window\.abyssConfig\s*=\s*\{popups:\s*\[[^\]]*\]\}/g,
    "window.abyssConfig={popups:[]}"
  );
  out = out.replace(/urls\s*=\s*\[[^\]]*decafeligiblyhad[^\]]*\]/gi, "urls=[]");
  // Hydrax: sebelum SoTrym, paksa URL /{slug}?v={slug} agar core.bundle tidak "Slug is not found"
  if (/abyss/i.test(pageUrl.hostname)) {
    out = out.replace(
      /window\.SoTrym\s*\(\s*JSON\.parse\s*\(\s*atob\s*\(\s*datas\s*\)\s*\)\s*\)/g,
      '(function(d){try{if(d&&d.slug)history.replaceState(null,"","/"+d.slug+"?v="+encodeURIComponent(d.slug))}catch(e){}return window.SoTrym(d)})(JSON.parse(atob(datas)))'
    );
    // Paksa core/lite/jwplayer lewat proxy supaya bisa di-patch (jangan load langsung iamcdn)
    out = out.replace(/https?:\/\/iamcdn\.net\//gi, "/__px__/iamcdn.net/");
    out = out.replace(/https?:\/\/(?:www\.)?abysscdn\.com\//gi, "/__px__/abysscdn.com/");
  }
  // Alert AdBlock/Sandbox / security gate Hydrax
  out = out.replace(
    /Due to certain reasons\s*\(AdBlock\/Sandbox\)[\s\S]{0,280}?try again\./gi,
    ""
  );
  out = out.replace(
    /Due to security concerns[\s\S]{0,320}?developer tools[\s\S]{0,120}?\)\./gi,
    ""
  );
  out = out.replace(
    /your access request has been denied[\s\S]{0,280}?try again\./gi,
    ""
  );

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
    if (key.toLowerCase() === "content-disposition") continue;
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
    res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
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
    const pathLower = finalUrl.pathname.toLowerCase();
    const isHtml = /text\/html/i.test(contentType);
    const isM3u8 =
      /mpegurl|m3u8/i.test(contentType) || pathLower.endsWith(".m3u8");
    const isMedia =
      !isHtml &&
      !isM3u8 &&
      (/video\/|audio\//i.test(contentType) ||
        /application\/octet-stream/i.test(contentType) ||
        /\.(mp4|webm|mkv|m4v|ts|m4s|aac|mp3)(\?|$)/i.test(pathLower) ||
        /\.mp4/i.test(finalUrl.search) ||
        /r2\.cloudflarestorage|wibufile/i.test(finalUrl.hostname));

    // Stream media (jangan buffer full file — penyebab loading abadi di Wibufile/VIP)
    if (isMedia && method !== "HEAD") {
      res.statusCode = upstream.status;
      copySafeHeaders(upstream, res);
      if (/\.mp4/i.test(pathLower) || /\.mp4/i.test(finalUrl.search) || /video\/mp4/i.test(contentType)) {
        res.setHeader("Content-Type", "video/mp4");
      } else if (/\.webm/i.test(pathLower)) {
        res.setHeader("Content-Type", "video/webm");
      } else {
        res.setHeader("Content-Type", contentType);
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
      res.setHeader("Accept-Ranges", "bytes");
      if (!upstream.body) {
        res.end();
        return;
      }
      const { Readable } = await import("node:stream");
      const nodeStream = Readable.fromWeb(upstream.body);
      nodeStream.on("error", () => {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      });
      nodeStream.pipe(res);
      return;
    }

    const buf = Buffer.from(await upstream.arrayBuffer());

    // Provider down / Cloudflare 5xx → jangan tampilkan halaman kosong
    if (upstream.status >= 500 && isHtml) {
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

    if (isHtml) {
      const html = sanitizeHtml(buf.toString("utf8"), finalUrl, origin);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
      return;
    }

    if (isM3u8) {
      let text = buf.toString("utf8");
      text = text.replace(/(https?:\/\/[^\s"']+)/g, (url) => {
        try {
          const abs = new URL(url);
          if (isPrivateHost(abs.hostname)) return url;
          return `/__px__/${abs.host}${abs.pathname}${abs.search}`;
        } catch {
          return url;
        }
      });
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      res.end(text);
      return;
    }

    const isJs =
      /javascript|ecmascript/i.test(contentType) || pathLower.endsWith(".js");
    if (isJs && /iamcdn|abysscdn|abyssplayer|short\.icu/i.test(finalUrl.hostname)) {
      const patched = patchAbyssPlayerJs(buf.toString("utf8"));
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(patched);
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

/** Ambil URL iframe dalam dari halaman playeriframe/videonode (skip iklan wrapper). */
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
    // Wrapper LK21 (playeriframe / videonode) → ambil iframe player asli
    if (/playeriframe\.|videonode\.de/i.test(target.hostname)) {
      const upstream = await fetchUpstream(target);
      const html = await upstream.text();
      const m =
        html.match(
          /<div[^>]*embed-container[^>]*>[\s\S]*?<iframe[^>]+src=["']([^"']+)["']/i
        ) || html.match(/<iframe[^>]+src=["'](https?:\/\/[^"']+)["']/i);
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

function handleVid(req, res) {
  const incoming = new URL(req.url, "http://127.0.0.1");
  const target = parseHttpUrl(incoming.searchParams.get("u"));
  if (!target) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(buildMessagePage("URL tidak valid", "Tidak bisa memuat video."));
    return;
  }
  const origin = requestOrigin(req);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(buildHtml5VideoPage(target.href, target.hostname, origin));
}

/**
 * Wrapper ala App TV (WebPlayerProxy.abyssWrapperHtml):
 * Hydrax harus jalan di dalam iframe (top !== self), bukan dokumen top proxy.
 */
function buildHydraxWrapperPage(abyssEmbedPath) {
  return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Hydrax</title>
<style>
html,body{margin:0;padding:0;height:100%;width:100%;background:#000;overflow:hidden}
iframe#wuEmbed{
  border:0!important;outline:0!important;box-shadow:none!important;
  margin:0!important;padding:0!important;
  width:100vw!important;height:100vh!important;display:block;background:#000!important;
}
</style></head>
<body>
<iframe id="wuEmbed" src="about:blank" allow="autoplay; fullscreen; encrypted-media"
  allowfullscreen scrolling="no" referrerpolicy="origin"></iframe>
<script>
(function () {
  var EMBED = ${JSON.stringify(String(abyssEmbedPath || ""))};
  var frame = document.getElementById("wuEmbed");
  var loaded = false;
  function go() {
    if (loaded || !frame) return;
    loaded = true;
    frame.src = EMBED;
  }
  // Pastikan Service Worker aktif dulu supaya GCS/CDN ter-proxy tanpa reload di dalam player
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/__wu_sw.js", { scope: "/" }).then(function () {
      if (navigator.serviceWorker.controller) go();
      else {
        navigator.serviceWorker.addEventListener("controllerchange", go);
        setTimeout(go, 2500);
      }
    }).catch(go);
  } else {
    go();
  }
})();
</script>
</body></html>`;
}

function handleHydraxWrap(req, res) {
  const incoming = new URL(req.url, "http://127.0.0.1");
  const target = parseHttpUrl(incoming.searchParams.get("u"));
  if (!target || !/abyssplayer|abyss\.to|short\.icu|abysscdn/i.test(target.hostname)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(buildMessagePage("URL Hydrax tidak valid", "Coba ganti server."));
    return;
  }
  const embed = toProxyPath(target.href);
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(buildHydraxWrapperPage(embed));
}

function middleware(req, res, next) {
  const path = req.url?.split("?")[0] || "";

  // Auth API dilayani router terpisah (Vite plugin / Express)
  if (path.startsWith("/api/auth")) return next();

  if (path === "/__wu_sw.js" || path === "/sw.import.js" || path.startsWith("/sw.import")) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Service-Worker-Allowed", "/");
    res.setHeader("Cache-Control", "no-store");
    res.end(PROXY_SW);
    return;
  }

  if (path === "/__vid__") return handleVid(req, res);
  if (path === "/__hydrax__" || path.startsWith("/__hydrax__?")) return handleHydraxWrap(req, res);
  if (path.startsWith("/__px__/")) return handleProxy(req, res);
  if (path === "/api/resolve") return handleResolve(req, res);
  if (path === "/api/embed") return handleLegacyEmbed(req, res);

  // Beacon CF: jangan ganggu console dengan 404 Vite
  if (path.startsWith("/cdn-cgi/rum")) {
    res.statusCode = 204;
    res.end();
    return;
  }

  // Setelah replaceState, request relatif player mengarah ke origin app (bukan /__px__/...).
  // Jangan ambil alih /assets/ Vite sendiri — hanya remap bila referer masih konteks embed.
  // Hydrax: setelah replaceState ke /{slug}, referer = https://app/{slug} (tanpa /__px__/).
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
      else if (path.startsWith("/player/") || /\/e\//.test(ref) || /gn1r5n/i.test(ref))
        host = "gn1r5n.org";
      else if (/turbo/i.test(ref)) host = "turbovidhls.com";
      else if (
        path.startsWith("/cdn-cgi/") ||
        /^https?:\/\/[^/]+\/[a-zA-Z0-9_-]{7,17}(?:\?.*)?\/?$/i.test(ref)
      )
        host = "abyssplayer.com";
      // Tanpa referer embed: biarkan Vite/static serve (CSS/JS app).
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

export { middleware as embedProxyMiddleware };

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
