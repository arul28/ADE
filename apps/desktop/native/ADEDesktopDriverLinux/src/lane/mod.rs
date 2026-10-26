//! One lane's screen: its X server, bus, window manager, apps and media.
//!
//! The rest of the lane's surface lives beside this file, each as a further
//! `impl Lane`: `windows` (the window list and the window verbs), `input`
//! (clicks, keys, `wait`) and `observe` (the element map).

mod input;
mod observe;
mod windows;

use crate::atspi::{A11y, Element};
use crate::fail;
use crate::launch;
use crate::media::{self, MediaCtx, MediaState, Recorder, StreamServer};
use crate::procs::{self, first_existing, which, Spawned};
use crate::protocol::{code, internal, iso_now, now_ms, DResult, DriverError, Output, Req};
use crate::xconn::{WinInfo, XConn};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct App {
    pub pid: i32,
    pub child: std::process::Child,
    pub app_name: String,
    pub bundle_id: String,
}

pub struct Lane {
    pub lane_id: String,
    pub name: String,
    pub created_at: String,
    pub width: u32,
    pub height: u32,
    pub display_num: u32,
    pub cookie: Vec<u8>,
    pub dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub xauth: PathBuf,
    pub dbus_addr: Option<String>,
    pub a11y: Option<A11y>,
    pub a11y_error: Option<String>,
    pub has_wm: bool,
    infra: Mutex<Vec<Spawned>>,
    pub apps: Mutex<Vec<App>>,
    pub x: Mutex<XConn>,
    observations: Mutex<VecDeque<(String, Vec<Element>)>>,
    pub media: Arc<Mutex<MediaState>>,
    last_activity: AtomicU64,
    pub stopping: AtomicBool,
    lease: Mutex<Option<(String, String)>>,
    out: Arc<Output>,
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut buf);
    }
    buf
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn safe_name(lane_id: &str) -> String {
    lane_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).take(80).collect()
}

/// An Xauthority file with one wildcard MIT-MAGIC-COOKIE-1 entry for `:num`.
fn write_xauth(path: &Path, num: u32, cookie: &[u8]) -> DResult<()> {
    let mut data = Vec::new();
    let field = |data: &mut Vec<u8>, bytes: &[u8]| {
        data.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
        data.extend_from_slice(bytes);
    };
    data.extend_from_slice(&0xffffu16.to_be_bytes());
    field(&mut data, b"");
    field(&mut data, num.to_string().as_bytes());
    field(&mut data, b"MIT-MAGIC-COOKIE-1");
    field(&mut data, cookie);
    std::fs::write(path, data).map_err(internal("xauthority"))?;
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    Ok(())
}

fn display_free(n: u32) -> bool {
    !Path::new(&format!("/tmp/.X{n}-lock")).exists() && !Path::new(&format!("/tmp/.X11-unix/X{n}")).exists()
}

fn runtime_root() -> PathBuf {
    let uid = unsafe { libc::getuid() };
    match std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_dir()) {
        Some(dir) => dir.join("ade-ld"),
        None => PathBuf::from(format!("/tmp/ade-ld-{uid}")),
    }
}

fn check_private_dir(path: &Path, uid: u32) -> DResult<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| DriverError::new(code::DISPLAY_UNAVAILABLE, format!("{} could not be read: {e}", path.display())))?;
    // `symlink_metadata` does not follow links, so a planted link to a
    // directory fails here along with a plain file.
    if !meta.file_type().is_dir() {
        fail!(
            code::DISPLAY_UNAVAILABLE,
            "{} is not a directory ADE may use for a lane screen (a link or a file is there instead). Remove it and try again.",
            path.display()
        );
    }
    if meta.uid() != uid {
        fail!(
            code::DISPLAY_UNAVAILABLE,
            "{} belongs to another user (uid {}), so ADE will not keep a lane's session bus there. Remove it, or set XDG_RUNTIME_DIR.",
            path.display(),
            meta.uid()
        );
    }
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    Ok(())
}

/// The root the lanes' runtime directories live under, after proving it is a
/// real directory this user owns. `/tmp` is world-writable: another local user
/// can create `/tmp/ade-ld-<uid>` (or a symlink there) before the first lane
/// starts, and the lane's bus socket would then live in a directory they own.
/// `$XDG_RUNTIME_DIR` is already the user's own directory; only the `ade-ld`
/// child is created and checked there.
fn ensure_private_dir(path: &Path) -> DResult<()> {
    use std::os::unix::fs::DirBuilderExt;
    let uid = unsafe { libc::getuid() };
    match std::fs::symlink_metadata(path) {
        Ok(_) => check_private_dir(path, uid),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = std::fs::DirBuilder::new();
            builder.mode(0o700);
            match builder.create(path) {
                Ok(()) => check_private_dir(path, uid),
                // Another lane created it a moment ago.
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => check_private_dir(path, uid),
                Err(e) => Err(DriverError::new(
                    code::DISPLAY_UNAVAILABLE,
                    format!("{} could not be created: {e}", path.display()),
                )),
            }
        }
        Err(e) => Err(DriverError::new(
            code::DISPLAY_UNAVAILABLE,
            format!("{} could not be read: {e}", path.display()),
        )),
    }
}

fn ensure_runtime_root() -> DResult<PathBuf> {
    let root = runtime_root();
    ensure_private_dir(&root)?;
    Ok(root)
}

/// Stops every child a lane started, newest first, the way `destroy` does.
fn stop_infra(infra: &mut Vec<Spawned>) {
    for s in infra.iter_mut().rev() {
        procs::stop_group(&mut s.child, s.pid, Duration::from_millis(800));
    }
    infra.clear();
}

pub fn xvfb_path() -> Option<PathBuf> {
    which("Xvfb")
}

pub fn wm_path() -> Option<PathBuf> {
    which("openbox")
}

pub fn dbus_path() -> Option<PathBuf> {
    which("dbus-daemon")
}

pub fn atspi_launcher() -> Option<PathBuf> {
    first_existing(&[
        "/usr/libexec/at-spi-bus-launcher",
        "/usr/lib/at-spi2-core/at-spi-bus-launcher",
        "/usr/lib/at-spi2/at-spi-bus-launcher",
        "/usr/lib/x86_64-linux-gnu/at-spi2-core/at-spi-bus-launcher",
        "/usr/lib/aarch64-linux-gnu/at-spi2-core/at-spi-bus-launcher",
        "/usr/lib64/at-spi2-core/at-spi-bus-launcher",
        "/usr/libexec/at-spi2/at-spi-bus-launcher",
    ])
}

impl Lane {
    /// Starts the lane's X server, bus and window manager. Runs on the lane's
    /// own worker thread, which lives as long as the lane.
    pub fn create(ade_home: &Path, lane_id: &str, name: &str, width: u32, height: u32, out: Arc<Output>) -> DResult<Lane> {
        let Some(xvfb) = xvfb_path() else {
            fail!(
                code::DISPLAY_UNAVAILABLE,
                "Xvfb is not installed on this Linux machine, so ADE cannot start a lane screen. Run: ade screen setup"
            );
        };
        // Even sizes: the H.264 encoder works in 2x2 blocks.
        let width = (width.clamp(640, 3840)) & !1;
        let height = (height.clamp(480, 2160)) & !1;
        let dir = ade_home.join("linux-desktop").join("lanes").join(safe_name(lane_id));
        std::fs::create_dir_all(&dir).map_err(internal("lane directory"))?;
        // Fail here, before any child runs, when the runtime root is not a
        // directory this user owns: `/tmp` is world-writable.
        let runtime_root_dir = ensure_runtime_root()?;
        let cookie = random_bytes(16);
        let mut infra: Vec<Spawned> = Vec::new();
        let mut display_num = 0;
        let mut xauth = PathBuf::new();
        let mut last_error = String::from("no free display number");
        for n in 90..400u32 {
            if !display_free(n) {
                continue;
            }
            xauth = dir.join("Xauthority");
            write_xauth(&xauth, n, &cookie)?;
            let mut cmd = Command::new(&xvfb);
            cmd.arg(format!(":{n}"))
                .args(["-screen", "0", &format!("{width}x{height}x24")])
                .args(["-nolisten", "tcp", "-noreset", "-dpi", "96", "+extension", "RANDR"])
                .arg("-auth")
                .arg(&xauth);
            let mut spawned = match procs::spawn(cmd, libc::SIGKILL, Some(&dir.join("xvfb.log"))) {
                Ok(s) => s,
                Err(e) => fail!(code::DISPLAY_UNAVAILABLE, "Xvfb did not start: {e}"),
            };
            let deadline = Instant::now() + Duration::from_secs(8);
            let mut up = false;
            while Instant::now() < deadline {
                if procs::reaped(&mut spawned.child) {
                    break;
                }
                if Path::new(&format!("/tmp/.X11-unix/X{n}")).exists() && XConn::connect(n, &cookie).is_ok() {
                    up = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            if up {
                display_num = n;
                infra.push(spawned);
                break;
            }
            last_error = std::fs::read_to_string(dir.join("xvfb.log")).unwrap_or_default().lines().last().unwrap_or("").to_string();
            procs::stop_group(&mut spawned.child, spawned.pid, Duration::from_millis(200));
        }
        if display_num == 0 {
            fail!(code::DISPLAY_UNAVAILABLE, "The lane's X server did not come up: {last_error}");
        }
        let display = format!(":{display_num}");
        let runtime_dir = runtime_root_dir.join(display_num.to_string());

        // Everything below runs in one place: a failure past this point has
        // children running that no other code can find (the lane never reaches
        // the driver's map), so it stops them instead of leaking a display.
        let start_lane = |infra: &mut Vec<Spawned>| -> DResult<Lane> {
            let _ = std::fs::remove_dir_all(&runtime_dir);
            std::fs::create_dir_all(&runtime_dir).map_err(internal("runtime directory"))?;

            // The lane's own session bus: its accessibility bus, and anything an
            // app looks up on "the session", stays inside the lane.
            let mut dbus_addr = None;
            let mut a11y_error = None;
            if let Some(dbus) = dbus_path() {
                let sock = runtime_dir.join("bus");
                let addr = format!("unix:path={}", sock.display());
                let mut cmd = Command::new(dbus);
                cmd.args(["--session", "--nofork", "--nopidfile"])
                    .arg(format!("--address={addr}"))
                    .env("DISPLAY", &display)
                    .env("XAUTHORITY", &xauth)
                    .env_remove("WAYLAND_DISPLAY")
                    .env("DBUS_SESSION_BUS_ADDRESS", &addr);
                match procs::spawn(cmd, libc::SIGKILL, Some(&dir.join("dbus.log"))) {
                    Ok(s) => {
                        infra.push(s);
                        let deadline = Instant::now() + Duration::from_secs(5);
                        while Instant::now() < deadline && !sock.exists() {
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        if sock.exists() {
                            dbus_addr = Some(addr);
                        } else {
                            a11y_error = Some("the lane's D-Bus session did not start".to_string());
                        }
                    }
                    Err(e) => a11y_error = Some(format!("dbus-daemon did not start: {e}")),
                }
            } else {
                a11y_error = Some("dbus-daemon is not installed".to_string());
            }
            let a11y = match dbus_addr.as_ref() {
                Some(addr) if atspi_launcher().is_some() => match A11y::bus_address(addr) {
                    Ok(_) => Some(A11y::new(addr.clone())),
                    Err(e) => {
                        a11y_error = Some(e.message);
                        None
                    }
                },
                Some(_) => {
                    a11y_error = Some("at-spi2-core is not installed".to_string());
                    None
                }
                None => None,
            };

            let mut has_wm = false;
            if let Some(wm) = wm_path() {
                let mut cmd = Command::new(wm);
                cmd.arg("--sm-disable").env("DISPLAY", &display).env("XAUTHORITY", &xauth).env_remove("WAYLAND_DISPLAY");
                if let Some(addr) = dbus_addr.as_ref() {
                    cmd.env("DBUS_SESSION_BUS_ADDRESS", addr);
                }
                if let Ok(s) = procs::spawn(cmd, libc::SIGKILL, Some(&dir.join("wm.log"))) {
                    infra.push(s);
                    has_wm = true;
                }
            }
            let x = XConn::connect(display_num, &cookie)?;
            x.set_background(0x1f2228);
            if has_wm {
                // Wait (briefly) for the manager to claim the screen, so the first
                // window an agent opens is decorated and listed.
                let deadline = Instant::now() + Duration::from_secs(3);
                while Instant::now() < deadline && !x.has_window_manager() {
                    std::thread::sleep(Duration::from_millis(30));
                }
            }
            Ok(Lane {
                lane_id: lane_id.to_string(),
                name: name.to_string(),
                created_at: iso_now(),
                width,
                height,
                display_num,
                cookie,
                dir,
                runtime_dir: runtime_dir.clone(),
                xauth: xauth.clone(),
                dbus_addr,
                a11y,
                a11y_error,
                has_wm,
                infra: Mutex::new(std::mem::take(infra)),
                apps: Mutex::new(Vec::new()),
                x: Mutex::new(x),
                observations: Mutex::new(VecDeque::new()),
                media: Arc::new(Mutex::new(MediaState { cursor_visible: true, ..Default::default() })),
                last_activity: AtomicU64::new(now_ms()),
                stopping: AtomicBool::new(false),
                lease: Mutex::new(None),
                out,
            })
        };
        match start_lane(&mut infra) {
            Ok(lane) => Ok(lane),
            Err(e) => {
                stop_infra(&mut infra);
                let _ = std::fs::remove_dir_all(&runtime_dir);
                let _ = std::fs::remove_file(&xauth);
                Err(e)
            }
        }
    }

    pub fn touch(&self) {
        self.last_activity.store(now_ms(), Ordering::SeqCst);
    }

    pub fn display_json(&self) -> Value {
        let windows = self.x.lock().unwrap().list_windows().len();
        json!({
            "laneId": self.lane_id,
            "displayId": self.display_num,
            "name": self.name,
            "mode": "virtual",
            "width": self.width,
            "height": self.height,
            "scale": 1,
            "origin": {"x": 0, "y": 0},
            "createdAt": self.created_at,
            "windowCount": windows,
            "lastActivityAt": crate::protocol::iso_from_ms(self.last_activity.load(Ordering::SeqCst)),
            "linux": {
                "display": format!(":{}", self.display_num),
                "windowManager": self.has_wm,
                "accessibility": self.a11y.is_some(),
                "accessibilityError": self.a11y_error,
            },
        })
    }

    fn app_env(&self, cmd: &mut Command) {
        cmd.env("DISPLAY", format!(":{}", self.display_num))
            .env("XAUTHORITY", &self.xauth)
            .env_remove("WAYLAND_DISPLAY")
            .env_remove("DESKTOP_STARTUP_ID");
        match self.dbus_addr.as_ref() {
            Some(addr) => {
                cmd.env("DBUS_SESSION_BUS_ADDRESS", addr);
            }
            None => {
                cmd.env_remove("DBUS_SESSION_BUS_ADDRESS");
            }
        }
        if let Some(a11y) = self.dbus_addr.as_ref().and_then(|addr| A11y::bus_address(addr).ok()) {
            cmd.env("AT_SPI_BUS_ADDRESS", a11y);
        }
    }

    // -----------------------------------------------------------------------
    // Apps
    // -----------------------------------------------------------------------

    pub fn launch(&self, req: &Value) -> DResult<Value> {
        let target = req.req_str("target")?;
        let extra: Vec<String> = req
            .get("args")
            .and_then(|a| a.as_array())
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let plan = launch::plan(&target, &extra, &self.dir, self.width as u16, self.height as u16)?;
        let before: Vec<u32> = self.windows().iter().map(|w| w.id).collect();
        let mut cmd = Command::new(&plan.program);
        cmd.args(&plan.args);
        self.app_env(&mut cmd);
        for (k, v) in &plan.env {
            cmd.env(k, v);
        }
        if let Some(home) = std::env::var_os("HOME") {
            cmd.current_dir(home);
        }
        let log_path = self.dir.join("apps.log");
        let spawned = procs::spawn(cmd, libc::SIGTERM, Some(&log_path))
            .map_err(|e| DriverError::new(code::INVALID_ARGUMENT, format!("{} did not start: {e}", plan.program.display())))?;
        let pid = spawned.pid;
        let mut child = spawned.child;
        // Watch (bounded) for the app's first window.
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut fresh: Vec<WinInfo> = Vec::new();
        let mut exited = None;
        while Instant::now() < deadline {
            fresh = self.windows().into_iter().filter(|w| !before.contains(&w.id)).collect();
            if !fresh.is_empty() {
                // A moment more for the rest of the app's first windows.
                std::thread::sleep(Duration::from_millis(250));
                fresh = self.windows().into_iter().filter(|w| !before.contains(&w.id)).collect();
                break;
            }
            if let Ok(Some(status)) = child.try_wait() {
                // Launchers (xdg-open, a shell wrapper) exit at once and
                // leave the app running; keep watching for its window.
                exited = Some(status);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if fresh.is_empty() {
            if let Some(status) = exited {
                if !status.success() {
                    let tail = std::fs::read_to_string(&log_path).unwrap_or_default();
                    let last: Vec<&str> = tail.lines().rev().take(3).collect();
                    fail!(
                        code::INVALID_ARGUMENT,
                        "{} exited ({}) without opening a window. {}",
                        plan.app_name,
                        status,
                        last.into_iter().rev().collect::<Vec<_>>().join(" ")
                    );
                }
            }
        }
        self.apps.lock().unwrap().push(App {
            pid,
            child,
            app_name: plan.app_name.clone(),
            bundle_id: plan.bundle_id.clone(),
        });
        self.touch();
        Ok(json!({
            "laneId": self.lane_id,
            "pid": pid,
            "appName": plan.app_name,
            "bundleId": plan.bundle_id,
            "windows": fresh.iter().map(|w| self.window_json(w)).collect::<Vec<_>>(),
            "watching": fresh.is_empty(),
            "handedOff": false,
            "message": if fresh.is_empty() { json!("The app started but has not opened a window yet. Run ade screen windows in a moment.") } else { Value::Null },
            "profileDir": plan.profile_dir.map(|p| p.display().to_string()),
            "resolvedPath": plan.program.display().to_string(),
        }))
    }

    /// Quits apps the lane opened: all, or those matching a name, id or pid.
    pub fn quit_apps(&self, which: Option<&str>) -> Vec<Value> {
        let mut apps = self.apps.lock().unwrap();
        let mut quit = Vec::new();
        let mut keep = Vec::new();
        for mut app in apps.drain(..) {
            let matches = match which {
                None => true,
                Some(w) => {
                    let w = w.to_ascii_lowercase();
                    app.pid.to_string() == w || app.app_name.to_ascii_lowercase() == w || app.bundle_id.to_ascii_lowercase() == w
                }
            };
            if !matches {
                keep.push(app);
                continue;
            }
            procs::stop_group(&mut app.child, app.pid, Duration::from_secs(3));
            quit.push(json!({"pid": app.pid, "appName": app.app_name, "bundleId": app.bundle_id, "released": false}));
        }
        *apps = keep;
        quit
    }

    // -----------------------------------------------------------------------
    // Teardown
    // -----------------------------------------------------------------------

    pub fn destroy(&self) -> Value {
        self.stopping.store(true, Ordering::SeqCst);
        self.stop_media();
        let quit = self.quit_apps(None);
        let mut infra = self.infra.lock().unwrap();
        // Window manager and bus first, then the X server: every client still
        // connected to the display (an app the lane did not start, say) goes
        // with it.
        stop_infra(&mut infra);
        let _ = std::fs::remove_dir_all(&self.runtime_dir);
        let _ = std::fs::remove_file(&self.xauth);
        json!({"destroyed": true, "releasedWindows": 0, "quitApps": quit, "appsLeftOpen": []})
    }

    fn stop_media(&self) {
        let recorder = {
            let mut m = self.media.lock().unwrap();
            if let Some(s) = m.server.take() {
                s.stop();
            }
            m.recorder.take()
        };
        if let Some(r) = recorder {
            let _ = r.finish();
        }
    }

    // -----------------------------------------------------------------------
    // Media
    // -----------------------------------------------------------------------

    fn media_ctx(&self) -> MediaCtx {
        MediaCtx {
            lane_id: self.lane_id.clone(),
            display_num: self.display_num,
            cookie: self.cookie.clone(),
            width: self.width,
            height: self.height,
            out: self.out.clone(),
        }
    }

    pub fn start_stream(&self, req: &Value) -> DResult<Value> {
        media::ffmpeg_check()?;
        let fps = req.i64_field("fps").unwrap_or(30).clamp(1, 60) as u32;
        let (port, codec) = {
            let mut m = self.media.lock().unwrap();
            if m.server.is_none() {
                m.server = Some(Arc::new(StreamServer::start()?));
            }
            m.stream_fps = fps;
            let server = m.server.as_ref().unwrap();
            server.want_key.store(true, Ordering::SeqCst);
            let port = server.port;
            let codec = m.codec.lock().unwrap().clone();
            (port, codec)
        };
        media::ensure_loop(&self.media, self.media_ctx());
        self.touch();
        Ok(json!({"laneId": self.lane_id, "port": port, "url": Value::Null, "token": Value::Null, "codec": codec, "width": self.width, "height": self.height, "fps": fps}))
    }

    pub fn set_stream_rate(&self, req: &Value) -> DResult<Value> {
        let fps = req.i64_field("fps").unwrap_or(30).clamp(1, 60) as u32;
        self.media.lock().unwrap().stream_fps = fps;
        Ok(json!({"fps": fps}))
    }

    pub fn set_cursor(&self, req: &Value) -> DResult<Value> {
        let visible = req.bool_field("visible");
        self.media.lock().unwrap().cursor_visible = visible;
        Ok(json!({"visible": visible}))
    }

    pub fn stop_stream(&self) -> DResult<Value> {
        let mut m = self.media.lock().unwrap();
        let stopped = m.server.is_some();
        if let Some(s) = m.server.take() {
            s.stop();
        }
        Ok(json!({"stopped": stopped}))
    }

    pub fn start_recording(&self, req: &Value) -> DResult<Value> {
        let path = req.req_str("filePath")?;
        let fps = req.i64_field("fps").unwrap_or(30).clamp(1, 60) as u32;
        let crop = match req.i64_field("windowId") {
            Some(id) => {
                let Some(w) = self.windows().into_iter().find(|x| x.id as i64 == id) else {
                    fail!(code::WINDOW_NOT_FOUND, "That window is not on this lane's screen.");
                };
                let x = w.x.clamp(0, self.width as i32 - 2);
                let y = w.y.clamp(0, self.height as i32 - 2);
                let cw = (w.width.min(self.width as i32 - x).max(2) as u32) & !1;
                let ch = (w.height.min(self.height as i32 - y).max(2) as u32) & !1;
                Some((x, y, cw, ch))
            }
            None => None,
        };
        {
            let m = self.media.lock().unwrap();
            if m.recorder.is_some() {
                fail!(code::INVALID_ARGUMENT, "Lane {} is already recording.", self.lane_id);
            }
        }
        let recorder = Recorder::start(&path, self.width, self.height, fps.min(30), req.bool_field("keepIdle"), crop)?;
        self.media.lock().unwrap().recorder = Some(recorder);
        media::ensure_loop(&self.media, self.media_ctx());
        self.touch();
        Ok(json!({"startedAt": iso_now()}))
    }

    pub fn stop_recording(&self) -> DResult<Value> {
        let recorder = self.media.lock().unwrap().recorder.take();
        match recorder {
            Some(r) => r.finish(),
            None => fail!(code::RECORDING_NOT_RUNNING, "Lane {} is not recording.", self.lane_id),
        }
    }

    pub fn set_lease(&self, req: &Value) -> DResult<Value> {
        let holder = req.req_str("holderId")?;
        let expires = req.get("expiresAt").cloned().unwrap_or(Value::Null);
        *self.lease.lock().unwrap() = Some((holder.clone(), expires.to_string()));
        Ok(json!({"laneId": self.lane_id, "holderId": holder, "expiresAt": expires}))
    }

    pub fn clear_lease(&self) -> DResult<Value> {
        *self.lease.lock().unwrap() = None;
        Ok(json!({"cleared": true}))
    }
}
