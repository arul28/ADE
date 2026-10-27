//! Key names and characters as X keysyms.

pub const SHIFT_L: u32 = 0xffe1;
pub const CONTROL_L: u32 = 0xffe3;
pub const ALT_L: u32 = 0xffe9;
pub const SUPER_L: u32 = 0xffeb;

/// ADE's modifier names. `cmd` is Control here, as on Windows: the shortcuts
/// an agent learns on a Mac (cmd+c, cmd+l) are control shortcuts on Linux.
pub fn modifier_keysym(name: &str) -> Option<u32> {
    match name.to_ascii_lowercase().as_str() {
        "shift" => Some(SHIFT_L),
        "cmd" | "command" | "control" | "ctrl" => Some(CONTROL_L),
        "option" | "opt" | "alt" => Some(ALT_L),
        "win" | "super" | "meta" => Some(SUPER_L),
        _ => None,
    }
}

pub fn keysym_for_name(name: &str) -> Option<u32> {
    let lower = name.to_ascii_lowercase();
    let ks = match lower.as_str() {
        "return" | "enter" => 0xff0d,
        "tab" => 0xff09,
        "space" => 0x20,
        "escape" | "esc" => 0xff1b,
        "backspace" => 0xff08,
        // ADE's `delete` is the Mac key of that name: backward delete.
        "delete" => 0xff08,
        "forwarddelete" | "forward_delete" | "del" => 0xffff,
        "up" | "uparrow" | "arrowup" => 0xff52,
        "down" | "downarrow" | "arrowdown" => 0xff54,
        "left" | "leftarrow" | "arrowleft" => 0xff51,
        "right" | "rightarrow" | "arrowright" => 0xff53,
        "home" => 0xff50,
        "end" => 0xff57,
        "pageup" | "page_up" => 0xff55,
        "pagedown" | "page_down" => 0xff56,
        "insert" => 0xff63,
        "menu" => 0xff67,
        "capslock" => 0xffe5,
        "printscreen" | "print" => 0xff61,
        _ => {
            if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u32>().ok()) {
                if (1..=24).contains(&n) {
                    return Some(0xffbe + n - 1);
                }
            }
            let mut chars = name.chars();
            match (chars.next(), chars.next()) {
                // A single letter is the unshifted key: `cmd+a`, not `cmd+A`.
                (Some(c), None) => return Some(keysym_for_char(c.to_ascii_lowercase())),
                _ => return None,
            }
        }
    };
    Some(ks)
}

pub fn keysym_for_char(c: char) -> u32 {
    let cp = c as u32;
    match c {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        '\u{8}' => 0xff08,
        _ if (0x20..=0x7e).contains(&cp) || (0xa0..=0xff).contains(&cp) => cp,
        _ => 0x0100_0000 | cp,
    }
}
