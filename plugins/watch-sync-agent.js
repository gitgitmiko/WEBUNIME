/**
 * Agen sinkron nonton bareng, disuntik ke setiap halaman player yang kita sajikan.
 * Diam sampai parent mengirim perintah; pemutaran biasa tidak terpengaruh.
 * Perintah mengalir turun lewat iframe bersarang, laporan mengalir naik.
 */
const SOURCE = `(function () {
  if (window.__wuSyncAgent) return;
  window.__wuSyncAgent = true;
  if (!window.parent || window.parent === window) return;

  var NS = "webunime-room";
  var MIN_DURATION = 60;
  var DRIFT_SECONDS = 2.5;
  var SEEK_COOLDOWN_MS = 3000;
  var role = null;
  var desired = null;
  var desiredAt = 0;
  var resumeAt = null;
  var lastSeek = 0;
  var userVolume = null;
  var mutedFallback = false;

  /** Video utama: iklan pre-roll pendek diabaikan. */
  function mainVideo() {
    var vids = document.querySelectorAll("video");
    for (var i = 0; i < vids.length; i++) {
      if (vids[i].duration >= MIN_DURATION) return vids[i];
    }
    return null;
  }

  function up(msg) {
    msg.source = NS;
    try { window.parent.postMessage(msg, "*"); } catch (e) {}
  }

  function down(msg) {
    var frames = document.querySelectorAll("iframe");
    for (var i = 0; i < frames.length; i++) {
      try { if (frames[i].contentWindow) frames[i].contentWindow.postMessage(msg, "*"); } catch (e) {}
    }
  }

  function seek(v, time) {
    lastSeek = Date.now();
    try { v.currentTime = time; } catch (e) {}
  }

  function play(v) {
    var p = v.play();
    if (!p || !p.catch) return;
    p.catch(function (err) {
      if (!err || err.name !== "NotAllowedError" || v.muted) return;
      // Kebijakan autoplay: tetap sinkron tanpa suara, penonton mengetuk untuk menyalakan.
      v.muted = true;
      mutedFallback = true;
      up({ status: "muted" });
      v.play().catch(function () { up({ status: "blocked" }); });
    });
  }

  function report(kind) {
    if (role !== "host" || resumeAt !== null) return;
    var v = mainVideo();
    if (!v) return;
    up({ report: { playing: !v.paused && !v.ended, time: v.currentTime, kind: kind } });
  }

  /** Host membuka ulang halaman / ganti server: lanjut dari posisi ruang. */
  function applyResume() {
    if (resumeAt === null) return;
    var v = mainVideo();
    if (!v) return;
    if (resumeAt > 3) seek(v, resumeAt);
    resumeAt = null;
  }

  function enforce() {
    if (role !== "viewer" || !desired) return;
    var v = mainVideo();
    if (!v) return;
    up({ status: "ready" });
    var target = desired.time + (desired.playing ? (Date.now() - desiredAt) / 1000 : 0);
    if (desired.playing && v.paused) play(v);
    if (!desired.playing && !v.paused) v.pause();
    var limit = desired.playing ? DRIFT_SECONDS : 0.5;
    if (Math.abs(v.currentTime - target) > limit && Date.now() - lastSeek > SEEK_COOLDOWN_MS) {
      seek(v, target);
    }
  }

  function handle(d) {
    role = d.role || role;
    if (d.cmd === "sync") {
      if (d.playback) {
        desired = d.playback;
        desiredAt = Date.now();
      }
      if (typeof d.resumeAt === "number" && d.resumeToken !== handle.token) {
        handle.token = d.resumeToken;
        resumeAt = d.resumeAt;
      }
      if (role === "host") {
        applyResume();
        if (mainVideo()) up({ status: "ready" });
      } else enforce();
    } else if (d.cmd === "volume") {
      userVolume = d;
      var v = mainVideo();
      if (v) {
        v.muted = Boolean(d.muted);
        v.volume = d.volume;
        mutedFallback = false;
      }
    }
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || typeof d !== "object" || d.source !== NS) return;
    if (e.source === window.parent) {
      if (!d.cmd) return;
      handle(d);
      down(d);
    } else if (d.report || d.status) {
      // Dari iframe anak: teruskan naik.
      up(d);
    }
  });

  function onMediaEvent(ev) {
    if (!ev.target || String(ev.target.tagName).toUpperCase() !== "VIDEO") return;
    if (ev.target !== mainVideo()) return;
    if (role === "host") report(ev.type);
    // Penonton: jeda / putar / geser dari dalam player langsung dikembalikan.
    else if (role === "viewer") enforce();
  }
  ["play", "pause", "seeked", "loadedmetadata"].forEach(function (name) {
    document.addEventListener(name, onMediaEvent, true);
  });
  document.addEventListener("loadedmetadata", function (ev) {
    if (userVolume && ev.target === mainVideo() && !mutedFallback) {
      ev.target.muted = Boolean(userVolume.muted);
      ev.target.volume = userVolume.volume;
    }
    if (role === "host") applyResume();
  }, true);

  setInterval(function () { report("tick"); }, 3000);
})();`;

export const WATCH_SYNC_AGENT_TAG = `<script>${SOURCE}</script>`;
