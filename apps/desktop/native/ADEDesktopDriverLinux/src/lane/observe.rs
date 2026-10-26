//! A lane's element map: the AT-SPI walk, the observation, handles and text.

use super::{hex, random_bytes, Lane};
use crate::atspi::{Element, Walk};
use crate::draw::{write_png, Canvas, PALETTE};
use crate::fail;
use crate::protocol::{code, iso_now, DResult, DriverError, Req};
use crate::xconn::WinInfo;
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

const OBSERVATION_RETENTION: usize = 8;
const WALK_BUDGET: Duration = Duration::from_millis(2500);
const WALK_NODE_CAP: usize = 12_000;

impl Lane {
    pub(crate) fn walk(&self, budget: Duration) -> Walk {
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
        let (w, h, mut rgb) = self.x.lock().unwrap().capture_rgb()?;
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

    pub(crate) fn resolve_handle(&self, handle: &str) -> DResult<(usize, Element)> {
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

    pub(crate) fn matches(e: &Element, needle: &str) -> bool {
        let n = needle.to_lowercase();
        e.name.to_lowercase().contains(&n) || e.value.as_ref().map(|v| v.to_lowercase().contains(&n)).unwrap_or(false)
    }

    /// The element a text names: an exact name first, interactive first.
    pub(crate) fn resolve_text(&self, text: &str) -> DResult<(Option<usize>, Element)> {
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
            None => fail!(code::INVALID_ARGUMENT, "Nothing on this lane's screen matches \"{text}\". Observe to see what is there."),
        }
    }
}
