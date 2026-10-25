//! One lane's screen: its X server, bus, window manager, apps and media.

use crate::atspi::{A11y, Element, Walk};
use crate::draw::{write_png, Canvas, PALETTE};
use crate::launch;
use crate::media::{self, MediaCtx, MediaState, Recorder, StreamServer};
use crate::procs::{self, first_existing, which, Spawned};
use crate::protocol::{code, internal, iso_now, now_ms, DResult, DriverError, Output, Req};
use crate::xconn::{WinInfo, XConn};
use crate::fail;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const OBSERVATION_RETENTION: usize = 8;
const WALK_BUDGET: Duration = Duration::from_millis(2500);
const WALK_NODE_CAP: usize = 12_000;

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

pub fn runtime_root() -> PathBuf {
    let uid = unsafe { libc::getuid() };
    match std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).filter(|p| p.is_dir()) {
        Some(dir) => dir.join("ade-ld"),
        None => PathBuf::from(format!("/tmp/ade-ld-{uid}")),
    }
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
    /// own worker thread, which outlives every child it starts here.
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
        let runtime_dir = runtime_root().join(display_num.to_string());
        let _ = std::fs::remove_dir_all(&runtime_dir);
        std::fs::create_dir_all(&runtime_dir).map_err(internal("runtime directory"))?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(runtime_root(), std::fs::Permissions::from_mode(0o700));
        }

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
            runtime_dir,
            xauth,
            dbus_addr,
            a11y,
            a11y_error,
            has_wm,
            infra: Mutex::new(infra),
            apps: Mutex::new(Vec::new()),
            x: Mutex::new(x),
            observations: Mutex::new(VecDeque::new()),
            media: Arc::new(Mutex::new(MediaState { cursor_visible: true, ..Default::default() })),
            last_activity: AtomicU64::new(now_ms()),
            stopping: AtomicBool::new(false),
            lease: Mutex::new(None),
            out,
        })
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

    pub fn window_json(&self, w: &WinInfo) -> Value {
        let app_name = if !w.class_name.is_empty() {
            w.class_name.clone()
        } else if let Some(n) = procs::process_name(w.pid) {
            n
        } else {
            "Window".into()
        };
        json!({
            "id": w.id,
            "pid": w.pid,
            "appName": app_name,
            "bundleId": if w.class_name.is_empty() { Value::Null } else { json!(w.class_name.to_ascii_lowercase()) },
            "title": if w.title.is_empty() { Value::Null } else { json!(w.title) },
            "frame": {"x": w.x, "y": w.y, "width": w.width, "height": w.height},
            "laneId": self.lane_id,
            "origin": "ade_launched",
            "onDisplayId": self.display_num,
            "minimized": w.minimized,
            "singleInstance": false,
            "iconPng": Value::Null,
        })
    }

    pub fn windows(&self) -> Vec<WinInfo> {
        self.x.lock().unwrap().list_windows()
    }

    pub fn windows_json(&self) -> Value {
        Value::Array(self.windows().iter().map(|w| self.window_json(w)).collect())
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
                exited = Some(status);
                if Instant::now() + Duration::from_secs(6) < deadline {
                    // Launchers (xdg-open, a shell wrapper) exit at once and
                    // leave the app running; keep watching for its window.
                }
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
        for s in infra.iter_mut().rev() {
            procs::stop_group(&mut s.child, s.pid, Duration::from_millis(800));
        }
        infra.clear();
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
    // Observation
    // -----------------------------------------------------------------------

    fn walk(&self, budget: Duration) -> Walk {
        match self.a11y.as_ref() {
            Some(a11y) => a11y.walk(budget, WALK_NODE_CAP).unwrap_or_else(|e| Walk {
                elements: Vec::new(),
                truncated_reason: Some("stalled"),
                stalled_apps: vec![e.message],
            }),
            None => Walk {
                elements: Vec::new(),
                truncated_reason: Some("stalled"),
                stalled_apps: vec![format!(
                    "Accessibility is unavailable on this lane screen ({}); act by coordinates from the screenshot.",
                    self.a11y_error.clone().unwrap_or_else(|| "no accessibility bus".into())
                )],
            },
        }
    }

    fn element_window(windows: &[WinInfo], e: &Element) -> Option<u32> {
        let (cx, cy) = (e.x + e.width / 2, e.y + e.height / 2);
        windows
            .iter()
            .find(|w| w.contains(cx, cy) && (e.pid == 0 || w.pid == 0 || w.pid == e.pid))
            .or_else(|| windows.iter().find(|w| w.contains(cx, cy)))
            .map(|w| w.id)
    }

    fn element_json(index: usize, obs: &str, e: &Element, windows: &[WinInfo], parent: Option<usize>) -> Value {
        json!({
            "index": index,
            "handle": format!("obs-{obs}:e:{index}"),
            "role": e.role,
            "subrole": Value::Null,
            "title": if e.name.is_empty() { Value::Null } else { json!(e.name) },
            "label": Value::Null,
            "value": e.value,
            "identifier": Value::Null,
            "help": Value::Null,
            "enabled": e.enabled,
            "focused": e.focused,
            "actions": e.actions,
            "frame": {"x": e.x, "y": e.y, "width": e.width, "height": e.height},
            "center": {"x": e.x + e.width / 2, "y": e.y + e.height / 2},
            "windowId": Self::element_window(windows, e),
            "pid": e.pid,
            "parentIndex": parent,
        })
    }

    pub fn observe(&self, req: &Value) -> DResult<Value> {
        let limit = req.i64_field("limit").unwrap_or(200).clamp(1, 2000) as usize;
        let window_filter = req.i64_field("windowId").map(|w| w as u32);
        let windows = self.windows();
        if let Some(wid) = window_filter {
            if !windows.iter().any(|w| w.id == wid) {
                fail!(code::WINDOW_NOT_FOUND, "Window {wid} is not on this lane's screen.");
            }
        }
        let walk = self.walk(WALK_BUDGET);
        let mut all: Vec<Element> = walk.elements;
        if let Some(wid) = window_filter {
            all.retain(|e| Self::element_window(&windows, e) == Some(wid));
        }
        // Keep only elements on the screen; trim to the limit with the ones
        // an agent acts on first, in tree order.
        all.retain(|e| e.x + e.width > 0 && e.y + e.height > 0 && e.x < self.width as i32 && e.y < self.height as i32);
        let element_count = all.len();
        let mut keep: Vec<bool> = vec![false; all.len()];
        let mut kept = 0;
        for pass in [true, false] {
            for (i, e) in all.iter().enumerate() {
                if kept >= limit {
                    break;
                }
                if !keep[i] && e.interactive == pass {
                    keep[i] = true;
                    kept += 1;
                }
            }
        }
        let mut remap: Vec<Option<usize>> = vec![None; all.len()];
        let mut elements: Vec<Element> = Vec::new();
        for (i, e) in all.into_iter().enumerate() {
            if keep[i] {
                remap[i] = Some(elements.len());
                let mut e = e;
                e.parent = e.parent.and_then(|p| remap.get(p).copied().flatten());
                elements.push(e);
            }
        }
        let obs_id = hex(&random_bytes(5));
        let elements_json: Vec<Value> =
            elements.iter().enumerate().map(|(i, e)| Self::element_json(i, &obs_id, e, &windows, e.parent)).collect();
        let screenshot_path = req.str_field("screenshotPath");
        let map_path = if req.bool_field("map") {
            Some(req.str_field("mapPath").unwrap_or_else(|| {
                screenshot_path.clone().map(|p| p.replace(".png", ".map.png")).unwrap_or_else(|| self.dir.join("map.png").display().to_string())
            }))
        } else {
            None
        };
        let shot = screenshot_path.clone().unwrap_or_else(|| self.dir.join(format!("observe-{obs_id}.png")).display().to_string());
        let (w, h, mut rgb) = self.x.lock().unwrap().capture_rgb(false)?;
        write_png(Path::new(&shot), w, h, &rgb)?;
        if let Some(mp) = map_path.as_ref() {
            let mut canvas = Canvas { w: w as i32, h: h as i32, rgb: &mut rgb };
            for (i, e) in elements.iter().enumerate() {
                let c = PALETTE[i % PALETTE.len()];
                canvas.rect(e.x, e.y, e.width, e.height, c);
                canvas.label(e.x, (e.y - 14).max(0), i, c);
            }
            write_png(Path::new(mp), w, h, &rgb)?;
        }
        {
            let mut obs = self.observations.lock().unwrap();
            obs.push_back((obs_id.clone(), elements));
            while obs.len() > OBSERVATION_RETENTION {
                obs.pop_front();
            }
        }
        let truncated = walk.truncated_reason.is_some() || element_count > kept;
        let reason = walk.truncated_reason.or(if element_count > kept { Some("limit") } else { None });
        self.touch();
        Ok(json!({
            "id": obs_id,
            "laneId": self.lane_id,
            "capturedAt": iso_now(),
            "screenshotPath": shot,
            "mapPath": map_path,
            "display": {"width": self.width, "height": self.height, "scale": 1},
            "windows": windows.iter().map(|w| self.window_json(w)).collect::<Vec<_>>(),
            "elements": elements_json,
            "elementCount": element_count,
            "truncated": truncated,
            "truncatedReason": reason,
            "stalledApps": walk.stalled_apps,
            "caption": req.str_field("caption"),
            "platform": "linux",
        }))
    }

    fn resolve_handle(&self, handle: &str) -> DResult<(usize, Element)> {
        let rest = handle.strip_prefix("obs-").ok_or_else(|| DriverError::new(code::HANDLE_EXPIRED, "Not an element handle. Observe first."))?;
        let (obs_id, index) = rest
            .split_once(":e:")
            .ok_or_else(|| DriverError::new(code::HANDLE_EXPIRED, "Not an element handle. Observe first."))?;
        let index: usize = index.parse().map_err(|_| DriverError::new(code::HANDLE_EXPIRED, "Not an element handle."))?;
        let obs = self.observations.lock().unwrap();
        let Some((_, elements)) = obs.iter().find(|(id, _)| id == obs_id) else {
            fail!(code::HANDLE_EXPIRED, "That observation is too old. Observe again.");
        };
        let e = elements.get(index).cloned().ok_or_else(|| DriverError::new(code::HANDLE_EXPIRED, "No such element. Observe again."))?;
        Ok((index, e))
    }

    fn matches(e: &Element, needle: &str) -> bool {
        let n = needle.to_lowercase();
        e.name.to_lowercase().contains(&n) || e.value.as_ref().map(|v| v.to_lowercase().contains(&n)).unwrap_or(false)
    }

    /// The element a text names: an exact name first, interactive first.
    fn resolve_text(&self, text: &str) -> DResult<(Option<usize>, Element)> {
        let lower = text.to_lowercase();
        // The newest observation first: the index answered belongs to the
        // tree the service resolves against.
        if let Some((_, elements)) = self.observations.lock().unwrap().back() {
            let pick = elements
                .iter()
                .enumerate()
                .filter(|(_, e)| Self::matches(e, text))
                .min_by_key(|(_, e)| (e.name.to_lowercase() != lower, !e.interactive, e.width * e.height));
            if let Some((i, e)) = pick {
                return Ok((Some(i), e.clone()));
            }
        }
        let walk = self.walk(WALK_BUDGET);
        let pick = walk
            .elements
            .iter()
            .enumerate()
            .filter(|(_, e)| Self::matches(e, text))
            .min_by_key(|(_, e)| (e.name.to_lowercase() != lower, !e.interactive, e.width * e.height));
        match pick {
            Some((_, e)) => Ok((None, e.clone())),
            None => fail!(code::HANDLE_EXPIRED, "Nothing on this lane's screen matches \"{text}\". Observe to see what is there."),
        }
    }

    fn target(&self, payload: &Value, text_is_target: bool) -> DResult<Option<(Option<usize>, Element)>> {
        if let Some(handle) = payload.str_field("handle") {
            let (i, e) = self.resolve_handle(&handle)?;
            return Ok(Some((Some(i), e)));
        }
        if text_is_target {
            if let Some(text) = payload.str_field("text") {
                return self.resolve_text(&text).map(Some);
            }
        }
        if let Some(t) = payload.get("target").filter(|t| t.is_object()) {
            return self.target(t, true);
        }
        Ok(None)
    }

    fn point(payload: &Value, key: &str) -> Option<(f64, f64)> {
        let p = payload.get(key).filter(|p| p.is_object()).unwrap_or(payload);
        Some((p.f64_field("x")?, p.f64_field("y")?))
    }

    fn center(e: &Element) -> (f64, f64) {
        (e.x as f64 + e.width as f64 / 2.0, e.y as f64 + e.height as f64 / 2.0)
    }

    /// Brings the window under an element (or a named window) to the front,
    /// as a person's click would.
    fn raise_for(&self, x: f64, y: f64, pid: i32) {
        let windows = self.windows();
        let hit = windows
            .iter()
            .find(|w| w.contains(x as i32, y as i32) && (pid == 0 || w.pid == 0 || w.pid == pid))
            .map(|w| w.id);
        if let (Some(id), Some(top)) = (hit, windows.iter().find(|w| w.contains(x as i32, y as i32)).map(|w| w.id)) {
            if id != top {
                let _ = self.x.lock().unwrap().focus(id);
                std::thread::sleep(Duration::from_millis(120));
            }
        }
    }

    fn payload_window(&self, payload: &Value) -> DResult<Option<WinInfo>> {
        let Some(id) = payload.i64_field("windowId") else { return Ok(None) };
        match self.windows().into_iter().find(|w| w.id as i64 == id) {
            Some(w) => Ok(Some(w)),
            None => fail!(code::WINDOW_NOT_FOUND, "Window {id} is not on this lane's screen."),
        }
    }

    // -----------------------------------------------------------------------
    // Input
    // -----------------------------------------------------------------------

    pub fn input(&self, req: &Value) -> DResult<Value> {
        let command = req.req_str("command")?;
        let empty = json!({});
        let payload = req.get("payload").filter(|p| p.is_object()).unwrap_or(&empty);
        self.touch();
        let mut resolved: Option<usize> = None;
        match command.as_str() {
            "click" => {
                let target = self.target(payload, true)?;
                let button = payload.str_field("button").unwrap_or_else(|| "left".into());
                let count = payload.i64_field("count").unwrap_or(1).clamp(1, 3) as u32;
                let (x, y) = match target {
                    Some((i, e)) => {
                        resolved = i;
                        if e.width <= 0 || e.height <= 0 {
                            // Nothing on screen to point at: the element's own action.
                            if self.a11y.as_ref().map(|a| a.do_action(&e.node, 0)).unwrap_or(false) {
                                return Ok(json!({"resolvedIndex": resolved}));
                            }
                        }
                        let (x, y) = Self::center(&e);
                        self.raise_for(x, y, e.pid);
                        (x, y)
                    }
                    None => match Self::point(payload, "at") {
                        Some(p) => p,
                        None => fail!(code::INVALID_ARGUMENT, "click needs a handle, a text match, or x and y."),
                    },
                };
                self.x.lock().unwrap().click(x, y, &button, count)?;
            }
            "type" => {
                let canonical = payload.get("typeText").and_then(|v| v.as_str()).is_some();
                let text = payload
                    .get("typeText")
                    .and_then(|v| v.as_str())
                    .or_else(|| payload.get("text").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string();
                if let Some((i, e)) = self.target(payload, canonical)? {
                    resolved = i;
                    let (x, y) = Self::center(&e);
                    self.raise_for(x, y, e.pid);
                    let focused = self.a11y.as_ref().map(|a| a.grab_focus(&e.node)).unwrap_or(false);
                    if !focused && e.width > 0 && e.height > 0 {
                        self.x.lock().unwrap().click(x, y, "left", 1)?;
                    }
                } else if let Some(w) = self.payload_window(payload)? {
                    self.x.lock().unwrap().focus(w.id)?;
                    std::thread::sleep(Duration::from_millis(100));
                } else if self.windows().is_empty() {
                    fail!(code::NO_WINDOW, "Lane {} has a screen but no window to type into.", self.lane_id);
                }
                let mut x = self.x.lock().unwrap();
                if payload.bool_field("clear") {
                    x.press_named("a", &["control".to_string()])?;
                    x.press_named("backspace", &[])?;
                }
                x.type_text(&text)?;
            }
            "setValue" => {
                let Some((i, e)) = self.target(payload, true)? else {
                    fail!(code::INVALID_ARGUMENT, "setValue needs a handle or a text match.");
                };
                resolved = i;
                let value = payload.get("value").cloned().unwrap_or(Value::Null);
                let a11y = self.a11y.as_ref().ok_or_else(|| DriverError::new(code::INVALID_ARGUMENT, "Accessibility is unavailable on this lane screen."))?;
                let ok = match value.as_f64() {
                    Some(n) if !e.editable => a11y.set_number(&e.node, n),
                    _ => a11y.set_text(&e.node, &value.as_str().map(String::from).unwrap_or_else(|| value.to_string())),
                };
                if !ok {
                    fail!(code::INVALID_ARGUMENT, "{} refused a value.", e.role);
                }
            }
            "press" => {
                let key = payload.req_str("key")?;
                let modifiers: Vec<String> = payload
                    .get("modifiers")
                    .and_then(|m| m.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                if let Ok(Some((i, e))) = self.target(payload, true) {
                    resolved = i;
                    if !self.a11y.as_ref().map(|a| a.grab_focus(&e.node)).unwrap_or(false) && e.width > 0 {
                        let (x, y) = Self::center(&e);
                        self.x.lock().unwrap().click(x, y, "left", 1)?;
                    }
                } else if let Some(w) = self.payload_window(payload)? {
                    self.x.lock().unwrap().focus(w.id)?;
                    std::thread::sleep(Duration::from_millis(100));
                }
                if key.eq_ignore_ascii_case("win") && modifiers.is_empty() {
                    fail!(code::INVALID_ARGUMENT, "Name a key to press with the Super modifier.");
                }
                self.x.lock().unwrap().press_named(&key, &modifiers)?;
            }
            "scroll" => {
                let direction = payload.str_field("direction").unwrap_or_else(|| "down".into());
                let amount = payload.i64_field("amount").unwrap_or(3).clamp(1, 50) as u32;
                let (x, y) = if let Some((i, e)) = self.target(payload, true)? {
                    resolved = i;
                    Self::center(&e)
                } else if let Some(p) = Self::point(payload, "at") {
                    p
                } else if let Some(w) = self.payload_window(payload)? {
                    self.x.lock().unwrap().focus(w.id)?;
                    ((w.x + w.width / 2) as f64, (w.y + w.height / 2) as f64)
                } else {
                    match self.windows().into_iter().find(|w| !w.minimized) {
                        Some(w) => ((w.x + w.width / 2) as f64, (w.y + w.height / 2) as f64),
                        None => fail!(code::NO_WINDOW, "Lane {} has a screen but no window to scroll.", self.lane_id),
                    }
                };
                self.x.lock().unwrap().scroll(x, y, &direction, amount)?;
            }
            "drag" => {
                let end = |key: &str| -> DResult<(f64, f64)> {
                    let part = payload.get(key).cloned().unwrap_or(Value::Null);
                    if let Some(p) = Self::point(&part, "") {
                        return Ok(p);
                    }
                    match self.target(&part, true)? {
                        Some((_, e)) => Ok(Self::center(&e)),
                        None => Err(DriverError::new(code::INVALID_ARGUMENT, format!("drag needs a \"{key}\" point or element."))),
                    }
                };
                let (from, to) = (end("from")?, end("to")?);
                let duration = payload.i64_field("durationMs").unwrap_or(500).clamp(0, 10_000) as u64;
                self.x.lock().unwrap().drag(from, to, duration)?;
            }
            "move" => {
                let Some((x, y)) = Self::point(payload, "to") else { fail!(code::INVALID_ARGUMENT, "move needs a point.") };
                self.x.lock().unwrap().move_to(x, y)?;
            }
            "mouseDown" | "mouseUp" => {
                if let Some((x, y)) = Self::point(payload, "at") {
                    self.x.lock().unwrap().move_to(x, y)?;
                }
                let button = payload.str_field("button").unwrap_or_else(|| "left".into());
                self.x.lock().unwrap().button(&button, command == "mouseDown")?;
            }
            "releaseCursor" => {}
            "releaseInput" => {
                self.x.lock().unwrap().release_all()?;
            }
            "wait" => return self.wait(payload),
            other => fail!(code::INVALID_ARGUMENT, "\"{other}\" is not an input command this driver knows."),
        }
        self.touch();
        Ok(json!({"resolvedIndex": resolved}))
    }

    pub fn wait(&self, payload: &Value) -> DResult<Value> {
        let text = payload.str_field("text");
        let gone = payload.str_field("gone");
        let title = payload.str_field("windowTitle").map(|t| t.to_lowercase());
        if text.is_none() && gone.is_none() && title.is_none() {
            fail!(code::INVALID_ARGUMENT, "wait needs one of \"text\", \"gone\", or \"windowTitle\".");
        }
        let timeout = payload.i64_field("timeoutMs").unwrap_or(10_000).clamp(250, 120_000) as u64;
        let deadline = Instant::now() + Duration::from_millis(timeout);
        let mut last_reason: Option<&'static str> = None;
        let mut stalled: Vec<String> = Vec::new();
        loop {
            if self.stopping.load(Ordering::SeqCst) {
                fail!(code::LANE_STOPPING, "The lane screen stopped while waiting.");
            }
            let met = if let Some(t) = title.as_ref() {
                self.windows().iter().any(|w| w.title.to_lowercase().contains(t))
            } else {
                let needle = text.clone().or(gone.clone()).unwrap();
                let walk = self.walk(Duration::from_millis(1500));
                last_reason = walk.truncated_reason;
                stalled = walk.stalled_apps.clone();
                let found = walk.elements.iter().any(|e| Self::matches(e, &needle));
                if text.is_some() { found } else { !found }
            };
            if met {
                return Ok(json!({"ok": true, "resolvedIndex": Value::Null, "truncatedReason": last_reason, "stalledApps": stalled}));
            }
            if Instant::now() >= deadline {
                return Ok(json!({"ok": false, "resolvedIndex": Value::Null, "truncatedReason": last_reason, "stalledApps": stalled}));
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }

    // -----------------------------------------------------------------------
    // Windows, screenshots
    // -----------------------------------------------------------------------

    pub fn window_action(&self, req: &Value, action: &str) -> DResult<Value> {
        let id = req.i64_field("windowId").ok_or_else(|| DriverError::new(code::INVALID_ARGUMENT, "\"windowId\" is required."))? as u32;
        if !self.windows().iter().any(|w| w.id == id) {
            fail!(code::WINDOW_NOT_FOUND, "Window {id} is not on this lane's screen.");
        }
        let mut closed = Value::Null;
        {
            let x = self.x.lock().unwrap();
            match action {
                "focus" => x.focus(id)?,
                "minimize" => x.minimize(id)?,
                _ => x.close(id)?,
            }
        }
        if action == "close" {
            let deadline = Instant::now() + Duration::from_millis(1500);
            let mut gone = false;
            while Instant::now() < deadline {
                if !self.windows().iter().any(|w| w.id == id) {
                    gone = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(60));
            }
            closed = json!(gone);
        } else {
            std::thread::sleep(Duration::from_millis(120));
        }
        self.touch();
        Ok(json!({"windowId": id, "closed": closed, "windows": self.windows_json()}))
    }

    pub fn screenshot(&self, req: &Value) -> DResult<Value> {
        let path = req.req_str("path")?;
        let (w, h, rgb) = self.x.lock().unwrap().capture_rgb(false)?;
        let (w, h, rgb) = match req.i64_field("windowId") {
            Some(id) => {
                let Some(win) = self.windows().into_iter().find(|x| x.id as i64 == id) else {
                    fail!(code::WINDOW_NOT_FOUND, "Window {id} is not on this lane's screen.");
                };
                crop_rgb(&rgb, w, h, win.x, win.y, win.width, win.height)
            }
            None => (w, h, rgb),
        };
        let bytes = write_png(Path::new(&path), w, h, &rgb)?;
        self.touch();
        Ok(json!({"laneId": self.lane_id, "filePath": path, "width": w, "height": h, "capturedAt": iso_now(), "bytes": bytes}))
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

    pub fn windows_signature(&self) -> (String, Value) {
        let windows = self.windows();
        let sig: String = windows.iter().map(|w| format!("{}:{}:{};", w.id, w.title, w.minimized)).collect();
        (sig, Value::Array(windows.iter().map(|w| self.window_json(w)).collect()))
    }
}

fn crop_rgb(rgb: &[u8], w: u32, h: u32, x: i32, y: i32, cw: i32, ch: i32) -> (u32, u32, Vec<u8>) {
    let x0 = x.clamp(0, w as i32) as u32;
    let y0 = y.clamp(0, h as i32) as u32;
    let x1 = (x + cw).clamp(0, w as i32) as u32;
    let y1 = (y + ch).clamp(0, h as i32) as u32;
    let (ow, oh) = ((x1 - x0).max(1), (y1 - y0).max(1));
    let mut out = Vec::with_capacity((ow * oh * 3) as usize);
    for row in y0..y0 + oh {
        let start = ((row * w + x0) * 3) as usize;
        let end = (start + (ow * 3) as usize).min(rgb.len());
        out.extend_from_slice(&rgb[start.min(end)..end]);
    }
    out.resize((ow * oh * 3) as usize, 0);
    (ow, oh, out)
}

