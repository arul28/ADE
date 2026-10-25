//! The NDJSON wire shared with the macOS and Windows drivers.
//!
//! One JSON object per line: a request `{"id","op",...}`, a reply
//! `{"id","ok":true,"result"}` / `{"id","ok":false,"error":{code,message}}`,
//! or an event `{"event":...}` with no id. The result shapes are the types in
//! `apps/desktop/src/shared/types/macDesktop.ts`; that file is the contract.

use serde_json::{json, Map, Value};
use std::io::Write;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub mod code {
    pub const DISPLAY_UNAVAILABLE: &str = "MAC_DESKTOP_DISPLAY_UNAVAILABLE";
    pub const NO_DISPLAY: &str = "MAC_DESKTOP_NO_DISPLAY";
    pub const NO_WINDOW: &str = "MAC_DESKTOP_NO_WINDOW";
    pub const WINDOW_NOT_FOUND: &str = "MAC_DESKTOP_WINDOW_NOT_FOUND";
    pub const HANDLE_EXPIRED: &str = "MAC_DESKTOP_HANDLE_EXPIRED";
    pub const RECORDING_NOT_RUNNING: &str = "MAC_DESKTOP_RECORDING_NOT_RUNNING";
    pub const LANE_STOPPING: &str = "lane_stopping";
    pub const UNKNOWN_OP: &str = "unknown_op";
    pub const PROTOCOL_ERROR: &str = "protocol_error";
    pub const INVALID_ARGUMENT: &str = "invalid_argument";
    pub const INTERNAL_ERROR: &str = "internal_error";
}

#[derive(Debug, Clone)]
pub struct DriverError {
    pub code: String,
    pub message: String,
}

impl DriverError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        DriverError { code: code.to_string(), message: message.into() }
    }
}

impl std::fmt::Display for DriverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub type DResult<T> = Result<T, DriverError>;

#[macro_export]
macro_rules! fail {
    ($code:expr, $($arg:tt)*) => {
        return Err($crate::protocol::DriverError::new($code, format!($($arg)*)))
    };
}

/// Any lower-level error, as an internal fault with its text kept.
pub fn internal<E: std::fmt::Display>(context: &str) -> impl FnOnce(E) -> DriverError + '_ {
    move |e| DriverError::new(code::INTERNAL_ERROR, format!("{context}: {e}"))
}

/// The single line writer. Replies and events from every thread go through
/// it, so a line is never interleaved with another.
pub struct Output {
    out: Mutex<std::io::Stdout>,
}

impl Output {
    pub fn new() -> Self {
        Output { out: Mutex::new(std::io::stdout()) }
    }

    pub fn write(&self, value: &Value) {
        let mut line = serde_json::to_string(value).unwrap_or_else(|_| "{}".into());
        line.push('\n');
        if let Ok(mut out) = self.out.lock() {
            let _ = out.write_all(line.as_bytes());
            let _ = out.flush();
        }
    }

    pub fn reply(&self, id: &Value, result: DResult<Value>) {
        if id.is_null() {
            return;
        }
        match result {
            Ok(result) => self.write(&json!({"id": id, "ok": true, "result": result})),
            Err(e) => self.write(&json!({"id": id, "ok": false, "error": {"code": e.code, "message": e.message}})),
        }
    }

    pub fn event(&self, name: &str, mut fields: Map<String, Value>) {
        fields.insert("event".into(), Value::String(name.into()));
        self.write(&Value::Object(fields));
    }
}

pub fn log(message: &str) {
    eprintln!("[ade-desktop-driver] {message}");
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `Date.toISOString()` spelling: millisecond UTC.
pub fn iso_now() -> String {
    iso_from_ms(now_ms())
}

pub fn iso_from_ms(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    if mo <= 2 {
        y += 1;
    }
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}.{millis:03}Z")
}

/// Request field readers. Missing or mistyped fields read as absent; required
/// ones answer `invalid_argument` naming the field.
pub trait Req {
    fn str_field(&self, key: &str) -> Option<String>;
    fn req_str(&self, key: &str) -> DResult<String>;
    fn i64_field(&self, key: &str) -> Option<i64>;
    fn f64_field(&self, key: &str) -> Option<f64>;
    fn bool_field(&self, key: &str) -> bool;
}

impl Req for Value {
    fn str_field(&self, key: &str) -> Option<String> {
        self.get(key).and_then(|v| v.as_str()).map(|s| s.to_string()).filter(|s| !s.is_empty())
    }
    fn req_str(&self, key: &str) -> DResult<String> {
        match self.str_field(key) {
            Some(s) => Ok(s),
            None => Err(DriverError::new(code::INVALID_ARGUMENT, format!("\"{key}\" is required."))),
        }
    }
    fn i64_field(&self, key: &str) -> Option<i64> {
        self.get(key).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
    }
    fn f64_field(&self, key: &str) -> Option<f64> {
        self.get(key).and_then(|v| v.as_f64())
    }
    fn bool_field(&self, key: &str) -> bool {
        self.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
    }
}

