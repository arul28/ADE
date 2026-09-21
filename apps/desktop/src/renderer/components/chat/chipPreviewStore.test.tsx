/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { useAppStore } from "../../state/appStore";
import { resetChipPreviewCacheForTesting, useChipPreview } from "./chipPreviewStore";

const URL = "https://linear.app/ade/issue/ADE-1";

function Probe() {
  const preview = useChipPreview(URL);
  return <span data-testid="title">{preview?.title ?? "—"}</span>;
}

function setProject(rootPath: string) {
  useAppStore.setState({ project: { rootPath } as never, projectBinding: null });
}

afterEach(() => {
  cleanup();
  resetChipPreviewCacheForTesting();
  useAppStore.setState({ project: null, projectBinding: null });
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("useChipPreview project scope", () => {
  it("re-keys to the new project when the project switches under a mounted chip", async () => {
    // The whole point of the project scope is that a title read with one
    // project's credentials never appears under another. A project switch keeps
    // the chat pane mounted, so the chip must SUBSCRIBE to the scope — a
    // one-shot read leaves it showing the previous project's title forever.
    const resolveSmartLinkPreview = vi.fn(async () => ({
      title: useAppStore.getState().project?.rootPath === "/alpha" ? "Alpha issue" : "Beta issue",
      iconDataUrl: null,
    }));
    (window as unknown as { ade: unknown }).ade = { agentChat: { resolveSmartLinkPreview } };

    setProject("/alpha");
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId("title").textContent).toBe("Alpha issue"));

    setProject("/beta");
    await waitFor(() => expect(screen.getByTestId("title").textContent).toBe("Beta issue"));
    expect(resolveSmartLinkPreview).toHaveBeenCalledTimes(2);
  });
});
