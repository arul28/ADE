/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, forwardRef, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding, PromptStashEntry } from "../../../shared/types";
import {
  ComposerPromptStash as ProductionComposerPromptStash,
  type ComposerPromptStashHandle,
} from "./ComposerPromptStash";

const noopAddAttachment = () => {};
const noopRemoveAttachment = () => {};
type ProductionPromptStashProps = ComponentProps<typeof ProductionComposerPromptStash>;
type TestPromptStashProps = Omit<ProductionPromptStashProps, "onAddAttachment" | "onRemoveAttachment"> & {
  onAddAttachment?: ProductionPromptStashProps["onAddAttachment"];
  onRemoveAttachment?: ProductionPromptStashProps["onRemoveAttachment"];
};
const ComposerPromptStash = forwardRef<ComposerPromptStashHandle, TestPromptStashProps>(
  function TestComposerPromptStash({
    onAddAttachment = noopAddAttachment,
    onRemoveAttachment = noopRemoveAttachment,
    ...props
  }, ref) {
    return (
      <ProductionComposerPromptStash
        ref={ref}
        {...props}
        onAddAttachment={onAddAttachment}
        onRemoveAttachment={onRemoveAttachment}
      />
    );
  },
);

const savedEntry: PromptStashEntry = {
  id: "stash-1",
  text: "Fix the parser",
  provider: "codex",
  modelId: "openai/gpt-5.4",
  createdAt: "2026-07-28T12:00:00.000Z",
};

function installBridge(overrides?: {
  list?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
  getImageDataUrl?: ReturnType<typeof vi.fn>;
  saveTempAttachment?: ReturnType<typeof vi.fn>;
}) {
  const promptStashes = {
    list: overrides?.list ?? vi.fn().mockResolvedValue([]),
    create: overrides?.create ?? vi.fn().mockResolvedValue(savedEntry),
    delete: overrides?.delete ?? vi.fn().mockResolvedValue(true),
  };
  (window as unknown as { ade: unknown }).ade = {
    agentChat: {
      promptStashes,
      getImageDataUrl: overrides?.getImageDataUrl ?? vi.fn().mockResolvedValue({
        dataUrl: "data:image/png;base64,cHJldmlldw==",
      }),
      saveTempAttachment: overrides?.saveTempAttachment ?? vi.fn().mockResolvedValue({
        path: "/project/.ade/attachments/stashed-design.png",
      }),
    },
  };
  return promptStashes;
}

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("ComposerPromptStash", () => {
  it("stays out of the toolbar when the composer and stash list are both empty", async () => {
    const bridge = installBridge();
    render(
      <ComposerPromptStash
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(bridge.list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /stashed prompt/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stash prompt" })).toBeNull();
  });

  it("honors the appearance toggle even when shared stashes exist", async () => {
    const bridge = installBridge({ list: vi.fn().mockResolvedValue([savedEntry]) });
    render(
      <ComposerPromptStash
        draft=""
        active
        buttonVisible={false}
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(bridge.list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Open 1 stashed prompt" })).toBeNull();
  });

  it("clears only after the runtime durably saves the prompt", async () => {
    const create = vi.fn().mockResolvedValue(savedEntry);
    const bridge = installBridge({ create });
    const onDraftChange = vi.fn();
    render(
      <ComposerPromptStash
        draft="Fix the parser"
        provider="codex"
        modelId="openai/gpt-5.4"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      text: "Fix the parser",
      provider: "codex",
      modelId: "openai/gpt-5.4",
    }, null));
    expect(onDraftChange).toHaveBeenCalledWith("");
    expect(bridge.list).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft intact and explains a failed save", async () => {
    installBridge({
      create: vi.fn().mockRejectedValue(new Error("Runtime unavailable")),
    });
    const onDraftChange = vi.fn();
    render(
      <ComposerPromptStash
        draft="Do not lose this"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Runtime unavailable");
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("restores a shared stash as a take operation", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    installBridge({
      list: vi.fn().mockResolvedValue([savedEntry]),
      delete: remove,
    });
    const onDraftChange = vi.fn();
    render(
      <ComposerPromptStash
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 stashed prompt" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/i }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith({ id: "stash-1" }, null));
    expect(onDraftChange).toHaveBeenCalledWith("Fix the parser");
    expect(screen.queryByText("Stashed prompts")).toBeNull();
  });

  it("deletes a listed stash through the binding that loaded it", async () => {
    const ownerBinding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:stash-owner:stash-project",
      targetId: "stash-owner",
      runtimeName: "Stash owner",
      projectId: "stash-project",
      rootPath: "/remote/stash-project",
      displayName: "Stash project",
    };
    const remove = vi.fn().mockResolvedValue(true);
    installBridge({
      list: vi.fn().mockResolvedValue([savedEntry]),
      delete: remove,
    });
    render(
      <ComposerPromptStash
        draft=""
        composerMachineBinding={ownerBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 stashed prompt" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete stashed prompt" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(
      { id: savedEntry.id },
      ownerBinding,
    ));
  });

  it("moves image attachments into a stash and restores their thumbnail and attachment", async () => {
    const composerMachineBinding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:source-machine:source-project",
      targetId: "source-machine",
      runtimeName: "Source Mac",
      projectId: "source-project",
      rootPath: "/remote/source-project",
      displayName: "Source project",
    };
    const imageAttachment = {
      path: "/remote/source-project/design.png",
      type: "image" as const,
    };
    const storedImageAttachment = {
      path: "/project/.ade/attachments/stashed-design.png",
      type: "image" as const,
    };
    const imageEntry: PromptStashEntry = {
      ...savedEntry,
      text: "Use this design",
      attachments: [storedImageAttachment],
    };
    const create = vi.fn().mockResolvedValue(imageEntry);
    const saveTempAttachment = vi.fn().mockResolvedValue({
      path: storedImageAttachment.path,
    });
    const sourceImageRead = vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,cHJldmlldw==",
    });
    installBridge({
      create,
      getImageDataUrl: sourceImageRead,
      saveTempAttachment,
    });
    const onDraftChange = vi.fn();
    const onRemoveAttachment = vi.fn();
    const saveView = render(
      <ComposerPromptStash
        draft="Use this design"
        attachments={[imageAttachment]}
        composerMachineBinding={composerMachineBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      text: "Use this design",
      attachments: [storedImageAttachment],
      provider: undefined,
      modelId: undefined,
    }, composerMachineBinding));
    expect(saveTempAttachment).toHaveBeenCalledWith({
      data: "cHJldmlldw==",
      filename: "design.png",
    }, composerMachineBinding);
    expect(sourceImageRead).toHaveBeenCalledWith(
      imageAttachment.path,
      composerMachineBinding,
    );
    expect(onDraftChange).toHaveBeenCalledWith("");
    expect(onRemoveAttachment).toHaveBeenCalledWith(imageAttachment.path);
    saveView.unmount();

    const onAddAttachment = vi.fn();
    const remove = vi.fn().mockResolvedValue(true);
    const getImageDataUrl = vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,cHJldmlldw==",
    });
    installBridge({
      list: vi.fn().mockResolvedValue([imageEntry]),
      delete: remove,
      getImageDataUrl,
    });
    render(
      <ComposerPromptStash
        draft=""
        composerMachineBinding={composerMachineBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
        onAddAttachment={onAddAttachment}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 stashed prompt" }));
    await waitFor(() => expect(getImageDataUrl).toHaveBeenCalledWith(
      storedImageAttachment.path,
      composerMachineBinding,
    ));
    expect(document.querySelector("[data-prompt-stash-menu] img")?.getAttribute("src"))
      .toBe("data:image/png;base64,cHJldmlldw==");
    fireEvent.click(screen.getByRole("button", { name: /Use this design/i }));
    expect(onAddAttachment).toHaveBeenCalledWith(storedImageAttachment);
    await waitFor(() => expect(remove).toHaveBeenCalledWith(
      { id: imageEntry.id },
      composerMachineBinding,
    ));
  });

  it("pins a sequential image copy to its captured owner when the active binding switches", async () => {
    const originalBinding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:source-machine:source-project",
      targetId: "source-machine",
      runtimeName: "Source Mac",
      projectId: "source-project",
      rootPath: "/remote/source-project",
      displayName: "Source project",
    };
    const switchedBinding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:other-machine:other-project",
      targetId: "other-machine",
      runtimeName: "Other Mac",
      projectId: "other-project",
      rootPath: "/remote/other-project",
      displayName: "Other project",
    };
    const sourceAttachments = [
      { path: "/Users/me/Desktop/first.png", type: "image" as const },
      { path: "/Users/me/Desktop/second.png", type: "image" as const },
    ];
    const storedAttachments = [
      { path: "/project/.ade/attachments/first.png", type: "image" as const },
      { path: "/project/.ade/attachments/second.png", type: "image" as const },
    ];
    let resolveFirstRead: ((result: { dataUrl: string }) => void) | undefined;
    let resolveSecondRead: ((result: { dataUrl: string }) => void) | undefined;
    let resolveFirstSave: ((result: { path: string }) => void) | undefined;
    let resolveSecondSave: ((result: { path: string }) => void) | undefined;
    const getImageDataUrl = vi.fn()
      .mockImplementationOnce(() => new Promise<{ dataUrl: string }>((resolve) => {
        resolveFirstRead = resolve;
      }))
      .mockImplementationOnce(() => new Promise<{ dataUrl: string }>((resolve) => {
        resolveSecondRead = resolve;
      }));
    const saveTempAttachment = vi.fn()
      .mockImplementationOnce(() => new Promise<{ path: string }>((resolve) => {
        resolveFirstSave = resolve;
      }))
      .mockImplementationOnce(() => new Promise<{ path: string }>((resolve) => {
        resolveSecondSave = resolve;
      }));
    const create = vi.fn().mockResolvedValue({
      ...savedEntry,
      attachments: storedAttachments,
    });
    installBridge({ create, getImageDataUrl, saveTempAttachment });
    const onDraftChange = vi.fn();
    const view = render(
      <ComposerPromptStash
        draft="Keep these images ordered"
        attachments={sourceAttachments}
        composerMachineBinding={originalBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));

    await waitFor(() => expect(getImageDataUrl).toHaveBeenCalledTimes(1));
    expect(getImageDataUrl).toHaveBeenNthCalledWith(
      1,
      sourceAttachments[0]!.path,
      originalBinding,
    );
    expect(saveTempAttachment).not.toHaveBeenCalled();

    view.rerender(
      <ComposerPromptStash
        draft="Keep these images ordered"
        attachments={sourceAttachments}
        composerMachineBinding={switchedBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    await act(async () => {
      resolveFirstRead?.({ dataUrl: "data:image/png;base64,Zmlyc3Q=" });
    });
    await waitFor(() => expect(saveTempAttachment).toHaveBeenCalledTimes(1));
    expect(saveTempAttachment).toHaveBeenNthCalledWith(1, {
      data: "Zmlyc3Q=",
      filename: "first.png",
    }, originalBinding);
    expect(getImageDataUrl).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstSave?.({ path: storedAttachments[0]!.path });
    });
    await waitFor(() => expect(getImageDataUrl).toHaveBeenCalledTimes(2));
    expect(getImageDataUrl).toHaveBeenNthCalledWith(
      2,
      sourceAttachments[1]!.path,
      originalBinding,
    );
    expect(saveTempAttachment).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSecondRead?.({ dataUrl: "data:image/png;base64,c2Vjb25k" });
    });
    await waitFor(() => expect(saveTempAttachment).toHaveBeenCalledTimes(2));
    expect(saveTempAttachment).toHaveBeenNthCalledWith(2, {
      data: "c2Vjb25k",
      filename: "second.png",
    }, originalBinding);
    expect(create).not.toHaveBeenCalled();

    await act(async () => {
      resolveSecondSave?.({ path: storedAttachments[1]!.path });
    });
    await waitFor(() => expect(create).toHaveBeenCalledWith({
      text: "Keep these images ordered",
      attachments: storedAttachments,
      provider: undefined,
      modelId: undefined,
    }, originalBinding));
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("never falls back to this desktop for an image owned by the effective remote binding", async () => {
    const composerMachineBinding: OpenProjectBinding = {
      kind: "remote",
      key: "remote:source-machine:source-project",
      targetId: "source-machine",
      runtimeName: "Source Mac",
      projectId: "source-project",
      rootPath: "/remote/source-project",
      displayName: "Source project",
    };
    const runtimeRead = vi.fn().mockRejectedValue(new Error("source runtime unavailable"));
    installBridge({ getImageDataUrl: runtimeRead });
    const localRead = vi.fn();
    (window as any).ade.app = { getImageDataUrl: localRead };

    render(
      <ComposerPromptStash
        draft="Keep the remote image"
        attachments={[{
          path: "/remote/source-project/design.png",
          type: "image",
        }]}
        composerMachineBinding={composerMachineBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));

    expect((await screen.findByRole("alert")).textContent).toContain("source runtime unavailable");
    expect(runtimeRead).toHaveBeenCalledWith(
      "/remote/source-project/design.png",
      composerMachineBinding,
    );
    expect(localRead).not.toHaveBeenCalled();
  });

  it("allows the captured local owner to use the Electron image fallback", async () => {
    const localBinding: OpenProjectBinding = {
      kind: "local",
      key: "local:/project",
      rootPath: "/project",
      displayName: "Project",
    };
    const sourceAttachment = {
      path: "/Users/me/Desktop/design.png",
      type: "image" as const,
    };
    const storedAttachment = {
      path: "/project/.ade/attachments/design.png",
      type: "image" as const,
    };
    const runtimeRead = vi.fn().mockRejectedValue(new Error("local runtime unavailable"));
    const localRead = vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,cHJldmlldw==",
    });
    const saveTempAttachment = vi.fn().mockResolvedValue({ path: storedAttachment.path });
    const create = vi.fn().mockResolvedValue({
      ...savedEntry,
      attachments: [storedAttachment],
    });
    installBridge({ create, getImageDataUrl: runtimeRead, saveTempAttachment });
    (window as any).ade.app = { getImageDataUrl: localRead };

    render(
      <ComposerPromptStash
        draft="Keep the local image"
        attachments={[sourceAttachment]}
        composerMachineBinding={localBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      text: "Keep the local image",
      attachments: [storedAttachment],
      provider: undefined,
      modelId: undefined,
    }, localBinding));
    expect(runtimeRead).toHaveBeenCalledWith(sourceAttachment.path, localBinding);
    expect(localRead).toHaveBeenCalledWith(sourceAttachment.path);
    expect(saveTempAttachment).toHaveBeenCalledWith({
      data: "cHJldmlldw==",
      filename: "design.png",
    }, localBinding);
  });

  it("keeps the original image when an older runtime cannot confirm attachment persistence", async () => {
    const localBinding: OpenProjectBinding = {
      kind: "local",
      key: "local:/project",
      rootPath: "/project",
      displayName: "Project",
    };
    const imageAttachment = {
      path: "/Users/me/Desktop/design.png",
      type: "image" as const,
    };
    const create = vi.fn().mockResolvedValue(savedEntry);
    const bridge = installBridge({ create });
    const onDraftChange = vi.fn();
    const onRemoveAttachment = vi.fn();
    const view = render(
      <ComposerPromptStash
        draft="Keep this safe"
        attachments={[imageAttachment]}
        composerMachineBinding={localBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));
    await waitFor(() => expect(view.container.querySelector(".animate-spin")).toBeNull());
    expect(create).toHaveBeenCalledTimes(1);
    expect(bridge.delete).toHaveBeenCalledWith({ id: savedEntry.id }, localBinding);
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onRemoveAttachment).not.toHaveBeenCalled();
  });

  it("rejects too many images before creating runtime copies", async () => {
    const create = vi.fn();
    const getImageDataUrl = vi.fn();
    const saveTempAttachment = vi.fn();
    installBridge({ create, getImageDataUrl, saveTempAttachment });
    render(
      <ComposerPromptStash
        draft="Too many references"
        attachments={Array.from({ length: 11 }, (_, index) => ({
          path: `/Users/me/Desktop/image-${index}.png`,
          type: "image" as const,
        }))}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stash prompt" }));

    expect((await screen.findByRole("alert")).textContent).toContain("up to 10 images");
    expect(create).not.toHaveBeenCalled();
    expect(getImageDataUrl).not.toHaveBeenCalled();
    expect(saveTempAttachment).not.toHaveBeenCalled();
  });

  it("keeps a machine-bound image stash intact when viewed from another synced runtime", async () => {
    const unavailableEntry: PromptStashEntry = {
      ...savedEntry,
      text: "",
      attachments: [],
      attachmentCount: 1,
      attachmentsAvailable: false,
    };
    const remove = vi.fn().mockResolvedValue(true);
    installBridge({
      list: vi.fn().mockResolvedValue([unavailableEntry]),
      delete: remove,
    });
    const onDraftChange = vi.fn();
    const onAddAttachment = vi.fn();
    render(
      <ComposerPromptStash
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
        onAddAttachment={onAddAttachment}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 stashed prompt" }));
    expect(screen.getByText("1 stashed image")).toBeTruthy();
    expect(screen.getByText("1 image on another machine")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /1 stashed image/i }));

    expect((await screen.findByRole("alert")).textContent).toContain("machine where this prompt was stashed");
    expect(remove).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onAddAttachment).not.toHaveBeenCalled();
  });

  it("renders the menu in a body portal so composer overflow cannot clip it", async () => {
    installBridge({ list: vi.fn().mockResolvedValue([savedEntry]) });
    render(
      <div data-testid="clipping-parent" style={{ overflow: "hidden" }}>
        <ComposerPromptStash
          draft=""
          active
          buttonVisible
          shortcutLabel="⌘+S"
          onDraftChange={vi.fn()}
        />
      </div>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 stashed prompt" }));
    const menu = screen.getByRole("dialog", { name: "Stashed prompts" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toContain("fixed");
  });

  it("repositions the portal when asynchronous menu content changes its height", async () => {
    let resizeCallback: ResizeObserverCallback = () => {
      throw new Error("ResizeObserver callback was not installed");
    };
    const observedElements: Element[] = [];
    const disconnected = vi.fn();
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalInnerHeight = window.innerHeight;
    const originalInnerWidth = window.innerWidth;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }

      observe(target: Element) {
        observedElements.push(target);
      }

      unobserve() {}

      disconnect() {
        disconnected();
      }
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_000 });

    try {
      installBridge({ list: vi.fn().mockResolvedValue([savedEntry]) });
      const view = render(
        <ComposerPromptStash
          draft=""
          active
          buttonVisible
          shortcutLabel="⌘+S"
          onDraftChange={vi.fn()}
        />,
      );

      const openButton = await screen.findByRole("button", { name: "Open 1 stashed prompt" });
      const anchor = view.container.firstElementChild as HTMLElement;
      vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
        bottom: 728,
        height: 28,
        left: 872,
        right: 900,
        top: 700,
        width: 28,
        x: 872,
        y: 700,
        toJSON: () => ({}),
      });
      fireEvent.click(openButton);

      const menu = await screen.findByRole("dialog", { name: "Stashed prompts" });
      expect(observedElements).toContain(menu);
      vi.spyOn(menu, "getBoundingClientRect").mockReturnValue({
        bottom: 300,
        height: 300,
        left: 0,
        right: 380,
        top: 0,
        width: 380,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });

      resizeCallback([], {} as ResizeObserver);

      await waitFor(() => expect(menu.style.top).toBe("390px"));
      view.unmount();
      expect(disconnected).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        value: originalResizeObserver,
      });
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalInnerHeight,
      });
      Object.defineProperty(window, "innerWidth", {
        configurable: true,
        value: originalInnerWidth,
      });
    }
  });

  it("closes the stash menu without consuming an entry when the user starts a new draft", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    installBridge({
      list: vi.fn().mockResolvedValue([savedEntry]),
      delete: remove,
    });
    const onDraftChange = vi.fn();
    const view = render(
      <ComposerPromptStash
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 stashed prompt" }));
    expect(screen.getByRole("dialog", { name: "Stashed prompts" })).toBeTruthy();

    view.rerender(
      <ComposerPromptStash
        draft="A new prompt"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Stashed prompts" })).toBeNull());
    expect(remove).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("keeps the shortcut available when the appearance button is hidden", async () => {
    const create = vi.fn().mockResolvedValue(savedEntry);
    installBridge({ create });
    const onDraftChange = vi.fn();
    const ref = createRef<ComposerPromptStashHandle>();
    render(
      <ComposerPromptStash
        ref={ref}
        draft="Hidden button prompt"
        active
        buttonVisible={false}
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    ref.current?.activate();

    await waitFor(() => expect(create).toHaveBeenCalledWith({
      text: "Hidden button prompt",
      provider: undefined,
      modelId: undefined,
    }, null));
    expect(onDraftChange).toHaveBeenCalledWith("");
    expect(screen.queryByRole("button", { name: "Stash prompt" })).toBeNull();
  });

  it("coalesces rapid shortcut presses into one durable save", async () => {
    let resolveCreate: ((entry: PromptStashEntry) => void) | undefined;
    const create = vi.fn().mockImplementation(() => new Promise<PromptStashEntry>((resolve) => {
      resolveCreate = resolve;
    }));
    installBridge({ create });
    const onDraftChange = vi.fn();
    const ref = createRef<ComposerPromptStashHandle>();
    render(
      <ComposerPromptStash
        ref={ref}
        draft="Save exactly once"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    ref.current?.activate();
    ref.current?.activate();

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    resolveCreate?.(savedEntry);
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith(""));
  });

  it("does not clear newer text typed while a remote save is in flight", async () => {
    let resolveCreate: ((entry: PromptStashEntry) => void) | undefined;
    const create = vi.fn().mockImplementation(() => new Promise<PromptStashEntry>((resolve) => {
      resolveCreate = resolve;
    }));
    installBridge({ create });
    const onDraftChange = vi.fn();
    const ref = createRef<ComposerPromptStashHandle>();
    const view = render(
      <ComposerPromptStash
        ref={ref}
        draft="Save this version"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    ref.current?.activate();
    view.rerender(
      <ComposerPromptStash
        ref={ref}
        draft="Newer typing"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    resolveCreate?.(savedEntry);

    await waitFor(() => expect(view.container.querySelector(".animate-spin")).toBeNull());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Save this version" }),
      null,
    );
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("does not clear text or images when attachments change during a remote save", async () => {
    const originalImage = { path: "/Users/me/Desktop/original.png", type: "image" as const };
    const newerImage = { path: "/Users/me/Desktop/newer.png", type: "image" as const };
    const storedImage = { path: "/project/.ade/attachments/original.png", type: "image" as const };
    let resolveCreate: ((entry: PromptStashEntry) => void) | undefined;
    const create = vi.fn().mockImplementation(() => new Promise<PromptStashEntry>((resolve) => {
      resolveCreate = resolve;
    }));
    installBridge({
      create,
      saveTempAttachment: vi.fn().mockResolvedValue({ path: storedImage.path }),
    });
    const onDraftChange = vi.fn();
    const onRemoveAttachment = vi.fn();
    const ref = createRef<ComposerPromptStashHandle>();
    const view = render(
      <ComposerPromptStash
        ref={ref}
        draft="Keep the newer composer intact"
        attachments={[originalImage]}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );

    ref.current?.activate();
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    view.rerender(
      <ComposerPromptStash
        ref={ref}
        draft="Keep the newer composer intact"
        attachments={[originalImage, newerImage]}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );
    resolveCreate?.({ ...savedEntry, attachments: [storedImage] });

    await waitFor(() => expect(view.container.querySelector(".animate-spin")).toBeNull());
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onRemoveAttachment).not.toHaveBeenCalled();
  });

  it("never overwrites edits made while a restored stash is being consumed remotely", async () => {
    let resolveDelete: ((deleted: boolean) => void) | undefined;
    const remove = vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => {
      resolveDelete = resolve;
    }));
    installBridge({
      list: vi.fn().mockResolvedValue([savedEntry]),
      delete: remove,
    });
    const onDraftChange = vi.fn();
    const view = render(
      <ComposerPromptStash
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 stashed prompt" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/i }));
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange).toHaveBeenCalledWith("Fix the parser");

    view.rerender(
      <ComposerPromptStash
        draft="Fix the parser with newer edits"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );
    resolveDelete?.(true);

    await waitFor(() => expect(view.container.querySelector(".animate-spin")).toBeNull());
    expect(remove).toHaveBeenCalledWith({ id: "stash-1" }, null);
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });
});
