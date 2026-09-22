import { describe, expect, it } from "vitest";
import type { IosScreenElement } from "../../../shared/types/iosSimulator";
import {
  ancestorsOf,
  commandFor,
  describeElement,
  hitTest,
  inspectContextFor,
  inspectTree,
  refTierOf,
  type IosSimulatorSnapshotElement,
} from "./appleInspectGeometry";

function makeElement(overrides: Partial<IosScreenElement> & Pick<IosScreenElement, "id" | "frame">): IosSimulatorSnapshotElement {
  const frame = overrides.frame;
  return {
    source: "accessibility",
    layer: "accessibility",
    label: null,
    value: null,
    role: null,
    elementType: null,
    identifier: null,
    pixelFrame: {
      x: frame.x * 3,
      y: frame.y * 3,
      width: frame.width * 3,
      height: frame.height * 3,
    },
    componentId: null,
    sourceFile: null,
    sourceLine: null,
    metadata: {},
    ...overrides,
    frame,
  };
}

const screen = makeElement({
  id: "screen",
  role: "application",
  frame: { x: 0, y: 0, width: 390, height: 844 },
});

const form = makeElement({
  id: "form",
  role: "form",
  label: "Sign in",
  frame: { x: 16, y: 200, width: 358, height: 280 },
});

const email = makeElement({
  id: "email",
  role: "textField",
  label: "Email",
  identifier: "emailField",
  frame: { x: 24, y: 220, width: 342, height: 44 },
});

const signIn = makeElement({
  id: "sign-in",
  source: "ade-inspector",
  layer: "app",
  role: "button",
  label: "Sign in",
  identifier: "signInButton",
  componentId: "SignInButton",
  sourceFile: "SignInView.swift",
  sourceLine: 42,
  frame: { x: 24, y: 412, width: 327, height: 50 },
});

const ghost = makeElement({
  id: "ghost",
  frame: { x: 40, y: 500, width: 80, height: 20 },
});

describe("hitTest", () => {
  const elements = [screen, form, email, signIn];

  it("returns the smallest-area element under a point", () => {
    const hit = hitTest(elements, { x: 50, y: 430 });
    expect(hit?.id).toBe("sign-in");
  });

  it("walks out to a container when the point only hits the larger frame", () => {
    const hit = hitTest(elements, { x: 30, y: 260 });
    expect(hit?.id).toBe("email");
    expect(hitTest(elements, { x: 20, y: 260 })?.id).toBe("form");
  });

  it("breaks equal-area ties by later snapshot index", () => {
    const first = makeElement({
      id: "first",
      label: "First",
      frame: { x: 10, y: 10, width: 40, height: 40 },
    });
    const second = makeElement({
      id: "second",
      label: "Second",
      frame: { x: 10, y: 10, width: 40, height: 40 },
    });
    expect(hitTest([first, second], { x: 20, y: 20 })?.id).toBe("second");
    expect(hitTest([second, first], { x: 20, y: 20 })?.id).toBe("first");
  });

  it("returns null when nothing contains the point", () => {
    expect(hitTest(elements, { x: -4, y: 10 })).toBeNull();
  });
});

describe("ancestorsOf", () => {
  it("walks containment from nearest parent to root when the snapshot has no parent ids", () => {
    const chain = ancestorsOf([screen, form, email, signIn], "sign-in");
    expect(chain.map((element) => element.id)).toEqual(["form", "screen"]);
  });

  it("uses declared parent ids when the snapshot carries them", () => {
    const root = makeElement({
      id: "root",
      frame: { x: 0, y: 0, width: 100, height: 100 },
      metadata: {},
    });
    const child = {
      ...makeElement({
        id: "child",
        frame: { x: 10, y: 10, width: 20, height: 20 },
      }),
      parentId: "mid",
    } as IosSimulatorSnapshotElement & { parentId: string };
    const mid = {
      ...makeElement({
        id: "mid",
        frame: { x: 5, y: 5, width: 80, height: 80 },
      }),
      parentId: "root",
    } as IosSimulatorSnapshotElement & { parentId: string };
    expect(ancestorsOf([root, child, mid], "child").map((element) => element.id)).toEqual(["mid", "root"]);
  });

  it("returns an empty chain for an unknown ref", () => {
    expect(ancestorsOf([screen], "missing")).toEqual([]);
  });
});

describe("inspectTree", () => {
  it("indents by containment", () => {
    const tree = inspectTree([screen, form, email, signIn]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.element.id).toBe("screen");
    expect(tree[0]?.children.map((node) => node.element.id)).toEqual(["form"]);
    expect(tree[0]?.children[0]?.children.map((node) => node.element.id)).toEqual(["email", "sign-in"]);
  });
});

describe("commandFor and ref tiers", () => {
  it("copies --identifier when the element has one (id: tier)", () => {
    expect(refTierOf(signIn)).toBe("id:");
    expect(commandFor(signIn)).toBe("ade --socket apple tap-element --identifier signInButton");
  });

  it("copies --ref component: when there is a component id and no identifier", () => {
    const el = makeElement({
      id: "comp",
      componentId: "SettingsRow",
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(refTierOf(el)).toBe("component:");
    expect(commandFor(el)).toBe("ade --socket apple tap-element --ref component:SettingsRow");
  });

  it("copies --label when the tier is label:", () => {
    const el = makeElement({
      id: "lab",
      label: "Continue",
      role: "button",
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(refTierOf(el)).toBe("label:");
    expect(commandFor(el)).toBe("ade --socket apple tap-element --label Continue");
  });

  it("quotes labels that need a shell token", () => {
    const el = makeElement({
      id: "spaced",
      label: "Sign in",
      role: "button",
      frame: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(commandFor(el)).toBe("ade --socket apple tap-element --label 'Sign in'");
  });

  it("falls back to --ref pos: when the element carries no identity", () => {
    expect(refTierOf(ghost)).toBe("pos:");
    expect(commandFor(ghost)).toBe("ade --socket apple tap-element --ref pos:ghost");
  });

  it("uses --identifier/--label when a pos: row still has a better query in metadata", () => {
    const byIdentifier = makeElement({
      id: "pos-id",
      frame: { x: 0, y: 0, width: 10, height: 10 },
      metadata: { accessibilityIdentifier: "hiddenId" },
    });
    expect(refTierOf(byIdentifier)).toBe("id:");
    expect(commandFor(byIdentifier)).toBe("ade --socket apple tap-element --identifier hiddenId");
  });
});

describe("describeElement", () => {
  it("formats title, subtitle, ref tier, and source file:line", () => {
    const described = describeElement(signIn);
    expect(described).toEqual({
      title: "Sign in",
      subtitle: "button · #signInButton",
      refTier: "id:",
      source: "SignInView.swift:42",
    });
  });
});

describe("inspectContextFor", () => {
  it("reproduces the insert-inspect-context packet shape", () => {
    const text = inspectContextFor(signIn, [screen, form, email, signIn]);
    expect(text).toContain("iOS visual inspect context attached by the user.");
    expect(text).toContain("1. Sign in (SignInView.swift:42, frame=x=24, y=412, w=327, h=50)");
    expect(text).toContain('"sourceConfidence": "exact"');
    expect(text).toContain('"componentId": "SignInButton"');
    expect(text).toContain('"screenshotFrame"');
    expect(text).toContain("nearbyElements");
    expect(text).toContain('"relation": "ancestor-or-container"');
  });
});
