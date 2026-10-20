#!/usr/bin/env node
/**
 * Turns the frames from `capture-film.mjs` into the website's scroll film:
 * one H.264 video per shot, short keyframe spacing so the page can seek to
 * any frame quickly, a poster of each shot's first frame, the machine
 * stills, and `film.json` (the capture's frame data).
 *
 *   node scripts/demo/encode-film.mjs [--in <OS temp dir>/ade-film] [--out ../web/public/film]
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const IN = path.resolve(arg("in", path.join(os.tmpdir(), "ade-film")));
const OUT = path.resolve(arg("out", path.join(here, "../../../web/public/film")));
/** Frames per second the videos are stamped with; the page seeks by frame, so this only sets the time scale. */
const FPS = 30;

function ffmpeg(args) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit", windowsHide: true });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
}

const film = JSON.parse(await fs.readFile(path.join(IN, "film.json"), "utf8"));
await fs.mkdir(OUT, { recursive: true });

for (const shot of film.shots) {
  const frames = path.join(IN, shot.name, "%04d.jpg");
  ffmpeg([
    "-framerate", String(FPS), "-i", frames,
    // 2560 wide keeps text sharp at the camera's closest zoom on a 2x screen.
    "-vf", "scale=2560:-2",
    "-c:v", "libx264", "-preset", "slow", "-crf", "26",
    // A keyframe every 12 frames and no B-frames: any frame decodes from at most 11 others.
    "-g", "12", "-bf", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    path.join(OUT, `${shot.name}.mp4`),
  ]);
  ffmpeg(["-i", path.join(IN, shot.name, "0000.jpg"), "-q:v", "4", path.join(OUT, `${shot.name}.jpg`)]);
  const last = String(shot.frames - 1).padStart(4, "0");
  ffmpeg(["-i", path.join(IN, shot.name, `${last}.jpg`), "-q:v", "4", path.join(OUT, `${shot.name}-end.jpg`)]);
  const { size } = await fs.stat(path.join(OUT, `${shot.name}.mp4`));
  console.log(`[film] ${shot.name}.mp4: ${shot.frames} frames, ${(size / 1e6).toFixed(1)} MB`);
}

/** Frames the page also shows as pictures: on phones, and before the videos load. */
const MARK_STILLS = { start: ["custom"], compose: ["typed", "done"], machines: ["typed"] };
for (const shot of film.shots) {
  for (const mark of MARK_STILLS[shot.name] ?? []) {
    const f = shot.marks[mark]?.f;
    if (f == null) continue;
    const frame = String(Math.min(shot.frames - 1, f + 2)).padStart(4, "0");
    ffmpeg(["-i", path.join(IN, shot.name, `${frame}.jpg`), "-q:v", "4", path.join(OUT, `${shot.name}-${mark}.jpg`)]);
  }
}

for (const still of await fs.readdir(path.join(IN, "stills")).catch(() => [])) {
  ffmpeg(["-i", path.join(IN, "stills", still), "-vf", "scale=1512:-2", "-q:v", "4", path.join(OUT, still)]);
}

await fs.writeFile(path.join(OUT, "film.json"), JSON.stringify({ ...film, fps: FPS }) + "\n");
console.log(`[film] wrote ${OUT}`);
