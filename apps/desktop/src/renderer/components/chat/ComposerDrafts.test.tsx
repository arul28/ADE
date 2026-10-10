/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, forwardRef, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding, DraftEntry } from "../../../shared/types";
import {
  ComposerDrafts as ProductionComposerDrafts,
  type ComposerDraftsHandle,
} from "./ComposerDrafts";

const noopAddAttachment = () => {};
const noopRemoveAttachment = () => {};
type ProductionDraftsProps = ComponentProps<typeof ProductionComposerDrafts>;
type TestDraftsProps = Omit<ProductionDraftsProps, "onAddAttachment" | "onRemoveAttachment"> & {
  onAddAttachment?: ProductionDraftsProps["onAddAttachment"];
  onRemoveAttachment?: ProductionDraftsProps["onRemoveAttachment"];
};
const ComposerDrafts = forwardRef<ComposerDraftsHandle, TestDraftsProps>(
  function TestComposerDrafts({
    onAddAttachment = noopAddAttachment,
    onRemoveAttachment = noopRemoveAttachment,
    ...props
  }, ref) {
    return (
      <ProductionComposerDrafts
        ref={ref}
        {...props}
        onAddAttachment={onAddAttachment}
        onRemoveAttachment={onRemoveAttachment}
      />
    );
  },
);

const savedEntry: DraftEntry = {
  id: "stash-1",
  text: "Fix the parser",
  provider: "codex",
  modelId: "openai/gpt-5.4",
  createdAt: "2026-07-28T12:00:00.000Z",
};

function installBridge(overrides?: {
  list?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
  claim?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
  sendNow?: ReturnType<typeof vi.fn>;
  getImageDataUrl?: ReturnType<typeof vi.fn>;
  saveTempAttachment?: ReturnType<typeof vi.fn>;
  getWindowSession?: ReturnType<typeof vi.fn>;
}) {
  const drafts = {
    list: overrides?.list ?? vi.fn().mockResolvedValue([]),
    create: overrides?.create ?? vi.fn().mockResolvedValue(savedEntry),
    update: overrides?.update ?? vi.fn().mockResolvedValue(savedEntry),
    // Attaching a draft is a claim, not a delete: the row is consumed and
    // handed back, and null means another machine got there first.
    claim: overrides?.claim ?? vi.fn().mockResolvedValue(savedEntry),
    delete: overrides?.delete ?? vi.fn().mockResolvedValue(true),
    sendNow: overrides?.sendNow ?? vi.fn().mockResolvedValue({ ok: true }),
  };
  (window as unknown as { ade: unknown }).ade = {
    agentChat: {
      drafts,
      getImageDataUrl: overrides?.getImageDataUrl ?? vi.fn().mockResolvedValue({
        dataUrl: "data:image/png;base64,cHJldmlldw==",
      }),
      saveTempAttachment: overrides?.saveTempAttachment ?? vi.fn().mockResolvedValue({
        path: "/project/.ade/attachments/stashed-design.png",
      }),
    },
    app: {
      getWindowSession: overrides?.getWindowSession ?? vi.fn().mockResolvedValue({
        windowId: 1,
        project: null,
        binding: null,
        openProjectTabs: [],
      }),
    },
  };
  return drafts;
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

describe("ComposerDrafts", () => {
  it("ignores a drafts refresh that lost its local project binding", async () => {
    const staleBinding: OpenProjectBinding = {
      kind: "local",
      key: "local:/stale-project",
      rootPath: "/stale-project",
      displayName: "Stale project",
    };
    const currentBinding: OpenProjectBinding = {
      kind: "local",
      key: "local:/current-project",
      rootPath: "/current-project",
      displayName: "Current project",
    };
    const list = vi.fn().mockRejectedValue(new Error(
      "Error invoking remote method 'ade.localRuntime.callAction': Error: Local runtime project is not available for this window.",
    ));
    const getWindowSession = vi.fn().mockResolvedValue({
      windowId: 1,
      project: { rootPath: currentBinding.rootPath, displayName: currentBinding.displayName },
      binding: currentBinding,
      openProjectTabs: [{ rootPath: currentBinding.rootPath, displayName: currentBinding.displayName }],
    });
    installBridge({ list, getWindowSession });

    render(
      <ComposerDrafts
        draft=""
        composerMachineBinding={staleBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(getWindowSession).toHaveBeenCalled());
    expect(list).toHaveBeenCalledWith(staleBinding);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a drafts error when the local project binding is still current", async () => {
    const currentBinding: OpenProjectBinding = {
      kind: "local",
      key: "local:/current-project",
      rootPath: "/current-project",
      displayName: "Current project",
    };
    installBridge({
      list: vi.fn().mockRejectedValue(new Error(
        "Error invoking remote method 'ade.localRuntime.callAction': Error: Local runtime project is not available for this window.",
      )),
      getWindowSession: vi.fn().mockResolvedValue({
        windowId: 1,
        project: { rootPath: currentBinding.rootPath, displayName: currentBinding.displayName },
        binding: currentBinding,
        openProjectTabs: [{ rootPath: currentBinding.rootPath, displayName: currentBinding.displayName }],
      }),
    });

    render(
      <ComposerDrafts
        draft=""
        composerMachineBinding={currentBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("stays out of the toolbar when the composer and stash list are both empty", async () => {
    const bridge = installBridge();
    render(
      <ComposerDrafts
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(bridge.list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /stashed prompt/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("honors the appearance toggle even when shared stashes exist", async () => {
    const bridge = installBridge({ list: vi.fn().mockResolvedValue([savedEntry]) });
    render(
      <ComposerDrafts
        draft=""
        active
        buttonVisible={false}
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(bridge.list).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Open 1 draft" })).toBeNull();
  });

  it("clears only after the runtime durably saves the prompt", async () => {
    const create = vi.fn().mockResolvedValue(savedEntry);
    const bridge = installBridge({ create });
    const onDraftChange = vi.fn();
    render(
      <ComposerDrafts
        draft="Fix the parser"
        provider="codex"
        modelId="openai/gpt-5.4"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

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
      <ComposerDrafts
        draft="Do not lose this"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Runtime unavailable");
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  // The claim comes first, so the machine that loses the race never receives
  // the text. Filling first and deleting after is what let two machines both
  // hold the same draft.
  it("claims a shared draft before filling the composer", async () => {
    const claim = vi.fn().mockResolvedValue(savedEntry);
    installBridge({
      list: vi.fn().mockResolvedValue([savedEntry]),
      claim,
    });
    const onDraftChange = vi.fn();
    render(
      <ComposerDrafts
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 draft" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Attach to composer" }));

    await waitFor(() => expect(claim).toHaveBeenCalledWith({ id: "stash-1" }, null));
    expect(onDraftChange).toHaveBeenCalledWith("Fix the parser");
    expect(screen.queryByText("Drafts")).toBeNull();
  });

  it("explains a draft another machine already took, without filling the composer", async () => {
    installBridge({
      list: vi.fn().mockResolvedValue([savedEntry]),
      claim: vi.fn().mockResolvedValue(null),
    });
    const onDraftChange = vi.fn();
    render(
      <ComposerDrafts
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 draft" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Attach to composer" }));

    expect((await screen.findByRole("alert")).textContent).toContain("taken on another machine");
    expect(onDraftChange).not.toHaveBeenCalled();
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
      <ComposerDrafts
        draft=""
        composerMachineBinding={ownerBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));

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
    const imageEntry: DraftEntry = {
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
      <ComposerDrafts
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

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
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
    const claim = vi.fn().mockResolvedValue(imageEntry);
    const getImageDataUrl = vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,cHJldmlldw==",
    });
    installBridge({
      list: vi.fn().mockResolvedValue([imageEntry]),
      claim,
      getImageDataUrl,
    });
    render(
      <ComposerDrafts
        draft=""
        composerMachineBinding={composerMachineBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
        onAddAttachment={onAddAttachment}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 draft" }));
    await waitFor(() => expect(getImageDataUrl).toHaveBeenCalledWith(
      storedImageAttachment.path,
      composerMachineBinding,
    ));
    expect(document.querySelector("[data-drafts-menu] img")?.getAttribute("src"))
      .toBe("data:image/png;base64,cHJldmlldw==");
    fireEvent.click(screen.getByRole("button", { name: /Use this design/i }));
    fireEvent.click(screen.getByRole("button", { name: "Attach to composer" }));
    // The claim is awaited before the composer is filled, so the text and its
    // images land a tick later than the click.
    await waitFor(() => expect(onAddAttachment).toHaveBeenCalledWith(storedImageAttachment));
    await waitFor(() => expect(claim).toHaveBeenCalledWith(
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
      <ComposerDrafts
        draft="Keep these images ordered"
        attachments={sourceAttachments}
        composerMachineBinding={originalBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    await waitFor(() => expect(getImageDataUrl).toHaveBeenCalledTimes(1));
    expect(getImageDataUrl).toHaveBeenNthCalledWith(
      1,
      sourceAttachments[0]!.path,
      originalBinding,
    );
    expect(saveTempAttachment).not.toHaveBeenCalled();

    view.rerender(
      <ComposerDrafts
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
      <ComposerDrafts
        draft="Keep the remote image"
        attachments={[{
          path: "/remote/source-project/design-remote-owner.png",
          type: "image",
        }]}
        composerMachineBinding={composerMachineBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect((await screen.findByRole("alert")).textContent).toContain("source runtime unavailable");
    expect(runtimeRead).toHaveBeenCalledWith(
      "/remote/source-project/design-remote-owner.png",
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
      <ComposerDrafts
        draft="Keep the local image"
        attachments={[sourceAttachment]}
        composerMachineBinding={localBinding}
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

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
      <ComposerDrafts
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

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
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
      <ComposerDrafts
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

    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));

    expect((await screen.findByRole("alert")).textContent).toContain("up to 10 images");
    expect(create).not.toHaveBeenCalled();
    expect(getImageDataUrl).not.toHaveBeenCalled();
    expect(saveTempAttachment).not.toHaveBeenCalled();
  });

  it("keeps a machine-bound image stash intact when viewed from another synced runtime", async () => {
    const unavailableEntry: DraftEntry = {
      ...savedEntry,
      text: "",
      attachments: [],
      attachmentCount: 1,
      attachmentsAvailable: false,
    };
    const claim = vi.fn().mockResolvedValue(unavailableEntry);
    installBridge({
      list: vi.fn().mockResolvedValue([unavailableEntry]),
      claim,
    });
    const onDraftChange = vi.fn();
    const onAddAttachment = vi.fn();
    render(
      <ComposerDrafts
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
        onAddAttachment={onAddAttachment}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 draft" }));
    // The row still says what it is, and that the image is not on this machine.
    const row = screen.getByRole("button", { name: /1 image elsewhere/i });
    fireEvent.click(row);

    // Attaching is refused up front: a button that can only fail is inert and
    // says why, rather than inviting a click that errors.
    const attach = (await screen.findByRole("button", { name: "Attach to composer" })) as HTMLButtonElement;
    expect(attach.disabled).toBe(true);
    expect(attach.getAttribute("title")).toBeTruthy();
    expect(claim).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
    expect(onAddAttachment).not.toHaveBeenCalled();
  });

  // The contract is "outside the clipping composer", not "a direct child of
  // body": the menu now renders inside the shared popover layer, which is
  // still a body portal.
  it("renders the menu outside the composer so overflow cannot clip it", async () => {
    installBridge({ list: vi.fn().mockResolvedValue([savedEntry]) });
    render(
      <div data-testid="clipping-parent" style={{ overflow: "hidden" }}>
        <ComposerDrafts
          draft=""
          active
          buttonVisible
          shortcutLabel="⌘+S"
          onDraftChange={vi.fn()}
        />
      </div>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 draft" }));
    const menu = screen.getByRole("dialog", { name: "Drafts" });
    expect(screen.getByTestId("clipping-parent").contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
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
        <ComposerDrafts
          draft=""
          active
          buttonVisible
          shortcutLabel="⌘+S"
          onDraftChange={vi.fn()}
        />,
      );

      const openButton = await screen.findByRole("button", { name: "Open 1 draft" });
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

      const menu = await screen.findByRole("dialog", { name: "Drafts" });
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
      <ComposerDrafts
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 draft" }));
    expect(screen.getByRole("dialog", { name: "Drafts" })).toBeTruthy();

    view.rerender(
      <ComposerDrafts
        draft="A new prompt"
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Drafts" })).toBeNull());
    expect(remove).not.toHaveBeenCalled();
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("keeps the shortcut available when the appearance button is hidden", async () => {
    const create = vi.fn().mockResolvedValue(savedEntry);
    installBridge({ create });
    const onDraftChange = vi.fn();
    const ref = createRef<ComposerDraftsHandle>();
    render(
      <ComposerDrafts
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
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });

  it("coalesces rapid shortcut presses into one durable save", async () => {
    let resolveCreate: ((entry: DraftEntry) => void) | undefined;
    const create = vi.fn().mockImplementation(() => new Promise<DraftEntry>((resolve) => {
      resolveCreate = resolve;
    }));
    installBridge({ create });
    const onDraftChange = vi.fn();
    const ref = createRef<ComposerDraftsHandle>();
    render(
      <ComposerDrafts
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
    let resolveCreate: ((entry: DraftEntry) => void) | undefined;
    const create = vi.fn().mockImplementation(() => new Promise<DraftEntry>((resolve) => {
      resolveCreate = resolve;
    }));
    installBridge({ create });
    const onDraftChange = vi.fn();
    const ref = createRef<ComposerDraftsHandle>();
    const view = render(
      <ComposerDrafts
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
      <ComposerDrafts
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
    let resolveCreate: ((entry: DraftEntry) => void) | undefined;
    const create = vi.fn().mockImplementation(() => new Promise<DraftEntry>((resolve) => {
      resolveCreate = resolve;
    }));
    installBridge({
      create,
      saveTempAttachment: vi.fn().mockResolvedValue({ path: storedImage.path }),
    });
    const onDraftChange = vi.fn();
    const onRemoveAttachment = vi.fn();
    const ref = createRef<ComposerDraftsHandle>();
    const view = render(
      <ComposerDrafts
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
      <ComposerDrafts
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

  // Claim-first inverted the old hazard. The composer used to be filled before
  // the remote consume resolved, so a late acknowledgement could overwrite
  // newer edits; now nothing is written until the claim comes back, and the
  // machine that loses the race is never handed the text at all.
  it("writes nothing into the composer until the claim comes back", async () => {
    let resolveClaim: ((entry: DraftEntry | null) => void) | undefined;
    const claim = vi.fn().mockImplementation(() => new Promise<DraftEntry | null>((resolve) => {
      resolveClaim = resolve;
    }));
    installBridge({
      list: vi.fn().mockResolvedValue([savedEntry]),
      claim,
    });
    const onDraftChange = vi.fn();
    render(
      <ComposerDrafts
        draft=""
        active
        buttonVisible
        shortcutLabel="⌘+S"
        onDraftChange={onDraftChange}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Open 1 draft" }));
    fireEvent.click(await screen.findByRole("button", { name: /Fix the parser/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Attach to composer" }));
    expect(onDraftChange).not.toHaveBeenCalled();

    resolveClaim?.(savedEntry);
    await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith("Fix the parser"));
    expect(onDraftChange).toHaveBeenCalledTimes(1);
  });
});
