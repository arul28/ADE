/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { IosSimulatorRunningPill } from "./IosSimulatorRunningPill";
import { WORK_LIVE_PIP_UNSUPPORTED_LABEL } from "./workLiveIosPictureInPicture";

afterEach(() => {
  cleanup();
});

describe("IosSimulatorRunningPill", () => {
  it("keeps Open and disables Float when picture-in-picture is unavailable", () => {
    render(
      <IosSimulatorRunningPill
        deviceName="iPhone 17"
        onOpen={() => {}}
        onFloat={() => {}}
      />,
    );
    expect(screen.getByText("Simulator running")).toBeTruthy();
    expect(screen.getByText("Open")).toBeTruthy();
    const float = screen.getByLabelText("Float") as HTMLButtonElement;
    expect(float.disabled).toBe(true);
    expect(float.getAttribute("aria-label")).toBe("Float");
    expect(WORK_LIVE_PIP_UNSUPPORTED_LABEL.length).toBeGreaterThan(0);
  });
});
