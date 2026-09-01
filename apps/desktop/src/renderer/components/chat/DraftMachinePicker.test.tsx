/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftMachinePicker, type DraftMachineOption } from "./DraftMachinePicker";

const LOCAL: DraftMachineOption = { id: "this-mac", name: "This computer" };
const STUDIO: DraftMachineOption = { id: "studio", name: "Mac Studio" };
const CLOUD: DraftMachineOption = {
  id: "__ade_cursor_cloud__",
  name: "Cursor Cloud",
  kind: "cloud",
};

describe("DraftMachinePicker", () => {
  afterEach(() => {
    cleanup();
  });

  async function revealTooltip(element: HTMLElement) {
    fireEvent.mouseEnter(element.parentElement ?? element);
  }

  it("mentions Cursor Cloud in the trigger tooltip only when a cloud row exists", async () => {
    const onChange = vi.fn();
    const view = render(
      <DraftMachinePicker
        machines={[LOCAL, STUDIO]}
        selectedMachineId={LOCAL.id}
        onChange={onChange}
      />,
    );
    const trigger = screen.getByRole("button", { name: /Choose machine/ });
    await revealTooltip(trigger);
    expect(await screen.findByText(/Pick this computer or another paired computer/)).toBeTruthy();
    expect(screen.queryByText(/or Cursor Cloud/)).toBeNull();

    view.rerender(
      <DraftMachinePicker
        machines={[LOCAL, CLOUD]}
        selectedMachineId={LOCAL.id}
        onChange={onChange}
      />,
    );
    await revealTooltip(screen.getByRole("button", { name: /Choose machine/ }));
    expect(await screen.findByText(/or Cursor Cloud/)).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders a disabled cloud row with its unavailableReason as the tooltip", async () => {
    render(
      <DraftMachinePicker
        machines={[
          LOCAL,
          {
            ...CLOUD,
            unavailableReason: "Parallel models runs locally.",
          },
        ]}
        selectedMachineId={LOCAL.id}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Choose machine/ }));
    const cloudRow = await screen.findByRole("menuitemradio", { name: /Cursor Cloud/ });
    expect((cloudRow as HTMLButtonElement).disabled).toBe(true);
    await revealTooltip(cloudRow);
    expect(await screen.findByText("Parallel models runs locally.")).toBeTruthy();
    expect(cloudRow.getAttribute("aria-checked")).toBe("false");
  });

  it("keeps the recovery picker visible when the selected machine disappeared", () => {
    const onChange = vi.fn();
    render(
      <DraftMachinePicker
        machines={[LOCAL]}
        selectedMachineId="studio"
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /current machine unavailable; fallback This computer/i,
    });
    fireEvent.click(trigger);

    const localRow = screen.getByRole("menuitemradio", { name: /This computer/ });
    expect(localRow).toBeTruthy();
    fireEvent.click(localRow);
    expect(onChange).toHaveBeenCalledWith(LOCAL.id);
  });

  it("keeps the recovery picker visible when the selected machine is unavailable", () => {
    const onChange = vi.fn();
    render(
      <DraftMachinePicker
        machines={[{ ...LOCAL, unavailableReason: "The machine is offline." }]}
        selectedMachineId={LOCAL.id}
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: /current machine unavailable; fallback This computer/i,
    });
    fireEvent.click(trigger);

    expect(screen.getByRole("menuitemradio", { name: /This computer/ })).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
});
