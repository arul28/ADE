//! PNG files and the numbered element map.

use crate::protocol::{internal, DResult};
use std::io::BufWriter;
use std::path::Path;

pub fn write_png(path: &Path, width: u32, height: u32, rgb: &[u8]) -> DResult<u64> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("png.partial");
    {
        let file = std::fs::File::create(&tmp).map_err(internal("screenshot file"))?;
        let mut enc = png::Encoder::new(BufWriter::new(file), width, height);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        // Fast: a screenshot is read once by a model, not archived.
        enc.set_compression(png::Compression::Fast);
        enc.set_filter(png::FilterType::Sub);
        let mut writer = enc.write_header().map_err(internal("png"))?;
        writer.write_image_data(rgb).map_err(internal("png"))?;
    }
    std::fs::rename(&tmp, path).map_err(internal("screenshot file"))?;
    Ok(std::fs::metadata(path).map(|m| m.len()).unwrap_or(0))
}

const DIGITS: [[u8; 5]; 10] = [
    [0b111, 0b101, 0b101, 0b101, 0b111],
    [0b010, 0b110, 0b010, 0b010, 0b111],
    [0b111, 0b001, 0b111, 0b100, 0b111],
    [0b111, 0b001, 0b111, 0b001, 0b111],
    [0b101, 0b101, 0b111, 0b001, 0b001],
    [0b111, 0b100, 0b111, 0b001, 0b111],
    [0b111, 0b100, 0b111, 0b101, 0b111],
    [0b111, 0b001, 0b010, 0b010, 0b010],
    [0b111, 0b101, 0b111, 0b101, 0b111],
    [0b111, 0b101, 0b111, 0b001, 0b111],
];

pub struct Canvas<'a> {
    pub w: i32,
    pub h: i32,
    pub rgb: &'a mut [u8],
}

impl Canvas<'_> {
    fn put(&mut self, x: i32, y: i32, c: [u8; 3]) {
        if x < 0 || y < 0 || x >= self.w || y >= self.h {
            return;
        }
        let o = ((y * self.w + x) * 3) as usize;
        self.rgb[o..o + 3].copy_from_slice(&c);
    }

    pub fn fill(&mut self, x: i32, y: i32, w: i32, h: i32, c: [u8; 3]) {
        for yy in y..y + h {
            for xx in x..x + w {
                self.put(xx, yy, c);
            }
        }
    }

    pub fn rect(&mut self, x: i32, y: i32, w: i32, h: i32, c: [u8; 3]) {
        for t in 0..2 {
            self.fill(x, y + t, w, 1, c);
            self.fill(x, y + h - 1 - t, w, 1, c);
            self.fill(x + t, y, 1, h, c);
            self.fill(x + w - 1 - t, y, 1, h, c);
        }
    }

    /// A number in a filled tag at (x, y): what the agent reads off the map.
    pub fn label(&mut self, x: i32, y: i32, n: usize, bg: [u8; 3]) {
        let text = n.to_string();
        let scale = 2;
        let tw = text.len() as i32 * 4 * scale + scale;
        let th = 5 * scale + 2 * scale;
        self.fill(x, y, tw, th, bg);
        for (i, ch) in text.bytes().enumerate() {
            let glyph = DIGITS[(ch - b'0') as usize];
            for (row, bits) in glyph.iter().enumerate() {
                for col in 0..3 {
                    if bits & (0b100 >> col) != 0 {
                        self.fill(
                            x + scale + (i as i32 * 4 + col) * scale,
                            y + scale + row as i32 * scale,
                            scale,
                            scale,
                            [255, 255, 255],
                        );
                    }
                }
            }
        }
    }
}

pub const PALETTE: [[u8; 3]; 6] = [[220, 38, 38], [37, 99, 235], [22, 163, 74], [202, 138, 4], [147, 51, 234], [219, 39, 119]];
