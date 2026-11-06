import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PNG } from "pngjs";
import type {
  AndroidElementContextItem,
  AndroidInspectPointArgs,
  AndroidInspectResult,
  AndroidScreenshot,
  AndroidSourceConfidence,
  AndroidSourceMatch,
  AndroidUiElement,
  AndroidUiSnapshot,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { requireLaneId } from "./androidEmulatorErrors";

/*
 * Parity with Apple's Inspect: the element under a point as the composer's
 * chip packet (`IosElementContextItem` shape, `contextSurface:
 * "android-emulator"`), with a crop of the element and, when ADE can find it
 * in the lane's worktree, the source file and line.
 *
 * The source search reads the lane's own files asynchronously, inside a time
 * and file budget, and gives up quietly: a source line is a help, never a
 * reason for Inspect to fail. Paths are joined with `path`, so it reads the
 * same on Windows, macOS and Linux.
 */

const SOURCE_EXTENSIONS = new Set([".kt", ".java", ".xml"]);
const SKIP_DIRS = new Set([".git", ".gradle", ".idea", ".ade", "build", "node_modules", ".cxx", ".externalNativeBuild", "out", "intermediates"]);
const SOURCE_SEARCH_BUDGET_MS = 1_500;
const SOURCE_SEARCH_MAX_FILES = 4_000;
const SOURCE_FILE_MAX_BYTES = 512 * 1024;
const CROP_PADDING_PX = 12;
const NEARBY_MAX = 8;

/** The smallest element whose bounds hold the point; ties go to the deeper one. */
export function androidElementAt(elements: readonly AndroidUiElement[], x: number, y: number): AndroidUiElement | null {
  let best: AndroidUiElement | null = null;
  for (const element of elements) {
    const { bounds } = element;
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    if (x < bounds.x || y < bounds.y || x >= bounds.x + bounds.width || y >= bounds.y + bounds.height) continue;
    const area = bounds.width * bounds.height;
    const bestArea = best ? best.bounds.width * best.bounds.height : Infinity;
    if (area < bestArea || (area === bestArea && best && element.path.length > best.path.length)) best = element;
  }
  return best;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** What to look for in the source, strongest first. */
function sourceNeedles(element: AndroidUiElement): Array<{ pattern: RegExp; confidence: "exact" | "candidate"; reason: string }> {
  const needles: Array<{ pattern: RegExp; confidence: "exact" | "candidate"; reason: string }> = [];
  const id = element.identifier?.trim();
  if (id && /^[\w.]+$/u.test(id)) {
    const word = escapeRegExp(id);
    needles.push(
      { pattern: new RegExp(`testTag\\(\\s*"${word}"\\s*\\)`, "u"), confidence: "exact", reason: `testTag("${id}")` },
      { pattern: new RegExp(`@\\+id/${word}"`, "u"), confidence: "exact", reason: `@+id/${id}` },
      { pattern: new RegExp(`\\bR\\.id\\.${word}\\b`, "u"), confidence: "exact", reason: `R.id.${id}` },
    );
  }
  const label = element.label?.trim();
  if (label && label.length <= 120) {
    const text = escapeRegExp(label);
    needles.push(
      { pattern: new RegExp(`contentDescription\\s*=\\s*"${text}"`, "u"), confidence: "exact", reason: `contentDescription "${label}"` },
      { pattern: new RegExp(`"${text}"`, "u"), confidence: "candidate", reason: `"${label}"` },
    );
  }
  const shown = element.text?.trim();
  if (shown && shown.length <= 120 && shown !== label) {
    needles.push({ pattern: new RegExp(`["'>]${escapeRegExp(shown)}["'<]`, "u"), confidence: "candidate", reason: `"${shown}"` });
  }
  return needles;
}

/**
 * Looks for the element in the lane's source. Returns the matches it found
 * (best first) inside the budget; an unreadable folder or file is skipped.
 */
export async function findAndroidSource(
  root: string,
  element: AndroidUiElement,
  options: { budgetMs?: number; maxFiles?: number; logger?: Logger | null } = {},
): Promise<AndroidSourceMatch[]> {
  const needles = sourceNeedles(element);
  if (needles.length === 0) return [];
  const deadline = Date.now() + (options.budgetMs ?? SOURCE_SEARCH_BUDGET_MS);
  const maxFiles = options.maxFiles ?? SOURCE_SEARCH_MAX_FILES;
  const matches: Array<AndroidSourceMatch & { rank: number }> = [];
  const queue: string[] = [root];
  let files = 0;
  while (queue.length && Date.now() < deadline && files < maxFiles) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (Date.now() >= deadline || files >= maxFiles) break;
      // Links are not followed: a link could lead out of the worktree.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) queue.push(full);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      files += 1;
      let text: string;
      try {
        const stat = await fs.promises.stat(full);
        if (stat.size > SOURCE_FILE_MAX_BYTES) continue;
        text = await fs.promises.readFile(full, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/u);
      needles.forEach((needle, rank) => {
        if (!needle.pattern.test(text)) return;
        const index = lines.findIndex((line) => needle.pattern.test(line));
        if (index < 0) return;
        matches.push({
          sourceFile: path.relative(root, full).split(path.sep).join("/"),
          sourceLine: index + 1,
          confidence: needle.confidence,
          reason: needle.reason,
          snippet: lines.slice(Math.max(0, index - 2), index + 3).join("\n"),
          rank,
        });
      });
    }
  }
  if (Date.now() >= deadline) options.logger?.debug?.("android.inspect_source_budget_spent", { files, matches: matches.length });
  // Strongest needle first; a strings.xml text match is the weakest kind of guess.
  return matches
    .sort((a, b) => a.rank - b.rank || Number(a.sourceFile.endsWith("strings.xml")) - Number(b.sourceFile.endsWith("strings.xml")))
    .slice(0, 5)
    .map(({ rank: _rank, ...match }) => match);
}

/** A PNG crop of the element (with a little room around it) as a data URL; null when the image cannot be read. */
export function cropAndroidElement(png: Buffer, bounds: AndroidUiElement["bounds"]): string | null {
  const image = PNG.sync.read(png);
  const x = Math.max(0, Math.floor(bounds.x - CROP_PADDING_PX));
  const y = Math.max(0, Math.floor(bounds.y - CROP_PADDING_PX));
  const right = Math.min(image.width, Math.ceil(bounds.x + bounds.width + CROP_PADDING_PX));
  const bottom = Math.min(image.height, Math.ceil(bounds.y + bounds.height + CROP_PADDING_PX));
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) return null;
  const crop = new PNG({ width, height });
  PNG.bitblt(image, crop, x, y, width, height, 0, 0);
  return `data:image/png;base64,${PNG.sync.write(crop).toString("base64")}`;
}

function compact(element: AndroidUiElement) {
  return {
    ref: element.ref,
    resourceId: element.resourceId,
    label: element.label,
    text: element.text,
    role: element.role,
    className: element.className,
    screenshotFrame: element.bounds,
  };
}

function nearby(snapshot: AndroidUiSnapshot, element: AndroidUiElement) {
  const cx = element.center.x;
  const cy = element.center.y;
  return snapshot.elements
    .filter((candidate) => candidate !== element && (candidate.label || candidate.text || candidate.identifier))
    .map((candidate) => ({ candidate, distance: Math.hypot(candidate.center.x - cx, candidate.center.y - cy) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, NEARBY_MAX)
    .map(({ candidate }) => ({
      ...compact(candidate),
      relation: element.path.startsWith(`${candidate.path}.`) ? "ancestor" : candidate.path.startsWith(`${element.path}.`) ? "descendant" : "nearby",
    }));
}

export type AndroidInspectDeps = {
  snapshot: (laneId: string) => Promise<AndroidUiSnapshot>;
  /** A screen capture with no proof filing; the caller deletes the file. */
  captureScreen: (laneId: string) => Promise<AndroidScreenshot>;
  laneRoot: (laneId: string) => string | null;
  logger: Logger | null;
  now: () => Date;
};

export function createAndroidInspect(deps: AndroidInspectDeps) {
  const crop = async (laneId: string, element: AndroidUiElement): Promise<string | null> => {
    let shot: AndroidScreenshot | null = null;
    try {
      shot = await deps.captureScreen(laneId);
      return cropAndroidElement(await fs.promises.readFile(shot.path), element.bounds);
    } catch (error) {
      deps.logger?.warn("android.inspect_crop_failed", { laneId, error: getErrorMessage(error) });
      return null;
    } finally {
      if (shot) await fs.promises.rm(shot.path, { force: true }).catch(() => undefined);
    }
  };

  const source = async (laneId: string, element: AndroidUiElement): Promise<AndroidSourceMatch[]> => {
    const root = deps.laneRoot(laneId);
    if (!root) return [];
    try {
      return await findAndroidSource(root, element, { logger: deps.logger });
    } catch (error) {
      deps.logger?.warn("android.inspect_source_failed", { laneId, error: getErrorMessage(error) });
      return [];
    }
  };

  return async function inspect(args: AndroidInspectPointArgs, options: { crop: boolean }): Promise<AndroidInspectResult> {
    const laneId = requireLaneId(args?.laneId);
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y must be numbers (device pixels).");
    const snapshot = await deps.snapshot(laneId);
    const ref = args.ref?.trim() || null;
    const element = (ref ? snapshot.elements.find((candidate) => candidate.ref === ref) : null) ?? androidElementAt(snapshot.elements, x, y);
    if (!element) return { item: null, source: "none", element: null };
    const [matches, screenshotDataUrl] = await Promise.all([
      source(laneId, element),
      options.crop ? crop(laneId, element) : Promise.resolve(null),
    ]);
    const exact = matches.find((match) => match.confidence === "exact") ?? null;
    const sourceConfidence: AndroidSourceConfidence = exact ? "exact" : matches.length ? "candidate" : "none";
    const name = element.label?.trim() || element.text?.trim() || element.identifier?.trim() || null;
    const item: AndroidElementContextItem = {
      kind: "ios_element",
      id: randomUUID(),
      componentId: name ?? element.role ?? "Android element",
      sourceFile: exact?.sourceFile ?? null,
      sourceLine: exact?.sourceLine ?? null,
      frame: element.bounds,
      metadata: {
        contextSurface: "android-emulator",
        androidInspectPacketVersion: 1,
        screenElementSource: snapshot.source,
        sourceConfidence,
        sourceResolution: exact ? "worktree-exact-search" : matches.length ? "worktree-candidate-search" : "none",
        sourceCandidates: matches,
        sourceSnippet: exact?.snippet ?? null,
        screen: { width: snapshot.width, height: snapshot.height, foregroundPackage: snapshot.foregroundPackage },
        selectedElement: compact(element),
        nearbyElements: nearby(snapshot, element),
        label: element.label,
        value: element.text,
        role: element.role,
        elementType: element.className,
        packageName: element.packageName,
        tapCommand: `ade android tap-element --ref ${JSON.stringify(element.ref)}`,
        selectionExplanation: "The user selected this UI element on the lane's Android emulator. The crop attachment is visual evidence for this packet; frames are in screenshot pixels.",
      },
      accessibilityIdentifier: element.resourceId,
      screenshotDataUrl,
      selectedAt: deps.now().toISOString(),
    };
    return { item, source: snapshot.source, element };
  };
}
