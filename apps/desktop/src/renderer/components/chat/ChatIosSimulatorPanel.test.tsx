/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatIosSimulatorPanel } from "./ChatIosSimulatorPanel";

/**
 * These are host tests. The panel is now two lines of routing — which surface
 * is showing, and what the toggle and `drawerModeRequest` do to it — so both
 * surfaces are mocked. The column's own behaviour is covered beside the column,
 * and Preview Lab's beside Preview Lab; asserting on either from here only
 * bought a second, slower copy of those tests.
 */

/**
 * The chat's machine scope reads the cross-machine lane store, which no test
 * here populates, so the lane's display name would be unreachable without this
 * seam. `lane` is the only field the host reads beyond the machine name.
 */
let scopeLane: { id: string; name: string } | null = null;

vi.mock("./ChatRuntimeScope", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./ChatRuntimeScope");
  return {
    ...actual,
    useChatRuntimeScopeForPin: (pin: unknown, laneId: string | null) => ({
      pin,
      binding: null,
      laneId,
      lane: scopeLane,
      laneWorktreePath: null,
      rootPath: null,
      isRemote: false,
      machineName: "This computer",
      online: true,
    }),
  };
});

type ColumnProps = { laneName: string; headerExtra?: React.ReactNode };
type PreviewProps = { headerExtra?: React.ReactNode };

const columnProps: ColumnProps[] = [];
const previewProps: PreviewProps[] = [];

vi.mock("../apple/AppleDeviceColumn", () => ({
  AppleDeviceColumn: (props: ColumnProps) => {
    columnProps.push(props);
    return (
      <div data-testid="apple-device-column">
        <span data-testid="column-lane-name">{props.laneName}</span>
        {props.headerExtra}
      </div>
    );
  },
}));

vi.mock("./IosSimPreviewLab", () => ({
  IosSimPreviewLab: (props: PreviewProps) => {
    previewProps.push(props);
    return (
      <div data-testid="ios-preview-lab">
        {props.headerExtra}
      </div>
    );
  },
}));

function renderPanel(overrides: Partial<React.ComponentProps<typeof ChatIosSimulatorPanel>> = {}) {
  return render(
    <ChatIosSimulatorPanel
      sessionId="chat-1"
      laneId="lane-1"
      projectRoot="/repo"
      {...overrides}
    />,
  );
}

beforeEach(() => {
  scopeLane = null;
  columnProps.length = 0;
  previewProps.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("ChatIosSimulatorPanel host", () => {
  it("shows the device column by default", () => {
    renderPanel();
    expect(screen.getByTestId("apple-device-column")).toBeTruthy();
    expect(screen.queryByTestId("ios-preview-lab")).toBeNull();
  });

  it("renders the surface toggle inside the column's header slot", () => {
    renderPanel();
    const column = screen.getByTestId("apple-device-column");
    expect(column.querySelector('[data-testid="ios-surface-toggle"]')).not.toBeNull();
  });

  it("switches to Preview Lab and back from the toggle", async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByTestId("ios-surface-preview"));
    expect(screen.getByTestId("ios-preview-lab")).toBeTruthy();
    expect(screen.queryByTestId("apple-device-column")).toBeNull();

    await user.click(screen.getByTestId("ios-surface-device"));
    expect(screen.getByTestId("apple-device-column")).toBeTruthy();
    expect(screen.queryByTestId("ios-preview-lab")).toBeNull();
  });

  it("gives Preview Lab the same toggle in its own header", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByTestId("ios-surface-preview"));
    const lab = screen.getByTestId("ios-preview-lab");
    expect(lab.querySelector('[data-testid="ios-surface-toggle"]')).not.toBeNull();
  });

  it("marks the showing surface as pressed", async () => {
    const user = userEvent.setup();
    renderPanel();
    expect(screen.getByTestId("ios-surface-device").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("ios-surface-preview").getAttribute("aria-pressed")).toBe("false");

    await user.click(screen.getByTestId("ios-surface-preview"));
    expect(screen.getByTestId("ios-surface-preview").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens Preview Lab for a preview drawer request", () => {
    renderPanel({ drawerModeRequest: { mode: "preview", nonce: 1 } });
    expect(screen.getByTestId("ios-preview-lab")).toBeTruthy();
  });

  it("returns to the device for any non-preview drawer request", () => {
    const { rerender } = renderPanel({ drawerModeRequest: { mode: "preview", nonce: 1 } });
    expect(screen.getByTestId("ios-preview-lab")).toBeTruthy();

    rerender(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        laneId="lane-1"
        projectRoot="/repo"
        drawerModeRequest={{ mode: "inspect", nonce: 2 }}
      />,
    );
    expect(screen.getByTestId("apple-device-column")).toBeTruthy();
    expect(screen.queryByTestId("ios-preview-lab")).toBeNull();
  });

  it("re-requesting the same mode with a new nonce still switches back", () => {
    const { rerender } = renderPanel({ drawerModeRequest: { mode: "interact", nonce: 1 } });
    const swap = (mode: "interact" | "preview", nonce: number) => rerender(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        laneId="lane-1"
        projectRoot="/repo"
        drawerModeRequest={{ mode, nonce }}
      />,
    );

    swap("preview", 2);
    expect(screen.getByTestId("ios-preview-lab")).toBeTruthy();
    swap("interact", 3);
    expect(screen.getByTestId("apple-device-column")).toBeTruthy();
  });

  it("resolves the lane's display name for the column", () => {
    scopeLane = { id: "lane-1", name: "apple-device-env" };
    renderPanel();
    expect(screen.getByTestId("column-lane-name").textContent).toBe("apple-device-env");
  });

  it("falls back to the lane id when the lane list has not loaded", () => {
    renderPanel();
    expect(screen.getByTestId("column-lane-name").textContent).toBe("lane-1");
  });

  it("falls back to a readable label with no lane at all", () => {
    renderPanel({ laneId: null });
    expect(screen.getByTestId("column-lane-name").textContent).toBe("this lane");
  });
});
