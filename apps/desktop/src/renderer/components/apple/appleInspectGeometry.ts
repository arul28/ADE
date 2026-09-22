import type { IosInspectableFrame, IosScreenElement } from "../../../shared/types/iosSimulator";

/**
 * The phase-3 contract named this `IosSimulatorSnapshotElement`. The live type
 * is `IosScreenElement` — same shape, no parent ids — so the overlay and panel
 * keep the contract's name as an alias.
 */
export type IosSimulatorSnapshotElement = IosScreenElement;

export type AppleInspectPoint = { x: number; y: number };

export type AppleInspectRefTier = "id:" | "component:" | "label:" | "pos:";

export type AppleInspectDescription = {
  title: string;
  subtitle: string;
  refTier: AppleInspectRefTier;
  source: string;
};

export type AppleInspectTreeNode = {
  element: IosSimulatorSnapshotElement;
  children: AppleInspectTreeNode[];
  depth: number;
};

export const POS_IDENTITY_HINT = "This element carries no identity — add an accessibility identifier.";

const REF_TIER_MEANING: Record<AppleInspectRefTier, string> = {
  "id:": "survives re-render",
  "component:": "survives re-render",
  "label:": "changes with copy",
  "pos:": "carries no identity",
};

export function refTierMeaning(tier: AppleInspectRefTier): string {
  switch (tier) {
    case "id:":
      return REF_TIER_MEANING["id:"];
    case "component:":
      return REF_TIER_MEANING["component:"];
    case "label:":
      return REF_TIER_MEANING["label:"];
    case "pos:":
      return REF_TIER_MEANING["pos:"];
    default: {
      const _never: never = tier;
      return _never;
    }
  }
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function accessibilityIdentifierOf(element: IosSimulatorSnapshotElement): string | null {
  const raw = element.metadata?.accessibilityIdentifier;
  return typeof raw === "string" ? nonEmpty(raw) : null;
}

function identifierOf(element: IosSimulatorSnapshotElement): string | null {
  return accessibilityIdentifierOf(element) ?? nonEmpty(element.identifier);
}

/**
 * Optional parent id. `IosScreenElement` does not declare one; a helper snapshot
 * that starts carrying `parentId` (own field or metadata) is honoured.
 */
function declaredParentId(element: IosSimulatorSnapshotElement): string | null {
  const own = (element as IosSimulatorSnapshotElement & { parentId?: string | null }).parentId;
  if (typeof own === "string") return nonEmpty(own);
  const meta = element.metadata?.parentId;
  return typeof meta === "string" ? nonEmpty(meta) : null;
}

function snapshotHasParentIds(elements: readonly IosSimulatorSnapshotElement[]): boolean {
  return elements.some((element) => declaredParentId(element) !== null);
}

export function deviceFrameOf(element: IosSimulatorSnapshotElement): IosInspectableFrame {
  return element.frame;
}

export function frameArea(frame: IosInspectableFrame): number {
  return Math.max(0, frame.width) * Math.max(0, frame.height);
}

export function containsPoint(frame: IosInspectableFrame, point: AppleInspectPoint): boolean {
  if (frame.width <= 0 || frame.height <= 0) return false;
  return (
    point.x >= frame.x
    && point.x <= frame.x + frame.width
    && point.y >= frame.y
    && point.y <= frame.y + frame.height
  );
}

function containsFrame(outer: IosInspectableFrame, inner: IosInspectableFrame): boolean {
  if (frameArea(outer) <= frameArea(inner)) return false;
  return (
    inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height
  );
}

export function findElement(
  elements: readonly IosSimulatorSnapshotElement[],
  ref: string | null | undefined,
): IosSimulatorSnapshotElement | null {
  if (!ref) return null;
  return elements.find((element) => element.id === ref) ?? null;
}

/**
 * Smallest-area hit under a device-point. Equal areas keep the later snapshot
 * index, so a later sibling painted on top of an equal-size peer wins.
 */
export function hitTest(
  elements: readonly IosSimulatorSnapshotElement[],
  point: AppleInspectPoint,
): IosSimulatorSnapshotElement | null {
  let best: IosSimulatorSnapshotElement | null = null;
  let bestArea = Infinity;
  let bestIndex = -1;
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    if (!element) continue;
    const frame = deviceFrameOf(element);
    if (!containsPoint(frame, point)) continue;
    const area = frameArea(frame);
    if (area < bestArea || (area === bestArea && index > bestIndex)) {
      best = element;
      bestArea = area;
      bestIndex = index;
    }
  }
  return best;
}

function containmentParentOf(
  elements: readonly IosSimulatorSnapshotElement[],
  element: IosSimulatorSnapshotElement,
): IosSimulatorSnapshotElement | null {
  const inner = deviceFrameOf(element);
  let best: IosSimulatorSnapshotElement | null = null;
  let bestArea = Infinity;
  let bestIndex = -1;
  for (let index = 0; index < elements.length; index += 1) {
    const candidate = elements[index];
    if (!candidate || candidate.id === element.id) continue;
    if (!containsFrame(deviceFrameOf(candidate), inner)) continue;
    const area = frameArea(deviceFrameOf(candidate));
    if (area < bestArea || (area === bestArea && index > bestIndex)) {
      best = candidate;
      bestArea = area;
      bestIndex = index;
    }
  }
  return best;
}

/**
 * Ancestors nearest-first. Uses declared parent ids when the snapshot carries
 * them; otherwise walks containment (smallest enclosing frame is the parent).
 */
export function ancestorsOf(
  elements: readonly IosSimulatorSnapshotElement[],
  ref: string,
): IosSimulatorSnapshotElement[] {
  const start = findElement(elements, ref);
  if (!start) return [];
  const byId = new Map(elements.map((element) => [element.id, element]));
  const useParents = snapshotHasParentIds(elements);
  const chain: IosSimulatorSnapshotElement[] = [];
  const seen = new Set<string>([start.id]);
  let current: IosSimulatorSnapshotElement | null = start;
  while (current) {
    let parent: IosSimulatorSnapshotElement | null = null;
    if (useParents) {
      const parentId = declaredParentId(current);
      parent = parentId ? byId.get(parentId) ?? null : null;
    } else {
      parent = containmentParentOf(elements, current);
    }
    if (!parent || seen.has(parent.id)) break;
    chain.push(parent);
    seen.add(parent.id);
    current = parent;
  }
  return chain;
}

export function inspectTree(elements: readonly IosSimulatorSnapshotElement[]): AppleInspectTreeNode[] {
  const useParents = snapshotHasParentIds(elements);
  const byId = new Map(elements.map((element) => [element.id, element]));
  const children = new Map<string, IosSimulatorSnapshotElement[]>();
  const roots: IosSimulatorSnapshotElement[] = [];
  for (const element of elements) {
    let parent: IosSimulatorSnapshotElement | null = null;
    if (useParents) {
      const parentId = declaredParentId(element);
      parent = parentId ? byId.get(parentId) ?? null : null;
    } else {
      parent = containmentParentOf(elements, element);
    }
    if (!parent) {
      roots.push(element);
      continue;
    }
    const siblings = children.get(parent.id);
    if (siblings) siblings.push(element);
    else children.set(parent.id, [element]);
  }

  const walk = (element: IosSimulatorSnapshotElement, depth: number): AppleInspectTreeNode => ({
    element,
    depth,
    children: (children.get(element.id) ?? []).map((child) => walk(child, depth + 1)),
  });
  return roots.map((element) => walk(element, 0));
}

export function refTierOf(element: IosSimulatorSnapshotElement): AppleInspectRefTier {
  if (identifierOf(element)) return "id:";
  if (nonEmpty(element.componentId)) return "component:";
  const descriptive = [element.role, element.elementType, element.label, element.value];
  if (descriptive.some((part) => nonEmpty(part) !== null)) return "label:";
  return "pos:";
}

function semanticRef(element: IosSimulatorSnapshotElement): string {
  const tier = refTierOf(element);
  switch (tier) {
    case "id:":
      return `id:${identifierOf(element) ?? element.id}`;
    case "component:":
      return `component:${nonEmpty(element.componentId) ?? element.id}`;
    case "label:":
      return `label:${nonEmpty(element.label) ?? nonEmpty(element.role) ?? element.id}`;
    case "pos:":
      return `pos:${element.id}`;
    default: {
      const _never: never = tier;
      return _never;
    }
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_.:/=@+-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

/**
 * Strongest `ade apple tap-element` query for this element.
 *
 * Default shape is `--ref <tier><value>`. When the tier is `pos:` (or a better
 * query exists — identifier, then label), the command uses `--identifier` /
 * `--label` so a paste actually names the control.
 */
export function commandFor(element: IosSimulatorSnapshotElement): string {
  const identifier = identifierOf(element);
  const label = nonEmpty(element.label);
  const tier = refTierOf(element);
  if (identifier) {
    return `ade --socket apple tap-element --identifier ${shellQuote(identifier)}`;
  }
  if (tier === "pos:" && label) {
    return `ade --socket apple tap-element --label ${shellQuote(label)}`;
  }
  if (tier === "label:" && label) {
    return `ade --socket apple tap-element --label ${shellQuote(label)}`;
  }
  return `ade --socket apple tap-element --ref ${shellQuote(semanticRef(element))}`;
}

export function describeElement(element: IosSimulatorSnapshotElement): AppleInspectDescription {
  const title = nonEmpty(element.label)
    ?? identifierOf(element)
    ?? nonEmpty(element.componentId)
    ?? nonEmpty(element.value)
    ?? nonEmpty(element.elementType)
    ?? nonEmpty(element.role)
    ?? element.id;
  const role = nonEmpty(element.role) ?? nonEmpty(element.elementType);
  const identifier = identifierOf(element);
  const subtitleParts = [role, identifier && identifier !== title ? `#${identifier}` : null].filter(
    (part): part is string => Boolean(part),
  );
  const sourceFile = nonEmpty(element.sourceFile);
  const source = sourceFile
    ? element.sourceLine != null ? `${sourceFile}:${element.sourceLine}` : sourceFile
    : element.source;
  return {
    title,
    subtitle: subtitleParts.join(" · ") || element.source,
    refTier: refTierOf(element),
    source,
  };
}

function compactElementForContext(element: IosSimulatorSnapshotElement): Record<string, unknown> {
  return {
    id: element.id,
    source: element.source,
    label: element.label,
    value: element.value,
    role: element.role,
    elementType: element.elementType,
    identifier: element.identifier,
    componentId: element.componentId,
    sourceFile: element.sourceFile,
    sourceLine: element.sourceLine,
    screenshotFrame: element.pixelFrame,
  };
}

function frameIntersectionArea(a: IosInspectableFrame, b: IosInspectableFrame): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function nearbyElements(
  selected: IosSimulatorSnapshotElement,
  elements: readonly IosSimulatorSnapshotElement[],
  limit = 8,
): Array<Record<string, unknown>> {
  const selectedFrame = selected.pixelFrame;
  return elements
    .filter((element) => element.id !== selected.id)
    .map((element) => {
      const intersection = frameIntersectionArea(selectedFrame, element.pixelFrame);
      let relation = "nearby";
      if (containsFrame(element.pixelFrame, selectedFrame)) relation = "ancestor-or-container";
      else if (containsFrame(selectedFrame, element.pixelFrame)) relation = "descendant";
      else if (intersection > 0) relation = "overlapping";
      return {
        ...compactElementForContext(element),
        relation,
        intersectionPx: Math.round(intersection),
      };
    })
    .sort((a, b) => Number(b.intersectionPx ?? 0) - Number(a.intersectionPx ?? 0))
    .slice(0, limit);
}

/**
 * The composer-facing inspect packet the frozen-snapshot path already inserts:
 * preamble, numbered selected row, then a JSON packet with `selectedElement`
 * (compact inspector row) and `nearbyElements`.
 */
export function inspectContextFor(
  element: IosSimulatorSnapshotElement,
  elements: readonly IosSimulatorSnapshotElement[],
): string {
  const described = describeElement(element);
  const frame = deviceFrameOf(element);
  const source = element.sourceFile
    ? `${element.sourceFile}${element.sourceLine != null ? `:${element.sourceLine}` : ""}`
    : "no source match";
  const frameText = `x=${frame.x}, y=${frame.y}, w=${frame.width}, h=${frame.height}`;
  const packet = {
    selectedElement: compactElementForContext(element),
    nearbyElements: nearbyElements(element, elements),
    sourceConfidence: element.sourceFile ? "exact" : "none",
    exactSource: element.sourceFile
      ? { sourceFile: element.sourceFile, sourceLine: element.sourceLine }
      : null,
  };
  return [
    "iOS visual inspect context attached by the user.",
    "Each packet came from the user clicking a UI element in the real iOS Simulator, dragging a simulator screenshot region, or dragging a capture area in an Xcode SwiftUI preview. Image attachments/crops are visual evidence for the same packet and use the same screenshot coordinate space.",
    "Use exactSource when sourceConfidence is exact. Treat sourceCandidates as ranked best guesses, not proof; prefer nearbyElements and the screenshot when the source is missing or only candidate quality.",
    "",
    `1. ${described.title} (${source}, frame=${frameText})`,
    "Packet:",
    JSON.stringify(packet, null, 2),
    "",
  ].join("\n");
}
