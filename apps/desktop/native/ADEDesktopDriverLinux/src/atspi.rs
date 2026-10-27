//! The element map: AT-SPI on the lane's own accessibility bus.
//!
//! Each lane runs its own D-Bus session, so its accessibility bus only ever
//! holds the lane's apps: an observation cannot leak another lane's (or the
//! user's) windows.
//!
//! Chromium answers the AT-SPI cache for its own UI only, so the page itself
//! is a real tree walk. The walk goes breadth first with every call of a level
//! in flight at once, prunes subtrees that are not SHOWING (a long page's
//! off-screen part), and stops at a node cap or a time budget, reporting why.

use crate::protocol::{code, internal, DResult, DriverError};
use futures_util::future::join_all;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

pub const IFACE_ACCESSIBLE: &str = "org.a11y.atspi.Accessible";

const STATE_ENABLED: u32 = 8;
const STATE_FOCUSABLE: u32 = 11;
const STATE_FOCUSED: u32 = 12;
const STATE_SENSITIVE: u32 = 24;
const STATE_SHOWING: u32 = 25;
const STATE_VISIBLE: u32 = 30;
const STATE_EDITABLE: u32 = 7;

pub fn has_state(states: &[u32], bit: u32) -> bool {
    let word = (bit / 32) as usize;
    states.get(word).map(|w| w & (1 << (bit % 32)) != 0).unwrap_or(false)
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct NodeRef {
    pub bus: String,
    pub path: String,
}

#[derive(Clone, Debug)]
pub struct Element {
    pub node: NodeRef,
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    pub enabled: bool,
    pub focused: bool,
    pub editable: bool,
    pub actions: Vec<String>,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub pid: i32,
    pub parent: Option<usize>,
    pub interactive: bool,
}

pub struct Walk {
    pub elements: Vec<Element>,
    pub truncated_reason: Option<&'static str>,
    pub stalled_apps: Vec<String>,
}

pub struct A11y {
    session_addr: String,
    conn: Mutex<Option<zbus::blocking::Connection>>,
}

fn role_name(role: u32) -> &'static str {
    const NAMES: [&str; 130] = [
        "invalid", "accelerator label", "alert", "animation", "arrow", "calendar", "canvas", "check box",
        "check menu item", "color chooser", "column header", "combo box", "date editor", "desktop icon",
        "desktop frame", "dial", "dialog", "directory pane", "drawing area", "file chooser", "filler",
        "focus traversable", "font chooser", "frame", "glass pane", "html container", "icon", "image",
        "internal frame", "label", "layered pane", "list", "list item", "menu", "menu bar", "menu item",
        "option pane", "page tab", "page tab list", "panel", "password text", "popup menu", "progress bar",
        "push button", "radio button", "radio menu item", "root pane", "row header", "scroll bar",
        "scroll pane", "separator", "slider", "spin button", "split pane", "status bar", "table",
        "table cell", "table column header", "table row header", "tearoff menu item", "terminal", "text",
        "toggle button", "tool bar", "tool tip", "tree", "tree table", "unknown", "viewport", "window",
        "extended", "header", "footer", "paragraph", "ruler", "application", "autocomplete", "editbar",
        "embedded", "entry", "chart", "caption", "document frame", "heading", "page", "section",
        "redundant object", "form", "link", "input method window", "table row", "tree item",
        "document spreadsheet", "document presentation", "document text", "document web", "document email",
        "comment", "list box", "grouping", "image map", "notification", "info bar", "level bar", "title bar",
        "block quote", "audio", "video", "definition", "article", "landmark", "log", "marquee", "math",
        "rating", "timer", "static", "math fraction", "math root", "subscript", "superscript",
        "description list", "description term", "description value", "footnote", "content deletion",
        "content insertion", "mark", "suggestion", "push button menu",
    ];
    NAMES.get(role as usize).copied().unwrap_or("unknown")
}

// The AT-SPI role numbers this driver's policy names. `role_name` above holds
// the full table; a number here must keep matching its row there.
const ROLE_ALERT: u32 = 2;
const ROLE_CHECK_BOX: u32 = 7;
const ROLE_CHECK_MENU_ITEM: u32 = 8;
const ROLE_COMBO_BOX: u32 = 11;
const ROLE_DIALOG: u32 = 16;
const ROLE_FRAME: u32 = 23;
const ROLE_IMAGE: u32 = 27;
const ROLE_LABEL: u32 = 29;
const ROLE_LIST_ITEM: u32 = 32;
const ROLE_MENU_ITEM: u32 = 35;
const ROLE_PAGE_TAB: u32 = 37;
const ROLE_PASSWORD_TEXT: u32 = 40;
const ROLE_PUSH_BUTTON: u32 = 43;
const ROLE_RADIO_BUTTON: u32 = 44;
const ROLE_RADIO_MENU_ITEM: u32 = 45;
const ROLE_SLIDER: u32 = 51;
const ROLE_SPIN_BUTTON: u32 = 52;
const ROLE_TERMINAL: u32 = 60;
const ROLE_TEXT: u32 = 61;
const ROLE_TOGGLE_BUTTON: u32 = 62;
const ROLE_TOOL_TIP: u32 = 64;
const ROLE_UNKNOWN: u32 = 67;
const ROLE_WINDOW: u32 = 69;
const ROLE_APPLICATION: u32 = 75;
const ROLE_AUTOCOMPLETE: u32 = 76;
const ROLE_ENTRY: u32 = 79;
const ROLE_CAPTION: u32 = 81;
const ROLE_HEADING: u32 = 83;
const ROLE_LINK: u32 = 88;
const ROLE_TREE_ITEM: u32 = 91;
const ROLE_LIST_BOX: u32 = 98;
const ROLE_NOTIFICATION: u32 = 101;
const ROLE_TITLE_BAR: u32 = 104;
const ROLE_STATIC: u32 = 116;
const ROLE_PUSH_BUTTON_MENU: u32 = 129;

/// Roles an agent acts on.
fn is_interactive_role(role: u32) -> bool {
    matches!(
        role,
        ROLE_CHECK_BOX
            | ROLE_CHECK_MENU_ITEM
            | ROLE_COMBO_BOX
            | ROLE_LIST_ITEM
            | ROLE_MENU_ITEM
            | ROLE_PAGE_TAB
            | ROLE_PASSWORD_TEXT
            | ROLE_PUSH_BUTTON
            | ROLE_RADIO_BUTTON
            | ROLE_RADIO_MENU_ITEM
            | ROLE_SLIDER
            | ROLE_SPIN_BUTTON
            | ROLE_TERMINAL
            | ROLE_TEXT
            | ROLE_TOGGLE_BUTTON
            | ROLE_ENTRY
            | ROLE_LINK
            | ROLE_TREE_ITEM
            | ROLE_PUSH_BUTTON_MENU
            | ROLE_LIST_BOX
            | ROLE_AUTOCOMPLETE
    )
}

/// Roles worth listing when they carry text: what an agent reads to orient.
fn is_text_role(role: u32) -> bool {
    matches!(
        role,
        ROLE_LABEL
            | ROLE_HEADING
            | ROLE_STATIC
            | ROLE_IMAGE
            | ROLE_ALERT
            | ROLE_DIALOG
            | ROLE_NOTIFICATION
            | ROLE_TOOL_TIP
            | ROLE_CAPTION
            | ROLE_TITLE_BAR
            | ROLE_FRAME
            | ROLE_WINDOW
    )
}

fn default_actions(role: u32, editable: bool) -> Vec<String> {
    let mut actions = Vec::new();
    if is_interactive_role(role) {
        actions.push("press".to_string());
    }
    if editable || matches!(role, ROLE_ENTRY | ROLE_PASSWORD_TEXT | ROLE_TEXT | ROLE_SPIN_BUTTON | ROLE_SLIDER) {
        actions.push("setValue".to_string());
    }
    actions
}

impl A11y {
    pub fn new(session_addr: String) -> Self {
        A11y { session_addr, conn: Mutex::new(None) }
    }

    /// Asks the session bus for the accessibility bus (starting the bus
    /// launcher on first use) and switches accessibility on for every toolkit
    /// that checks, Chromium and Electron included.
    pub fn bus_address(session_addr: &str) -> DResult<String> {
        let session = zbus::blocking::connection::Builder::address(session_addr)
            .map_err(internal("session bus address"))?
            .build()
            .map_err(internal("session bus"))?;
        for prop in ["IsEnabled", "ScreenReaderEnabled"] {
            let _ = session.call_method(
                Some("org.a11y.Bus"),
                "/org/a11y/bus",
                Some("org.freedesktop.DBus.Properties"),
                "Set",
                &("org.a11y.Status", prop, Value::from(true)),
            );
        }
        let reply = session
            .call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.a11y.Bus"), "GetAddress", &())
            .map_err(|e| DriverError::new(code::DISPLAY_UNAVAILABLE, format!("No accessibility bus (is at-spi2-core installed?): {e}")))?;
        reply.body().deserialize::<String>().map_err(internal("a11y address"))
    }

    fn connection(&self) -> DResult<zbus::blocking::Connection> {
        let mut guard = self.conn.lock().unwrap();
        if let Some(c) = guard.as_ref() {
            return Ok(c.clone());
        }
        let addr = Self::bus_address(&self.session_addr)?;
        let c = zbus::blocking::connection::Builder::address(addr.as_str())
            .map_err(internal("a11y bus address"))?
            .build()
            .map_err(internal("a11y bus"))?;
        *guard = Some(c.clone());
        Ok(c)
    }

    pub fn reset(&self) {
        *self.conn.lock().unwrap() = None;
    }

    /// Walks every app on the lane's bus within `budget`.
    pub fn walk(&self, budget: Duration, node_cap: usize) -> DResult<Walk> {
        let conn = self.connection()?;
        let (tx, rx) = mpsc::channel();
        let cancel = Arc::new(AtomicBool::new(false));
        let progress: Arc<Mutex<Option<Walk>>> = Arc::new(Mutex::new(None));
        {
            let cancel = cancel.clone();
            let progress = progress.clone();
            std::thread::spawn(move || {
                let result = zbus::block_on(walk_async(conn.inner().clone(), node_cap, cancel, progress));
                let _ = tx.send(result);
            });
        }
        match rx.recv_timeout(budget) {
            Ok(result) => result,
            Err(_) => {
                cancel.store(true, Ordering::SeqCst);
                // Whatever was finished before the deadline, marked as cut short.
                let partial = progress.lock().unwrap().take();
                match partial {
                    Some(mut walk) => {
                        walk.truncated_reason = Some("timeout");
                        Ok(walk)
                    }
                    None => {
                        self.reset();
                        Ok(Walk { elements: Vec::new(), truncated_reason: Some("stalled"), stalled_apps: Vec::new() })
                    }
                }
            }
        }
    }

    fn call<B>(&self, node: &NodeRef, iface: &str, method: &str, body: &B) -> DResult<zbus::Message>
    where
        B: serde::Serialize + zbus::zvariant::DynamicType,
    {
        let conn = self.connection()?;
        conn.call_method(Some(node.bus.as_str()), node.path.as_str(), Some(iface), method, body)
            .map_err(|e| DriverError::new(code::HANDLE_EXPIRED, format!("The element no longer answers ({e}). Observe again.")))
    }

    pub fn do_action(&self, node: &NodeRef, index: i32) -> bool {
        self.call(node, "org.a11y.atspi.Action", "DoAction", &(index,))
            .ok()
            .and_then(|m| m.body().deserialize::<bool>().ok())
            .unwrap_or(false)
    }

    pub fn grab_focus(&self, node: &NodeRef) -> bool {
        self.call(node, "org.a11y.atspi.Component", "GrabFocus", &())
            .ok()
            .and_then(|m| m.body().deserialize::<bool>().ok())
            .unwrap_or(false)
    }

    pub fn set_text(&self, node: &NodeRef, text: &str) -> bool {
        self.call(node, "org.a11y.atspi.EditableText", "SetTextContents", &(text,))
            .ok()
            .and_then(|m| m.body().deserialize::<bool>().ok())
            .unwrap_or(false)
    }

    pub fn set_number(&self, node: &NodeRef, value: f64) -> bool {
        self.call(
            node,
            "org.freedesktop.DBus.Properties",
            "Set",
            &("org.a11y.atspi.Value", "CurrentValue", Value::from(value)),
        )
        .is_ok()
    }

}

type Conn = zbus::Connection;

async fn call_async<B>(conn: &Conn, node: &NodeRef, iface: &str, method: &str, body: &B) -> Option<zbus::Message>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    conn.call_method(Some(node.bus.as_str()), node.path.as_str(), Some(iface), method, body).await.ok()
}

async fn children(conn: &Conn, node: &NodeRef) -> Vec<NodeRef> {
    let Some(msg) = call_async(conn, node, IFACE_ACCESSIBLE, "GetChildren", &()).await else { return Vec::new() };
    msg.body()
        .deserialize::<Vec<(String, OwnedObjectPath)>>()
        .map(|v| {
            v.into_iter()
                .filter(|(bus, path)| !bus.is_empty() && path.as_str() != "/org/a11y/atspi/null")
                .map(|(bus, path)| NodeRef { bus, path: path.to_string() })
                .collect()
        })
        .unwrap_or_default()
}

async fn role_of(conn: &Conn, node: &NodeRef) -> Option<u32> {
    call_async(conn, node, IFACE_ACCESSIBLE, "GetRole", &()).await?.body().deserialize::<u32>().ok()
}

async fn states_of(conn: &Conn, node: &NodeRef) -> Vec<u32> {
    match call_async(conn, node, IFACE_ACCESSIBLE, "GetState", &()).await {
        Some(m) => m.body().deserialize::<Vec<u32>>().unwrap_or_default(),
        None => Vec::new(),
    }
}

async fn prop_string(conn: &Conn, node: &NodeRef, iface: &str, prop: &str) -> Option<String> {
    let msg = call_async(conn, node, "org.freedesktop.DBus.Properties", "Get", &(iface, prop)).await?;
    let value: OwnedValue = msg.body().deserialize().ok()?;
    String::try_from(value).ok()
}

async fn extents_of(conn: &Conn, node: &NodeRef) -> Option<(i32, i32, i32, i32)> {
    call_async(conn, node, "org.a11y.atspi.Component", "GetExtents", &(0u32,)).await?.body().deserialize().ok()
}

async fn text_of(conn: &Conn, node: &NodeRef) -> Option<String> {
    let msg = call_async(conn, node, "org.a11y.atspi.Text", "GetText", &(0i32, -1i32)).await?;
    msg.body().deserialize::<String>().ok()
}

async fn pid_of(conn: &Conn, bus: &str) -> i32 {
    let reply = conn
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "GetConnectionUnixProcessID",
            &(bus,),
        )
        .await;
    reply.ok().and_then(|m| m.body().deserialize::<u32>().ok()).map(|p| p as i32).unwrap_or(0)
}

struct Pending {
    node: NodeRef,
    parent: Option<usize>,
    depth: u32,
    app: usize,
}

struct Candidate {
    node: NodeRef,
    role: u32,
    states: Vec<u32>,
    parent: Option<usize>,
    app: usize,
}

const BATCH: usize = 192;

async fn walk_async(
    conn: Conn,
    node_cap: usize,
    cancel: Arc<AtomicBool>,
    progress: Arc<Mutex<Option<Walk>>>,
) -> DResult<Walk> {
    let root = NodeRef { bus: "org.a11y.atspi.Registry".into(), path: "/org/a11y/atspi/accessible/root".into() };
    let apps = children(&conn, &root).await;
    let mut app_pids: Vec<i32> = Vec::new();
    let mut frontier: Vec<Pending> = Vec::new();
    for app in apps {
        let pid = pid_of(&conn, &app.bus).await;
        frontier.push(Pending { node: app, parent: None, depth: 0, app: app_pids.len() });
        app_pids.push(pid);
    }
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut details: HashMap<NodeRef, (String, Frame)> = HashMap::new();
    let mut fetched = 0usize;
    let mut node_count = 0usize;
    let mut truncated: Option<&'static str> = None;
    // The emitted ancestor of each walked node, so an element's parentIndex
    // points at the nearest ancestor that is itself in the list.
    while !frontier.is_empty() {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        if node_count >= node_cap {
            truncated = Some("node_cap");
            break;
        }
        let take = frontier.len().min(BATCH).min(node_cap - node_count);
        let level: Vec<Pending> = frontier.drain(..take).collect();
        node_count += level.len();
        let infos = join_all(level.iter().map(|p| {
            let conn = &conn;
            async move {
                if p.depth == 0 {
                    return (ROLE_APPLICATION, Vec::new(), children(conn, &p.node).await);
                }
                let role = role_of(conn, &p.node).await.unwrap_or(ROLE_UNKNOWN);
                let states = states_of(conn, &p.node).await;
                let showing = states.is_empty() || has_state(&states, STATE_SHOWING);
                let kids = if showing { children(conn, &p.node).await } else { Vec::new() };
                (role, states, kids)
            }
        }))
        .await;
        for (p, (role, states, kids)) in level.into_iter().zip(infos) {
            let mut parent_for_kids = p.parent;
            let visible = has_state(&states, STATE_SHOWING) && has_state(&states, STATE_VISIBLE);
            if p.depth > 0 && visible && (is_interactive_role(role) || is_text_role(role)) {
                parent_for_kids = Some(candidates.len());
                candidates.push(Candidate { node: p.node.clone(), role, states, parent: p.parent, app: p.app });
            }
            for kid in kids {
                frontier.push(Pending { node: kid, parent: parent_for_kids, depth: p.depth + 1, app: p.app });
            }
        }
        // Names and frames for this level's new candidates, then publish
        // what is finished so far for a walk that runs out of time.
        fetch_details(&conn, &candidates[fetched..], &mut details).await;
        fetched = candidates.len();
        *progress.lock().unwrap() = Some(build(&candidates, &details, &HashMap::new(), &app_pids, Some("timeout")));
    }
    if truncated.is_none() && !frontier.is_empty() && cancel.load(Ordering::SeqCst) {
        truncated = Some("timeout");
    }
    let values = fetch_values(&conn, &candidates, &details).await;
    Ok(build(&candidates, &details, &values, &app_pids, truncated))
}
type Frame = Option<(i32, i32, i32, i32)>;

async fn fetch_details(conn: &Conn, fresh: &[Candidate], details: &mut HashMap<NodeRef, (String, Frame)>) {
    for chunk in fresh.chunks(BATCH) {
        let rows = join_all(chunk.iter().map(|c| async move {
            let name = prop_string(conn, &c.node, IFACE_ACCESSIBLE, "Name").await.unwrap_or_default();
            let frame = extents_of(conn, &c.node).await;
            (name, frame)
        }))
        .await;
        for (c, row) in chunk.iter().zip(rows) {
            details.insert(c.node.clone(), row);
        }
    }
}

/// Current text of the editable fields that are on screen.
async fn fetch_values(conn: &Conn, candidates: &[Candidate], details: &HashMap<NodeRef, (String, Frame)>) -> HashMap<NodeRef, String> {
    let wanted: Vec<&Candidate> = candidates
        .iter()
        .filter(|c| has_state(&c.states, STATE_EDITABLE) || matches!(c.role, ROLE_ENTRY | ROLE_PASSWORD_TEXT | ROLE_COMBO_BOX | ROLE_SPIN_BUTTON))
        .filter(|c| matches!(details.get(&c.node), Some((_, Some((_, _, w, h))))if *w > 0 && *h > 0))
        .collect();
    let mut out = HashMap::new();
    for chunk in wanted.chunks(BATCH) {
        let rows = join_all(chunk.iter().map(|c| text_of(conn, &c.node))).await;
        for (c, row) in chunk.iter().zip(rows) {
            if let Some(text) = row {
                out.insert(c.node.clone(), text.chars().take(200).collect());
            }
        }
    }
    out
}

/// The element list: candidates with an on-screen frame, minus text roles
/// that carry no text.
fn build(
    candidates: &[Candidate],
    details: &HashMap<NodeRef, (String, Frame)>,
    values: &HashMap<NodeRef, String>,
    app_pids: &[i32],
    truncated: Option<&'static str>,
) -> Walk {
    let mut remap: Vec<Option<usize>> = vec![None; candidates.len()];
    let mut elements: Vec<Element> = Vec::new();
    for (i, c) in candidates.iter().enumerate() {
        let Some((name, Some((x, y, w, h)))) = details.get(&c.node).cloned() else { continue };
        if w <= 0 || h <= 0 {
            continue;
        }
        let interactive = is_interactive_role(c.role);
        if !interactive && name.trim().is_empty() {
            continue;
        }
        let editable = has_state(&c.states, STATE_EDITABLE);
        let parent = c.parent.and_then(|p| remap.get(p).copied().flatten());
        remap[i] = Some(elements.len());
        elements.push(Element {
            node: c.node.clone(),
            role: role_name(c.role).to_string(),
            name: name.trim().to_string(),
            value: values.get(&c.node).cloned(),
            enabled: has_state(&c.states, STATE_ENABLED) || has_state(&c.states, STATE_SENSITIVE),
            focused: has_state(&c.states, STATE_FOCUSED),
            editable,
            actions: default_actions(c.role, editable || (has_state(&c.states, STATE_FOCUSABLE) && c.role == ROLE_TEXT)),
            x,
            y,
            width: w,
            height: h,
            pid: app_pids.get(c.app).copied().unwrap_or(0),
            parent,
            interactive,
        });
    }
    Walk { elements, truncated_reason: truncated, stalled_apps: Vec::new() }
}
