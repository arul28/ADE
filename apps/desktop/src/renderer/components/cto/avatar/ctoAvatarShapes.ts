import type { CtoAvatarShape } from "../../../../shared/types/cto";

/**
 * The CTO's bodies, drawn in a 100 × 100 box.
 *
 * Each silhouette is a hand-placed list of points: organic shapes run a
 * closed Catmull-Rom curve through theirs, hard-edged ones round the corners
 * of a polygon. Every body sits on the same floor (y ≈ 86) and fills roughly
 * the same area, so swapping shapes never makes the CTO look bigger or
 * smaller. `eyes` is where the face goes on that body: the centre of the eye
 * line, the distance between the two eyes, and a scale for a small face.
 */

export type CtoAvatarShapeSpec = {
  /** The body outline. */
  path: string;
  /** Extra parts drawn behind the body in the body colour (the chip's pins). */
  extras?: string;
  eyes: { x: number; y: number; gap: number; scale: number };
};

type Point = readonly [number, number];

const round = (value: number) => Math.round(value * 100) / 100;

/** A smooth closed curve through every point (uniform Catmull-Rom as cubic Béziers). */
function smoothClosed(points: readonly Point[]): string {
  const n = points.length;
  const at = (index: number) => points[(index + n) % n]!;
  let d = `M ${round(at(0)[0])} ${round(at(0)[1])}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${round(c1x)} ${round(c1y)} ${round(c2x)} ${round(c2y)} ${round(p2[0])} ${round(p2[1])}`;
  }
  return `${d} Z`;
}

/** A polygon whose corners are rounded with radius `r`. */
function roundedPolygon(points: readonly Point[], r: number): string {
  const n = points.length;
  const at = (index: number) => points[(index + n) % n]!;
  const toward = (from: Point, to: Point, distance: number): Point => {
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    const length = Math.hypot(dx, dy) || 1;
    return [from[0] + (dx / length) * distance, from[1] + (dy / length) * distance];
  };
  let d = "";
  for (let i = 0; i < n; i += 1) {
    const corner = at(i);
    const enter = toward(corner, at(i - 1), r);
    const leave = toward(corner, at(i + 1), r);
    d += `${i === 0 ? "M" : " L"} ${round(enter[0])} ${round(enter[1])}`;
    d += ` Q ${round(corner[0])} ${round(corner[1])} ${round(leave[0])} ${round(leave[1])}`;
  }
  return `${d} Z`;
}

function hexagon(cx: number, cy: number, radius: number): Point[] {
  return Array.from({ length: 6 }, (_, i) => {
    const angle = (Math.PI / 3) * i;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;
  });
}

function rect(x: number, y: number, w: number, h: number, r: number): string {
  return roundedPolygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], r);
}

export const CTO_AVATAR_SHAPE_SPECS: Record<CtoAvatarShape, CtoAvatarShapeSpec> = {
  // A river stone: a little fuller on the right, a little lower on the left.
  pebble: {
    path: smoothClosed([
      [50, 17], [69, 20], [83, 33], [87, 53], [81, 73], [64, 85],
      [43, 86], [24, 79], [14, 61], [16, 39], [29, 24],
    ]),
    eyes: { x: 51, y: 51, gap: 20, scale: 1 },
  },
  // Two soft lobes over one round belly.
  bean: {
    path: smoothClosed([
      [14, 57], [18, 38], [31, 27], [47, 29], [58, 26], [72, 20],
      [85, 29], [88, 49], [82, 70], [64, 84], [41, 86], [22, 78],
    ]),
    eyes: { x: 52, y: 55, gap: 20, scale: 1 },
  },
  // A puffy four-point star: round tips, soft valleys, the face in the middle.
  spark: {
    path: smoothClosed([
      [50, 11], [57.5, 20], [68.5, 33.5], [82, 44.5], [91, 52], [82, 59.5], [68.5, 70.5], [57.5, 84],
      [50, 93], [42.5, 84], [31.5, 70.5], [18, 59.5], [9, 52], [18, 44.5], [31.5, 33.5], [42.5, 20],
    ]),
    eyes: { x: 50, y: 52, gap: 18, scale: 0.92 },
  },
  // The dev nod: a rounded die with two pins on each side.
  chip: {
    path: rect(20, 23, 60, 60, 15),
    extras: [
      rect(11, 38, 12, 7, 2.5), rect(11, 61, 12, 7, 2.5),
      rect(77, 38, 12, 7, 2.5), rect(77, 61, 12, 7, 2.5),
    ].join(" "),
    eyes: { x: 50, y: 52, gap: 20, scale: 1 },
  },
  drop: {
    path: smoothClosed([
      [50, 9], [60, 23], [74, 41], [83, 60], [77, 77], [63, 86],
      [50, 88], [37, 86], [23, 77], [17, 60], [26, 41], [40, 23],
    ]),
    eyes: { x: 50, y: 61, gap: 20, scale: 1 },
  },
  cloud: {
    path: "M 26 83 A 15 15 0 0 1 15 59 A 16 16 0 0 1 33 37 A 19 19 0 0 1 68 35 A 16 16 0 0 1 85 59 A 15 15 0 0 1 74 83 Q 50 88 26 83 Z",
    eyes: { x: 50, y: 60, gap: 20, scale: 1 },
  },
  hex: {
    path: roundedPolygon(hexagon(50, 52, 38), 11),
    eyes: { x: 50, y: 52, gap: 20, scale: 1 },
  },
};
