/* The reveal's settings: every knob of the glass and the motion, and the two looks it starts from. */

export type Look = "light" | "dark";

export interface GlassTuning {
  /** How far the slab stands above the logo, so how hard the rim bends it */
  opticalDepth: number;
  /** Colour split of everything the rim draws in */
  dispersion: number;
  /** Soft colour glow inside the rim */
  colorBleed: number;
  doubleBevel: number;
  bevelWidth: number;
  /** Superellipse exponent of the tile: 2 is a circle, ~5 an app icon */
  corner: number;
  cornerPull: number;
  cornerWidth: number;
  cornerFocus: number;
  edgeSmear: number;
  stretch: number;
  tilt: number;
  /** Ball-lens bulge of the young droplet */
  bulge: number;
  specular: number;
  halo: number;
  shadow: number;
  ripple: number;
  /** Droplet spring: 0 = no overshoot */
  bounce: number;
  /** Droplet spring period, seconds */
  response: number;
  startSize: number;
  startZoom: number;
  /** Seconds the logo takes to glide out of the droplet's magnification */
  glide: number;
  /** Seconds the logo stays in glass */
  present: number;
  drift: number;
  swell: number;
  focus: number;
  /** Soft band of light that crosses the glass while it holds the logo (0 = none) */
  sheen: number;
  /** How far the light turns round the rim while the glass holds, radians */
  lightTurn: number;
}

export interface Settings extends GlassTuning {
  tileSize: number;
  logoScale: number;
  finalScale: number;
  logoOffset: [number, number];
  iconPlate: boolean;
  keepPlate: boolean;
  originalColors: boolean;
  background: string;
  plateColor: string;
  logoColor: string;
  hold: number;
}

const LIGHT: Settings = {
  tileSize: 256, logoScale: 0.7, finalScale: 0.69, logoOffset: [0, 0], iconPlate: false, keepPlate: false, originalColors: false,
  opticalDepth: 1.1, dispersion: 1.7, colorBleed: 1.25, doubleBevel: 1, bevelWidth: 0.14, corner: 4.8,
  cornerPull: 2.1, cornerWidth: 2.2, cornerFocus: 0.58, edgeSmear: 2.85, stretch: 0, tilt: 0.35, bulge: 1,
  specular: 1, halo: 0, shadow: 1, ripple: 1,
  bounce: 0, response: 0.42, startSize: 0.2, startZoom: 2.6, glide: 2.3, present: 2.4, drift: 0.12, swell: 0.5, focus: 1,
  sheen: 1, lightTurn: 0.9,
  hold: 1, background: "#e9e9eb", plateColor: "#ffffff", logoColor: "#0e1428",
};

export const LOOKS: Record<Look, Settings> = {
  light: LIGHT,
  dark: {
    ...LIGHT, logoScale: 0.72, finalScale: 1, iconPlate: true,
    halo: 1, shadow: 0, ripple: 0.5, startZoom: 1.6, drift: 0.05,
    opticalDepth: 0.75, bevelWidth: 0.22, dispersion: 0.9,
    colorBleed: 0.45, corner: 5, cornerPull: 1.4, edgeSmear: 1.2, tilt: 0, cornerWidth: 1.2, cornerFocus: 0.4,
    background: "#000000", plateColor: "#05070b", logoColor: "#ffffff",
  },
};
