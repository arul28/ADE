//! One X11 connection to a lane's display: windows, input, and pixels.
//!
//! Input is XTEST. On macOS and a shared Windows desktop, real input means the
//! user's own pointer; here the display is the lane's alone, so XTEST input is
//! background input by construction and needs no lease. Apps accept it as
//! genuine (unlike XSendEvent, which Chromium and GTK drop for pointer events).

use crate::keys;
use crate::protocol::{code, internal, DResult, DriverError};
use std::collections::HashMap;
use std::os::unix::net::UnixStream;
use std::time::Duration;
use x11rb::connection::Connection;
use x11rb::protocol::xfixes::ConnectionExt as _;
use x11rb::protocol::xproto::{self, AtomEnum, ClientMessageEvent, ConnectionExt as _, EventMask, ImageFormat, Window};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::{DefaultStream, RustConnection};

pub const KEY_PRESS: u8 = 2;
pub const KEY_RELEASE: u8 = 3;
pub const BUTTON_PRESS: u8 = 4;
pub const BUTTON_RELEASE: u8 = 5;
pub const MOTION_NOTIFY: u8 = 6;

#[derive(Clone, Debug)]
pub struct WinInfo {
    pub id: u32,
    pub pid: i32,
    pub class_name: String,
    pub title: String,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub minimized: bool,
}

impl WinInfo {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        !self.minimized && x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
}

pub struct Atoms {
    pub net_client_list_stacking: u32,
    pub net_client_list: u32,
    pub net_wm_name: u32,
    pub net_wm_pid: u32,
    pub net_wm_state: u32,
    pub net_wm_state_hidden: u32,
    pub net_wm_window_type: u32,
    pub net_wm_window_type_dock: u32,
    pub net_wm_window_type_desktop: u32,
    pub net_active_window: u32,
    pub net_close_window: u32,
    pub net_supporting_wm_check: u32,
    pub utf8_string: u32,
    pub wm_state: u32,
    pub wm_change_state: u32,
    pub wm_protocols: u32,
    pub wm_delete_window: u32,
}

pub struct XConn {
    pub conn: RustConnection,
    pub root: Window,
    pub width: u16,
    pub height: u16,
    pub atoms: Atoms,
    keymap: HashMap<u32, (u8, u8)>,
    keysyms_per_keycode: u8,
    scratch: Vec<u8>,
    scratch_next: usize,
    modifier_codes: HashMap<u32, u8>,
    pressed_buttons: Vec<u8>,
}

pub fn connect_raw(display_num: u32, cookie: &[u8]) -> DResult<(RustConnection, usize)> {
    let path = format!("/tmp/.X11-unix/X{display_num}");
    let stream = UnixStream::connect(&path)
        .map_err(|e| DriverError::new(code::DISPLAY_UNAVAILABLE, format!("Could not reach the lane display {path}: {e}")))?;
    let (stream, _peer) = DefaultStream::from_unix_stream(stream).map_err(internal("X11 stream"))?;
    let conn = RustConnection::connect_to_stream_with_auth_info(stream, 0, b"MIT-MAGIC-COOKIE-1".to_vec(), cookie.to_vec())
        .map_err(|e| DriverError::new(code::DISPLAY_UNAVAILABLE, format!("The lane display refused the connection: {e}")))?;
    Ok((conn, 0))
}

fn intern(conn: &RustConnection, name: &str) -> DResult<u32> {
    Ok(conn.intern_atom(false, name.as_bytes()).map_err(internal("intern"))?.reply().map_err(internal("intern"))?.atom)
}

impl XConn {
    pub fn connect(display_num: u32, cookie: &[u8]) -> DResult<XConn> {
        let (conn, screen) = connect_raw(display_num, cookie)?;
        let (root, width, height) = {
            let s = &conn.setup().roots[screen];
            (s.root, s.width_in_pixels, s.height_in_pixels)
        };
        let atoms = Atoms {
            net_client_list_stacking: intern(&conn, "_NET_CLIENT_LIST_STACKING")?,
            net_client_list: intern(&conn, "_NET_CLIENT_LIST")?,
            net_wm_name: intern(&conn, "_NET_WM_NAME")?,
            net_wm_pid: intern(&conn, "_NET_WM_PID")?,
            net_wm_state: intern(&conn, "_NET_WM_STATE")?,
            net_wm_state_hidden: intern(&conn, "_NET_WM_STATE_HIDDEN")?,
            net_wm_window_type: intern(&conn, "_NET_WM_WINDOW_TYPE")?,
            net_wm_window_type_dock: intern(&conn, "_NET_WM_WINDOW_TYPE_DOCK")?,
            net_wm_window_type_desktop: intern(&conn, "_NET_WM_WINDOW_TYPE_DESKTOP")?,
            net_active_window: intern(&conn, "_NET_ACTIVE_WINDOW")?,
            net_close_window: intern(&conn, "_NET_CLOSE_WINDOW")?,
            net_supporting_wm_check: intern(&conn, "_NET_SUPPORTING_WM_CHECK")?,
            utf8_string: intern(&conn, "UTF8_STRING")?,
            wm_state: intern(&conn, "WM_STATE")?,
            wm_change_state: intern(&conn, "WM_CHANGE_STATE")?,
            wm_protocols: intern(&conn, "WM_PROTOCOLS")?,
            wm_delete_window: intern(&conn, "WM_DELETE_WINDOW")?,
        };
        let _ = conn.xfixes_query_version(5, 0).map(|c| c.reply());
        let mut x = XConn {
            conn,
            root,
            width,
            height,
            atoms,
            keymap: HashMap::new(),
            keysyms_per_keycode: 1,
            scratch: Vec::new(),
            scratch_next: 0,
            modifier_codes: HashMap::new(),
            pressed_buttons: Vec::new(),
        };
        x.load_keymap()?;
        Ok(x)
    }

    fn load_keymap(&mut self) -> DResult<()> {
        let (min, max) = (self.conn.setup().min_keycode, self.conn.setup().max_keycode);
        let reply = self
            .conn
            .get_keyboard_mapping(min, max - min + 1)
            .map_err(internal("keymap"))?
            .reply()
            .map_err(internal("keymap"))?;
        let per = reply.keysyms_per_keycode.max(1) as usize;
        self.keysyms_per_keycode = per as u8;
        self.keymap.clear();
        self.scratch.clear();
        for (i, chunk) in reply.keysyms.chunks(per).enumerate() {
            let keycode = min as usize + i;
            if keycode > 255 {
                break;
            }
            let keycode = keycode as u8;
            if chunk.iter().all(|&k| k == 0) {
                self.scratch.push(keycode);
                continue;
            }
            for (level, &ks) in chunk.iter().take(2).enumerate() {
                if ks != 0 {
                    self.keymap.entry(ks).or_insert((keycode, level as u8));
                }
            }
        }
        // The last empty keycodes are the scratch slots for characters the
        // layout cannot type; keep a few.
        let keep = self.scratch.len().saturating_sub(4);
        self.scratch.drain(..keep);
        for ks in [keys::SHIFT_L, keys::CONTROL_L, keys::ALT_L, keys::SUPER_L] {
            if let Some(&(code, _)) = self.keymap.get(&ks) {
                self.modifier_codes.insert(ks, code);
            }
        }
        Ok(())
    }

    fn prop(&self, window: Window, atom: u32, kind: u32) -> Option<xproto::GetPropertyReply> {
        self.conn.get_property(false, window, atom, kind, 0, 4096).ok()?.reply().ok()
    }

    fn prop_u32s(&self, window: Window, atom: u32, kind: impl Into<u32>) -> Vec<u32> {
        self.prop(window, atom, kind.into())
            .and_then(|r| r.value32().map(|it| it.collect()))
            .unwrap_or_default()
    }

    fn prop_string(&self, window: Window, atom: u32, kind: impl Into<u32>) -> Option<String> {
        let r = self.prop(window, atom, kind.into())?;
        if r.value.is_empty() {
            return None;
        }
        Some(String::from_utf8_lossy(&r.value).trim_end_matches('\0').to_string())
    }

    /// A plain dark backdrop instead of Xvfb's black.
    pub fn set_background(&self, rgb: u32) {
        let _ = self.conn.change_window_attributes(self.root, &xproto::ChangeWindowAttributesAux::new().background_pixel(rgb));
        let _ = self.conn.clear_area(false, self.root, 0, 0, 0, 0);
        let _ = self.conn.flush();
    }

    pub fn has_window_manager(&self) -> bool {
        !self.prop_u32s(self.root, self.atoms.net_supporting_wm_check, AtomEnum::WINDOW).is_empty()
    }

    /// The lane's top-level app windows, topmost first.
    pub fn list_windows(&self) -> Vec<WinInfo> {
        let mut ids = self.prop_u32s(self.root, self.atoms.net_client_list_stacking, AtomEnum::WINDOW);
        if ids.is_empty() {
            ids = self.prop_u32s(self.root, self.atoms.net_client_list, AtomEnum::WINDOW);
        }
        let managed = !ids.is_empty();
        if !managed {
            // No window manager: mapped top-level children of the root.
            ids = self
                .conn
                .query_tree(self.root)
                .ok()
                .and_then(|c| c.reply().ok())
                .map(|r| r.children)
                .unwrap_or_default();
        }
        let mut out = Vec::new();
        for id in ids.into_iter().rev() {
            if let Some(info) = self.describe(id, managed) {
                out.push(info);
            }
        }
        out
    }

    pub fn describe(&self, id: Window, managed: bool) -> Option<WinInfo> {
        let types = self.prop_u32s(id, self.atoms.net_wm_window_type, AtomEnum::ATOM);
        if types.contains(&self.atoms.net_wm_window_type_dock) || types.contains(&self.atoms.net_wm_window_type_desktop) {
            return None;
        }
        let states = self.prop_u32s(id, self.atoms.net_wm_state, AtomEnum::ATOM);
        let mut minimized = states.contains(&self.atoms.net_wm_state_hidden);
        if !managed {
            let attrs = self.conn.get_window_attributes(id).ok()?.reply().ok()?;
            if attrs.override_redirect || attrs.map_state != xproto::MapState::VIEWABLE {
                return None;
            }
        } else if let Some(wm_state) = self.prop_u32s(id, self.atoms.wm_state, self.atoms.wm_state).first() {
            minimized = minimized || *wm_state == 3;
        }
        let class = self.prop(id, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into()).map(|r| r.value).unwrap_or_default();
        let mut parts = class.split(|&b| b == 0).map(|p| String::from_utf8_lossy(p).to_string());
        let _instance = parts.next();
        let class_name = parts.next().unwrap_or_default();
        let title = self
            .prop_string(id, self.atoms.net_wm_name, self.atoms.utf8_string)
            .or_else(|| self.prop_string(id, AtomEnum::WM_NAME.into(), AtomEnum::ANY))
            .unwrap_or_default();
        if !managed && class_name.is_empty() && title.is_empty() {
            return None;
        }
        let pid = self.prop_u32s(id, self.atoms.net_wm_pid, AtomEnum::CARDINAL).first().copied().unwrap_or(0) as i32;
        let geo = self.conn.get_geometry(id).ok()?.reply().ok()?;
        let origin = self.conn.translate_coordinates(id, self.root, 0, 0).ok()?.reply().ok()?;
        Some(WinInfo {
            id,
            pid,
            class_name,
            title,
            x: origin.dst_x as i32,
            y: origin.dst_y as i32,
            width: geo.width as i32,
            height: geo.height as i32,
            minimized,
        })
    }

    fn client_message(&self, window: Window, kind: u32, data: [u32; 5]) -> DResult<()> {
        let event = ClientMessageEvent::new(32, window, kind, data);
        self.conn
            .send_event(false, self.root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event)
            .map_err(internal("send_event"))?;
        self.conn.flush().map_err(internal("flush"))?;
        Ok(())
    }

    pub fn focus(&self, window: Window) -> DResult<()> {
        if self.has_window_manager() {
            self.client_message(window, self.atoms.net_active_window, [2, x11rb::CURRENT_TIME, 0, 0, 0])?;
        } else {
            let _ = self.conn.map_window(window);
            let _ = self.conn.configure_window(window, &xproto::ConfigureWindowAux::new().stack_mode(xproto::StackMode::ABOVE));
            let _ = self.conn.set_input_focus(xproto::InputFocus::PARENT, window, x11rb::CURRENT_TIME);
            self.conn.flush().map_err(internal("flush"))?;
        }
        Ok(())
    }

    pub fn minimize(&self, window: Window) -> DResult<()> {
        self.client_message(window, self.atoms.wm_change_state, [3, 0, 0, 0, 0])
    }

    pub fn close(&self, window: Window) -> DResult<()> {
        if self.has_window_manager() {
            return self.client_message(window, self.atoms.net_close_window, [x11rb::CURRENT_TIME, 2, 0, 0, 0]);
        }
        let protocols = self.prop_u32s(window, self.atoms.wm_protocols, AtomEnum::ATOM);
        if protocols.contains(&self.atoms.wm_delete_window) {
            let event = ClientMessageEvent::new(32, window, self.atoms.wm_protocols, [self.atoms.wm_delete_window, x11rb::CURRENT_TIME, 0, 0, 0]);
            self.conn.send_event(false, window, EventMask::NO_EVENT, event).map_err(internal("send_event"))?;
        } else {
            self.conn.kill_client(window).map_err(internal("kill_client"))?;
        }
        self.conn.flush().map_err(internal("flush"))?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Input (XTEST)
    // -----------------------------------------------------------------------

    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> DResult<()> {
        self.conn
            .xtest_fake_input(kind, detail, 0, if kind == MOTION_NOTIFY { self.root } else { x11rb::NONE }, x, y, 0)
            .map_err(internal("xtest"))?;
        Ok(())
    }

    fn sync(&self) -> DResult<()> {
        // A round trip, so every queued event has reached the server before
        // the caller observes the result.
        self.conn.get_input_focus().map_err(internal("sync"))?.reply().map_err(internal("sync"))?;
        Ok(())
    }

    fn clamp(&self, x: f64, y: f64) -> (i16, i16) {
        let cx = x.round().clamp(0.0, (self.width as f64 - 1.0).max(0.0)) as i16;
        let cy = y.round().clamp(0.0, (self.height as f64 - 1.0).max(0.0)) as i16;
        (cx, cy)
    }

    pub fn move_to(&self, x: f64, y: f64) -> DResult<()> {
        let (x, y) = self.clamp(x, y);
        self.fake(MOTION_NOTIFY, 0, x, y)?;
        self.sync()
    }

    pub fn button_code(button: &str) -> u8 {
        match button {
            "right" => 3,
            "middle" | "center" => 2,
            _ => 1,
        }
    }

    pub fn click(&mut self, x: f64, y: f64, button: &str, count: u32) -> DResult<()> {
        let (x, y) = self.clamp(x, y);
        let b = Self::button_code(button);
        self.fake(MOTION_NOTIFY, 0, x, y)?;
        for i in 0..count.clamp(1, 3) {
            if i > 0 {
                std::thread::sleep(Duration::from_millis(40));
            }
            self.fake(BUTTON_PRESS, b, 0, 0)?;
            self.fake(BUTTON_RELEASE, b, 0, 0)?;
        }
        self.sync()
    }

    pub fn button(&mut self, button: &str, down: bool) -> DResult<()> {
        let b = Self::button_code(button);
        self.fake(if down { BUTTON_PRESS } else { BUTTON_RELEASE }, b, 0, 0)?;
        if down {
            self.pressed_buttons.push(b);
        } else {
            self.pressed_buttons.retain(|&p| p != b);
        }
        self.sync()
    }

    pub fn release_all(&mut self) -> DResult<()> {
        let buttons = std::mem::take(&mut self.pressed_buttons);
        for b in buttons {
            self.fake(BUTTON_RELEASE, b, 0, 0)?;
        }
        for code in self.modifier_codes.values().copied().collect::<Vec<_>>() {
            self.fake(KEY_RELEASE, code, 0, 0)?;
        }
        self.sync()
    }

    pub fn scroll(&mut self, x: f64, y: f64, direction: &str, amount: u32) -> DResult<()> {
        let (x, y) = self.clamp(x, y);
        let b = match direction {
            "up" => 4,
            "left" => 6,
            "right" => 7,
            _ => 5,
        };
        self.fake(MOTION_NOTIFY, 0, x, y)?;
        for _ in 0..amount.clamp(1, 50) {
            self.fake(BUTTON_PRESS, b, 0, 0)?;
            self.fake(BUTTON_RELEASE, b, 0, 0)?;
        }
        self.sync()
    }

    pub fn drag(&mut self, from: (f64, f64), to: (f64, f64), duration_ms: u64) -> DResult<()> {
        let (fx, fy) = self.clamp(from.0, from.1);
        let (tx, ty) = self.clamp(to.0, to.1);
        self.fake(MOTION_NOTIFY, 0, fx, fy)?;
        self.fake(BUTTON_PRESS, 1, 0, 0)?;
        self.sync()?;
        let steps = ((duration_ms / 16).max(4)).min(240) as i32;
        let pause = Duration::from_millis((duration_ms / steps as u64).max(1));
        for i in 1..=steps {
            let x = fx as i32 + (tx as i32 - fx as i32) * i / steps;
            let y = fy as i32 + (ty as i32 - fy as i32) * i / steps;
            self.fake(MOTION_NOTIFY, 0, x as i16, y as i16)?;
            self.conn.flush().map_err(internal("flush"))?;
            std::thread::sleep(pause);
        }
        self.fake(BUTTON_RELEASE, 1, 0, 0)?;
        self.sync()
    }

    fn keycode_for(&mut self, keysym: u32) -> DResult<(u8, bool)> {
        if let Some(&(code, level)) = self.keymap.get(&keysym) {
            return Ok((code, level == 1));
        }
        // Bind the keysym to a scratch keycode, as xdotool does, so any
        // character can be typed whatever the layout.
        if self.scratch.is_empty() {
            return Err(DriverError::new(code::INVALID_ARGUMENT, format!("The lane keyboard cannot type keysym 0x{keysym:x}.")));
        }
        let slot = self.scratch[self.scratch_next % self.scratch.len()];
        self.scratch_next += 1;
        self.keymap.retain(|_, v| v.0 != slot);
        let per = self.keysyms_per_keycode as usize;
        let syms = vec![keysym; per];
        self.conn
            .change_keyboard_mapping(1, slot, per as u8, &syms)
            .map_err(internal("keymap"))?;
        self.sync()?;
        // Clients refresh their keymap on MappingNotify; give them a moment.
        std::thread::sleep(Duration::from_millis(15));
        self.keymap.insert(keysym, (slot, 0));
        Ok((slot, false))
    }

    pub fn press_keysym(&mut self, keysym: u32, modifiers: &[u32]) -> DResult<()> {
        let (code, shift) = self.keycode_for(keysym)?;
        let mut held: Vec<u8> = Vec::new();
        for m in modifiers {
            if let Some(&mc) = self.modifier_codes.get(m) {
                held.push(mc);
            }
        }
        if shift {
            if let Some(&sc) = self.modifier_codes.get(&keys::SHIFT_L) {
                if !held.contains(&sc) {
                    held.push(sc);
                }
            }
        }
        for &mc in &held {
            self.fake(KEY_PRESS, mc, 0, 0)?;
        }
        self.fake(KEY_PRESS, code, 0, 0)?;
        self.fake(KEY_RELEASE, code, 0, 0)?;
        for &mc in held.iter().rev() {
            self.fake(KEY_RELEASE, mc, 0, 0)?;
        }
        self.sync()
    }

    pub fn press_named(&mut self, key: &str, modifiers: &[String]) -> DResult<()> {
        let keysym = keys::keysym_for_name(key)
            .ok_or_else(|| DriverError::new(code::INVALID_ARGUMENT, format!("\"{key}\" is not a key name this driver knows.")))?;
        let mods: Vec<u32> = modifiers.iter().filter_map(|m| keys::modifier_keysym(m)).collect();
        self.press_keysym(keysym, &mods)
    }

    pub fn type_text(&mut self, text: &str) -> DResult<()> {
        for ch in text.chars() {
            let keysym = keys::keysym_for_char(ch);
            self.press_keysym(keysym, &[])?;
            // A short pause per character: an editor that batches input
            // (a canvas, a terminal) keeps up, and a long text stays bounded.
            std::thread::sleep(Duration::from_millis(2));
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Pixels
    // -----------------------------------------------------------------------

    /// The whole display as tightly packed RGB.
    pub fn capture_rgb(&self, with_cursor: bool) -> DResult<(u32, u32, Vec<u8>)> {
        let (w, h) = (self.width as u32, self.height as u32);
        let bgrx = capture_bgrx(&self.conn, self.root, self.width, self.height)?;
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for px in bgrx.chunks_exact(4) {
            rgb.extend_from_slice(&[px[2], px[1], px[0]]);
        }
        if with_cursor {
            overlay_cursor_rgb(&self.conn, &mut rgb, w, h);
        }
        Ok((w, h, rgb))
    }
}

/// Frames through MIT-SHM: the X server writes the root window straight into
/// memory this process maps, instead of streaming 8 MB per 1080p frame over
/// the socket. Falls back to plain GetImage when the server refuses.
pub struct ShmCapture {
    seg: u32,
    addr: *mut u8,
    size: usize,
    width: u16,
    height: u16,
}

unsafe impl Send for ShmCapture {}

impl ShmCapture {
    pub fn new(conn: &RustConnection, width: u16, height: u16) -> Option<ShmCapture> {
        use x11rb::protocol::shm::ConnectionExt as _;
        conn.shm_query_version().ok()?.reply().ok()?;
        let size = width as usize * height as usize * 4;
        unsafe {
            let id = libc::shmget(libc::IPC_PRIVATE, size, libc::IPC_CREAT | 0o600);
            if id < 0 {
                return None;
            }
            let addr = libc::shmat(id, std::ptr::null(), 0);
            if addr as isize == -1 {
                libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
                return None;
            }
            let seg = conn.generate_id().ok()?;
            let attached = conn.shm_attach(seg, id as u32, false).ok().map(|c| c.check().is_ok()).unwrap_or(false);
            // Marked for removal now: the segment goes away with the last
            // detach, even if this process is killed.
            libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
            if !attached {
                libc::shmdt(addr);
                return None;
            }
            Some(ShmCapture { seg, addr: addr as *mut u8, size, width, height })
        }
    }

    pub fn capture(&self, conn: &RustConnection, root: Window, out: &mut Vec<u8>) -> DResult<()> {
        use x11rb::protocol::shm::ConnectionExt as _;
        conn.shm_get_image(root, 0, 0, self.width, self.height, u32::MAX, ImageFormat::Z_PIXMAP.into(), self.seg, 0)
            .map_err(internal("shm_get_image"))?
            .reply()
            .map_err(internal("shm_get_image"))?;
        out.clear();
        out.extend_from_slice(unsafe { std::slice::from_raw_parts(self.addr, self.size) });
        Ok(())
    }

    pub fn release(&self, conn: &RustConnection) {
        use x11rb::protocol::shm::ConnectionExt as _;
        let _ = conn.shm_detach(self.seg);
        let _ = conn.flush();
        unsafe {
            libc::shmdt(self.addr as *const libc::c_void);
        }
    }
}

/// The root window as BGRX, 4 bytes a pixel. Large reads go in bands so no
/// single reply passes the server's maximum request length.
pub fn capture_bgrx(conn: &RustConnection, root: Window, width: u16, height: u16) -> DResult<Vec<u8>> {
    let mut out = Vec::with_capacity(width as usize * height as usize * 4);
    let band: u16 = 256;
    let mut y = 0u16;
    while y < height {
        let h = band.min(height - y);
        let reply = conn
            .get_image(ImageFormat::Z_PIXMAP, root, 0, y as i16, width, h, u32::MAX)
            .map_err(internal("get_image"))?
            .reply()
            .map_err(internal("get_image"))?;
        if reply.data.len() < width as usize * h as usize * 4 {
            return Err(DriverError::new(code::DISPLAY_UNAVAILABLE, "The lane display returned a short frame (not 24-bit?)."));
        }
        out.extend_from_slice(&reply.data[..width as usize * h as usize * 4]);
        y += h;
    }
    Ok(out)
}

/// Draws the current cursor (XFixes) onto an RGB frame. Xvfb never draws the
/// cursor into its framebuffer, so a viewer would otherwise see none.
pub fn overlay_cursor_rgb(conn: &RustConnection, rgb: &mut [u8], w: u32, h: u32) {
    blend_cursor(conn, w, h, |idx, r, g, b, a| {
        let o = idx * 3;
        rgb[o] = blend(rgb[o], r, a);
        rgb[o + 1] = blend(rgb[o + 1], g, a);
        rgb[o + 2] = blend(rgb[o + 2], b, a);
    });
}

pub fn overlay_cursor_bgrx(conn: &RustConnection, bgrx: &mut [u8], w: u32, h: u32) {
    blend_cursor(conn, w, h, |idx, r, g, b, a| {
        let o = idx * 4;
        bgrx[o] = blend(bgrx[o], b, a);
        bgrx[o + 1] = blend(bgrx[o + 1], g, a);
        bgrx[o + 2] = blend(bgrx[o + 2], r, a);
    });
}

fn blend(dst: u8, src_premul: u8, a: u8) -> u8 {
    (src_premul as u32 + dst as u32 * (255 - a as u32) / 255).min(255) as u8
}

fn blend_cursor(conn: &RustConnection, w: u32, h: u32, mut put: impl FnMut(usize, u8, u8, u8, u8)) {
    let Some(cursor) = conn.xfixes_get_cursor_image().ok().and_then(|c| c.reply().ok()) else { return };
    let (cw, ch) = (cursor.width as i32, cursor.height as i32);
    let ox = cursor.x as i32 - cursor.xhot as i32;
    let oy = cursor.y as i32 - cursor.yhot as i32;
    for cy in 0..ch {
        for cx in 0..cw {
            let argb = cursor.cursor_image[(cy * cw + cx) as usize];
            let a = (argb >> 24) as u8;
            if a == 0 {
                continue;
            }
            let (x, y) = (ox + cx, oy + cy);
            if x < 0 || y < 0 || x >= w as i32 || y >= h as i32 {
                continue;
            }
            put((y as u32 * w + x as u32) as usize, (argb >> 16) as u8, (argb >> 8) as u8, argb as u8, a);
        }
    }
}
