import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BranchIcon,
  Button,
  Chip,
  EmptyState,
  INPUT_CLS,
  LaneIcon,
  PaneHeader,
  SettingsSectionShell,
  SettingsToggle,
  cn,
} from "../src/index";

afterEach(cleanup);

describe("cn", () => {
  it("merges conflicting Tailwind utilities, last one wins", () => {
    // Load-bearing: desktop call sites pass `h-6 px-2` to override Button's
    // own `h-8 px-4`. Drop tailwind-merge and those call sites regress.
    expect(cn("h-8 px-4", "h-6 px-2")).toBe("h-6 px-2");
    expect(cn("a", false && "b", ["c"])).toBe("a c");
  });
});

describe("Button", () => {
  it("emits both vocabularies so one component serves app and page", () => {
    render(<Button>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    // Tailwind utilities for the desktop renderer…
    expect(button.className).toContain("inline-flex");
    expect(button.className).toContain("h-8");
    expect(button.className).toContain("px-4");
    expect(button.className).toContain("tracking-[1px]");
    // …and the stable kit classes the injected stylesheet implements.
    expect(button.className).toContain("ade-btn");
    expect(button.className).toContain("ade-btn-md");
    expect(button.className).toContain("ade-btn-outline");
  });

  it("keeps the inline variant chrome, which is host-independent", () => {
    const { rerender } = render(<Button variant="primary">P</Button>);
    expect(screen.getByRole("button").style.background).toBe("rgb(167, 139, 250)");
    rerender(<Button variant="danger">D</Button>);
    expect(screen.getByRole("button").className).toContain("ade-btn-danger");
    rerender(<Button variant="ghost" size="sm">G</Button>);
    const ghost = screen.getByRole("button");
    expect(ghost.className).toContain("ade-btn-sm");
    expect(ghost.className).toContain("h-7");
    expect(ghost.style.background).toBe("transparent");
  });

  it("lets a caller override the size utilities", () => {
    render(<Button className="h-6 px-2">S</Button>);
    const button = screen.getByRole("button");
    expect(button.className).toContain("h-6");
    expect(button.className).not.toContain("h-8");
  });

  it("forwards the ref and the native button props", () => {
    let node: HTMLButtonElement | null = null;
    render(<Button ref={(el) => { node = el; }} type="submit" disabled>X</Button>);
    expect(node).not.toBeNull();
    expect(screen.getByRole("button")).toHaveProperty("type", "submit");
    expect(screen.getByRole("button")).toHaveProperty("disabled", true);
  });
});

describe("Chip", () => {
  it("renders its children with both vocabularies", () => {
    render(<Chip>ready</Chip>);
    const chip = screen.getByText("ready");
    expect(chip.className).toContain("ade-chip");
    expect(chip.className).toContain("uppercase");
    expect(chip.style.background).toBe("rgb(26, 23, 32)");
  });
});

describe("PaneHeader", () => {
  it("renders the title, and the meta and right slots only when given", () => {
    const { rerender, container } = render(<PaneHeader title="Issues" />);
    expect(screen.getByText("Issues").className).toContain("ade-pane-header-title");
    expect(container.querySelector(".ade-pane-header-meta")).toBeNull();
    expect(container.querySelector(".ade-pane-header-right")).toBeNull();
    rerender(<PaneHeader title="Issues" meta="12" right={<span>x</span>} />);
    expect(container.querySelector(".ade-pane-header-meta")?.textContent).toBe("12");
    expect(container.querySelector(".ade-pane-header-right")?.textContent).toBe("x");
  });
});

describe("EmptyState", () => {
  it("renders title, description and icon, and survives a host with no animate()", () => {
    // jsdom has no Element.animate. The component must still render its final
    // state rather than throwing — the same path a CSP-restricted guest takes.
    const Icon = ({ size }: { size?: number }) => <svg data-testid="icon" width={size} />;
    const { container } = render(
      <EmptyState title="Nothing here" description="Connect Linear to see issues." icon={Icon}>
        <button type="button">Connect</button>
      </EmptyState>,
    );
    expect(screen.getByText("Nothing here").className).toContain("ade-empty-state-title");
    expect(screen.getByText("Connect Linear to see issues.").className).toContain(
      "ade-empty-state-description",
    );
    expect(screen.getByTestId("icon")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(container.querySelector(".ade-empty-state")).toBeTruthy();
  });

  it("omits the description and icon blocks when they are absent", () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.querySelector(".ade-empty-state-description")).toBeNull();
    expect(container.querySelector(".ade-empty-state-icon")).toBeNull();
  });
});

describe("vcs icons", () => {
  it("draws a lane and a branch glyph, hidden from the accessibility tree", () => {
    const { container } = render(<><LaneIcon /><BranchIcon /></>);
    const lane = container.querySelector(".ade-vcs-lane-icon");
    const branch = container.querySelector(".ade-vcs-branch-icon");
    expect(lane).toBeTruthy();
    expect(branch).toBeTruthy();
    expect(lane?.getAttribute("aria-hidden")).toBe("true");
    expect(branch?.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("settings shell", () => {
  it("mirrors the id onto the settings anchor so search and deep links find it", () => {
    const { container } = render(
      <SettingsSectionShell id="linear" title="Linear" description="Issues" brandColor="#5E6AD2">
        <div>body</div>
      </SettingsSectionShell>,
    );
    const section = container.querySelector("section");
    expect(section?.getAttribute("id")).toBe("linear");
    expect(section?.getAttribute("data-settings-anchor")).toBe("linear");
    expect(screen.getByRole("heading", { name: "Linear" })).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("renders the toggle as a switch that reports its state", () => {
    const seen: boolean[] = [];
    render(<SettingsToggle id="t" checked={false} onChange={(v) => seen.push(v)} />);
    const toggle = screen.getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    toggle.click();
    expect(seen).toEqual([true]);
  });

  it("does not fire onChange while disabled", () => {
    const seen: boolean[] = [];
    render(<SettingsToggle id="t" checked disabled onChange={(v) => seen.push(v)} />);
    screen.getByRole("switch").click();
    expect(seen).toEqual([]);
  });
});

describe("input styles", () => {
  it("keeps the app's class string and appends the kit class", () => {
    expect(INPUT_CLS).toContain("h-8 w-full rounded-md");
    expect(INPUT_CLS).toContain("focus:ring-accent/20");
    expect(INPUT_CLS.endsWith("ade-input")).toBe(true);
  });
});
