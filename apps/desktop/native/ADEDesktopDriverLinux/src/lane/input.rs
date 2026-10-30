//! A lane's input: clicks, keys, scroll, drag, buttons, and `wait`.

use super::Lane;
use crate::atspi::Element;
use crate::fail;
use crate::protocol::{code, DResult, DriverError, Req};
use crate::xconn::WinInfo;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

impl Lane {
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
                let pace_ms = payload.get("typePaceMs").and_then(|v| v.as_u64()).unwrap_or(0);
                x.type_text(&text, pace_ms)?;
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

    fn wait(&self, payload: &Value) -> DResult<Value> {
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
}
