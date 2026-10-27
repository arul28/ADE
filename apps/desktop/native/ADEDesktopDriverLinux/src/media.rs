//! Live view and recording.
//!
//! Frames come from the lane's X server only when it reports damage, so a
//! still screen costs nothing; a one-a-second heartbeat keeps a viewer's
//! picture fresh. They are encoded to H.264 by the system's ffmpeg (libx264 on
//! Debian, Ubuntu and Arch; OpenH264 on Fedora), so ADE ships no codec of its
//! own. The stream reaches the brain as Annex-B access units in the same
//! 12-byte record framing the macOS and Windows drivers use.

use crate::procs::which;
use crate::protocol::{code, iso_now, log, now_ms, DResult, DriverError, Output};
use crate::xconn::{capture_bgrx, connect_raw, overlay_cursor_bgrx, ShmCapture};
use serde_json::{json, Map, Value};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{sync_channel, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::damage::{self, ConnectionExt as _};
use x11rb::protocol::xproto::ConnectionExt as _;
use x11rb::protocol::Event;

const RECORD_MAGIC: u32 = 0xade1_f00d;
const KIND_CONFIG: u8 = 1;
const KIND_UNIT: u8 = 2;
const HEARTBEAT_MS: u64 = 1000;
const IDLE_CUT_AFTER_MS: u64 = 1500;
/// A 2-vCPU box should not spend its cores encoding a picture nobody can
/// follow at 60 fps. Overridable for a fast machine.
fn max_fps() -> u32 {
    std::env::var("ADE_LINUX_DESKTOP_MAX_FPS").ok().and_then(|v| v.parse().ok()).unwrap_or(30).clamp(1, 60)
}

// ---------------------------------------------------------------------------
// Encoder discovery
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Codec {
    X264,
    OpenH264,
}

pub struct FfmpegInfo {
    pub path: Option<std::path::PathBuf>,
    pub codec: Option<Codec>,
}

/// The system ffmpeg and its H.264 encoder. A found encoder is kept for the
/// driver's life; a missing one is looked for again (at most every few
/// seconds), so `ade screen setup` installing ffmpeg needs no driver restart.
pub fn ffmpeg() -> &'static FfmpegInfo {
    static FOUND: OnceLock<FfmpegInfo> = OnceLock::new();
    static MISSING: Mutex<Option<(Instant, &'static FfmpegInfo)>> = Mutex::new(None);
    if let Some(info) = FOUND.get() {
        return info;
    }
    let mut missing = MISSING.lock().unwrap();
    if let Some((at, info)) = *missing {
        if at.elapsed() < Duration::from_secs(5) {
            return info;
        }
    }
    let info = probe_ffmpeg();
    if info.codec.is_some() {
        return FOUND.get_or_init(|| info);
    }
    let leaked: &'static FfmpegInfo = Box::leak(Box::new(info));
    *missing = Some((Instant::now(), leaked));
    leaked
}

fn probe_ffmpeg() -> FfmpegInfo {
    {
        let Some(path) = which("ffmpeg") else { return FfmpegInfo { path: None, codec: None } };
        let out = Command::new(&path).args(["-hide_banner", "-encoders"]).stderr(Stdio::null()).output();
        let text = out.map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default();
        let has = |name: &str| text.lines().any(|l| l.split_whitespace().nth(1) == Some(name));
        let codec = if has("libx264") {
            Some(Codec::X264)
        } else if has("libopenh264") {
            Some(Codec::OpenH264)
        } else {
            None
        };
        FfmpegInfo { path: Some(path), codec }
    }
}

fn require_ffmpeg() -> DResult<(&'static std::path::Path, Codec)> {
    let info = ffmpeg();
    let Some(path) = info.path.as_deref() else {
        return Err(DriverError::new(
            code::DISPLAY_UNAVAILABLE,
            "ffmpeg is not installed on this Linux machine, so the lane screen cannot stream or record. Run: ade screen setup",
        ));
    };
    let Some(codec) = info.codec else {
        return Err(DriverError::new(
            code::DISPLAY_UNAVAILABLE,
            "This machine's ffmpeg has no H.264 encoder (libx264 or libopenh264). Install a full ffmpeg build.",
        ));
    };
    Ok((path, codec))
}

pub fn ffmpeg_check() -> DResult<()> {
    require_ffmpeg().map(|_| ())
}

// ---------------------------------------------------------------------------
// The loopback byte server
// ---------------------------------------------------------------------------

fn record(kind: u8, key: bool, payload: &[u8]) -> Arc<Vec<u8>> {
    let mut out = Vec::with_capacity(12 + payload.len());
    out.extend_from_slice(&RECORD_MAGIC.to_be_bytes());
    out.push(kind);
    out.push(key as u8);
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Arc::new(out)
}

struct Client {
    tx: SyncSender<Arc<Vec<u8>>>,
    need_key: bool,
    alive: Arc<AtomicBool>,
}

pub struct StreamServer {
    pub port: u16,
    clients: Arc<Mutex<Vec<Client>>>,
    config: Arc<Mutex<Option<Arc<Vec<u8>>>>>,
    running: Arc<AtomicBool>,
    pub want_key: Arc<AtomicBool>,
    count: Arc<AtomicUsize>,
    /// The picture size the encoder was started at, for the config record.
    size: Mutex<(u32, u32)>,
}

impl StreamServer {
    pub fn start() -> DResult<StreamServer> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|e| DriverError::new(code::DISPLAY_UNAVAILABLE, format!("The stream could not open a loopback port: {e}")))?;
        let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
        let server = StreamServer {
            port,
            clients: Arc::new(Mutex::new(Vec::new())),
            config: Arc::new(Mutex::new(None)),
            running: Arc::new(AtomicBool::new(true)),
            want_key: Arc::new(AtomicBool::new(true)),
            count: Arc::new(AtomicUsize::new(0)),
            size: Mutex::new((0, 0)),
        };
        let (clients, config, running, want_key, count) =
            (server.clients.clone(), server.config.clone(), server.running.clone(), server.want_key.clone(), server.count.clone());
        listener.set_nonblocking(true).ok();
        std::thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_nodelay(true);
                        let mut list = clients.lock().unwrap();
                        list.retain(|c| c.alive.load(Ordering::SeqCst));
                        if list.len() >= 8 {
                            continue;
                        }
                        // Room for a few seconds of frames; a reader that
                        // falls further behind skips to the next keyframe.
                        let (tx, rx) = sync_channel::<Arc<Vec<u8>>>(90);
                        let alive = Arc::new(AtomicBool::new(true));
                        if let Some(cfg) = config.lock().unwrap().clone() {
                            let _ = tx.try_send(cfg);
                        }
                        let writer_alive = alive.clone();
                        let counter = count.clone();
                        std::thread::spawn(move || {
                            let mut stream: TcpStream = stream;
                            while let Ok(rec) = rx.recv() {
                                if stream.write_all(&rec).is_err() {
                                    break;
                                }
                            }
                            writer_alive.store(false, Ordering::SeqCst);
                            counter.fetch_sub(1, Ordering::SeqCst);
                        });
                        count.fetch_add(1, Ordering::SeqCst);
                        list.push(Client { tx, need_key: true, alive });
                        want_key.store(true, Ordering::SeqCst);
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(40)),
                }
            }
        });
        Ok(server)
    }

    pub fn readers(&self) -> usize {
        self.count.load(Ordering::SeqCst)
    }

    /// The config record every viewer parses (`iosSimVideoRecords.ts`): JSON
    /// with the WebCodecs codec string and the picture size, Annex-B units.
    pub fn set_config(&self, codec: &str) {
        let (width, height) = *self.size.lock().unwrap();
        let body = serde_json::json!({ "codec": codec, "width": width, "height": height, "annexB": true }).to_string();
        let rec = record(KIND_CONFIG, false, body.as_bytes());
        let mut cfg = self.config.lock().unwrap();
        if cfg.as_ref().map(|c| c.as_slice() == rec.as_slice()).unwrap_or(false) {
            return;
        }
        *cfg = Some(rec.clone());
        for c in self.clients.lock().unwrap().iter() {
            let _ = c.tx.try_send(rec.clone());
        }
    }

    pub fn broadcast(&self, key: bool, unit: &[u8]) {
        let rec = record(KIND_UNIT, key, unit);
        let mut list = self.clients.lock().unwrap();
        list.retain(|c| c.alive.load(Ordering::SeqCst));
        for c in list.iter_mut() {
            if c.need_key && !key {
                continue;
            }
            match c.tx.try_send(rec.clone()) {
                Ok(()) => c.need_key = false,
                Err(TrySendError::Full(_)) => {
                    // Never hand a decoder a frame whose reference it skipped.
                    c.need_key = true;
                    self.want_key.store(true, Ordering::SeqCst);
                }
                Err(TrySendError::Disconnected(_)) => c.alive.store(false, Ordering::SeqCst),
            }
        }
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.clients.lock().unwrap().clear();
    }
}

// ---------------------------------------------------------------------------
// ffmpeg processes
// ---------------------------------------------------------------------------

fn bitrate_kbps(w: u32, h: u32) -> u32 {
    ((w as u64 * h as u64 * 30 / 12_500) as u32).clamp(2000, 24_000)
}

/// A live H.264 encoder: raw frames in, access units out on a reader thread.
struct LiveEncoder {
    child: Child,
    stdin: ChildStdin,
}

impl LiveEncoder {
    fn start(w: u32, h: u32, fps: u32, server: Arc<StreamServer>, codec_out: Arc<Mutex<Option<String>>>) -> DResult<LiveEncoder> {
        let (path, codec) = require_ffmpeg()?;
        *server.size.lock().unwrap() = (w, h);
        let kbps = bitrate_kbps(w, h);
        let mut cmd = Command::new(path);
        cmd.args(["-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr0"])
            .args(["-s", &format!("{w}x{h}"), "-r", &fps.to_string(), "-i", "pipe:0", "-an"]);
        match codec {
            Codec::X264 => {
                cmd.args(["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-bf", "0", "-g", "600"])
                    .args(["-x264-params", "repeat-headers=1:aud=1:sliced-threads=0", "-threads", "2"]);
            }
            Codec::OpenH264 => {
                cmd.args(["-c:v", "libopenh264", "-g", "600", "-bsf:v", "h264_metadata=aud=insert"]);
            }
        }
        cmd.args(["-b:v", &format!("{kbps}k"), "-maxrate", &format!("{kbps}k"), "-bufsize", &format!("{}k", kbps / 2)])
            .args(["-pix_fmt", "yuv420p", "-flush_packets", "1", "-f", "h264", "pipe:1"]);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        let mut child = cmd.spawn().map_err(|e| DriverError::new(code::DISPLAY_UNAVAILABLE, format!("ffmpeg did not start: {e}")))?;
        let stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        unsafe {
            // A whole 1440p keyframe fits in one pipe write, so a packet
            // rarely arrives in pieces.
            libc::fcntl(stdout.as_raw_fd(), libc::F_SETPIPE_SZ, 1 << 20);
        }
        std::thread::spawn(move || read_units(&mut stdout, &server, &codec_out));
        Ok(LiveEncoder { child, stdin })
    }

    fn encode(&mut self, frame: &[u8]) -> bool {
        self.stdin.write_all(frame).is_ok()
    }
}

impl Drop for LiveEncoder {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn nal_type(nal: &[u8]) -> u8 {
    nal.first().map(|b| b & 0x1f).unwrap_or(0)
}

/// Splits an Annex-B byte stream into NAL payloads (without start codes).
/// Returns the NALs complete so far and how many bytes they consumed; the
/// tail after the last start code stays for the next read.
fn split_nals(buf: &[u8], final_flush: bool) -> (Vec<(usize, usize)>, usize) {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= buf.len() {
        if buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1 {
            starts.push((i, i + 3));
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut nals = Vec::new();
    for w in 0..starts.len() {
        let begin = starts[w].1;
        let end = if w + 1 < starts.len() {
            let mut e = starts[w + 1].0;
            if e > begin && buf[e - 1] == 0 {
                e -= 1;
            }
            e
        } else if final_flush {
            buf.len()
        } else {
            break;
        };
        nals.push((begin, end));
    }
    let consumed = if final_flush {
        buf.len()
    } else {
        starts.get(nals.len()).map(|s| if s.0 > 0 && buf[s.0 - 1] == 0 { s.0 - 1 } else { s.0 }).unwrap_or(0)
    };
    (nals, consumed)
}

fn codec_string(sps: &[u8]) -> Option<String> {
    if sps.len() < 4 {
        return None;
    }
    Some(format!("avc1.{:02x}{:02x}{:02x}", sps[1], sps[2], sps[3]))
}

/// Reads ffmpeg's byte stream and publishes one record per access unit.
/// An access unit ends at the next delimiter, or when the encoder goes quiet
/// with a picture in hand (the last frame before a still screen).
fn read_units(stdout: &mut std::process::ChildStdout, server: &StreamServer, codec_out: &Mutex<Option<String>>) {
    let fd = stdout.as_raw_fd();
    let mut buf: Vec<u8> = Vec::with_capacity(1 << 20);
    let mut unit: Vec<u8> = Vec::new();
    let mut unit_key = false;
    let mut unit_has_picture = false;
    let mut chunk = vec![0u8; 1 << 20];
    let emit = |unit: &mut Vec<u8>, key: &mut bool, pic: &mut bool| {
        if *pic {
            server.broadcast(*key, unit);
        }
        unit.clear();
        *key = false;
        *pic = false;
    };
    loop {
        let mut pfd = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
        let ready = unsafe { libc::poll(&mut pfd, 1, 12) };
        if ready == 0 {
            // Quiet: whatever is buffered is a complete picture.
            if !buf.is_empty() {
                let (nals, _) = split_nals(&buf, true);
                for (b, e) in nals {
                    push_nal(&buf[b..e], &mut unit, &mut unit_key, &mut unit_has_picture, server, codec_out, &emit);
                }
                buf.clear();
            }
            if unit_has_picture {
                emit(&mut unit, &mut unit_key, &mut unit_has_picture);
            }
            continue;
        }
        let n = match stdout.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        buf.extend_from_slice(&chunk[..n]);
        let (nals, consumed) = split_nals(&buf, false);
        for (b, e) in nals {
            let nal = buf[b..e].to_vec();
            push_nal(&nal, &mut unit, &mut unit_key, &mut unit_has_picture, server, codec_out, &emit);
        }
        buf.drain(..consumed);
    }
}

fn push_nal(
    nal: &[u8],
    unit: &mut Vec<u8>,
    key: &mut bool,
    pic: &mut bool,
    server: &StreamServer,
    codec_out: &Mutex<Option<String>>,
    emit: &dyn Fn(&mut Vec<u8>, &mut bool, &mut bool),
) {
    let t = nal_type(nal);
    if t == 9 {
        // Access-unit delimiter: the previous unit is complete. The
        // delimiter itself is not forwarded; decoders do not need it.
        emit(unit, key, pic);
        return;
    }
    if t == 7 {
        if let Some(c) = codec_string(nal) {
            let mut guard = codec_out.lock().unwrap();
            if guard.as_deref() != Some(c.as_str()) {
                *guard = Some(c.clone());
            }
            // Deduplicated by the record's bytes, so a size change with the
            // same profile still reaches the viewers.
            server.set_config(&c);
        }
    }
    if t == 5 {
        *key = true;
    }
    if t == 1 || t == 5 {
        *pic = true;
    }
    unit.extend_from_slice(&[0, 0, 0, 1]);
    unit.extend_from_slice(nal);
}

/// The MP4 recorder: raw frames in at a fixed rate, ffmpeg writes the file.
pub struct Recorder {
    child: Child,
    stdin: Option<ChildStdin>,
    pub path: String,
    pub fps: u32,
    pub frames: u64,
    pub started_ms: u64,
    pub idle_cut_ms: u64,
    pub keep_idle: bool,
    pub crop: Option<(i32, i32, u32, u32)>,
    pub last_change_ms: u64,
    pub error: Option<String>,
    /// Whether `media_loop` has already sent this error as
    /// `recording-interrupted`.
    reported: bool,
}

impl Recorder {
    pub fn start(path: &str, w: u32, h: u32, fps: u32, keep_idle: bool, crop: Option<(i32, i32, u32, u32)>) -> DResult<Recorder> {
        let (ff, codec) = require_ffmpeg()?;
        if let Some(dir) = std::path::Path::new(path).parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let (ow, oh) = crop.map(|c| (c.2, c.3)).unwrap_or((w, h));
        let mut cmd = Command::new(ff);
        cmd.args(["-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr0"])
            .args(["-s", &format!("{ow}x{oh}"), "-r", &fps.to_string(), "-i", "pipe:0", "-an"]);
        match codec {
            Codec::X264 => {
                let preset = std::env::var("ADE_LINUX_DESKTOP_RECORD_PRESET").unwrap_or_else(|_| "ultrafast".into());
                cmd.args(["-c:v", "libx264", "-preset", &preset, "-crf", "23", "-threads", "2"]);
            }
            Codec::OpenH264 => {
                cmd.args(["-c:v", "libopenh264", "-b:v", &format!("{}k", bitrate_kbps(ow, oh))]);
            }
        }
        cmd.args(["-pix_fmt", "yuv420p", "-movflags", "+faststart", "-f", "mp4", path]);
        cmd.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::inherit());
        let mut child = cmd.spawn().map_err(|e| DriverError::new(code::INTERNAL_ERROR, format!("ffmpeg did not start: {e}")))?;
        let stdin = child.stdin.take();
        Ok(Recorder {
            child,
            stdin,
            path: path.to_string(),
            fps,
            frames: 0,
            started_ms: now_ms(),
            idle_cut_ms: 0,
            keep_idle,
            crop,
            last_change_ms: now_ms(),
            error: None,
            reported: false,
        })
    }

    fn write(&mut self, frame: &[u8], w: u32) {
        let Some(stdin) = self.stdin.as_mut() else { return };
        let ok = match self.crop {
            None => stdin.write_all(frame).is_ok(),
            Some((cx, cy, cw, ch)) => {
                let mut ok = true;
                for row in 0..ch {
                    let y = cy.max(0) as u32 + row;
                    let start = ((y * w + cx.max(0) as u32) * 4) as usize;
                    let end = start + (cw * 4) as usize;
                    if end > frame.len() {
                        ok = stdin.write_all(&vec![0u8; (cw * 4) as usize]).is_ok();
                    } else {
                        ok = stdin.write_all(&frame[start..end]).is_ok();
                    }
                    if !ok {
                        break;
                    }
                }
                ok
            }
        };
        if ok {
            self.frames += 1;
        } else if self.error.is_none() {
            self.error = Some("ffmpeg stopped accepting frames".into());
        }
    }

    /// Closes the input and waits for ffmpeg to write the movie index.
    pub fn finish(mut self) -> DResult<Value> {
        drop(self.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(60);
        let status = loop {
            match self.child.try_wait() {
                Ok(Some(s)) => break Some(s),
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                _ => {
                    let _ = self.child.kill();
                    break None;
                }
            }
        };
        let wall = now_ms().saturating_sub(self.started_ms);
        let media = self.frames * 1000 / self.fps.max(1) as u64;
        if status.map(|s| !s.success()).unwrap_or(true) || self.frames == 0 {
            let _ = std::fs::remove_file(&self.path);
            return Err(DriverError::new(
                code::INTERNAL_ERROR,
                format!(
                    "The recording could not be finished ({}).",
                    self.error.clone().unwrap_or_else(|| if self.frames == 0 { "no frames".into() } else { "ffmpeg failed".into() })
                ),
            ));
        }
        Ok(json!({
            "filePath": self.path,
            "durationMs": media,
            "wallDurationMs": wall,
            "idleCutMs": self.idle_cut_ms,
            "frameCount": self.frames,
        }))
    }
}

// ---------------------------------------------------------------------------
// The per-lane media loop
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct MediaState {
    pub server: Option<Arc<StreamServer>>,
    pub stream_fps: u32,
    pub cursor_visible: bool,
    pub recorder: Option<Recorder>,
    pub codec: Arc<Mutex<Option<String>>>,
    pub running: bool,
}

pub struct MediaCtx {
    pub lane_id: String,
    pub display_num: u32,
    pub cookie: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub out: Arc<Output>,
}

pub fn ensure_loop(state: &Arc<Mutex<MediaState>>, ctx: MediaCtx) {
    {
        let mut s = state.lock().unwrap();
        if s.running {
            return;
        }
        s.running = true;
    }
    let state = state.clone();
    std::thread::spawn(move || {
        let result = media_loop(&state, &ctx);
        if let Err(e) = result {
            state.lock().unwrap().running = false;
            log(&format!("media loop for {} ended: {}", ctx.lane_id, e));
            let mut m = Map::new();
            m.insert("laneId".into(), json!(ctx.lane_id));
            m.insert("message".into(), json!(e.message));
            ctx.out.event("stream-error", m);
        }
    });
}

fn media_loop(state: &Arc<Mutex<MediaState>>, ctx: &MediaCtx) -> DResult<()> {
    let (conn, screen) = connect_raw(ctx.display_num, &ctx.cookie)?;
    let root = conn.setup().roots[screen].root;
    let (w, h) = (ctx.width, ctx.height);
    let _ = conn.damage_query_version(1, 1).map(|c| c.reply());
    let damage_id = conn.generate_id().map_err(crate::protocol::internal("damage id"))?;
    conn.damage_create(damage_id, root, damage::ReportLevel::NON_EMPTY)
        .map_err(crate::protocol::internal("damage"))?;
    conn.flush().ok();
    let shm = ShmCapture::new(&conn, w as u16, h as u16);
    if shm.is_none() {
        log(&format!("media {}: MIT-SHM unavailable, capturing over the socket", ctx.lane_id));
    }
    let mut encoder: Option<LiveEncoder> = None;
    let mut frame: Vec<u8> = Vec::new();
    let mut dirty = true;
    let mut last_pointer = (i16::MIN, i16::MIN);
    let mut last_stream_frame = 0u64;
    let mut stats_frames = 0u64;
    let mut stats_since = now_ms();
    let debug = std::env::var_os("ADE_LINUX_DESKTOP_DEBUG").is_some();
    let (mut t_capture, mut t_encode, mut t_record, mut n_capture, mut n_ticks) = (0u128, 0u128, 0u128, 0u64, 0u64);
    loop {
        let tick = Instant::now();
        // Drain damage: any drawing since the last tick makes the frame dirty.
        while let Ok(Some(event)) = conn.poll_for_event() {
            if let Event::DamageNotify(_) = event {
                dirty = true;
            }
        }
        if dirty {
            let _ = conn.damage_subtract(damage_id, x11rb::NONE, x11rb::NONE);
        }
        let (server, fps, cursor_visible, recording) = {
            let mut s = state.lock().unwrap();
            if s.server.is_none() && s.recorder.is_none() {
                // Decided under the lock, so a start that lands right now
                // sees the loop gone and starts a new one.
                s.running = false;
                break;
            }
            let fps = s.stream_fps.max(s.recorder.as_ref().map(|r| r.fps).unwrap_or(0)).clamp(1, max_fps());
            (s.server.clone(), fps, s.cursor_visible, s.recorder.is_some())
        };
        // The cursor is not in Xvfb's framebuffer: a moved pointer is a change.
        if cursor_visible {
            if let Ok(Ok(p)) = conn.query_pointer(root).map(|c| c.reply()) {
                if (p.root_x, p.root_y) != last_pointer {
                    last_pointer = (p.root_x, p.root_y);
                    dirty = true;
                }
            }
        }
        let readers = server.as_ref().map(|s| s.readers()).unwrap_or(0);
        let want_key = server.as_ref().map(|s| s.want_key.swap(false, Ordering::SeqCst)).unwrap_or(false);
        let now = now_ms();
        let stream_due = readers > 0 && (dirty || want_key || now - last_stream_frame >= HEARTBEAT_MS);
        let changed = dirty;
        n_ticks += 1;
        if (stream_due || recording) && (dirty || frame.is_empty()) {
            let t = Instant::now();
            match shm.as_ref() {
                Some(shm) => shm.capture(&conn, root, &mut frame)?,
                None => frame = capture_bgrx(&conn, root, w as u16, h as u16)?,
            }
            if cursor_visible {
                overlay_cursor_bgrx(&conn, &mut frame, w, h);
            }
            dirty = false;
            t_capture += t.elapsed().as_micros();
            n_capture += 1;
        }
        let t_enc_start = Instant::now();
        if let Some(server) = server.as_ref() {
            if readers == 0 {
                encoder = None;
            } else if stream_due {
                // A new reader, or one that fell behind, starts on a keyframe:
                // a fresh encoder's first picture is one.
                if want_key || encoder.is_none() {
                    let codec = state.lock().unwrap().codec.clone();
                    encoder = Some(LiveEncoder::start(w, h, fps, server.clone(), codec)?);
                }
                if let Some(enc) = encoder.as_mut() {
                    if !enc.encode(&frame) {
                        encoder = None;
                    } else {
                        stats_frames += 1;
                    }
                }
                last_stream_frame = now;
            }
        } else {
            encoder = None;
        }
        t_encode += t_enc_start.elapsed().as_micros();
        let t_rec_start = Instant::now();
        let mut interrupted = None;
        if recording {
            let mut s = state.lock().unwrap();
            if let Some(rec) = s.recorder.as_mut() {
                // A recorder whose ffmpeg is gone is not fed again: its error
                // stays for `record.stop`, and the event goes out once.
                if rec.error.is_none() {
                    if changed {
                        rec.last_change_ms = now;
                    }
                    let idle = !rec.keep_idle && now - rec.last_change_ms > IDLE_CUT_AFTER_MS;
                    if idle {
                        rec.idle_cut_ms += 1000 / fps as u64;
                    } else {
                        rec.write(&frame, w);
                    }
                }
                if rec.error.is_some() && !rec.reported {
                    rec.reported = true;
                    interrupted = rec.error.clone();
                }
            }
        }
        if let Some(message) = interrupted {
            let mut m = Map::new();
            m.insert("laneId".into(), json!(ctx.lane_id));
            m.insert("error".into(), json!(message));
            ctx.out.event("recording-interrupted", m);
        }
        t_record += t_rec_start.elapsed().as_micros();
        if debug && now - stats_since >= 5_000 {
            log(&format!(
                "media {}: ticks {} captures {} (avg {} ms) encode-write avg {} ms record-write avg {} ms streamed {}",
                ctx.lane_id, n_ticks, n_capture, t_capture / 1000 / n_capture.max(1) as u128,
                t_encode / 1000 / n_ticks.max(1) as u128, t_record / 1000 / n_ticks.max(1) as u128, stats_frames
            ));
            (t_capture, t_encode, t_record, n_capture, n_ticks, stats_frames) = (0, 0, 0, 0, 0, 0);
            stats_since = now;
        }
        if !debug && now - stats_since >= 30_000 && stats_frames > 0 {
            log(&format!("stream {}: {} frames in 30s at {}", ctx.lane_id, stats_frames, iso_now()));
            stats_frames = 0;
            stats_since = now;
        }
        let budget = Duration::from_millis(1000 / fps as u64);
        let spent = tick.elapsed();
        if spent < budget {
            std::thread::sleep(budget - spent);
        }
    }
    if let Some(shm) = shm.as_ref() {
        shm.release(&conn);
    }
    let _ = conn.damage_destroy(damage_id);
    let _ = conn.flush();
    Ok(())
}
