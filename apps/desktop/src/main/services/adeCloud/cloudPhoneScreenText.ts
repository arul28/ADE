/**
 * A phone's accessibility tree as the ADE Cloud iPhone's screen text, and the
 * words of `act` steps, for a provider that answers the raw tree (Revyl) so it
 * reads and acts the same as NoMac does: one element per line,
 * `kind "label" #id state @x,y`, in points, and steps that name elements by
 * those same words (`tap "Sign In"`, `fill #email a@b.c`, `tap @120,300`).
 */

/** One node of iOS's accessibility tree as Revyl's `hierarchy` answers it. */
type AxNode = {
  type?: unknown;
  role?: unknown;
  AXLabel?: unknown;
  AXUniqueId?: unknown;
  AXValue?: unknown;
  title?: unknown;
  enabled?: unknown;
  traits?: unknown;
  frame?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
  children?: unknown;
};

export type ScreenElement = {
  kind: string;
  label: string;
  id: string | null;
  value: string | null;
  state: string[];
  x: number;
  y: number;
  frame: { x: number; y: number; width: number; height: number };
  traits: string[];
};

export type Screen = {
  app: string | null;
  width: number;
  height: number;
  elements: ScreenElement[];
};

/** iOS's element types as the screen text names them. */
const KINDS: Record<string, string> = {
  Button: "button",
  StaticText: "text",
  Heading: "heading",
  TextField: "field",
  SecureTextField: "secure-field",
  SearchField: "search-field",
  TextView: "text-view",
  Switch: "switch",
  Toggle: "switch",
  Slider: "slider",
  Image: "image",
  Cell: "cell",
  Link: "link",
  Tab: "tab",
  TabBar: "tab-bar",
  Picker: "picker",
  PickerWheel: "picker",
  SegmentedControl: "segmented",
  Stepper: "stepper",
  ProgressIndicator: "progress",
  Alert: "alert",
  Menu: "menu",
  MenuItem: "menu-item",
  Icon: "icon",
  NavigationBar: "nav-bar",
  Keyboard: "keyboard",
  Key: "key",
};
/** Containers: never a line of their own, only their children. */
const CONTAINERS = new Set(["Application", "Window", "Group", "Other", "ScrollView", "Table", "CollectionView", "List", "LayoutArea", "LayoutItem", "Pane", "ScrollBar"]);

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : null);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The tree Revyl answered (a list of roots, or one root) as the screen's elements, top to bottom. */
export function screenOf(raw: unknown, fallback: { width: number; height: number } | null): Screen {
  const roots = (Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : []) as AxNode[];
  const app = roots.map((root) => text(root.AXLabel)).find(Boolean) ?? null;
  const rootFrame = roots[0]?.frame;
  const width = num(rootFrame?.width) || fallback?.width || 0;
  const height = num(rootFrame?.height) || fallback?.height || 0;
  const elements: ScreenElement[] = [];
  const visit = (node: AxNode): void => {
    const type = text(node.type) ?? text(node.role)?.replace(/^AX/, "") ?? "Other";
    const traits = Array.isArray(node.traits) ? node.traits.filter((trait): trait is string => typeof trait === "string") : [];
    const frame = { x: num(node.frame?.x), y: num(node.frame?.y), width: num(node.frame?.width), height: num(node.frame?.height) };
    const label = text(node.AXLabel) ?? text(node.title);
    const id = text(node.AXUniqueId);
    const value = text(node.AXValue);
    const centerX = frame.x + frame.width / 2;
    const centerY = frame.y + frame.height / 2;
    // Its center on the screen: a row scrolled half under the top can't be tapped at its center.
    const onScreen = frame.width > 0 && frame.height > 0
      && (!width || (centerX >= 0 && centerX <= width))
      && (!height || (centerY >= 0 && centerY <= height));
    if (!CONTAINERS.has(type) && onScreen && (label || id || value)) {
      const kind = KINDS[type] ?? type.toLowerCase();
      const state: string[] = [];
      if (node.enabled === false) state.push("disabled");
      if (traits.includes("IsEditing")) state.push("focused");
      if (traits.includes("Selected")) state.push("selected");
      if (kind === "switch" && value != null) state.push(value === "1" || /^on$/i.test(value) ? "on" : "off");
      else if (value != null && value !== label) state.push(`value=${JSON.stringify(value)}`);
      elements.push({
        kind,
        label: label ?? (kind === "text" ? value ?? "" : ""),
        id,
        value,
        state,
        x: Math.round(centerX),
        y: Math.round(centerY),
        frame,
        traits,
      });
    }
    if (Array.isArray(node.children)) for (const child of node.children) if (child && typeof child === "object") visit(child as AxNode);
  };
  for (const root of roots) visit(root);
  return { app, width, height, elements };
}

/** One element as a line: `kind "label" #id state @x,y`. */
function elementLine(element: ScreenElement): string {
  return [
    element.kind,
    element.label ? JSON.stringify(element.label) : null,
    element.id ? `#${/\s/.test(element.id) ? JSON.stringify(element.id) : element.id}` : null,
    ...element.state,
    `@${element.x},${element.y}`,
  ].filter(Boolean).join(" ");
}

/** The whole screen as text, or the elements whose words hold `find`. */
export function screenText(screen: Screen, find?: string): string {
  const head = `${screen.app ? `app ${JSON.stringify(screen.app)} ` : ""}screen ${screen.width}x${screen.height} (points)`;
  if (!screen.elements.length) return `${head}\nNothing on the screen can be read yet. If it is still loading, read it again in a moment.`;
  if (find) {
    const wanted = find.toLowerCase();
    const found = screen.elements.filter((element) => [element.label, element.id, element.value].some((word) => word?.toLowerCase().includes(wanted)));
    return found.length ? `${head}\n${found.map(elementLine).join("\n")}` : `${head}\nNothing on the screen matches ${JSON.stringify(find)}.`;
  }
  return `${head}\n${screen.elements.map(elementLine).join("\n")}`;
}

/* ---- Steps ---- */

/** A step's words: bare words, and JSON-quoted values kept whole (`"Sign In"`, `#"an id"`). */
export function stepWords(step: string): Array<{ word: string; quoted: boolean; id?: boolean }> {
  const words: Array<{ word: string; quoted: boolean; id?: boolean }> = [];
  const pattern = /\s*(#?)("(?:[^"\\]|\\.)*"|\S+)/gy;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(step)) !== null) {
    if (!match[0].trim()) break;
    const [, hash, body] = match;
    if (body!.startsWith("\"")) {
      // An unclosed quote (`type "hello`) keeps its last letter.
      let value = body!.length > 1 && body!.endsWith("\"") ? body!.slice(1, -1) : body!.slice(1);
      try {
        value = JSON.parse(body!) as string;
      } catch {
        // A quote it can't read is taken as written.
      }
      // `#"an id"` is an id; `"#Trending"` is a label that starts with #.
      words.push({ word: `${hash}${value}`, quoted: true, id: Boolean(hash) });
    } else {
      words.push({ word: `${hash}${body}`, quoted: false });
    }
  }
  return words;
}

export type StepTarget =
  | { by: "label"; label: string }
  | { by: "id"; id: string }
  | { by: "point"; x: number; y: number };

/** A step's element: `"Label"`, a bare label, `#id`, or `@x,y`. */
export function readTarget(word: { word: string; quoted: boolean; id?: boolean }): StepTarget {
  const point = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(word.word);
  if (point && !word.quoted) return { by: "point", x: Number(point[1]), y: Number(point[2]) };
  if (word.word.startsWith("#") && word.word.length > 1 && (!word.quoted || word.id)) return { by: "id", id: word.word.slice(1) };
  return { by: "label", label: word.word };
}

export const targetWords = (target: StepTarget): string =>
  target.by === "point" ? `@${target.x},${target.y}` : target.by === "id" ? `#${target.id}` : JSON.stringify(target.label);

/** Elements a person presses before ones they read, when a label is on both. */
const PRESSABLE = new Set(["button", "cell", "link", "tab", "switch", "field", "secure-field", "search-field", "text-view", "menu-item", "icon", "key", "segmented"]);

/**
 * The element a step names, or null: an exact id; else an exact label (any
 * case), else a label that starts with it, else one that holds it; a
 * pressable, enabled element first, then the one nearest the top.
 */
export function findElement(screen: Screen, target: StepTarget): ScreenElement | null {
  if (target.by === "point") return null;
  if (target.by === "id") return screen.elements.find((element) => element.id === target.id) ?? null;
  const wanted = target.label.toLowerCase();
  const rank = (element: ScreenElement): number => (PRESSABLE.has(element.kind) ? 0 : 1) + (element.state.includes("disabled") ? 2 : 0);
  for (const match of [
    (element: ScreenElement) => element.label.toLowerCase() === wanted || element.value?.toLowerCase() === wanted,
    (element: ScreenElement) => element.label.toLowerCase().startsWith(wanted),
    (element: ScreenElement) => element.label.toLowerCase().includes(wanted) || Boolean(element.value?.toLowerCase().includes(wanted)),
  ]) {
    const found = screen.elements.filter(match).sort((left, right) => rank(left) - rank(right));
    if (found.length) return found[0]!;
  }
  return null;
}
