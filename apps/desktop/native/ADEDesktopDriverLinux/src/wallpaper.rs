//! The lane screen's wallpaper: ADE's dark backdrop with the ADE mark.
//!
//! An empty Xvfb screen in one flat colour reads as a dead screen. This paints
//! a still picture in ADE's own colours instead: the dark canvas lit by the
//! violet, indigo and lavender lobes of ADE's backdrop gradient (the dark
//! theme's `WorkToolPickerBackdrop` palette), with the ADE mark in the middle.
//!
//! It is painted once, when the lane's screen starts. The picture becomes the
//! root window's background pixmap, so the X server repaints uncovered areas
//! by itself and nothing here runs again: no timer, no CPU while idle, and a
//! still picture for the encoder. It is not a window, so neither the window
//! list nor the accessibility tree sees it.

use crate::protocol::{code, internal, DResult, DriverError};
use crate::xconn::XConn;
use x11rb::connection::{Connection, RequestConnection as _};
use x11rb::protocol::xproto::{self, ConnectionExt as _, ImageFormat, ImageOrder};

/// ADE's dark canvas (`--color-bg`, `#0C0B10`): the picture's base, and the
/// flat colour the screen keeps when the picture cannot be painted.
pub const BASE: u32 = 0x0c0b10;

/// The ADE mark (`renderer/public/logo.png` at 720 px wide, its faint outer
/// glow removed so it does not draw a haze on a dark screen).
const MARK_PNG: &[u8] = include_bytes!("../assets/ade-mark.png");

/// How much of the mark shows through: a wallpaper, not a sign.
const MARK_OPACITY: f32 = 0.55;

struct Lobe {
    x: f32,
    y: f32,
    inv_r2: f32,
    color: [f32; 3],
    strength: f32,
}

/// Paints the wallpaper onto the lane's root window. On any failure the screen
/// keeps the flat [`BASE`] colour the caller set first.
pub fn paint(x: &XConn) -> DResult<()> {
    let conn = &x.conn;
    let setup = conn.setup();
    let depth = setup.roots[0].root_depth;
    let bpp = setup.pixmap_formats.iter().find(|f| f.depth == depth).map(|f| f.bits_per_pixel).unwrap_or(0);
    // The lane's Xvfb is `WxHx24`: 32 bits a pixel, BGRX in memory. Anything
    // else is not a screen this helper started.
    if depth != 24 || bpp != 32 || setup.image_byte_order != ImageOrder::LSB_FIRST {
        return Err(DriverError::new(
            code::INTERNAL_ERROR,
            format!("wallpaper: the display is {depth}-bit at {bpp} bits a pixel, not 24-bit"),
        ));
    }
    let (w, h) = (x.width as u32, x.height as u32);
    let mut pixels = backdrop(w, h);
    if let Some(mark) = decode_mark() {
        draw_mark(&mut pixels, w, h, &mark);
    }

    let pixmap = conn.generate_id().map_err(internal("wallpaper"))?;
    conn.create_pixmap(depth, pixmap, x.root, x.width, x.height).map_err(internal("wallpaper"))?;
    let gc = conn.generate_id().map_err(internal("wallpaper"))?;
    conn.create_gc(gc, pixmap, &xproto::CreateGCAux::new()).map_err(internal("wallpaper"))?;
    let result = upload(x, pixmap, gc, depth, &pixels);
    // The root window holds its own reference to its background: the pixmap
    // and the GC can go now, whatever happened in the upload.
    let _ = conn.free_gc(gc);
    let _ = conn.free_pixmap(pixmap);
    if result.is_ok() {
        let _ = conn.clear_area(false, x.root, 0, 0, 0, 0);
    }
    let _ = conn.flush();
    result
}

/// Copies the BGRX picture into `pixmap` and makes it the root background.
/// Bands stay under the server's request limit (8 MB is one band with
/// BIG-REQUESTS, about 34 rows of 1080p without it). Each request is checked,
/// so a refused upload never becomes a background of uninitialised memory.
fn upload(x: &XConn, pixmap: u32, gc: u32, depth: u8, pixels: &[u8]) -> DResult<()> {
    let conn = &x.conn;
    let (w, h) = (x.width as usize, x.height as usize);
    let row = w * 4;
    let rows = (conn.maximum_request_bytes().saturating_sub(64) / row).clamp(1, h);
    let mut y = 0usize;
    while y < h {
        let n = rows.min(h - y);
        conn.put_image(ImageFormat::Z_PIXMAP, pixmap, gc, x.width, n as u16, 0, y as i16, 0, depth, &pixels[y * row..(y + n) * row])
            .map_err(internal("wallpaper"))?
            .check()
            .map_err(internal("wallpaper"))?;
        y += n;
    }
    conn.change_window_attributes(x.root, &xproto::ChangeWindowAttributesAux::new().background_pixmap(pixmap))
        .map_err(internal("wallpaper"))?
        .check()
        .map_err(internal("wallpaper"))?;
    Ok(())
}

/// The backdrop as BGRX: ADE's dark base, mixed towards each lobe's colour by
/// a smooth falloff, then a soft vignette. Sizes are relative to the screen,
/// so every lane size (640x480 to 3840x2160) gets the same composition.
fn backdrop(w: u32, h: u32) -> Vec<u8> {
    let (wf, hf) = (w as f32, h as f32);
    let span = wf.max(hf);
    let lobe = |x: f32, y: f32, r: f32, color: [f32; 3], strength: f32| Lobe {
        x: x * wf,
        y: y * hf,
        inv_r2: 1.0 / (r * span * r * span),
        color,
        strength,
    };
    let lobes = [
        // `--color-accent-deep` violet, from the lower left.
        lobe(0.10, 0.98, 0.85, [124.0, 58.0, 237.0], 0.42),
        // Indigo, the cooler second lobe, from the upper right.
        lobe(0.94, 0.02, 0.70, [99.0, 102.0, 241.0], 0.30),
        // `--color-accent` lavender, a faint light behind the mark.
        lobe(0.55, 0.62, 0.42, [167.0, 139.0, 250.0], 0.10),
    ];
    let base = [((BASE >> 16) & 0xff) as f32, ((BASE >> 8) & 0xff) as f32, (BASE & 0xff) as f32];
    let mut out = vec![0u8; (w * h * 4) as usize];
    for py in 0..h {
        let fy = py as f32 + 0.5;
        let vy = (fy / hf - 0.5) * 2.0;
        for px in 0..w {
            let fx = px as f32 + 0.5;
            let mut c = base;
            for l in &lobes {
                let (dx, dy) = (fx - l.x, fy - l.y);
                let t = 1.0 - (dx * dx + dy * dy) * l.inv_r2;
                if t > 0.0 {
                    let f = t * t * l.strength;
                    for (channel, target) in c.iter_mut().zip(l.color) {
                        *channel += (target - *channel) * f;
                    }
                }
            }
            let vx = (fx / wf - 0.5) * 2.0;
            let v = 1.0 - 0.24 * ((vx * vx + vy * vy) * 0.5).min(1.0);
            let o = ((py * w + px) * 4) as usize;
            out[o] = (c[2] * v).round().clamp(0.0, 255.0) as u8;
            out[o + 1] = (c[1] * v).round().clamp(0.0, 255.0) as u8;
            out[o + 2] = (c[0] * v).round().clamp(0.0, 255.0) as u8;
        }
    }
    out
}

/// The mark as premultiplied RGBA, with its size.
struct Mark {
    w: usize,
    h: usize,
    rgba: Vec<f32>,
}

fn decode_mark() -> Option<Mark> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(MARK_PNG));
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return None;
    }
    let (w, h) = (info.width as usize, info.height as usize);
    let mut rgba = Vec::with_capacity(w * h * 4);
    for px in buf[..info.line_size * h].chunks_exact(4).take(w * h) {
        let a = px[3] as f32 / 255.0;
        rgba.extend_from_slice(&[px[0] as f32 * a, px[1] as f32 * a, px[2] as f32 * a, a]);
    }
    Some(Mark { w, h, rgba })
}

/// The mark, centred a little above the middle, about a quarter of the
/// screen's width (never taller than half the screen), scaled bilinearly.
fn draw_mark(out: &mut [u8], w: u32, h: u32, mark: &Mark) {
    let (wf, hf) = (w as f32, h as f32);
    let aspect = mark.w as f32 / mark.h as f32;
    let mw = (wf * 0.28).min(hf * 0.5 * aspect).clamp(64.0, 1000.0);
    let mh = mw / aspect;
    let (mw, mh) = (mw.round() as i64, mh.round() as i64);
    let left = (w as i64 - mw) / 2;
    let top = (hf * 0.46) as i64 - mh / 2;
    let (sx, sy) = (mark.w as f32 / mw as f32, mark.h as f32 / mh as f32);
    let sample = |x: usize, y: usize, i: usize| mark.rgba[(y * mark.w + x) * 4 + i];
    for ty in 0..mh {
        let oy = top + ty;
        if oy < 0 || oy >= h as i64 {
            continue;
        }
        let fy = ((ty as f32 + 0.5) * sy - 0.5).max(0.0);
        let y0 = (fy as usize).min(mark.h - 1);
        let y1 = (y0 + 1).min(mark.h - 1);
        let wy = fy - y0 as f32;
        for tx in 0..mw {
            let ox = left + tx;
            if ox < 0 || ox >= w as i64 {
                continue;
            }
            let fx = ((tx as f32 + 0.5) * sx - 0.5).max(0.0);
            let x0 = (fx as usize).min(mark.w - 1);
            let x1 = (x0 + 1).min(mark.w - 1);
            let wx = fx - x0 as f32;
            let mut s = [0.0f32; 4];
            for (i, v) in s.iter_mut().enumerate() {
                let top_row = sample(x0, y0, i) * (1.0 - wx) + sample(x1, y0, i) * wx;
                let bottom_row = sample(x0, y1, i) * (1.0 - wx) + sample(x1, y1, i) * wx;
                *v = top_row * (1.0 - wy) + bottom_row * wy;
            }
            let a = s[3] * MARK_OPACITY;
            if a <= 0.002 {
                continue;
            }
            let o = ((oy as u32 * w + ox as u32) * 4) as usize;
            // BGRX: the mark's premultiplied R, G, B over what is there.
            for (dst, src) in [(o + 2, s[0]), (o + 1, s[1]), (o, s[2])] {
                out[dst] = (src * MARK_OPACITY + out[dst] as f32 * (1.0 - a)).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
}
