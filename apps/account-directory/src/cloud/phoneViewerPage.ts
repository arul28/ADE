/**
 * `GET /cloud/phone/viewer`: ADE's page for a phone streamed over WebRTC
 * (Revyl's; `phoneRevyl.ts` makes the link, `phones.ts` serves the route). It
 * plays the `#whep=` stream in a video sized to the screen, under one clear
 * canvas that takes input (no per-frame copy), and with `#ws=` sends the
 * person's touches and keys to the phone in its own points as Revyl's own
 * player does: touch down, move, up; typed text and Enter/Backspace at the
 * field last tapped. Keys arrive through a hidden input that never raises an
 * on-screen keyboard. The desktop pane, the iPhone app and the web app open it
 * as they open NoMac's page: they find the canvas, press "home", and read "not
 * running" when the phone ends. Static: the link's `#` part names the phone.
 */
export function phoneViewerPage(): Response {
  return new Response(VIEWER_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src https: wss:; media-src blob: https:; img-src data: blob:",
    },
  });
}

const VIEWER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>ADE Cloud iPhone</title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden;font:14px -apple-system,system-ui,sans-serif;color:#aaa}
#stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
#frame{position:relative;background:#000}
#frame video,#frame canvas{position:absolute;inset:0;width:100%;height:100%;display:block}
canvas{touch-action:none;cursor:pointer;background:transparent}
#keys{position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;border:0;padding:0;font-size:16px;pointer-events:none}
#note{position:absolute;left:0;right:0;bottom:16px;text-align:center;pointer-events:none}
#home{position:absolute;left:-1000px;top:0}
</style></head>
<body><div id="stage"><div id="frame"><video id="video" muted playsinline autoplay></video><canvas id="screen" width="1" height="1"></canvas></div></div><input id="keys" inputmode="none" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-hidden="true" tabindex="-1"><div id="note">Connecting to the phone…</div><button id="home" tabindex="-1">Home</button>
<script>
(function(){
  var params = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
  var whep = params.get("whep"), wsUrl = params.get("ws");
  var W = Number(params.get("w")) || 440, H = Number(params.get("h")) || 956;
  var ice = []; try { ice = JSON.parse(params.get("ice") || "[]"); } catch (e) {}
  // The video shows itself; the canvas over it is clear and only takes touches (and is what hosts measure).
  var canvas = document.getElementById("screen"), frame = document.getElementById("frame"), keys = document.getElementById("keys");
  var video = document.getElementById("video"), note = document.getElementById("note");
  var ended = false, live = false;
  function say(text){ note.textContent = text; note.style.display = text ? "" : "none"; }
  function end(){ if (ended) return; ended = true; say("The phone is not running any more."); }
  function fit(){
    var scale = Math.min(innerWidth / W, innerHeight / H);
    frame.style.width = Math.floor(W * scale) + "px"; frame.style.height = Math.floor(H * scale) + "px";
  }
  addEventListener("resize", fit); fit();
  video.addEventListener("playing", function(){ if (!live) { live = true; say(""); } });
  // A web view that wants a tap before video plays (the iPhone app's) gets one.
  function resume(){ if (video.srcObject && video.paused) video.play().catch(function(){ if (!live && !ended) say("Tap to show the phone."); }); }
  async function play(){
    if (!whep) { say("This link has no stream."); return; }
    var pc = new RTCPeerConnection({ iceServers: ice });
    var stream = new MediaStream();
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = function(event){ if (event.track.kind === "video") { stream.addTrack(event.track); video.srcObject = stream; resume(); } };
    pc.onconnectionstatechange = function(){ if (pc.connectionState === "failed" || pc.connectionState === "closed") end(); };
    var offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    await new Promise(function(resolve){ if (pc.iceGatheringState === "complete") return resolve(); var t = setTimeout(resolve, 2000); pc.addEventListener("icegatheringstatechange", function(){ if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); } }); });
    var answer = await fetch(whep, { method: "POST", headers: { "content-type": "application/sdp" }, body: pc.localDescription.sdp });
    if (answer.status === 404 || answer.status === 410) return end();
    if (!answer.ok) throw new Error("stream " + answer.status);
    await pc.setRemoteDescription({ type: "answer", sdp: await answer.text() });
  }
  play().catch(function(){ if (!ended) say("The phone's picture didn't load. Close and open the view again."); });

  var socket = null, actionId = 0, queue = [];
  function connect(){
    if (!wsUrl || ended) return;
    socket = new WebSocket(wsUrl);
    socket.onopen = function(){ while (queue.length) socket.send(queue.shift()); };
    socket.onclose = function(event){ socket = null; if (event.code === 4404 || event.code === 4410) return end(); if (!ended) setTimeout(connect, 1000); };
    socket.onmessage = function(event){ if (typeof event.data === "string" && /"(SESSION_ENDED|DEVICE_STOPPED|session_ended)"/.test(event.data)) end(); };
  }
  function send(action, fields){
    if (!wsUrl || ended) return;
    var message = JSON.stringify(Object.assign({ event_type: "STREAM", action: "MANUAL_" + action, action_id: ++actionId, client_sent_at_ms: Date.now() }, fields));
    if (socket && socket.readyState === 1) socket.send(message); else { queue.push(message); if (queue.length > 50) queue.shift(); }
  }
  connect();

  function point(event){
    var rect = canvas.getBoundingClientRect();
    return { x: Math.round(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * W), y: Math.round(Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * H) };
  }
  var down = null;
  // A cancelled press gives no focus by itself: it focuses a hidden input instead, so keys reach this page
  // (in an iframe, and in the iPhone app's web view, which sends keys only to a text field). No on-screen keyboard.
  canvas.addEventListener("pointerdown", function(event){ event.preventDefault(); keys.focus({ preventScroll: true }); resume(); canvas.setPointerCapture && canvas.setPointerCapture(event.pointerId); var p = point(event); down = { x: p.x, y: p.y, at: Date.now(), last: p }; send("TOUCH_DOWN", p); });
  canvas.addEventListener("pointermove", function(event){ if (!down) return; var p = point(event); down.last = p; send("TOUCH_MOVE", p); });
  function lift(event){
    if (!down) return; var p = event && event.clientX !== undefined ? point(event) : down.last; var held = Date.now() - down.at;
    var gesture = Math.hypot(p.x - down.x, p.y - down.y) >= 12 ? "drag" : held >= 500 ? "long_press" : "tap";
    send("TOUCH_UP", { x: p.x, y: p.y, gesture: gesture, duration_ms: held }); down = null;
    if (gesture === "tap") { flush(); lastTap = { x: p.x, y: p.y }; }
  }
  canvas.addEventListener("pointerup", lift); canvas.addEventListener("pointercancel", lift);
  var wheel = null;
  canvas.addEventListener("wheel", function(event){
    event.preventDefault();
    var p = point(event);
    if (!wheel) { wheel = { x: p.x, y: p.y, cx: p.x, cy: p.y, at: Date.now() }; send("TOUCH_DOWN", { x: p.x, y: p.y }); }
    wheel.cx = Math.max(0, Math.min(W, wheel.cx - event.deltaX)); wheel.cy = Math.max(0, Math.min(H, wheel.cy - event.deltaY));
    send("TOUCH_MOVE", { x: Math.round(wheel.cx), y: Math.round(wheel.cy) });
    clearTimeout(wheel.timer);
    wheel.timer = setTimeout(function(){ send("TOUCH_UP", { x: Math.round(wheel.cx), y: Math.round(wheel.cy), gesture: "drag", duration_ms: Date.now() - wheel.at }); wheel = null; }, 120);
  }, { passive: false });
  // Typing goes to the field last tapped, as Revyl's own player sends it: the
  // text at that point, a few keys at a time; Enter and Backspace as keys there.
  var lastTap = null, typed = "", typeTimer = null;
  function flush(){ clearTimeout(typeTimer); typeTimer = null; if (!typed || !lastTap) { typed = ""; return; } send("INPUT", { x: lastTap.x, y: lastTap.y, value: typed, incremental: true, skip_tap: true, clear_first: false }); typed = ""; }
  function type(text){ if (!lastTap) return; typed += text; if (!typeTimer) typeTimer = setTimeout(flush, 25); }
  var NAMED = { Enter: "ENTER", Backspace: "BACKSPACE" };
  addEventListener("keydown", function(event){
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (NAMED[event.key]) { event.preventDefault(); if (!lastTap) return; flush(); send("KEY", { x: lastTap.x, y: lastTap.y, key: NAMED[event.key] }); return; }
    if (Array.from(event.key).length === 1) { event.preventDefault(); type(event.key); }
  });
  // Text that comes with no key (an input method, dictation, a paste of words) arrives as the input's value.
  keys.addEventListener("input", function(){ if (keys.value) { type(keys.value); keys.value = ""; } });
  addEventListener("paste", function(event){
    var text = event.clipboardData && event.clipboardData.getData("text/plain");
    if (text) { event.preventDefault(); type(text.slice(0, 2000)); }
  });
  document.getElementById("home").addEventListener("click", function(){ send("GO_HOME", {}); });
})();
</script></body></html>`;
