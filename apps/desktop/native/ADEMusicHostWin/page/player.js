// ADE's MusicKit control script. The host forwards ADE's JSON commands here
// (chrome.webview message events) and writes what we post back to its stdout.
//
// Wire format, one JSON object per message:
//   command: {"rid":"r1","cmd":"<name>", ...args}
//   reply:   {"reply":"r1","cmd":"<name>","ok":true,"result":...} or {"ok":false,"error":"..."}
//   event:   {"event":"<name>", ...}
//
// Tokens arrive in `configure` and leave in `authorize`'s reply only. Nothing
// here logs them. MusicKit saves the Music-User-Token in this profile's
// localStorage; ADE keeps it in its own encrypted store and passes it in on
// every start, so the page deletes MusicKit's copy whenever MusicKit writes it.
(function () {
  "use strict";
  var post = function (o) {
    try { window.chrome.webview.postMessage(JSON.stringify(o)); } catch (e) { /* host gone */ }
  };
  var statusEl = function (text) {
    var el = document.getElementById("status");
    if (el) el.textContent = text;
  };
  var loaded = false;
  var mk = null;
  var lastTimeEmit = 0;

  // MusicKit's key is "<prefix>.<team id>.media-user-token".
  var forgetSavedUserToken = function () {
    try {
      for (var i = localStorage.length - 1; i >= 0; i--) {
        var key = localStorage.key(i);
        if (key && /\.media-user-token$/.test(key)) localStorage.removeItem(key);
      }
    } catch (e) { /* storage unavailable: nothing saved */ }
  };
  // Before MusicKit loads: a token saved by an older build must not sign it in.
  forgetSavedUserToken();

  var stateNames = {};
  var playbackStateName = function (n) {
    if (!stateNames.ready && window.MusicKit && MusicKit.PlaybackStates) {
      for (var k in MusicKit.PlaybackStates) {
        if (typeof MusicKit.PlaybackStates[k] === "number") stateNames[MusicKit.PlaybackStates[k]] = k;
      }
      stateNames.ready = true;
    }
    return stateNames[n] || "none";
  };

  var artworkOf = function (item) {
    var art = item && (item.artwork || (item.attributes && item.attributes.artwork));
    return art && art.url ? { url: art.url, width: art.width || null, height: art.height || null, bgColor: art.bgColor || null } : null;
  };

  var slimItem = function (item) {
    if (!item) return null;
    var a = item.attributes || {};
    var pp = item.playParams || a.playParams || {};
    return {
      id: String(item.id),
      type: item.type || null,
      title: item.title || a.name || "",
      artist: item.artistName || a.artistName || "",
      album: item.albumName || a.albumName || "",
      artwork: artworkOf(item),
      durationMs: item.playbackDuration || a.durationInMillis || null,
      catalogId: pp.catalogId || (pp.isLibrary ? null : pp.id) || null,
      isLibrary: Boolean(pp.isLibrary) || /^i\./.test(String(item.id)) || /^l\./.test(String(item.id)),
    };
  };

  var round = function (n) { return Math.round((n || 0) * 10) / 10; };

  var snapshot = function () {
    if (!mk) return { ready: false, loaded: loaded };
    var q = mk.queue;
    return {
      ready: true,
      authorized: mk.isAuthorized,
      state: playbackStateName(mk.playbackState),
      isPlaying: mk.isPlaying,
      time: round(mk.currentPlaybackTime),
      duration: round(mk.currentPlaybackDuration),
      queuePosition: q ? q.position : -1,
      queueLength: q ? q.length : 0,
      shuffle: mk.shuffleMode,
      repeat: mk.repeatMode,
      volume: mk.volume,
      nowPlaying: slimItem(mk.nowPlayingItem),
    };
  };

  var emitState = function (reason) {
    post({ event: "state", reason: reason, state: snapshot() });
  };

  var wire = function () {
    var on = function (name, fn) { mk.addEventListener(name, fn); };
    on("playbackStateDidChange", function () { emitState("playbackState"); });
    on("nowPlayingItemDidChange", function () { emitState("nowPlaying"); });
    on("queueItemsDidChange", function () { emitState("queueItems"); post({ event: "queueChanged" }); });
    on("queuePositionDidChange", function () { emitState("queuePosition"); post({ event: "queueChanged" }); });
    on("shuffleModeDidChange", function () { emitState("shuffle"); });
    on("repeatModeDidChange", function () { emitState("repeat"); });
    on("playbackVolumeDidChange", function () { emitState("volume"); });
    on("playbackDurationDidChange", function () { emitState("duration"); });
    on("authorizationStatusDidChange", function () {
      post({ event: "authorization", authorized: mk.isAuthorized });
      emitState("authorization");
    });
    on("playbackTimeDidChange", function () {
      var now = Date.now();
      if (now - lastTimeEmit < 1000) return;
      lastTimeEmit = now;
      post({ event: "time", time: round(mk.currentPlaybackTime), duration: round(mk.currentPlaybackDuration), isPlaying: mk.isPlaying });
    });
    on("mediaPlaybackError", function (e) {
      post({ event: "playbackError", error: String((e && (e.errorCode || e.message)) || e) });
    });
  };

  var queueItems = function () {
    var q = mk.queue;
    if (!q) return { position: -1, items: [] };
    var items = [];
    for (var i = 0; i < q.items.length; i++) items.push(slimItem(q.items[i]));
    return { position: q.position, items: items };
  };

  var setQueueAndMaybePlay = async function (descriptor, c) {
    var index = typeof c.index === "number" && c.index > 0 ? c.index : 0;
    if (index > 0) descriptor.startWith = index;
    descriptor.startPlaying = false;
    await mk.setQueue(descriptor);
    if (typeof c.shuffle === "number") mk.shuffleMode = c.shuffle;
    if (mk.queue && index > 0 && mk.queue.position !== index && index < mk.queue.length) {
      await mk.changeToMediaAtIndex(index);
    }
    if (c.play !== false) await mk.play();
    if (typeof c.position === "number" && c.position > 0) await mk.seekToTime(c.position);
  };

  var needMk = function () {
    if (!mk) throw new Error("not_configured");
    return mk;
  };

  var handlers = {
    configure: async function (c) {
      if (!loaded) throw new Error("musickit_not_loaded");
      if (!mk) {
        mk = await MusicKit.configure({
          developerToken: c.developerToken,
          app: { name: "ADE", build: c.appBuild || "1.0.0", icon: location.origin + "/ade-icon.png" },
        });
        wire();
      }
      if (c.userToken) mk.musicUserToken = c.userToken;
      forgetSavedUserToken();
      if (typeof c.volume === "number") mk.volume = c.volume;
      statusEl("MusicKit " + MusicKit.version + " ready");
      return snapshot();
    },
    authorize: async function () {
      var token;
      try {
        token = await needMk().authorize();
      } finally {
        forgetSavedUserToken();
      }
      return { userToken: token || mk.musicUserToken || null, authorized: mk.isAuthorized };
    },
    unauthorize: async function () {
      try {
        await needMk().unauthorize();
      } finally {
        forgetSavedUserToken();
      }
      return snapshot();
    },
    queue: async function () { return queueItems(); },
    playItems: async function (c) {
      needMk();
      var ids = (c.ids || []).map(String).filter(Boolean);
      if (!ids.length) throw new Error("no_items");
      await setQueueAndMaybePlay(ids.length === 1 ? { song: ids[0] } : { songs: ids }, c);
      return snapshot();
    },
    playCollection: async function (c) {
      needMk();
      var kind = c.kind === "album" ? "album" : c.kind === "station" ? "station" : "playlist";
      var d = {};
      d[kind] = String(c.id);
      await setQueueAndMaybePlay(d, c);
      return snapshot();
    },
    pause: async function () { needMk().pause(); return snapshot(); },
    resume: async function () { await needMk().play(); return snapshot(); },
    toggle: async function () {
      var m = needMk();
      if (m.isPlaying) m.pause(); else await m.play();
      return snapshot();
    },
    next: async function () { await needMk().skipToNextItem(); return snapshot(); },
    prev: async function () {
      var m = needMk();
      // Like every player: a few seconds in, "previous" restarts the song.
      if (m.currentPlaybackTime > 3) await m.seekToTime(0);
      else await m.skipToPreviousItem();
      return snapshot();
    },
    seek: async function (c) { await needMk().seekToTime(Math.max(0, Number(c.position) || 0)); lastTimeEmit = 0; return snapshot(); },
    volume: async function (c) { needMk().volume = Math.max(0, Math.min(1, Number(c.value))); return snapshot(); },
    shuffle: async function (c) { needMk().shuffleMode = c.mode ? 1 : 0; return snapshot(); },
    repeat: async function (c) { var r = Number(c.mode); needMk().repeatMode = r === 1 || r === 2 ? r : 0; return snapshot(); },
    playAt: async function (c) { await needMk().changeToMediaAtIndex(Number(c.index) || 0); return snapshot(); },
    playNext: async function (c) { await needMk().playNext({ songs: (c.ids || []).map(String) }); return queueItems(); },
    playLater: async function (c) { await needMk().playLater({ songs: (c.ids || []).map(String) }); return queueItems(); },
    // What ADE keeps when it unloads this host, so a relaunch continues the
    // same song at the same second.
    snapshot: async function () {
      var m = needMk();
      var q = queueItems();
      return {
        ids: q.items.map(function (i) { return i.id; }),
        index: q.position,
        position: round(m.currentPlaybackTime),
        shuffle: m.shuffleMode,
        repeat: m.repeatMode,
        volume: m.volume,
        nowPlaying: slimItem(m.nowPlayingItem),
      };
    },
  };

  window.chrome.webview.addEventListener("message", async function (ev) {
    var c;
    try { c = JSON.parse(ev.data); } catch (e) { post({ reply: null, ok: false, error: "bad_json" }); return; }
    var t0 = performance.now();
    try {
      var h = handlers[c.cmd];
      if (!h) throw new Error("unknown_command:" + c.cmd);
      var result = await h(c);
      post({ reply: c.rid || null, cmd: c.cmd, ok: true, ms: Math.round(performance.now() - t0), result: result });
    } catch (e) {
      post({ reply: c.rid || null, cmd: c.cmd, ok: false, ms: Math.round(performance.now() - t0), error: String((e && (e.errorCode || e.message)) || e) });
    }
  });

  document.addEventListener("musickitloaded", function () {
    loaded = true;
    statusEl("MusicKit " + MusicKit.version + " loaded");
    post({ event: "loaded", version: MusicKit.version, origin: location.origin });
  });

  // The CDN script can fail (offline, blocked). Say so instead of hanging.
  setTimeout(function () {
    if (!loaded) post({ event: "loadFailed", error: window.MusicKit ? "musickit_no_event" : "musickit_script_unavailable" });
  }, 20000);
})();
