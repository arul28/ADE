// ADE's Spotify Web Playback SDK script. The host forwards ADE's JSON
// commands here (chrome.webview message events) and writes what we post back
// to its stdout. Same wire format as page/player.js:
//   command: {"rid":"r1","cmd":"<name>", ...args}
//   reply:   {"reply":"r1","cmd":"<name>","ok":true,"result":...} or {"ok":false,"error":"..."}
//   event:   {"event":"<name>", ...}
//
// The access token never lives here longer than a call: the SDK asks for one
// (`needToken`), ADE answers with `token`, and the SDK keeps it in memory.
// Nothing here logs it.
(function () {
  "use strict";
  var post = function (o) {
    try { window.chrome.webview.postMessage(JSON.stringify(o)); } catch (e) { /* host gone */ }
  };
  var player = null;
  var deviceId = null;
  var tokenWaiters = [];
  var sdkReady = false;
  var pendingConfigure = null;

  // The SDK's state, trimmed to what ADE shows. Sent on every change; ADE
  // drops what does not move its own state.
  var trimState = function (s) {
    if (!s) return null;
    var t = s.track_window && s.track_window.current_track;
    return {
      paused: Boolean(s.paused),
      position: s.position || 0,
      duration: s.duration || 0,
      shuffle: Boolean(s.shuffle),
      repeat: s.repeat_mode || 0,
      loading: Boolean(s.loading),
      track: t ? {
        uri: t.uri,
        id: t.id,
        name: t.name,
        duration_ms: t.duration_ms,
        type: t.type,
        album: t.album ? { name: t.album.name, uri: t.album.uri, images: t.album.images || [] } : null,
        artists: (t.artists || []).map(function (a) { return { name: a.name, uri: a.uri }; })
      } : null
    };
  };

  var createPlayer = function (opts) {
    if (player) return;
    player = new window.Spotify.Player({
      name: opts.name || "ADE",
      volume: typeof opts.volume === "number" ? opts.volume : 0.8,
      getOAuthToken: function (cb) {
        tokenWaiters.push(cb);
        if (tokenWaiters.length === 1) post({ event: "needToken" });
      }
    });
    player.addListener("ready", function (e) {
      deviceId = e.device_id;
      post({ event: "ready", deviceId: deviceId });
    });
    player.addListener("not_ready", function (e) {
      post({ event: "notReady", deviceId: e.device_id });
    });
    player.addListener("player_state_changed", function (s) {
      post({ event: "state", state: trimState(s) });
    });
    ["initialization_error", "authentication_error", "account_error", "playback_error", "autoplay_failed"].forEach(function (kind) {
      player.addListener(kind, function (e) {
        post({ event: "playerError", kind: kind, message: (e && e.message) || kind });
      });
    });
  };

  window.onSpotifyWebPlaybackSDKReady = function () {
    sdkReady = true;
    post({ event: "sdkReady" });
    if (pendingConfigure) {
      var p = pendingConfigure;
      pendingConfigure = null;
      p();
    }
  };

  var run = function (msg) {
    var reply = function (ok, result, error) {
      post({ reply: msg.rid, cmd: msg.cmd, ok: ok, result: result === undefined ? null : result, error: error || null });
    };
    var settle = function (promise) {
      Promise.resolve(promise).then(function (v) { reply(true, v === undefined ? null : v); }, function (e) { reply(false, null, (e && e.message) || String(e)); });
    };
    switch (msg.cmd) {
      case "configure": {
        var go = function () {
          createPlayer(msg);
          settle(player.connect().then(function (ok) {
            if (!ok) throw new Error("Spotify's player could not start.");
            return { connected: true };
          }));
        };
        if (sdkReady) go(); else pendingConfigure = go;
        return;
      }
      case "token": {
        var waiters = tokenWaiters;
        tokenWaiters = [];
        for (var i = 0; i < waiters.length; i++) {
          try { waiters[i](msg.token); } catch (e) { /* SDK internal */ }
        }
        reply(true);
        return;
      }
      case "activate":
        // Lets audio start without a click where the engine asks for one.
        if (player && player.activateElement) settle(player.activateElement()); else reply(true);
        return;
      case "pause": if (player) settle(player.pause()); else reply(true); return;
      case "resume": if (player) settle(player.resume()); else reply(true); return;
      case "toggle": if (player) settle(player.togglePlay()); else reply(true); return;
      case "seek": if (player) settle(player.seek(Math.max(0, Math.round(msg.ms || 0)))); else reply(true); return;
      case "next": if (player) settle(player.nextTrack()); else reply(true); return;
      case "previous": if (player) settle(player.previousTrack()); else reply(true); return;
      case "volume": if (player) settle(player.setVolume(Math.max(0, Math.min(1, Number(msg.value) || 0)))); else reply(true); return;
      case "state": if (player) settle(player.getCurrentState().then(trimState)); else reply(true, null); return;
      case "disconnect": if (player) player.disconnect(); reply(true); return;
      default: reply(false, null, "unknown command");
    }
  };

  var listen = function () {
    if (!window.chrome || !window.chrome.webview) return false;
    window.chrome.webview.addEventListener("message", function (ev) {
      var msg;
      try { msg = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
      if (msg && msg.cmd) run(msg);
    });
    return true;
  };
  if (!listen()) document.addEventListener("DOMContentLoaded", listen);
  post({ event: "loaded" });
})();
