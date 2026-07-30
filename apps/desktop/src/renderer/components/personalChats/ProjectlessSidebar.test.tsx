/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ProjectlessSidebar } from "./ProjectlessSidebar";

afterEach(cleanup);

function renderSidebar(overrides: Partial<Parameters<typeof ProjectlessSidebar>[0]> = {}) {
  const props: Parameters<typeof ProjectlessSidebar>[0] = {
    standalone: false,
    machineLabel: "This computer",
    machineId: "local",
    machineOptions: [
      { id: "local", name: "This computer" },
      { id: "target-1", name: "MacBook Pro (97)" },
    ],
    onSelectMachine: vi.fn(),
    grouped: [],
    loading: false,
    query: "",
    onQueryChange: vi.fn(),
    selectedId: null,
    onSelect: vi.fn(),
    onNewChat: vi.fn(),
    onBack: vi.fn(),
    mobileListOpen: true,
    menuId: null,
    onToggleMenu: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  };
  render(<ProjectlessSidebar {...props} />);
  return props;
}

describe("ProjectlessSidebar machine picker", () => {
  it("names the machine absolutely instead of calling it remote or 'this machine'", () => {
    renderSidebar({ machineLabel: "MacBook Pro (97)", machineId: "target-1" });

    const trigger = screen.getByRole("button", {
      name: "Chats run on MacBook Pro (97). Choose a machine.",
    });
    expect(trigger.textContent).toContain("MacBook Pro (97)");
    expect(document.body.textContent).not.toMatch(/this machine/i);
    expect(document.body.textContent).not.toMatch(/remote/i);
  });

  it("lets the user choose the machine instead of inheriting it silently", () => {
    const props = renderSidebar();

    fireEvent.click(
      screen.getByRole("button", { name: "Chats run on This computer. Choose a machine." }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /MacBook Pro \(97\)/ }));

    expect(props.onSelectMachine).toHaveBeenCalledWith("target-1");
  });
});
