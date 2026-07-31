import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type {
  AgentChatFileRef,
  AgentChatLocalFileRef,
  OpenProjectBinding,
} from "../../../shared/types";
import { stripDataUrlPrefix } from "../../lib/visualContextFormatting";

export type LocalImageAttachment = AgentChatLocalFileRef & { type: "image" };

export type DraftAttachmentMachineScope = {
  machineId: string;
  bindingKey: string | null;
  scopeKey: string;
};

export function shouldTransferDraftAttachments(
  previous: DraftAttachmentMachineScope | null,
  current: DraftAttachmentMachineScope,
): boolean {
  return Boolean(
    previous
    && previous.scopeKey === current.scopeKey
    && (
      previous.machineId !== current.machineId
      || previous.bindingKey !== current.bindingKey
    ),
  );
}

export function partitionDraftMachineAttachments(
  attachments: AgentChatFileRef[],
  linkedVisualAttachmentPaths: ReadonlySet<string>,
): {
  portableAttachments: AgentChatFileRef[];
  imageAttachments: LocalImageAttachment[];
  removedAttachmentCount: number;
} {
  const portableAttachments = attachments.filter((attachment) => attachment.type === "image-url");
  const imageAttachments = attachments.filter(
    (attachment): attachment is LocalImageAttachment => (
      attachment.type === "image" && !linkedVisualAttachmentPaths.has(attachment.path)
    ),
  );
  return {
    portableAttachments,
    imageAttachments,
    removedAttachmentCount: attachments.length - portableAttachments.length - imageAttachments.length,
  };
}

export async function copyDraftImageAttachmentsToMachine(args: {
  attachments: LocalImageAttachment[];
  sourceBinding: OpenProjectBinding;
  targetBinding: OpenProjectBinding;
}): Promise<LocalImageAttachment[]> {
  return Promise.all(args.attachments.map(async (attachment) => {
    const { dataUrl } = await window.ade.agentChat.getImageDataUrl(
      attachment.path,
      args.sourceBinding,
    );
    const filename = attachment.path.split(/[\\/]/).pop() || "attachment.png";
    const saved = await window.ade.agentChat.saveTempAttachment({
      data: stripDataUrlPrefix(dataUrl),
      filename,
    }, args.targetBinding);
    return { ...attachment, path: saved.path };
  }));
}

export function useDraftAttachmentTransfer(args: {
  enabled: boolean;
  machine: {
    id: string;
    name: string;
    binding: OpenProjectBinding | null;
  };
  scopeKey: string;
  scopeReady: boolean;
  attachments: AgentChatFileRef[];
  setAttachments: Dispatch<SetStateAction<AgentChatFileRef[]>>;
  attachmentOwnerBindingRef: MutableRefObject<OpenProjectBinding | null>;
  getLinkedVisualAttachmentPaths: () => ReadonlySet<string>;
  visualContextCount: number;
  clearVisualContext: () => void;
  setError: Dispatch<SetStateAction<string | null>>;
}): {
  pending: boolean;
  blockedReason: string | null;
} {
  const {
    enabled,
    machine,
    scopeKey,
    scopeReady,
    attachments,
    setAttachments,
    attachmentOwnerBindingRef,
    getLinkedVisualAttachmentPaths,
    visualContextCount,
    clearVisualContext,
    setError,
  } = args;
  const previousMachineRef = useRef<(typeof machine & { scopeKey: string }) | null>(null);
  const transferSequenceRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  useEffect(() => {
    if (!blockedReason) return;
    if (attachments.some((attachment) => attachment.type === "image")) return;
    setBlockedReason(null);
    setError((current) => current === blockedReason ? null : current);
  }, [attachments, blockedReason, setError]);

  useEffect(() => {
    if (!enabled) {
      previousMachineRef.current = null;
      transferSequenceRef.current += 1;
      setPending(false);
      setBlockedReason(null);
      return;
    }
    const currentMachine = { ...machine, scopeKey };
    const previousMachine = previousMachineRef.current;
    if (!previousMachine || previousMachine.scopeKey !== currentMachine.scopeKey) {
      transferSequenceRef.current += 1;
      setPending(false);
      setBlockedReason(null);
      if (!scopeReady) {
        previousMachineRef.current = null;
        attachmentOwnerBindingRef.current = null;
        return;
      }
      previousMachineRef.current = currentMachine;
      attachmentOwnerBindingRef.current = currentMachine.binding;
      return;
    }
    previousMachineRef.current = currentMachine;
    if (!shouldTransferDraftAttachments({
      machineId: previousMachine.id,
      bindingKey: previousMachine.binding?.key ?? null,
      scopeKey: previousMachine.scopeKey,
    }, {
      machineId: currentMachine.id,
      bindingKey: currentMachine.binding?.key ?? null,
      scopeKey: currentMachine.scopeKey,
    })) return;

    const {
      portableAttachments,
      imageAttachments,
      removedAttachmentCount,
    } = partitionDraftMachineAttachments(attachments, getLinkedVisualAttachmentPaths());
    const removedCount = removedAttachmentCount + visualContextCount;
    const transferSequence = transferSequenceRef.current + 1;
    transferSequenceRef.current = transferSequence;
    setBlockedReason(null);
    setPending(imageAttachments.length > 0);
    setAttachments([...portableAttachments, ...imageAttachments]);
    clearVisualContext();

    if (removedCount > 0) {
      setError(
        `Removed ${removedCount} non-portable attachment${removedCount === 1 ? "" : "s"} from ${previousMachine.name}.`,
      );
    } else {
      setError(null);
    }

    if (imageAttachments.length === 0) {
      attachmentOwnerBindingRef.current = currentMachine.binding;
      return;
    }
    const sourceBinding = attachmentOwnerBindingRef.current ?? previousMachine.binding;
    if (!sourceBinding || !currentMachine.binding) {
      setPending(false);
      return;
    }
    if (sourceBinding.key === currentMachine.binding.key) {
      setPending(false);
      return;
    }
    void copyDraftImageAttachmentsToMachine({
      attachments: imageAttachments,
      sourceBinding,
      targetBinding: currentMachine.binding,
    }).then((transferredImages) => {
      if (transferSequenceRef.current !== transferSequence) return;
      const transferredPaths = new Map(
        imageAttachments.map((attachment, index) => [
          attachment.path,
          transferredImages[index]!,
        ]),
      );
      setAttachments((currentAttachments) => currentAttachments.map(
        (attachment) => transferredPaths.get(attachment.path) ?? attachment,
      ));
      attachmentOwnerBindingRef.current = currentMachine.binding;
      setPending(false);
    }).catch((transferError: unknown) => {
      if (transferSequenceRef.current !== transferSequence) return;
      setPending(false);
      const message =
        `Couldn't move ${imageAttachments.length === 1 ? "the image" : `${imageAttachments.length} images`} `
        + `to ${currentMachine.name}. Switch back to ${previousMachine.name} or remove `
        + `${imageAttachments.length === 1 ? "it" : "them"} before sending: `
        + `${transferError instanceof Error ? transferError.message : String(transferError)}`;
      setBlockedReason(message);
      setError(message);
    });
  }, [
    attachmentOwnerBindingRef,
    attachments,
    clearVisualContext,
    enabled,
    getLinkedVisualAttachmentPaths,
    machine,
    scopeReady,
    scopeKey,
    setAttachments,
    setError,
    visualContextCount,
  ]);

  return { pending, blockedReason };
}
