/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentChatFileRef, OpenProjectBinding } from "../../../shared/types";
import {
  copyDraftImageAttachmentsToMachine,
  partitionDraftMachineAttachments,
  shouldTransferDraftAttachments,
  useDraftAttachmentTransfer,
} from "./draftAttachmentTransfer";

describe("draft attachment transfer", () => {
  const localBinding: OpenProjectBinding = {
    kind: "local",
    key: "local:/tmp/project-under-test",
    rootPath: "/tmp/project-under-test",
    displayName: "project-under-test",
  };
  const remoteBinding: OpenProjectBinding = {
    kind: "remote",
    key: "remote:target-studio:project-a",
    targetId: "target-studio",
    runtimeName: "Arul's Mac Studio",
    projectId: "project-a",
    rootPath: "/Volumes/work/project-under-test",
    displayName: "project-under-test",
  };

  beforeEach(() => {
    window.ade = {
      agentChat: {
        getImageDataUrl: vi.fn().mockResolvedValue({
          dataUrl: "data:image/png;base64,aW1hZ2U=",
        }),
        saveTempAttachment: vi.fn().mockResolvedValue({
          path: `${remoteBinding.rootPath}/.ade/attachments/clipboard.png`,
        }),
      },
    } as unknown as typeof window.ade;
  });

  it("copies pasted image bytes from the source machine into the target machine", async () => {
    const copied = await copyDraftImageAttachmentsToMachine({
      attachments: [{
        path: `${localBinding.rootPath}/.ade/attachments/clipboard.png`,
        type: "image",
      }],
      sourceBinding: localBinding,
      targetBinding: remoteBinding,
    });

    expect(window.ade.agentChat.getImageDataUrl).toHaveBeenCalledWith(
      `${localBinding.rootPath}/.ade/attachments/clipboard.png`,
      localBinding,
    );
    expect(window.ade.agentChat.saveTempAttachment).toHaveBeenCalledWith({
      data: "aW1hZ2U=",
      filename: "clipboard.png",
    }, remoteBinding);
    expect(copied).toEqual([{
      path: `${remoteBinding.rootPath}/.ade/attachments/clipboard.png`,
      type: "image",
    }]);
  });

  it("keeps portable URLs and pasted images while excluding linked visual context", () => {
    expect(partitionDraftMachineAttachments([
      { path: "https://example.com/image.png", type: "image-url", url: "https://example.com/image.png" },
      { path: "/tmp/clipboard.png", type: "image" },
      { path: "/tmp/ios.png", type: "image" },
      { path: "/tmp/spec.md", type: "file" },
    ], new Set(["/tmp/ios.png"]))).toEqual({
      portableAttachments: [{
        path: "https://example.com/image.png",
        type: "image-url",
        url: "https://example.com/image.png",
      }],
      imageAttachments: [{ path: "/tmp/clipboard.png", type: "image" }],
      removedAttachmentCount: 2,
    });
  });

  it("transfers only for machine changes inside the same composer scope", () => {
    const previous = {
      machineId: "this-mac",
      bindingKey: localBinding.key,
      scopeKey: "project-a:draft",
    };
    expect(shouldTransferDraftAttachments(previous, {
      machineId: remoteBinding.targetId,
      bindingKey: remoteBinding.key,
      scopeKey: "project-a:draft",
    })).toBe(true);
    expect(shouldTransferDraftAttachments(previous, {
      machineId: remoteBinding.targetId,
      bindingKey: remoteBinding.key,
      scopeKey: "project-b:draft",
    })).toBe(false);
  });

  it("keeps source images after a failed transfer and recovers when switching back", async () => {
    const imageAttachment: AgentChatFileRef = {
      path: `${localBinding.rootPath}/.ade/attachments/clipboard.png`,
      type: "image",
    };
    vi.mocked(window.ade.agentChat.getImageDataUrl).mockRejectedValueOnce(
      new Error("remote unavailable"),
    );
    const setAttachments = vi.fn();
    const setError = vi.fn();
    const attachmentOwnerBindingRef = { current: localBinding };
    const clearVisualContext = vi.fn();

    const { result, rerender } = renderHook(
      ({ machine }) => useDraftAttachmentTransfer({
        enabled: true,
        machine,
        scopeKey: "project-a:draft",
        scopeReady: true,
        attachments: [imageAttachment],
        setAttachments,
        attachmentOwnerBindingRef,
        getLinkedVisualAttachmentPaths: () => new Set(),
        visualContextCount: 0,
        clearVisualContext,
        setError,
      }),
      {
        initialProps: {
          machine: {
            id: "this-mac",
            name: "This Mac",
            binding: localBinding as OpenProjectBinding,
          },
        },
      },
    );

    rerender({
      machine: {
        id: remoteBinding.targetId,
        name: remoteBinding.runtimeName,
        binding: remoteBinding,
      },
    });

    await waitFor(() => expect(result.current.blockedReason).toContain("remote unavailable"));
    expect(setAttachments).toHaveBeenCalledWith([imageAttachment]);
    expect(attachmentOwnerBindingRef.current).toBe(localBinding);

    act(() => {
      rerender({
        machine: { id: "this-mac", name: "This Mac", binding: localBinding },
      });
    });

    await waitFor(() => expect(result.current.blockedReason).toBeNull());
    expect(result.current.pending).toBe(false);
    expect(setAttachments).not.toHaveBeenCalledWith([]);
  });

  it("waits for the incoming project machine before owning its restored images", () => {
    const remoteImage: AgentChatFileRef = {
      path: `${remoteBinding.rootPath}/.ade/attachments/clipboard.png`,
      type: "image",
    };
    const attachmentOwnerBindingRef = { current: localBinding as OpenProjectBinding | null };
    const setAttachments = vi.fn();

    const { rerender } = renderHook(
      ({ machine, scopeKey, scopeReady, attachments }) => useDraftAttachmentTransfer({
        enabled: true,
        machine,
        scopeKey,
        scopeReady,
        attachments,
        setAttachments,
        attachmentOwnerBindingRef,
        getLinkedVisualAttachmentPaths: () => new Set(),
        visualContextCount: 0,
        clearVisualContext: vi.fn(),
        setError: vi.fn(),
      }),
      {
        initialProps: {
          machine: {
            id: "this-mac",
            name: "This Mac",
            binding: localBinding as OpenProjectBinding,
          },
          scopeKey: "local-project:draft",
          scopeReady: true,
          attachments: [] as AgentChatFileRef[],
        },
      },
    );

    rerender({
      machine: { id: "this-mac", name: "This Mac", binding: localBinding },
      scopeKey: "remote-project:draft",
      scopeReady: false,
      attachments: [remoteImage],
    });
    expect(attachmentOwnerBindingRef.current).toBeNull();

    rerender({
      machine: {
        id: remoteBinding.targetId,
        name: remoteBinding.runtimeName,
        binding: remoteBinding,
      },
      scopeKey: "remote-project:draft",
      scopeReady: true,
      attachments: [remoteImage],
    });

    expect(attachmentOwnerBindingRef.current).toBe(remoteBinding);
    expect(window.ade.agentChat.getImageDataUrl).not.toHaveBeenCalled();
    expect(window.ade.agentChat.saveTempAttachment).not.toHaveBeenCalled();
  });

  it("does not carry a remote owner into a bound-local project draft", () => {
    const localImage: AgentChatFileRef = {
      path: `${localBinding.rootPath}/.ade/attachments/clipboard.png`,
      type: "image",
    };
    const attachmentOwnerBindingRef = { current: remoteBinding as OpenProjectBinding | null };

    const { rerender } = renderHook(
      ({ machine, scopeKey, scopeReady, attachments }) => useDraftAttachmentTransfer({
        enabled: true,
        machine,
        scopeKey,
        scopeReady,
        attachments,
        setAttachments: vi.fn(),
        attachmentOwnerBindingRef,
        getLinkedVisualAttachmentPaths: () => new Set(),
        visualContextCount: 0,
        clearVisualContext: vi.fn(),
        setError: vi.fn(),
      }),
      {
        initialProps: {
          machine: {
            id: remoteBinding.targetId,
            name: remoteBinding.runtimeName,
            binding: remoteBinding as OpenProjectBinding,
          },
          scopeKey: "remote-project:draft",
          scopeReady: true,
          attachments: [] as AgentChatFileRef[],
        },
      },
    );

    rerender({
      machine: {
        id: remoteBinding.targetId,
        name: remoteBinding.runtimeName,
        binding: remoteBinding,
      },
      scopeKey: "local-project:draft",
      scopeReady: false,
      attachments: [localImage],
    });
    expect(attachmentOwnerBindingRef.current).toBeNull();

    rerender({
      machine: { id: "this-mac", name: "This Mac", binding: localBinding },
      scopeKey: "local-project:draft",
      scopeReady: true,
      attachments: [localImage],
    });

    expect(attachmentOwnerBindingRef.current).toBe(localBinding);
    expect(window.ade.agentChat.getImageDataUrl).not.toHaveBeenCalled();
  });
});
