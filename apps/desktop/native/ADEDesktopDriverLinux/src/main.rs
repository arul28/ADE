//! `ade-desktop-driver` for Linux.
//!
//! The brain's child process. It owns one lane screen per lane: an Xvfb
//! display with its own window manager and D-Bus session, created on
//! `display.create` and gone on `display.destroy`. It speaks the same NDJSON
//! op table and error codes as the macOS and Windows drivers, so the service,
//! the CLI, the viewers and proof work unchanged.
//!
//! Requests for one lane run in order on that lane's own worker thread (a
//! viewer's pointer events must land in the order they were sent); `wait`,
//! `ping` and cross-lane ops run on their own threads so a long wait never
//! holds a lane's input.
//!
//! A lane's worker lives exactly as long as the lane: `display.create` starts
//! it, and the worker drops its own queue entry once its screen is gone, after
//! the destroy has run and the requests already queued are answered. It also
//! drops the entry when its own create failed and left no lane behind. Nothing
//! else removes or re-creates that entry, so a request cannot strand a worker
//! for a lane that no longer exists.

mod atspi;
mod draw;
mod keys;
mod lane;
mod launch;
mod media;
mod procs;
mod protocol;
mod xconn;

use lane::Lane;
use protocol::{code, log, DResult, DriverError, Output, Req};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const VERSION: &str = concat!("linux-", env!("CARGO_PKG_VERSION"));

/// Sent to a lane's worker after its screen is gone, to wake an idle worker so
/// it can drop its own queue entry and end. Never answered, never logged.
const LANE_GONE: &str = "__lane_gone";

/// One lane's request queue, and the gate its requests share with a teardown
/// that runs off the worker (`display.reconcile`, driver exit).
struct LaneQueue {
    tx: Sender<Value>,
    /// Held by the lane's worker while it answers one request, and by a
    /// teardown running on another thread: a request never runs while the
    /// lane's screen is being destroyed.
    gate: Arc<Mutex<()>>,
}

struct Driver {
    ade_home: PathBuf,
    out: Arc<Output>,
    lanes: Mutex<HashMap<String, Arc<Lane>>>,
    queues: Mutex<HashMap<String, LaneQueue>>,
    shutting_down: AtomicBool,
}

impl Driver {
    fn lane(&self, lane_id: &str) -> DResult<Arc<Lane>> {
        self.lanes.lock().unwrap().get(lane_id).cloned().ok_or_else(|| {
            DriverError::new(code::NO_DISPLAY, format!("Lane {lane_id} has no screen. Start it first: ade screen start"))
        })
    }

    fn lane_ids(&self) -> Vec<String> {
        self.lanes.lock().unwrap().keys().cloned().collect()
    }

    fn ping(&self) -> Value {
        let ff = media::ffmpeg();
        let mut missing: Vec<&str> = Vec::new();
        if lane::xvfb_path().is_none() {
            missing.push("xvfb");
        }
        if lane::wm_path().is_none() {
            missing.push("openbox");
        }
        if lane::dbus_path().is_none() {
            missing.push("dbus");
        }
        if lane::atspi_launcher().is_none() {
            missing.push("at-spi2-core");
        }
        match (ff.path.is_some(), ff.codec.is_some()) {
            (false, _) => missing.push("ffmpeg"),
            // An installed ffmpeg with no H.264 encoder is a different
            // problem with a different fix, so it carries its own requirement
            // name: installing the `ffmpeg` package again would not help.
            // Keep this equal to `LINUX_DESKTOP_ENCODER_REQUIREMENT` in
            // `apps/desktop/src/shared/types/macDesktop.ts`: the CLI and the
            // setup verb read that constant, and nothing but this build mints
            // the name on the wire.
            (true, false) => missing.push("ffmpeg-encoder"),
            (true, true) => {}
        }
        json!({
            "version": VERSION,
            "pid": std::process::id(),
            "displayMode": if lane::xvfb_path().is_some() { "virtual" } else { "unavailable" },
            "permissions": {"screenRecording": "granted", "accessibility": "granted"},
            "displays": self.lane_ids(),
            "linux": {
                "xvfb": lane::xvfb_path().map(|p| p.display().to_string()),
                "windowManager": lane::wm_path().map(|p| p.display().to_string()),
                "dbus": lane::dbus_path().map(|p| p.display().to_string()),
                "atspi": lane::atspi_launcher().map(|p| p.display().to_string()),
                "ffmpeg": ff.path.as_ref().map(|p| p.display().to_string()),
                "encoder": ff.codec.map(|c| format!("{c:?}").to_lowercase()),
                "missing": missing,
            },
        })
    }

    fn create(&self, req: &Value) -> DResult<Value> {
        let lane_id = req.req_str("laneId")?;
        if let Some(existing) = self.lanes.lock().unwrap().get(&lane_id).cloned() {
            existing.touch();
            return Ok(existing.display_json());
        }
        let name = req.str_field("name").unwrap_or_else(|| "ADE lane".into());
        let width = req.i64_field("width").unwrap_or(1920).max(1) as u32;
        let height = req.i64_field("height").unwrap_or(1080).max(1) as u32;
        let lane = Arc::new(Lane::create(&self.ade_home, &lane_id, &name, width, height, self.out.clone())?);
        let display = lane.display_json();
        self.lanes.lock().unwrap().insert(lane_id.clone(), lane.clone());
        spawn_watcher(lane.clone(), self.out.clone());
        let mut fields = serde_json::Map::new();
        fields.insert("laneId".into(), json!(lane_id));
        fields.insert("display".into(), display.clone());
        self.out.event("display-created", fields);
        log(&format!("lane {lane_id}: display :{} {}x{}", lane.display_num, lane.width, lane.height));
        Ok(display)
    }

    fn destroy(&self, lane_id: &str, reason: &str) -> Value {
        // The lane goes first, so a request queued behind this destroy finds
        // no screen and answers `NO_DISPLAY`. The queue entry belongs to the
        // lane's worker: it drops the entry itself, after this teardown has
        // run and the requests already queued are answered, which is what
        // ends the thread. Removing it here would let the next request create
        // a second worker for a lane whose destroy is still running.
        let lane = self.lanes.lock().unwrap().remove(lane_id);
        let Some(lane) = lane else {
            return json!({"destroyed": false, "releasedWindows": 0, "quitApps": [], "appsLeftOpen": []});
        };
        let result = lane.destroy();
        self.wake_worker(lane_id);
        let mut fields = serde_json::Map::new();
        fields.insert("laneId".into(), json!(lane_id));
        fields.insert("reason".into(), json!(reason));
        self.out.event("display-destroyed", fields);
        result
    }

    /// Tells a lane's worker its screen is gone.
    ///
    /// The worker may be idle in `recv`, in which case nothing else would ever
    /// wake it: the entry it owns would live until the driver exits.
    fn wake_worker(&self, lane_id: &str) {
        if let Some(queue) = self.queues.lock().unwrap().get(lane_id) {
            let _ = queue.tx.send(json!({ "op": LANE_GONE }));
        }
    }

    /// The gate a teardown off the lane's worker must hold: it waits for the
    /// request in flight to finish and keeps the next one from starting.
    fn lane_gate(&self, lane_id: &str) -> Option<Arc<Mutex<()>>> {
        self.queues.lock().unwrap().get(lane_id).map(|queue| queue.gate.clone())
    }

    /// One request, answered. Runs on the lane's worker (or its own thread).
    fn handle(&self, req: &Value) -> DResult<Value> {
        let op = req.str_field("op").unwrap_or_default();
        if self.shutting_down.load(Ordering::SeqCst) && op != "ping" {
            return Err(DriverError::new(code::LANE_STOPPING, "The Linux desktop driver is shutting down."));
        }
        match op.as_str() {
            "ping" => Ok(self.ping()),
            "watch-permissions" => Ok(json!({"watch": req.bool_field("watch")})),
            "request-permission" => {
                Ok(json!({"requested": false, "permissions": {"screenRecording": "granted", "accessibility": "granted"}}))
            }
            "display.create" => self.create(req),
            "display.destroy" => {
                let lane_id = req.req_str("laneId")?;
                Ok(self.destroy(&lane_id, &req.str_field("reason").unwrap_or_else(|| "stopped".into())))
            }
            "display.reconcile" => {
                let live: Vec<String> = req
                    .get("liveLaneIds")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                    .unwrap_or_default();
                let mut destroyed = Vec::new();
                for id in self.lane_ids() {
                    if !live.contains(&id) {
                        // Off the lane's worker, so hold the lane's gate: no
                        // request of that lane may run while its screen is
                        // being destroyed.
                        let gate = self.lane_gate(&id);
                        let _held = gate.as_ref().map(|gate| gate.lock().unwrap());
                        self.destroy(&id, "reconciled");
                        destroyed.push(id);
                    }
                }
                Ok(json!({"destroyed": destroyed}))
            }
            "window.list" => match req.str_field("laneId") {
                Some(id) => Ok(json!({"windows": self.lane(&id)?.windows_json()})),
                None => {
                    let lanes: Vec<Arc<Lane>> = self.lanes.lock().unwrap().values().cloned().collect();
                    let all: Vec<Value> = lanes
                        .iter()
                        .flat_map(|l| l.windows_json().as_array().cloned().unwrap_or_default())
                        .collect();
                    Ok(json!({"windows": all}))
                }
            },
            "window.focus" => self.lane(&req.req_str("laneId")?)?.window_action(req, "focus"),
            "window.minimize" => self.lane(&req.req_str("laneId")?)?.window_action(req, "minimize"),
            "window.close" => self.lane(&req.req_str("laneId")?)?.window_action(req, "close"),
            "window.park" | "window.unpark" | "app.adopt" | "present" => Err(DriverError::new(
                code::UNKNOWN_OP,
                format!("\"{op}\" has no meaning on a Linux lane screen: every window on it already belongs to the lane."),
            )),
            "app.launch" => self.lane(&req.req_str("laneId")?)?.launch(req),
            "app.quit" => {
                let lane = self.lane(&req.req_str("laneId")?)?;
                Ok(json!({"quit": lane.quit_apps(req.str_field("app").as_deref())}))
            }
            "observe" => self.lane(&req.req_str("laneId")?)?.observe(req),
            "input" => self.lane(&req.req_str("laneId")?)?.input(req),
            "capture.screenshot" => self.lane(&req.req_str("laneId")?)?.screenshot(req),
            "lease.set" => self.lane(&req.req_str("laneId")?)?.set_lease(req),
            "lease.clear" => self.lane(&req.req_str("laneId")?)?.clear_lease(),
            "stream.start" => self.lane(&req.req_str("laneId")?)?.start_stream(req),
            "stream.setRate" => self.lane(&req.req_str("laneId")?)?.set_stream_rate(req),
            "stream.setCursorVisible" => self.lane(&req.req_str("laneId")?)?.set_cursor(req),
            "stream.stop" => self.lane(&req.req_str("laneId")?)?.stop_stream(),
            "record.start" => self.lane(&req.req_str("laneId")?)?.start_recording(req),
            "record.stop" => self.lane(&req.req_str("laneId")?)?.stop_recording(),
            "" => Err(DriverError::new(code::PROTOCOL_ERROR, "A request needs an \"op\".")),
            other => Err(DriverError::new(code::UNKNOWN_OP, format!("This ade-desktop-driver build does not implement \"{other}\"."))),
        }
    }

    fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        for id in self.lane_ids() {
            // The worker is not the caller here, so wait out its request and
            // keep the next one from starting (it answers `LANE_STOPPING`).
            let gate = self.lane_gate(&id);
            let _held = gate.as_ref().map(|gate| gate.lock().unwrap());
            self.destroy(&id, "driver_exit");
        }
    }
}

/// Emits `windows-changed` when a lane's window list changes.
fn spawn_watcher(lane: Arc<Lane>, out: Arc<Output>) {
    std::thread::spawn(move || {
        let mut last = String::new();
        while !lane.stopping.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(700));
            if lane.stopping.load(Ordering::SeqCst) {
                break;
            }
            let (sig, windows) = lane.windows_signature();
            if sig != last {
                last = sig;
                let mut fields = serde_json::Map::new();
                fields.insert("laneId".into(), json!(lane.lane_id));
                fields.insert("windows".into(), windows);
                out.event("windows-changed", fields);
            }
        }
    });
}

/// Starts one lane's worker and returns its queue entry.
///
/// The worker owns the entry. It holds the gate while it answers a request;
/// once `Driver::destroy` has run it receives `LANE_GONE`, removes its own
/// entry, and ends after answering the requests already queued behind it. A
/// `display.create` that failed before a lane existed removes it the same way.
/// Nothing else inserts or removes that entry, so it cannot outlive its lane,
/// and no request can re-create it for a lane whose destroy is still running.
fn lane_queue(driver: &Arc<Driver>, lane_id: &str) -> LaneQueue {
    let (tx, rx) = channel::<Value>();
    let gate = Arc::new(Mutex::new(()));
    let gate_for_worker = gate.clone();
    let worker_lane = lane_id.to_string();
    let worker_driver = driver.clone();
    std::thread::Builder::new()
        .name(format!("lane-{}", &lane_id.chars().take(8).collect::<String>()))
        .spawn(move || {
            while let Ok(req) = rx.recv() {
                let op = req.str_field("op").unwrap_or_default();
                // Its screen is gone. Drop the entry if it is still this
                // worker's, so no new worker is created for the id, then keep
                // answering what is already queued until the channel ends.
                if op == LANE_GONE {
                    drop_own_entry(&worker_driver, &worker_lane, &gate_for_worker);
                    continue;
                }
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                // One request at a time, and never while a teardown holds the
                // gate from another thread (`display.reconcile`, driver exit).
                let result = {
                    let _gate = gate_for_worker.lock().unwrap();
                    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| worker_driver.handle(&req)))
                        .unwrap_or_else(|_| Err(DriverError::new(code::INTERNAL_ERROR, "The driver hit an internal fault on this request.")))
                };
                // A `display.create` that failed before a lane existed (no
                // Xvfb, a taken display number) has nothing left to serve.
                // `display.destroy` finds no lane, so it returns before it
                // wakes this worker, and the entry would idle until the driver
                // exits. The worker owns the entry, so it drops its own; a
                // retry then starts a fresh worker, as it did before.
                if op == "display.create"
                    && result.is_err()
                    && !worker_driver.lanes.lock().unwrap().contains_key(&worker_lane)
                {
                    drop_own_entry(&worker_driver, &worker_lane, &gate_for_worker);
                }
                worker_driver.out.reply(&id, result);
            }
        })
        .expect("lane worker");
    LaneQueue { tx, gate }
}

/// Removes this worker's queue entry, if the map still holds it and it is not a
/// newer worker's: the one place that ends the worker's ownership of the id.
fn drop_own_entry(driver: &Driver, lane_id: &str, gate: &Arc<Mutex<()>>) {
    let mut queues = driver.queues.lock().unwrap();
    if queues.get(lane_id).map(|queue| Arc::ptr_eq(&queue.gate, gate)).unwrap_or(false) {
        queues.remove(lane_id);
    }
}

/// An X server a crashed earlier driver left behind (its parent is gone and
/// its auth file is under this ADE home). The parent-death signal makes this
/// rare; this sweep makes it harmless.
fn sweep_orphans(ade_home: &PathBuf) {
    let marker = ade_home.join("linux-desktop").display().to_string();
    let Ok(entries) = std::fs::read_dir("/proc") else { return };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else { continue };
        let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) else { continue };
        let cmd = String::from_utf8_lossy(&cmdline).replace('\0', " ");
        if cmd.starts_with("Xvfb") || cmd.contains("/Xvfb ") {
            if cmd.contains(&marker) && procs::parent_of(pid) == Some(1) {
                log(&format!("killing orphaned lane X server pid {pid}"));
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }
}

static SIGNAL_PIPE: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_signal(_: libc::c_int) {
    let fd = SIGNAL_PIPE.load(Ordering::SeqCst);
    if fd >= 0 {
        let b = 1u8;
        unsafe {
            libc::write(fd, &b as *const u8 as *const libc::c_void, 1);
        }
    }
}

fn ade_home_from_args() -> PathBuf {
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--ade-home") {
        if let Some(v) = args.get(i + 1) {
            return PathBuf::from(v);
        }
    }
    if let Some(home) = std::env::var_os("ADE_HOME") {
        return PathBuf::from(home);
    }
    PathBuf::from(std::env::var_os("HOME").unwrap_or_else(|| "/tmp".into())).join(".ade")
}

fn main() {
    let ade_home = ade_home_from_args();
    if std::env::args().any(|a| a == "--version") {
        println!("{VERSION}");
        return;
    }
    let out = Arc::new(Output::new());
    let driver = Arc::new(Driver {
        ade_home: ade_home.clone(),
        out: out.clone(),
        lanes: Mutex::new(HashMap::new()),
        queues: Mutex::new(HashMap::new()),
        shutting_down: AtomicBool::new(false),
    });
    sweep_orphans(&ade_home);

    // SIGTERM / SIGINT / SIGHUP: tear every lane down (finishing recordings)
    // and exit, on a thread of its own.
    let mut fds = [0i32; 2];
    unsafe {
        libc::pipe(fds.as_mut_ptr());
        SIGNAL_PIPE.store(fds[1], Ordering::SeqCst);
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::signal(sig, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
        }
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }
    {
        let driver = driver.clone();
        let read_fd = fds[0];
        std::thread::spawn(move || {
            let mut b = 0u8;
            unsafe {
                libc::read(read_fd, &mut b as *mut u8 as *mut libc::c_void, 1);
            }
            driver.shutdown();
            std::process::exit(0);
        });
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(line) {
            Ok(v @ Value::Object(_)) => v,
            _ => {
                out.write(&json!({"id": Value::Null, "ok": false, "error": {"code": code::PROTOCOL_ERROR, "message": "Not a JSON object."}}));
                continue;
            }
        };
        if req.get("type").and_then(|t| t.as_str()) == Some("quit") {
            break;
        }
        let id = req.get("id").cloned().unwrap_or(Value::Null);
        let op = req.str_field("op").unwrap_or_default();
        let lane_id = req.str_field("laneId");
        let is_wait = op == "input" && req.get("command").and_then(|c| c.as_str()) == Some("wait");
        let global = matches!(op.as_str(), "ping" | "display.reconcile" | "watch-permissions" | "request-permission")
            || (op == "window.list" && lane_id.is_none());
        // A lane's worker exists only while the lane does: `display.create`
        // starts one, and the worker drops its own entry once its screen is
        // gone. A request for a lane that is already gone (a stale read racing
        // a destroy) joins no worker, so it runs on its own thread instead of
        // stranding one. The lookup and the send are one operation: nothing
        // re-creates an entry that the worker removed.
        let tx = match lane_id {
            Some(lane_id) if !global && !is_wait => {
                let mut queues = driver.queues.lock().unwrap();
                if let Some(queue) = queues.get(&lane_id) {
                    Some(queue.tx.clone())
                } else if op == "display.create" {
                    let queue = queues.entry(lane_id.clone()).or_insert_with(|| lane_queue(&driver, &lane_id));
                    Some(queue.tx.clone())
                } else {
                    None
                }
            }
            _ => None,
        };
        match tx {
            Some(tx) => {
                let _ = tx.send(req);
            }
            _ => {
                let driver = driver.clone();
                std::thread::spawn(move || {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| driver.handle(&req)))
                        .unwrap_or_else(|_| Err(DriverError::new(code::INTERNAL_ERROR, "The driver hit an internal fault on this request.")));
                    driver.out.reply(&id, result);
                });
            }
        }
    }
    // Stdin closed or quit asked: the brain is gone or wants us gone.
    driver.shutdown();
    std::process::exit(0);
}
