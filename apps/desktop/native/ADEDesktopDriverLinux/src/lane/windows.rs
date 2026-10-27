//! A lane's windows: the list and its JSON, the window verbs, screenshots.

use super::Lane;
use crate::draw::write_png;
use crate::fail;
use crate::procs;
use crate::protocol::{code, iso_now, DResult, DriverError, Req};
use crate::xconn::WinInfo;
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, Instant};

impl Lane {
    pub(crate) fn window_json(&self, w: &WinInfo) -> Value {
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

    pub(crate) fn windows(&self) -> Vec<WinInfo> {
        self.x.lock().unwrap().list_windows()
    }

    pub fn windows_json(&self) -> Value {
        Value::Array(self.windows().iter().map(|w| self.window_json(w)).collect())
    }

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
        let (w, h, rgb) = self.x.lock().unwrap().capture_rgb()?;
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
