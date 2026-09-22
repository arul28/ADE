/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  APPLE_DRAWER_GROUPS,
  DRAWER_BUTTON,
  DRAWER_GHOST_BUTTON,
  DRAWER_ICON_BUTTON,
  DRAWER_INPUT,
  DRAWER_PRIMARY_BUTTON,
  DrawerSegmented,
  DrawerSwitch,
  Group,
  Row,
  Subhead,
  isAppleDrawerGroupId,
} from "./drawerPrimitives";

afterEach(cleanup);

describe("drawer primitives", () => {
  it("names the four groups §B1 asks for, in order", () => {
    expect(APPLE_DRAWER_GROUPS).toEqual(["device", "app", "capture", "preview-lab"]);
    expect(isAppleDrawerGroupId("capture")).toBe(true);
    expect(isAppleDrawerGroupId("recording")).toBe(false);
    expect(isAppleDrawerGroupId(null)).toBe(false);
  });

  it("puts NO outline on any control: the card carries the edge (§B2)", () => {
    // The owner's report was forty hairline boxes in one column. Every token
    // here is `border-0` or borderless by construction; the card class is the
    // only thing in the drawer that draws an edge.
    for (const token of [DRAWER_BUTTON, DRAWER_PRIMARY_BUTTON, DRAWER_GHOST_BUTTON, DRAWER_ICON_BUTTON, DRAWER_INPUT]) {
      expect(token).toContain("border-0");
      expect(token).not.toContain("border-border");
    }
  });

  it("spends the accent on the primary verb and nothing else", () => {
    expect(DRAWER_PRIMARY_BUTTON).toContain("var(--color-accent)");
    for (const token of [DRAWER_BUTTON, DRAWER_GHOST_BUTTON, DRAWER_ICON_BUTTON, DRAWER_INPUT]) {
      expect(token).not.toContain("var(--color-accent)_22%");
    }
  });

  it("fills controls with a foreground mix, never white, so the light theme sees them too", () => {
    for (const token of [DRAWER_BUTTON, DRAWER_INPUT]) {
      expect(token).toContain("var(--color-fg)");
      expect(token).not.toContain("bg-white/");
    }
  });

  describe("Group", () => {
    function renderGroup(open: boolean, onToggle = vi.fn()) {
      return {
        onToggle,
        ...render(
          <Group id="device" title="Device" open={open} onToggle={onToggle} testId="g" right={<button type="button">More</button>}>
            <p>body</p>
          </Group>,
        ),
      };
    }

    it("is a solid tools-grid card that says whether it is open", () => {
      renderGroup(true);
      const card = screen.getByTestId("g");
      expect(card.className).toContain("ade-tool-card");
      expect(card.className).toContain("ade-tool-card-solid");
      expect(card.getAttribute("data-open")).toBe("true");
      expect(screen.getByRole("button", { name: "Device" }).getAttribute("aria-expanded")).toBe("true");
    });

    it("UNMOUNTS its body when closed, so the polls inside it stop", () => {
      const { rerender, onToggle } = renderGroup(false);
      expect(screen.queryByText("body")).toBeNull();
      // The header-right slot belongs to the open card: a `⋯` over a collapsed
      // header acts on rows nobody can see.
      expect(screen.queryByRole("button", { name: "More" })).toBeNull();
      rerender(
        <Group id="device" title="Device" open onToggle={onToggle} testId="g" right={<button type="button">More</button>}>
          <p>body</p>
        </Group>,
      );
      expect(screen.getByText("body")).toBeTruthy();
      expect(screen.getByRole("button", { name: "More" })).toBeTruthy();
    });

    it("hands its own id to the toggle, open or closed", () => {
      const { onToggle } = renderGroup(true);
      fireEvent.click(screen.getByRole("button", { name: "Device" }));
      expect(onToggle).toHaveBeenCalledWith("device");
    });

    it("gives the card the only heading, so a screen reader hears four sections", () => {
      renderGroup(true);
      expect(screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent)).toEqual(["Device"]);
    });
  });

  it("draws a Subhead as a muted label, not a heading", () => {
    render(<Subhead label="Location" />);
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Location").className).toContain("text-muted-fg/70");
  });

  it("keeps a row's label and control on one line, with the label giving way", () => {
    render(<Row label="Reduce Transparency"><span>x</span></Row>);
    const label = screen.getByText("Reduce Transparency");
    expect(label.parentElement?.className).toContain("flex-nowrap");
    expect(label.className).toContain("truncate");
  });

  it("renders an unreported switch off and inert rather than hiding it", () => {
    const onChange = vi.fn();
    render(<DrawerSwitch label="VoiceOver" checked={undefined} disabled={false} onChange={onChange} />);
    const control = screen.getByRole("switch", { name: "VoiceOver" }) as HTMLButtonElement;
    expect(control.disabled).toBe(true);
    expect(control.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(control);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not re-write the segment that is already selected", () => {
    const onChange = vi.fn();
    render(
      <DrawerSegmented
        ariaLabel="Appearance"
        value="light"
        options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
        disabled={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Dark" }));
    expect(onChange).toHaveBeenCalledWith("dark");
  });
});
