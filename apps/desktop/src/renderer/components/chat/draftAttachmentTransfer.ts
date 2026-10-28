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
  AppControlContextItem,
  BuiltInBrowserContextItem,
  IosElementContextItem,
  OpenProjectBinding,
} from "../../../shared/types";
import {
  getAppControlContextAttachmentPath,
  getBuiltInBrowserContextAttachmentPath,
  getIosContextAttachmentPath,
  stripDataUrlPrefix,
} from "../../lib/visualContextFormatting";
import { readAttachmentImageDataUrl } from "../../lib/attachmentImage";
import { draftAttachmentSource, rememberDraftAttachmentSource } from "./draftAttachmentSources";
import { readAttachmentStagingMode } from "./chatAttachmentStaging";
import type { ChatNoticeAction } from "./chatNotice";


export type DraftAttachmentMachineScope = {
  machineId: string;
  bindingKey: string | null;
  scopeKey: string;
};

export function collectDraftVisualAttachmentPaths(args: {
  linkedAttachmentPaths: ReadonlySet<string>;
  iosContextItems: IosElementContextItem[];
  appControlContextItems: AppControlContextItem[];
  builtInBrowserContextItems: BuiltInBrowserContextItem[];
}): Set<string> {
  const paths = new Set(args.linkedAttachmentPaths);
  for (const item of args.iosContextItems) {
    const path = getIosContextAttachmentPath(item);
    if (path) paths.add(path);
  }
  for (const item of args.appControlContextItems) {
    const path = getAppControlContextAttachmentPath(item);
    if (path) paths.add(path);
  }
  for (const item of args.builtInBrowserContextItems) {
    const path = getBuiltInBrowserContextAttachmentPath(item);
    if (path) paths.add(path);
  }
  return paths;
}

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

/**
 * Sort a draft's attachments for a machine switch: URLs need nothing, an
 * attachment this window can stage again (any image, or a file whose bytes or
 * local path it kept, such as a long paste) moves, and the rest stays behind.
 */
export function partitionDraftMachineAttachments(
  attachments: AgentChatFileRef[],
  linkedVisualAttachmentPaths: ReadonlySet<string>,
): {
  portableAttachments: AgentChatFileRef[];
  movableAttachments: AgentChatLocalFileRef[];
  removedAttachments: AgentChatLocalFileRef[];
  /** Images of selected elements; they go with the selection they belong to. */
  linkedAttachments: AgentChatLocalFileRef[];
} {
  const portableAttachments: AgentChatFileRef[] = [];
  const movableAttachments: AgentChatLocalFileRef[] = [];
  const removedAttachments: AgentChatLocalFileRef[] = [];
  const linkedAttachments: AgentChatLocalFileRef[] = [];
  for (const attachment of attachments) {
    if (attachment.type === "image-url") portableAttachments.push(attachment);
    else if (linkedVisualAttachmentPaths.has(attachment.path)) linkedAttachments.push(attachment);
    else if (attachment.type === "image" || draftAttachmentSource(attachment.path)) movableAttachments.push(attachment);
    else removedAttachments.push(attachment);
  }
  return { portableAttachments, movableAttachments, removedAttachments, linkedAttachments };
}

/** Whether moving this attachment has to read it back from its old machine. */
function needsSourceMachine(attachment: AgentChatLocalFileRef): boolean {
  return !draftAttachmentSource(attachment.path);
}

/**
 * Stage each attachment again on the target machine: from the bytes or local
 * path this window kept, else (an image) read back from the source machine.
 */
export async function copyDraftAttachmentsToMachine(args: {
  attachments: AgentChatLocalFileRef[];
  sourceBinding: OpenProjectBinding | null;
  targetBinding: OpenProjectBinding;
}): Promise<AgentChatLocalFileRef[]> {
  return Promise.all(args.attachments.map(async (attachment) => {
    const source = draftAttachmentSource(attachment.path);
    let path: string;
    if (source?.kind === "bytes") {
      ({ path } = await window.ade.agentChat.saveTempAttachment(
        { data: source.data, filename: source.filename },
        args.targetBinding,
      ));
    } else if (source?.kind === "local") {
      // A path only travels to a host that can copy or stream it; an older
      // host (or a relay route) takes base64 alone, which this file never was.
      const { mode } = await readAttachmentStagingMode(args.targetBinding);
      if (mode === "base64") throw new Error("ADE on that machine can't receive files from this computer; attach it again there");
      ({ path } = await window.ade.agentChat.stageFileAttachment(
        { sourcePath: source.sourcePath, filename: source.filename },
        args.targetBinding,
      ));
    } else {
      if (!args.sourceBinding) throw new Error("the machine it was attached on is not connected");
      const { dataUrl } = await readAttachmentImageDataUrl(attachment.path, args.sourceBinding);
      const filename = attachment.path.split(/[\\/]/).pop() || "attachment.png";
      ({ path } = await window.ade.agentChat.saveTempAttachment({
        data: stripDataUrlPrefix(dataUrl),
        filename,
      }, args.targetBinding));
    }
    if (source) rememberDraftAttachmentSource(path, source);
    return { ...attachment, path };
  }));
}

/** "the image", "3 images", "the attachment", "2 attachments". */
function attachmentNoun(attachments: AgentChatLocalFileRef[]): string {
  const word = attachments.every((attachment) => attachment.type === "image") ? "image" : "attachment";
  return attachments.length === 1 ? `the ${word}` : `${attachments.length} ${word}s`;
}

function attachmentName(attachment: AgentChatLocalFileRef): string {
  return attachment.path.split(/[\\/]/).pop() || "a file";
}

/**
 * What the person reads when part of a draft cannot follow it: which items,
 * and what to do. Not an ADE failure — a file picked on one machine is not on
 * the other.
 */
function leftBehindMessage(args: {
  removed: AgentChatLocalFileRef[];
  visualContextCount: number;
  from: string;
  to: string;
}): string | null {
  const parts: string[] = [];
  if (args.removed.length === 1) {
    parts.push(`"${attachmentName(args.removed[0]!)}" stayed on ${args.from}; attach it again on ${args.to}.`);
  } else if (args.removed.length > 1) {
    parts.push(`${args.removed.length} files stayed on ${args.from}; attach them again on ${args.to}.`);
  }
  if (args.visualContextCount > 0) {
    parts.push(
      `${args.visualContextCount === 1 ? "The selected element" : `${args.visualContextCount} selected elements`} `
      + `from ${args.from} ${args.visualContextCount === 1 ? "was" : "were"} cleared; select again on ${args.to}.`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : null;
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
  setError: Dispatch<ChatNoticeAction>;
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
  const attachmentOwnerMachineIdRef = useRef<string | null>(null);
  const lastTransferAttemptRef = useRef<string | null>(null);
  const transferSequenceRef = useRef(0);
  const [pending, setPending] = useState(false);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);

  useEffect(() => {
    if (!blockedReason) return;
    if (attachments.some((attachment) => attachment.type !== "image-url")) return;
    setBlockedReason(null);
    setError((current) => current === blockedReason ? null : current);
  }, [attachments, blockedReason, setError]);

  useEffect(() => {
    if (!enabled) {
      previousMachineRef.current = null;
      attachmentOwnerMachineIdRef.current = null;
      lastTransferAttemptRef.current = null;
      transferSequenceRef.current += 1;
      setPending(false);
      setBlockedReason(null);
      return;
    }
    const currentMachine = { ...machine, scopeKey };
    const hasMachineOwnedDraftContent = attachments.some(
      (attachment) => attachment.type !== "image-url",
    ) || visualContextCount > 0;
    let previousMachine = previousMachineRef.current;
    if (!previousMachine || previousMachine.scopeKey !== currentMachine.scopeKey) {
      transferSequenceRef.current += 1;
      setPending(false);
      setBlockedReason(null);
      if (!scopeReady) {
        previousMachineRef.current = null;
        attachmentOwnerMachineIdRef.current = null;
        lastTransferAttemptRef.current = null;
        return;
      }
      previousMachineRef.current = currentMachine;
      if (hasMachineOwnedDraftContent) {
        const ownerBinding = attachmentOwnerBindingRef.current;
        attachmentOwnerMachineIdRef.current = ownerBinding?.kind === "remote"
          ? ownerBinding.targetId
          : ownerBinding?.key === currentMachine.binding?.key
            ? currentMachine.id
            : null;
        if (ownerBinding?.key === currentMachine.binding?.key) return;
        previousMachine = currentMachine;
      } else {
        attachmentOwnerMachineIdRef.current = currentMachine.id;
        attachmentOwnerBindingRef.current = currentMachine.binding;
        return;
      }
    }
    // A binding can disappear transiently while a selected machine reconnects.
    // Do not treat that as a machine transfer: partitioning below removes
    // non-portable attachments and clears visual context.
    if (!currentMachine.binding) {
      lastTransferAttemptRef.current = null;
      setPending(false);
      return;
    }
    const ownerBinding = attachmentOwnerBindingRef.current;
    const machineChanged = shouldTransferDraftAttachments({
      machineId: previousMachine.id,
      bindingKey: previousMachine.binding?.key ?? null,
      scopeKey: previousMachine.scopeKey,
    }, {
      machineId: currentMachine.id,
      bindingKey: currentMachine.binding?.key ?? null,
      scopeKey: currentMachine.scopeKey,
    });
    const transferAttemptKey = [
      currentMachine.scopeKey,
      ownerBinding?.key ?? "unknown-owner",
      currentMachine.binding.key,
    ].join("\0");
    const restoredContentNeedsTransfer = hasMachineOwnedDraftContent
      && ownerBinding?.key !== currentMachine.binding.key
      && lastTransferAttemptRef.current !== transferAttemptKey;
    previousMachineRef.current = currentMachine;
    if (!machineChanged && !restoredContentNeedsTransfer) return;
    lastTransferAttemptRef.current = transferAttemptKey;

    const {
      portableAttachments,
      movableAttachments,
      removedAttachments,
      linkedAttachments,
    } = partitionDraftMachineAttachments(attachments, getLinkedVisualAttachmentPaths());
    const transferSequence = transferSequenceRef.current + 1;
    transferSequenceRef.current = transferSequence;
    setBlockedReason(null);
    setPending(movableAttachments.length > 0);
    setAttachments([...portableAttachments, ...movableAttachments]);
    clearVisualContext();

    // A file picked on one machine is not on the other: a status, not a failure.
    const leftBehind = leftBehindMessage({
      // A selection's images are named with the selection; with no selection
      // left to name them, they are named as files.
      removed: visualContextCount > 0 ? removedAttachments : [...removedAttachments, ...linkedAttachments],
      visualContextCount,
      from: previousMachine.name,
      to: currentMachine.name,
    });
    setError(leftBehind ? { message: leftBehind, kind: "status" } : null);

    if (movableAttachments.length === 0) {
      attachmentOwnerMachineIdRef.current = currentMachine.id;
      attachmentOwnerBindingRef.current = currentMachine.binding;
      return;
    }
    const ownerMachineId = attachmentOwnerMachineIdRef.current;
    const sourceBinding = ownerBinding
      ?? (ownerMachineId === previousMachine.id ? previousMachine.binding : null);
    if (!sourceBinding && movableAttachments.some(needsSourceMachine)) {
      setPending(false);
      if (ownerMachineId === currentMachine.id) {
        attachmentOwnerMachineIdRef.current = currentMachine.id;
        attachmentOwnerBindingRef.current = currentMachine.binding;
        return;
      }
      const message =
        `Couldn't move ${attachmentNoun(movableAttachments)} `
        + `to ${currentMachine.name} because the source machine is disconnected. Reconnect or switch back `
        + `to the source machine, or remove ${movableAttachments.length === 1 ? "it" : "them"} before sending.`;
      setBlockedReason(message);
      setError(message);
      return;
    }
    if (sourceBinding?.key === currentMachine.binding.key) {
      attachmentOwnerMachineIdRef.current = currentMachine.id;
      attachmentOwnerBindingRef.current = currentMachine.binding;
      setPending(false);
      return;
    }
    void copyDraftAttachmentsToMachine({
      attachments: movableAttachments,
      sourceBinding,
      targetBinding: currentMachine.binding,
    }).then((transferred) => {
      if (transferSequenceRef.current !== transferSequence) return;
      const transferredPaths = new Map(
        movableAttachments.map((attachment, index) => [
          attachment.path,
          transferred[index]!,
        ]),
      );
      setAttachments((currentAttachments) => currentAttachments.map(
        (attachment) => transferredPaths.get(attachment.path) ?? attachment,
      ));
      attachmentOwnerMachineIdRef.current = currentMachine.id;
      attachmentOwnerBindingRef.current = currentMachine.binding;
      setPending(false);
    }).catch((transferError: unknown) => {
      if (transferSequenceRef.current !== transferSequence) return;
      setPending(false);
      const message =
        `Couldn't move ${attachmentNoun(movableAttachments)} `
        + `to ${currentMachine.name}. Switch back to ${previousMachine.name} or remove `
        + `${movableAttachments.length === 1 ? "it" : "them"} before sending: `
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
