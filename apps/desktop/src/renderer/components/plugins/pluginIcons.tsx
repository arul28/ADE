import React from "react";
import {
  BeerStein,
  Bell,
  Bookmark,
  Brain,
  Bug,
  Calendar,
  ChartBar,
  ChartLine,
  ChatCircleDots,
  Clock,
  ClockCounterClockwise,
  Cloud,
  Code,
  Compass,
  Cube,
  CurrencyDollar,
  Database,
  Desktop,
  DeviceMobile,
  EnvelopeSimple,
  Eye,
  FileCode,
  Flag,
  Folder,
  GearSix,
  GitBranch,
  GitCommit,
  GitPullRequest,
  Globe,
  Graph,
  Heart,
  Image,
  Kanban,
  Key,
  Lightning,
  Link,
  ListChecks,
  Lock,
  MagicWand,
  Microphone,
  MusicNote,
  Note,
  Package,
  Palette,
  Play,
  Plug,
  PuzzlePiece,
  Robot,
  Rocket,
  Rows,
  ShieldCheck,
  Sparkle,
  Star,
  Storefront,
  Table,
  Tag,
  Terminal,
  Timer,
  Toolbox,
  TrendUp,
  UsersThree,
  VideoCamera,
  Wrench,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Claude, Codex, Cursor, Github, OpenAI } from "@lobehub/icons";
import {
  isPluginBrandTokenName,
  parsePluginBrandGlyph,
  pluginBrandTokenKey,
  type PluginBrandGlyph,
} from "../../../shared/plugins/vocabularyBrandIcons";

/**
 * Manifest icon names → glyphs.
 *
 * Deliberately a curated map rather than `import * as PhosphorIcons`. A
 * namespace import defeats tree-shaking for whatever chunk it lands in, and the
 * tab rail lives in the always-loaded shell chunk — the whole Phosphor set would
 * ride along with it. Authors pick a name from this list; anything else falls
 * back to the puzzle glyph rather than rendering nothing.
 *
 * Adding a name here is additive and safe. Removing one is not: a plugin already
 * shipped with that icon silently changes appearance.
 *
 * This map and iOS's token map are two halves of one promise, and they have now
 * broken it in both directions. The plugin alpha retrospective recorded `beer`
 * rendering as a Phosphor stein on desktop and as `cup.and.saucer.fill` — which
 * reads as tea — on the phone. The fix for that then left desktop without the
 * token at all, so the retrospective's own literal example, `"icon": "beer"`,
 * drew a mug on the phone and a puzzle piece here. A name that resolves on one
 * client and not the other is worse than a name neither has: the author sees
 * their plugin working and has no reason to look.
 */

type PriorityLevel = "urgent" | "high" | "medium" | "low" | "none";

/**
 * Linear's own histogram — three bars, or a bang in a square for urgent —
 * as the five tokens High/Medium/Low used to share as `chart-bar`.
 *
 * Drawn here rather than borrowed from Phosphor's cell-signal set so the
 * phone (custom SwiftUI) and desktop show the same picture, and so Urgent is
 * not a lightning bolt next to three identical bar charts.
 */
function priorityGlyph(level: PriorityLevel): PhosphorIcon {
  function PriorityGlyph({
    size = 16,
    color,
    className,
    style,
    ...rest
  }: {
    size?: number | string;
    color?: string;
    className?: string;
    style?: React.CSSProperties;
    weight?: unknown;
    [key: string]: unknown;
  }) {
    const { weight: _weight, ...passthrough } = rest;
    const pixels = typeof size === "number" ? size : Number.parseFloat(String(size)) || 16;
    const fill = color ?? "currentColor";
    return (
      <span
        {...(passthrough as Record<string, unknown>)}
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 0,
          color: fill,
          opacity: 1,
          ...style,
        }}
      >
        <svg
          width={pixels}
          height={pixels}
          viewBox="0 0 16 16"
          aria-hidden="true"
          style={{ display: "block" }}
        >
          {level === "urgent" ? (
            <>
              <rect x="2" y="2" width="12" height="12" rx="3" fill="currentColor" />
              <rect x="7.2" y="4.4" width="1.6" height="5.2" rx="0.8" fill="#fff" />
              <rect x="7.2" y="10.6" width="1.6" height="1.6" rx="0.8" fill="#fff" />
            </>
          ) : level === "none" ? (
            <rect x="3" y="7.2" width="10" height="1.6" rx="0.8" fill="currentColor" opacity="0.4" />
          ) : (
            [0, 1, 2].map((index) => {
              const filled = level === "high" ? true : level === "medium" ? index < 2 : index < 1;
              const heights = [5, 8.5, 12];
              const h = heights[index]!;
              return (
                <rect
                  key={index}
                  x={3.2 + index * 3.4}
                  y={14 - h - 1.6}
                  width="2.6"
                  height={h}
                  rx="0.6"
                  fill="currentColor"
                  opacity={filled ? 1 : 0.35}
                />
              );
            })
          )}
        </svg>
      </span>
    );
  }
  PriorityGlyph.displayName = `PriorityGlyph(${level})`;
  return PriorityGlyph as unknown as PhosphorIcon;
}

const PLUGIN_ICONS: Record<string, PhosphorIcon> = {
  beer: BeerStein,
  bell: Bell,
  bookmark: Bookmark,
  brain: Brain,
  bug: Bug,
  calendar: Calendar,
  chart: ChartLine,
  "chart-bar": ChartBar,
  chat: ChatCircleDots,
  clock: Clock,
  "clock-counter-clockwise": ClockCounterClockwise,
  cloud: Cloud,
  code: Code,
  compass: Compass,
  cube: Cube,
  currency: CurrencyDollar,
  database: Database,
  desktop: Desktop,
  "device-mobile": DeviceMobile,
  envelope: EnvelopeSimple,
  eye: Eye,
  file: FileCode,
  flag: Flag,
  folder: Folder,
  gear: GearSix,
  "git-branch": GitBranch,
  "git-commit": GitCommit,
  "git-pull-request": GitPullRequest,
  globe: Globe,
  graph: Graph,
  heart: Heart,
  image: Image,
  kanban: Kanban,
  key: Key,
  lightning: Lightning,
  link: Link,
  list: ListChecks,
  "list-checks": ListChecks,
  lock: Lock,
  magic: MagicWand,
  microphone: Microphone,
  music: MusicNote,
  note: Note,
  package: Package,
  palette: Palette,
  play: Play,
  plug: Plug,
  puzzle: PuzzlePiece,
  robot: Robot,
  rocket: Rocket,
  rows: Rows,
  shield: ShieldCheck,
  sparkle: Sparkle,
  star: Star,
  storefront: Storefront,
  table: Table,
  tag: Tag,
  terminal: Terminal,
  timer: Timer,
  toolbox: Toolbox,
  trend: TrendUp,
  users: UsersThree,
  video: VideoCamera,
  wrench: Wrench,
  "priority-urgent": priorityGlyph("urgent"),
  "priority-high": priorityGlyph("high"),
  "priority-medium": priorityGlyph("medium"),
  "priority-low": priorityGlyph("low"),
  "priority-none": priorityGlyph("none"),
};

/* ── Brand tokens ─────────────────────────────────────────────── */

/**
 * A small, CLOSED set of vendor marks a manifest may name.
 *
 * The glyph list above is deliberately generic, and that is right for almost
 * every plugin: a colour theme drawn as a palette reads correctly on any client.
 * It is wrong for a plugin whose whole subject is one company's product. The
 * Cursor Cloud plugin declared `cloud`, the only honest token available to it,
 * and the Marketplace drew a weather glyph next to the word "Cursor". A reader
 * who already knows the mark learns nothing from a generic stand-in.
 *
 * Three rules keep this from becoming a second, unbounded icon namespace:
 *
 * 1. **The set is closed and small.** Only vendors ADE already ships artwork for
 *    on EVERY client are in it. A token that resolves here and puzzles on the
 *    phone is the exact cross-client break the token list exists to prevent, and
 *    this repo has paid for that once already with `beer`.
 * 2. **No new artwork.** Each entry points at a logo the product already draws
 *    somewhere else, so a brand token can never be the reason a mark is
 *    out of date.
 * 3. **Unknown degrades identically.** `brand:whatever` with no shipped file
 *    and no closed-catalogue entry is an unknown token, and it draws the same
 *    puzzle piece any other unknown token draws.
 *
 * A plugin that needs a mark ADE does not ship — Linear, Jira — names a
 * `brandIcons` SVG in its manifest. The host sanitizes it to paths and every
 * client draws that list. See `vocabularyBrandIcons.ts`.
 */
type BrandMark = React.ComponentType<{ size?: number | string; className?: string; style?: React.CSSProperties }>;

/**
 * Wrap a vendor mark so it renders anywhere a Phosphor glyph does.
 *
 * Every caller of {@link pluginIcon} renders the result as a component with
 * Phosphor's props — `size`, `weight`, `color`, `aria-hidden`. A LobeHub mark
 * takes `size` and would forward `weight` straight onto its `<svg>`, where React
 * warns about an unknown attribute. The wrapper takes the props apart: `size`
 * reaches the mark, `color` becomes the surrounding `color` so a tinted context
 * still tints anything the mark draws in `currentColor`, and `weight` is dropped
 * because a logo has no stroke weight to vary.
 *
 * The BARE mark is used, never the boxed `.Avatar`: these draw inline beside
 * text at 11-16px, where a filled brand tile reads as a badge stuck onto the row
 * rather than as that row's icon.
 */
function brandGlyph(Mark: BrandMark, label: string): PhosphorIcon {
  function BrandGlyph({
    size = 16,
    color,
    className,
    style,
    ...rest
  }: {
    size?: number | string;
    color?: string;
    className?: string;
    style?: React.CSSProperties;
    weight?: unknown;
    [key: string]: unknown;
  }) {
    const { weight: _weight, ...passthrough } = rest;
    const pixels = typeof size === "number" ? size : Number.parseFloat(String(size)) || 16;
    return (
      <span
        {...(passthrough as Record<string, unknown>)}
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 0,
          ...(color ? { color } : {}),
          ...style,
        }}
      >
        <Mark size={pixels} />
      </span>
    );
  }
  BrandGlyph.displayName = `BrandGlyph(${label})`;
  return BrandGlyph as unknown as PhosphorIcon;
}

const PLUGIN_BRAND_ICONS: Record<string, PhosphorIcon> = {
  "brand:claude": brandGlyph(Claude, "Claude"),
  "brand:codex": brandGlyph(Codex, "Codex"),
  "brand:cursor": brandGlyph(Cursor, "Cursor"),
  "brand:github": brandGlyph(Github, "GitHub"),
  "brand:openai": brandGlyph(OpenAI, "OpenAI"),
};

const shippedBrandGlyphCache = new Map<string, PhosphorIcon>();

function shippedBrandGlyph(glyph: PluginBrandGlyph, label: string): PhosphorIcon {
  const cacheKey = `${glyph.viewBox}\0${glyph.paths.map((entry) => `${entry.evenodd ? "e" : "n"}:${entry.d}`).join("\0")}`;
  const cached = shippedBrandGlyphCache.get(cacheKey);
  if (cached) return cached;
  function ShippedBrandGlyph({
    size = 16,
    color,
    className,
    style,
    ...rest
  }: {
    size?: number | string;
    color?: string;
    className?: string;
    style?: React.CSSProperties;
    weight?: unknown;
    [key: string]: unknown;
  }) {
    const { weight: _weight, ...passthrough } = rest;
    const pixels = typeof size === "number" ? size : Number.parseFloat(String(size)) || 16;
    return (
      <span
        {...(passthrough as Record<string, unknown>)}
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          lineHeight: 0,
          ...(color ? { color } : {}),
          ...style,
        }}
      >
        <svg
          width={pixels}
          height={pixels}
          viewBox={glyph.viewBox}
          fill="currentColor"
          aria-hidden="true"
          style={{ display: "block" }}
        >
          {glyph.paths.map((entry, index) => (
            <path
              key={index}
              d={entry.d}
              {...(entry.evenodd ? { fillRule: "evenodd" as const } : {})}
            />
          ))}
        </svg>
      </span>
    );
  }
  ShippedBrandGlyph.displayName = `ShippedBrandGlyph(${label})`;
  const Icon = ShippedBrandGlyph as unknown as PhosphorIcon;
  shippedBrandGlyphCache.set(cacheKey, Icon);
  return Icon;
}

/** Brand token names, for docs, the authoring skill and the parity tests. */
export const PLUGIN_BRAND_ICON_NAMES: readonly string[] = Object.keys(PLUGIN_BRAND_ICONS).sort();

/** Whether a token names a vendor mark rather than a generic glyph. */
export function isPluginBrandIconName(name: string | null | undefined): boolean {
  return isPluginBrandTokenName(name);
}

/** The glyph for a plugin that named no icon, or named one this build lacks. */
export const DEFAULT_PLUGIN_ICON: PhosphorIcon = PuzzlePiece;

/** The Marketplace's own nav glyph. Exported so the rail and the page agree. */
export const MARKETPLACE_ICON: PhosphorIcon = Storefront;

/**
 * Does this build have artwork for that name, once the plugin's own is counted?
 *
 * {@link PLUGIN_ICON_NAMES} is the closed list every client compiles in, and it
 * is the wrong allowlist on its own: a `brand:*` token a PLUGIN ships is a
 * legitimate icon everywhere an icon token is legal — a tab, a badge, a panel,
 * a URL-matcher chip — and it can never appear in a compiled list, because the
 * artwork arrives with the package. Asking the closed list alone reported
 * `ade-linear`'s own `brand:linear` as an unknown glyph.
 *
 * So the question is asked with the plugin's shipped collection in hand. Absent
 * it, the answer is the closed list, which is what a caller holding only a name
 * should get. A well-formed token with no artwork on either side is still
 * false: it degrades to the puzzle piece, and calling that "resolved" would
 * hide the one failure this predicate exists to catch.
 */
export function pluginIconNameResolves(
  name: string | null | undefined,
  shipped?: Readonly<Record<string, unknown>>,
): boolean {
  const key = (name ?? "").trim().toLowerCase();
  if (key.length === 0) return false;
  if (Object.hasOwn(PLUGIN_ICONS, key) || Object.hasOwn(PLUGIN_BRAND_ICONS, key)) return true;
  const token = pluginBrandTokenKey(key);
  return Boolean(token && shipped && Object.hasOwn(shipped, token));
}

/** Icon names a manifest may use, for docs and the authoring skill. */
export const PLUGIN_ICON_NAMES: readonly string[] = [
  ...Object.keys(PLUGIN_ICONS),
  ...Object.keys(PLUGIN_BRAND_ICONS),
].sort();

/**
 * Resolve a manifest icon name. Never returns null — unknown names degrade.
 *
 * `Object.hasOwn`, not a plain lookup: the name comes from an untrusted
 * manifest, and `"constructor"` or `"toString"` resolve through the prototype
 * chain to functions that are not components. React throws on the first one it
 * is asked to render, and a tab-rail glyph renders above the route's error
 * boundary — so a one-word manifest field could take the whole app chrome down.
 */
export function pluginIcon(
  name: string | null | undefined,
  shipped?: Readonly<Record<string, PluginBrandGlyph>>,
): PhosphorIcon {
  const key = (name ?? "").trim().toLowerCase();
  if (Object.hasOwn(PLUGIN_BRAND_ICONS, key)) return PLUGIN_BRAND_ICONS[key]!;
  const token = pluginBrandTokenKey(key);
  if (token && shipped && Object.hasOwn(shipped, token)) {
    // Re-validated, not trusted. The host sanitizes a glyph on the way in, but
    // this row reaches the renderer through the plugin record and the CRR table
    // another machine filled — the same reason iOS re-runs the ceilings. A
    // malformed row draws the fallback rather than throwing inside the tab
    // rail, which renders above the route's error boundary.
    const glyph = parsePluginBrandGlyph(shipped[token]);
    if (glyph) return shippedBrandGlyph(glyph, key);
  }
  return Object.hasOwn(PLUGIN_ICONS, key) ? PLUGIN_ICONS[key]! : DEFAULT_PLUGIN_ICON;
}

/* ── Identity ───────────────────────────────────────────────────────────── */

/**
 * The glyphs a plugin gets when it names none.
 *
 * A subset of {@link PLUGIN_ICONS}, and a subset for a reason: this list is
 * what an unnamed plugin is DRAWN AS, so it holds only glyphs that read as a
 * generic piece of software. `heart`, `currency` and `bug` are all legal icon
 * names and none of them should ever be assigned to a plugin that did not ask
 * for one — a payments glyph on a colour theme is worse than a puzzle piece.
 *
 * Order is part of the contract: the assignment is `hash % length`, so
 * inserting a name in the middle re-skins every plugin after it. Append only.
 */
export const PLUGIN_IDENTITY_GLYPHS: readonly string[] = [
  "puzzle",
  "cube",
  "package",
  "plug",
  "toolbox",
  "sparkle",
  "compass",
  "graph",
  "kanban",
  "table",
  "list",
  "note",
  "terminal",
  "code",
  "file",
  "folder",
  "database",
  "cloud",
  "lightning",
  "rocket",
  "palette",
  "magic",
  "gear",
  "globe",
];

/**
 * The colours those glyphs are drawn in.
 *
 * Tokens, declared per theme in `index.css`, because the tile inverts between
 * light and dark and a fixed hex would be unreadable on one of them. Same
 * append-only rule as the glyph list.
 */
export const PLUGIN_IDENTITY_COLORS: readonly string[] = [
  "var(--plugin-identity-0)",
  "var(--plugin-identity-1)",
  "var(--plugin-identity-2)",
  "var(--plugin-identity-3)",
  "var(--plugin-identity-4)",
  "var(--plugin-identity-5)",
  "var(--plugin-identity-6)",
  "var(--plugin-identity-7)",
];

/* ── Official brand marks ───────────────────────────────────────────────── */

/**
 * Tile artwork for the three officials that carry someone else's brand.
 *
 * Linear, Apple and Electron are recognised by their marks, not by a glyph from
 * a generic set — an issue tracker drawn as a checklist and a simulator drawn as
 * `</>` is what the gallery looked like before this map existed. The rest of the
 * official set stays on glyph-plus-colour, which is the identity the whole
 * catalogue is built on; a logo is for a name a reader already knows.
 *
 * Inline SVG source rather than a URL, because these must render with the
 * network off. The bundled listings are what the Marketplace shows on a cold,
 * offline start, and a tile that only appears once a directory answers is a tile
 * that is missing exactly when the app is trying to prove it still works. The
 * strings mirror `plugins/<id>/icon.svg` — the published packages carry the same
 * artwork so a directory entry can point `iconUrl` at a raw URL later — and the
 * two copies are edited together.
 *
 * Each is a FULL-BLEED square: the mark sits on its own brand background rather
 * than being drawn in a theme colour. An `<img>` is a separate document, so
 * `currentColor` and the theme's CSS variables do not reach inside it; a black
 * Apple mark would be a black square on a dark theme. Carrying the background
 * makes the tile legible in both themes and gives it the weight of an app icon.
 */
const OFFICIAL_PLUGIN_LOGOS: Record<string, string> = {
  "ade-linear":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
    + '<rect width="64" height="64" fill="#5E6AD2"/>'
    + '<g transform="translate(13.4 13.4) scale(1.547)" fill="#FFFFFF">'
    + '<path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"/>'
    + "</g></svg>",
  "ade-ios-sim":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
    + '<defs><linearGradient id="a" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#4E4E54"/><stop offset="1" stop-color="#232326"/>'
    + "</linearGradient></defs>"
    + '<rect width="64" height="64" fill="url(#a)"/>'
    + '<g transform="translate(15.7 15.4) scale(1.36)" fill="#FFFFFF">'
    + '<path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>'
    + "</g></svg>",
  "ade-app-control":
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">'
    + '<rect width="64" height="64" fill="#2B2E3A"/>'
    + '<g transform="rotate(30 32 32)">'
    + '<g fill="none" stroke="#9FEAF9" stroke-width="3">'
    + '<ellipse cx="32" cy="32" rx="22" ry="8.4"/>'
    + '<ellipse cx="32" cy="32" rx="22" ry="8.4" transform="rotate(60 32 32)"/>'
    + '<ellipse cx="32" cy="32" rx="22" ry="8.4" transform="rotate(120 32 32)"/>'
    + "</g>"
    + '<circle cx="53.4" cy="27.6" r="4.2" fill="#9FEAF9"/>'
    + "</g>"
    + '<circle cx="32" cy="32" r="5.4" fill="#9FEAF9"/>'
    + "</svg>",
};

/**
 * The bundled mark for an official plugin, as a `data:` URL, or null.
 *
 * Encoded on demand rather than stored encoded so the artwork above stays
 * readable and diffable. `encodeURIComponent` is the whole escape: `#` in a
 * fill would otherwise start a fragment and drop the rest of the document.
 *
 * Keyed by id alone, and deliberately so: the same plugin must look the same
 * bundled, listed, and installed, and the id is the only field that is the same
 * in all three. A directory entry that publishes its own `iconUrl` still wins —
 * see {@link pluginIdentity} — so this never overrides what an author shipped.
 */
export function officialPluginLogo(pluginId: string): string | null {
  const svg = Object.hasOwn(OFFICIAL_PLUGIN_LOGOS, pluginId) ? OFFICIAL_PLUGIN_LOGOS[pluginId]! : null;
  return svg === null ? null : `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * FNV-1a over the plugin id.
 *
 * Any stable hash would do; what matters is that it is computed HERE rather
 * than stored anywhere. A plugin's derived look must be identical on every
 * machine, in the gallery and in the tab rail, before and after it is
 * installed, and the only input that is the same in all four places is the id.
 */
function hashPluginId(pluginId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < pluginId.length; index += 1) {
    hash ^= pluginId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export type PluginIdentity = {
  Icon: PhosphorIcon;
  /** A CSS colour — a theme token when derived, a published hex when named. */
  color: string;
  /** Set only when the plugin published an image. */
  imageUrl: string | null;
};

/**
 * What a plugin looks like.
 *
 * Three layers, in order: a published image wins, then a published glyph and
 * colour, then a pair derived from the id. There is deliberately no fourth
 * layer where a plugin has no identity at all — an unstyled row in a
 * catalogue reads as broken, and "the author didn't fill in a field" is not
 * something a reader should be able to see.
 *
 * The image layer has a second half: an official whose mark ADE bundles falls
 * back to that mark when no image was published. Published beats bundled so a
 * directory entry can move a logo without shipping a build, and bundled beats
 * nothing so the marks survive an offline start.
 *
 * The derived pair is two independent draws off one hash so that two plugins
 * sharing a glyph are unlikely to share its colour as well.
 */
export function pluginIdentity(input: {
  pluginId: string;
  icon?: string | null;
  accent?: string | null;
  iconUrl?: string | null;
  brandIcons?: Readonly<Record<string, PluginBrandGlyph>>;
}): PluginIdentity {
  const hash = hashPluginId(input.pluginId);
  const named = (input.icon ?? "").trim().toLowerCase();
  // One predicate rather than a second copy of the three-way check: this asked
  // the same question the allowlist asks, and the two had to be edited together
  // every time the token grammar grew.
  const hasNamedIcon = pluginIconNameResolves(named, input.brandIcons);
  const glyph = hasNamedIcon
    ? named
    : PLUGIN_IDENTITY_GLYPHS[hash % PLUGIN_IDENTITY_GLYPHS.length]!;
  const accent = (input.accent ?? "").trim();
  const color = accent.length > 0
    ? accent
    // A second, decorrelated draw: `hash >>> 8` so a glyph collision does not
    // drag the colour along with it.
    : PLUGIN_IDENTITY_COLORS[(hash >>> 8) % PLUGIN_IDENTITY_COLORS.length]!;
  const published = input.iconUrl?.trim();
  return {
    Icon: pluginIcon(glyph, input.brandIcons),
    color,
    imageUrl: published ? published : officialPluginLogo(input.pluginId),
  };
}
