/**
 * The story film: frames of the real ADE app, captured by
 * `apps/desktop/scripts/demo/capture-film.mjs` and encoded by `encode-film.mjs`
 * into `/film/`. The scroll picks a frame; nothing plays on a timer, so every
 * scroll step moves the story and scrolling back plays it backwards.
 *
 * Everything here is in "world" pixels: the app's own window is the rect
 * (0, 0, 1512, 982), and the other machines of the map sit around it. A camera
 * is a rect in world pixels that the stage fills.
 */
import { useEffect, useState } from "react";

export type Rect = [number, number, number, number];

export type FilmShot = {
  name: string;
  frames: number;
  /** Per frame: pointer x, y and flags (1 visible, 2 click, 4 right click). */
  cursor: Array<[number, number, number]>;
  cams: Array<{ f: number; rect: Rect; ease: number }>;
  marks: Record<string, { f: number; [key: string]: unknown }>;
};

export type Film = { width: number; height: number; scale: number; fps: number; shots: FilmShot[] };

export const APP: Rect = [0, 0, 1512, 982];

export function useFilmManifest(): Film | null {
  const [film, setFilm] = useState<Film | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/film/film.json")
      .then((response) => (response.ok ? response.json() : null))
      .then((data: Film | null) => {
        if (alive && data?.shots?.length) setFilm(data);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return film;
}

/* ── Timeline ────────────────────────────────────────────────────────── */

export type Segment =
  | { kind: "shot"; start: number; units: number; shot: FilmShot }
  | { kind: "ring"; start: number; units: number }
  | { kind: "network"; start: number; units: number };

export const PAGE_UNITS = { ring: 96, network: 60 };

/** Shots that play on the other machines' screens, not on the main stage. */
export const SCREEN_SHOTS = ["studio", "windows"];

/** The story order: the ring of providers, the app's shots, and the map of machines at the end. */
export function buildTimeline(film: Film): { segments: Segment[]; total: number } {
  const segments: Segment[] = [];
  let at = 0;
  const shot = (name: string) => {
    const found = film.shots.find((s) => s.name === name);
    if (!found) return;
    segments.push({ kind: "shot", start: at, units: found.frames, shot: found });
    at += found.frames;
  };
  const page = (kind: "ring" | "network") => {
    segments.push({ kind, start: at, units: PAGE_UNITS[kind] });
    at += PAGE_UNITS[kind];
  };
  page("ring");
  shot("start");
  shot("compose");
  shot("machines");
  page("network");
  return { segments, total: at };
}

export function segmentAt(segments: Segment[], u: number): { segment: Segment; local: number; index: number } {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (u >= segment.start || index === 0) return { segment, local: Math.max(0, u - segment.start), index };
  }
  return { segment: segments[0]!, local: 0, index: 0 };
}

/** Where a shot's named moment sits on the timeline. */
export function markUnit(segments: Segment[], shotName: string, mark: string): number {
  const segment = segments.find((s) => s.kind === "shot" && s.shot.name === shotName);
  if (!segment || segment.kind !== "shot") return 0;
  return segment.start + (segment.shot.marks[mark]?.f ?? 0);
}

export function shotMark<T = number[]>(film: Film, shotName: string, mark: string, key: string): T | null {
  const value = film.shots.find((s) => s.name === shotName)?.marks[mark]?.[key];
  return (value as T) ?? null;
}

/* ── Easing and rects ────────────────────────────────────────────────── */

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOut = (t: number) => 1 - (1 - t) ** 3;
/** 0 before `a`, 1 after `b`, eased between. */
export const span = (v: number, a: number, b: number) => easeInOut(clamp01((v - a) / (b - a)));

/** Moves between two camera rects: the centre glides, the size zooms evenly. */
export function mixRect(a: Rect, b: Rect, t: number): Rect {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const ca = [a[0] + a[2] / 2, a[1] + a[3] / 2];
  const cb = [b[0] + b[2] / 2, b[1] + b[3] / 2];
  const w = a[2] * (b[2] / a[2]) ** t;
  const h = a[3] * (b[3] / a[3]) ** t;
  const cx = ca[0]! + (cb[0]! - ca[0]!) * t;
  const cy = ca[1]! + (cb[1]! - ca[1]!) * t;
  return [cx - w / 2, cy - h / 2, w, h];
}

/** The camera of a shot at fractional frame `f`, starting from `from` (where the last segment left it). */
export function shotCamera(shot: FilmShot, f: number, from: Rect): Rect {
  let rect = from;
  for (let i = 0; i < shot.cams.length; i += 1) {
    const cam = shot.cams[i]!;
    if (f < cam.f) break;
    // A shot's opening camera eases in from wherever the story was.
    const ease = i === 0 && cam.ease === 0 ? 24 : cam.ease;
    rect = mixRect(rect, cam.rect, ease === 0 ? 1 : easeInOut(clamp01((f - cam.f) / ease)));
  }
  return rect;
}

export function shotEndCamera(shot: FilmShot, from: Rect): Rect {
  return shotCamera(shot, shot.frames + 1000, from);
}

/** Pointer at fractional frame `f`, eased between captured frames. */
export function pointerAt(shot: FilmShot, f: number): { x: number; y: number; visible: boolean; click: number; right: boolean } {
  const i = Math.max(0, Math.min(shot.cursor.length - 1, Math.floor(f)));
  const j = Math.min(shot.cursor.length - 1, i + 1);
  const t = clamp01(f - i);
  const a = shot.cursor[i]!;
  const b = shot.cursor[j]!;
  let click = -1;
  let right = false;
  for (let k = i; k >= Math.max(0, i - 8); k -= 1) {
    if (shot.cursor[k]![2] & 2) {
      click = (f - k) / 8;
      right = Boolean(shot.cursor[k]![2] & 4);
      break;
    }
  }
  return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, visible: Boolean(a[2] & 1), click, right };
}
