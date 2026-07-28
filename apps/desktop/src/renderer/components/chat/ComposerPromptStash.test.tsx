/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, forwardRef, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PromptStashEntry } from "../../../shared/types";
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
    }));
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

    await waitFor(() => expect(remove).toHaveBeenCalledWith({ id: "stash-1" }));
    expect(onDraftChange).toHaveBeenCalledWith("Fix the parser");
    expect(screen.queryByText("Stashed prompts")).toBeNull();
  });

  it("moves image attachments into a stash and restores their thumbnail and attachment", async () => {
    const imageAttachment = {
      path: "/Users/me/Desktop/design.png",
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
    installBridge({ create, saveTempAttachment });
    const onDraftChange = vi.fn();
    const onRemoveAttachment = vi.fn();
    const saveView = render(
      <ComposerPromptStash
        draft="Use this design"
        attachments={[imageAttachment]}
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
    }));
    expect(saveTempAttachment).toHaveBeenCalledWith({
      data: "cHJldmlldw==",
      filename: "design.png",
    });
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
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
        onAddAttachment={onAddAttachment}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 stashed prompt" }));
    await waitFor(() => expect(getImageDataUrl).toHaveBeenCalledWith(storedImageAttachment.path));
    expect(document.querySelector("[data-prompt-stash-menu] img")?.getAttribute("src"))
      .toBe("data:image/png;base64,cHJldmlldw==");
    fireEvent.click(screen.getByRole("button", { name: /Use this design/i }));
    expect(onAddAttachment).toHaveBeenCalledWith(storedImageAttachment);
    await waitFor(() => expect(remove).toHaveBeenCalledWith({ id: imageEntry.id }));
  });

  it("keeps the original image when an older runtime cannot confirm attachment persistence", async () => {
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
    expect(bridge.delete).toHaveBeenCalledWith({ id: savedEntry.id });
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
    }));
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
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ text: "Save this version" }));
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
    expect(remove).toHaveBeenCalledWith({ id: "stash-1" });
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });
});
