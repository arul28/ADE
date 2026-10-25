//! What `app.launch` starts for a target: an app name, a path, a .desktop
//! entry, or a URL.

use crate::procs::{is_executable, which};
use crate::protocol::{code, DResult, DriverError};
use std::path::{Path, PathBuf};

pub struct LaunchPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub app_name: String,
    pub bundle_id: String,
    pub profile_dir: Option<PathBuf>,
    pub env: Vec<(String, String)>,
}

const BROWSERS: [&str; 8] = [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "microsoft-edge",
    "microsoft-edge-stable",
    "brave-browser",
    "firefox",
];

fn is_url(target: &str) -> bool {
    let lower = target.to_ascii_lowercase();
    ["http://", "https://", "file://", "about:", "chrome://"].iter().any(|p| lower.starts_with(p))
        || (lower.contains('.') && !lower.contains(' ') && !lower.contains('/') && lower.starts_with("www."))
}

fn is_chromium(program: &Path) -> bool {
    let name = program.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
    ["chrome", "chromium", "edge", "brave"].iter().any(|b| name.contains(b))
}

fn is_firefox(program: &Path) -> bool {
    program.file_name().and_then(|n| n.to_str()).map(|n| n.contains("firefox")).unwrap_or(false)
}

/// An Electron app ships `resources/app.asar` (or `resources/app`) beside its
/// binary. Electron honours Chromium's switches.
fn is_electron(program: &Path) -> bool {
    let real = std::fs::canonicalize(program).unwrap_or_else(|_| program.to_path_buf());
    let Some(dir) = real.parent() else { return false };
    dir.join("resources/app.asar").exists() || dir.join("resources/app").is_dir()
}

fn desktop_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/share/applications"));
    }
    let data = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| "/usr/local/share:/usr/share".into());
    for d in data.split(':').filter(|d| !d.is_empty()) {
        dirs.push(PathBuf::from(d).join("applications"));
    }
    dirs.push(PathBuf::from("/var/lib/snapd/desktop/applications"));
    dirs.push(PathBuf::from("/var/lib/flatpak/exports/share/applications"));
    dirs
}

struct DesktopEntry {
    name: String,
    exec: Vec<String>,
    id: String,
}

fn split_exec(exec: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = exec.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '\\' if quoted => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            ' ' | '\t' if !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            _ => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    // Field codes (%u, %F, ...) are for file managers; ADE passes its own args.
    out.into_iter().filter(|a| !(a.len() == 2 && a.starts_with('%'))).collect()
}

fn parse_desktop(path: &Path) -> Option<DesktopEntry> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut in_entry = false;
    let (mut name, mut exec, mut hidden) = (None, None, false);
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        if let Some(v) = line.strip_prefix("Name=") {
            name.get_or_insert(v.to_string());
        } else if let Some(v) = line.strip_prefix("Exec=") {
            exec.get_or_insert(v.to_string());
        } else if line == "NoDisplay=true" || line == "Hidden=true" {
            hidden = true;
        }
    }
    let exec = split_exec(&exec?);
    if exec.is_empty() {
        return None;
    }
    let _ = hidden;
    Some(DesktopEntry {
        name: name.unwrap_or_default(),
        exec,
        id: path.file_stem()?.to_string_lossy().to_string(),
    })
}

fn find_desktop(target: &str) -> Option<DesktopEntry> {
    let want = target.to_ascii_lowercase();
    let mut by_name: Option<DesktopEntry> = None;
    for dir in desktop_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            let stem = path.file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            if stem == want || stem.ends_with(&format!(".{want}")) {
                if let Some(d) = parse_desktop(&path) {
                    return Some(d);
                }
            }
            if by_name.is_none() {
                if let Some(d) = parse_desktop(&path) {
                    if d.name.to_ascii_lowercase() == want {
                        by_name = Some(d);
                    }
                }
            }
        }
    }
    by_name
}

fn alias(target: &str) -> Option<Vec<&'static str>> {
    let t = target.to_ascii_lowercase();
    Some(match t.as_str() {
        "chrome" | "google chrome" | "browser" | "web browser" => BROWSERS.to_vec(),
        "chromium" => vec!["chromium", "chromium-browser"],
        "edge" | "microsoft edge" => vec!["microsoft-edge", "microsoft-edge-stable"],
        "firefox" => vec!["firefox"],
        "terminal" | "xterm" => vec!["x-terminal-emulator", "xfce4-terminal", "gnome-terminal", "konsole", "xterm"],
        "files" | "file manager" => vec!["nautilus", "thunar", "pcmanfm", "dolphin"],
        "text editor" | "editor" | "gedit" => vec!["gnome-text-editor", "gedit", "mousepad", "xed", "kate"],
        "code" | "vs code" | "vscode" | "visual studio code" => vec!["code", "codium"],
        _ => return None,
    })
}

fn find_browser() -> Option<PathBuf> {
    BROWSERS.iter().find_map(|b| which(b))
}

pub fn plan(target: &str, extra: &[String], lane_dir: &Path, width: u16, height: u16) -> DResult<LaunchPlan> {
    let target = target.trim();
    if target.is_empty() {
        return Err(DriverError::new(code::INVALID_ARGUMENT, "Name an app, a path or a URL to open."));
    }
    let (program, mut args, app_name, bundle_id) = if is_url(target) {
        let browser = find_browser().ok_or_else(|| {
            DriverError::new(
                code::INVALID_ARGUMENT,
                "No browser is installed on this Linux machine. Install Google Chrome or Chromium, then open the URL again.",
            )
        })?;
        let url = if target.to_ascii_lowercase().starts_with("www.") { format!("https://{target}") } else { target.to_string() };
        let name = browser.file_name().unwrap().to_string_lossy().to_string();
        (browser, vec![url], name.clone(), name)
    } else if target.contains('/') && Path::new(target).exists() {
        let p = PathBuf::from(target);
        if p.extension().and_then(|e| e.to_str()) == Some("desktop") {
            let d = parse_desktop(&p).ok_or_else(|| DriverError::new(code::INVALID_ARGUMENT, format!("{target} has no Exec line.")))?;
            let program = which(&d.exec[0]).unwrap_or_else(|| PathBuf::from(&d.exec[0]));
            (program, d.exec[1..].to_vec(), d.name, d.id)
        } else if is_executable(&p) {
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            (p, Vec::new(), name.clone(), name)
        } else {
            let opener = which("xdg-open").or_else(|| which("gio")).ok_or_else(|| {
                DriverError::new(code::INVALID_ARGUMENT, format!("{target} is not a program, and xdg-open is not installed to open it."))
            })?;
            let args = if opener.ends_with("gio") { vec!["open".to_string(), target.to_string()] } else { vec![target.to_string()] };
            (opener, args, "xdg-open".into(), "xdg-open".into())
        }
    } else if let Some(found) = alias(target).and_then(|names| names.iter().find_map(|n| which(n))) {
        let name = found.file_name().unwrap().to_string_lossy().to_string();
        (found, Vec::new(), name.clone(), name)
    } else if let Some(found) = which(target).or_else(|| which(&target.to_ascii_lowercase().replace(' ', "-"))) {
        let name = found.file_name().unwrap().to_string_lossy().to_string();
        (found, Vec::new(), name.clone(), name)
    } else if let Some(d) = find_desktop(target) {
        let program = which(&d.exec[0]).unwrap_or_else(|| PathBuf::from(&d.exec[0]));
        (program, d.exec[1..].to_vec(), d.name, d.id)
    } else {
        return Err(DriverError::new(
            code::INVALID_ARGUMENT,
            format!("\"{target}\" is not an installed app on this Linux machine (not on PATH and no .desktop entry)."),
        ));
    };

    let mut env = vec![
        ("GDK_BACKEND".into(), "x11".into()),
        ("QT_QPA_PLATFORM".into(), "xcb".into()),
        ("XDG_SESSION_TYPE".into(), "x11".into()),
        ("MOZ_ENABLE_WAYLAND".into(), "0".into()),
        ("ELECTRON_OZONE_PLATFORM_HINT".into(), "x11".into()),
        ("ACCESSIBILITY_ENABLED".into(), "1".into()),
        ("NO_AT_BRIDGE".into(), "0".into()),
        ("QT_ACCESSIBILITY".into(), "1".into()),
        ("QT_LINUX_ACCESSIBILITY_ALWAYS_ON".into(), "1".into()),
    ];
    let root = unsafe { libc::geteuid() } == 0;
    let mut profile_dir = None;
    let mut prefix: Vec<String> = Vec::new();
    if is_chromium(&program) || is_electron(&program) {
        // The renderer only builds its accessibility tree when asked.
        prefix.push("--force-renderer-accessibility".into());
        prefix.push("--ozone-platform=x11".into());
        // Xvfb has no GPU, so Chromium composites every frame through
        // SwiftShader, a software GL. Software compositing draws the same
        // pixels for about a fifth of the CPU (Chrome scrolling a Wikipedia
        // page at 1080p on 2 vCPUs: 132% of a core to 28%), and WebGL keeps
        // working through the GPU process. An app's own GPU switch wins.
        if !args.iter().chain(extra.iter()).any(|a| a.starts_with("--disable-gpu") || a.starts_with("--enable-gpu") || a.starts_with("--use-gl") || a.starts_with("--use-angle")) {
            prefix.push("--disable-gpu-compositing".into());
        }
        if root {
            prefix.push("--no-sandbox".into());
        }
    }
    if is_chromium(&program) {
        // A lane-private profile: the agent's browsing never touches the
        // user's own profile, and a second lane's Chrome is a separate
        // instance instead of a tab in the first one.
        let dir = lane_dir.join("profiles").join(program.file_name().unwrap().to_string_lossy().to_string());
        let _ = std::fs::create_dir_all(&dir);
        clear_stale_chromium_lock(&dir);
        prefix.extend([
            format!("--user-data-dir={}", dir.display()),
            "--no-first-run".into(),
            "--no-default-browser-check".into(),
            "--password-store=basic".into(),
            "--disable-dev-shm-usage".into(),
            // A lane's Chrome is stopped with its screen; never greet the next
            // run with "Restore pages?".
            "--hide-crash-restore-bubble".into(),
            "--start-maximized".into(),
            format!("--window-size={width},{height}"),
            "--window-position=0,0".into(),
        ]);
        profile_dir = Some(dir);
    } else if is_firefox(&program) {
        let dir = lane_dir.join("profiles").join("firefox");
        let _ = std::fs::create_dir_all(&dir);
        prefix.extend(["--new-instance".into(), "--profile".into(), dir.display().to_string()]);
        profile_dir = Some(dir);
        env.push(("GNOME_ACCESSIBILITY".into(), "1".into()));
    }
    prefix.append(&mut args);
    prefix.extend(extra.iter().cloned());
    Ok(LaunchPlan { program, args: prefix, app_name, bundle_id, profile_dir, env })
}

/// Chromium locks its profile with a `SingletonLock` symlink naming
/// `<hostname>-<pid>`. A lock left by a Chrome that is gone (the helper was
/// killed, the machine rebooted, or a VM came back under a new hostname, as
/// cloud boxes do on resume) makes the next launch exit 21 with "profile in
/// use" and no window. Remove it when no live process on this host holds it.
fn clear_stale_chromium_lock(profile: &Path) {
    let lock = profile.join("SingletonLock");
    let Ok(target) = std::fs::read_link(&lock) else { return };
    let target = target.to_string_lossy().to_string();
    let (host, pid) = match target.rsplit_once('-') {
        Some((host, pid)) => (host.to_string(), pid.parse::<i32>().ok()),
        None => (String::new(), None),
    };
    let this_host = std::fs::read_to_string("/proc/sys/kernel/hostname").map(|h| h.trim().to_string()).unwrap_or_default();
    let alive = host == this_host
        && pid.map(|pid| pid > 0 && unsafe { libc::kill(pid, 0) } == 0).unwrap_or(false);
    if alive {
        return;
    }
    for name in ["SingletonLock", "SingletonCookie", "SingletonSocket"] {
        let _ = std::fs::remove_file(profile.join(name));
    }
}
