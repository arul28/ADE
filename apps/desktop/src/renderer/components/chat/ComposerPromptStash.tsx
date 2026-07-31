import {
  BookmarkSimple,
  Check,
  File,
  Image,
  SpinnerGap,
  Trash,
} from "@phosphor-icons/react";
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type AgentChatFileRef,
  MAX_PROMPT_STASH_ATTACHMENTS,
  MAX_PROMPT_STASHES,
  type OpenProjectBinding,
  type PromptStashEntry,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { SmartTooltip } from "../ui/SmartTooltip";

const STASH_SNIPPET_MAX_CHARS = 110;
const STASH_MENU_MAX_WIDTH = 380;
const STASH_MENU_VIEWPORT_MARGIN = 16;
const STASH_MENU_GAP = 10;
const LOCAL_RUNTIME_PROJECT_UNAVAILABLE_MESSAGE =
  "Local runtime project is not available for this window.";

export type ComposerPromptStashHandle = {
  activate: () => void;
  handleMenuKeyDown: (event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
  }) => boolean;
};

function promptSnippet(text: string): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized.length <= STASH_SNIPPET_MAX_CHARS) return normalized;
  return `${normalized.slice(0, STASH_SNIPPET_MAX_CHARS)}…`;
}

function relativeTime(iso: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

function providerLabel(entry: PromptStashEntry): string | null {
  const provider = entry.provider?.trim();
  if (!provider) return null;
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function attachmentName(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

function sameAttachment(left: AgentChatFileRef, right: AgentChatFileRef): boolean {
  return left.path === right.path
    && left.type === right.type
    && (left.type !== "image-url" || right.type !== "image-url" || left.url === right.url);
}

function stashAttachments(entry: PromptStashEntry): AgentChatFileRef[] {
  return entry.attachments ?? [];
}

function isStashableAttachment(attachment: AgentChatFileRef): boolean {
  return attachment.type === "image" || attachment.type === "image-url";
}

function base64FromDataUrl(dataUrl: string): string {
  const separator = dataUrl.indexOf(",");
  if (separator < 0 || !/;base64$/i.test(dataUrl.slice(0, separator))) {
    throw new Error("The attached image could not be prepared for stashing.");
  }
  const base64 = dataUrl.slice(separator + 1);
  if (!base64) throw new Error("The attached image is empty.");
  return base64;
}

function stashEntryLabel(entry: PromptStashEntry, attachments: AgentChatFileRef[]): string {
  const snippet = promptSnippet(entry.text);
  if (snippet) return snippet;
  if (attachments.length === 1) return attachmentName(attachments[0]!.path);
  const attachmentCount = stashAttachmentCount(entry);
  return attachmentCount === 1 ? "1 stashed image" : `${attachmentCount} stashed images`;
}

function stashAttachmentCount(entry: PromptStashEntry): number {
  return entry.attachmentCount ?? stashAttachments(entry).length;
}

function stashAttachmentsUnavailable(entry: PromptStashEntry): boolean {
  return entry.attachmentsAvailable === false && stashAttachmentCount(entry) > 0;
}

function normalizedProjectRoot(rootPath: string): string {
  return rootPath.trim().replace(/[\\/]+$/, "");
}

function hasLocalProjectRoot(
  session: Awaited<ReturnType<typeof window.ade.app.getWindowSession>>,
  rootPath: string,
): boolean {
  const expectedRoot = normalizedProjectRoot(rootPath);
  const sessionRoots = [
    session.binding?.kind === "local" ? session.binding.rootPath : null,
    session.project?.rootPath,
    ...session.openProjectTabs.map((project) => project.rootPath),
  ];
  return sessionRoots.some(
    (candidate) => candidate != null && normalizedProjectRoot(candidate) === expectedRoot,
  );
}

async function isStaleLocalPromptStashRequest(
  error: unknown,
  binding: OpenProjectBinding | null,
): Promise<boolean> {
  if (
    binding?.kind !== "local" ||
    !(error instanceof Error) ||
    !error.message.includes(LOCAL_RUNTIME_PROJECT_UNAVAILABLE_MESSAGE)
  ) {
    return false;
  }
  try {
    const session = await window.ade.app.getWindowSession();
    return !hasLocalProjectRoot(session, binding.rootPath);
  } catch {
    // Preserve the original runtime error when the window session cannot be read.
    return false;
  }
}

function StashImageThumbnail({
  attachment,
  composerMachineBinding,
}: {
  attachment: AgentChatFileRef;
  composerMachineBinding: OpenProjectBinding | null;
}) {
  const directUrl = attachment.type === "image-url" ? attachment.url : null;
  const [src, setSrc] = useState<string | null>(directUrl);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const capturedBinding = composerMachineBinding;
    let cancelled = false;
    setSrc(directUrl);
    setFailed(false);
    if (directUrl || attachment.type !== "image") return () => { cancelled = true; };
    const readImage = window.ade?.agentChat?.getImageDataUrl;
    if (!readImage) {
      setFailed(true);
      return () => { cancelled = true; };
    }
    void readImage(attachment.path, capturedBinding)
      .then(({ dataUrl }) => {
        if (!cancelled) setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [attachment, composerMachineBinding, directUrl]);

  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/[0.08] bg-black/25 text-muted-fg/35">
      {src && !failed ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <Image size={15} aria-hidden />
      )}
    </span>
  );
}

export type ComposerPromptStashProps = {
  draft: string;
  attachments?: AgentChatFileRef[];
  composerMachineBinding?: OpenProjectBinding | null;
  provider?: string | null;
  modelId?: string | null;
  active: boolean;
  buttonVisible: boolean;
  shortcutLabel: string;
  disabled?: boolean;
  onDraftChange: (value: string) => void;
  onAddAttachment: (attachment: AgentChatFileRef) => void;
  onRemoveAttachment: (path: string) => void;
};

export const ComposerPromptStash = forwardRef<ComposerPromptStashHandle, ComposerPromptStashProps>(function ComposerPromptStash({
  draft,
  attachments = [],
  composerMachineBinding = null,
  provider,
  modelId,
  active,
  buttonVisible,
  shortcutLabel,
  disabled = false,
  onDraftChange,
  onAddAttachment,
  onRemoveAttachment,
}, ref) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const operationInFlightRef = useRef(false);
  const refreshSequenceRef = useRef(0);
  const latestDraftRef = useRef(draft);
  latestDraftRef.current = draft;
  const latestAttachmentsRef = useRef(attachments);
  latestAttachmentsRef.current = attachments;
  const latestComposerMachineBindingRef = useRef(composerMachineBinding);
  latestComposerMachineBindingRef.current = composerMachineBinding;
  const [stashSnapshot, setStashSnapshot] = useState<{
    entries: PromptStashEntry[];
    ownerBinding: OpenProjectBinding | null;
  }>({
    entries: [],
    ownerBinding: null,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveReceiptKey, setSaveReceiptKey] = useState(0);
  const [saveReceiptVisible, setSaveReceiptVisible] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [errorNoticePosition, setErrorNoticePosition] = useState({ left: 0, bottom: 0 });
  const stashableComposerAttachments = useMemo(
    () => attachments.filter(isStashableAttachment),
    [attachments],
  );
  const currentBindingKey = composerMachineBinding?.key ?? null;
  const entriesOwnerBinding = stashSnapshot.ownerBinding;
  const entriesOwnerBindingKey = entriesOwnerBinding?.key ?? null;
  const entries = entriesOwnerBindingKey === currentBindingKey ? stashSnapshot.entries : [];
  const hasComposerContent = draft.trim().length > 0 || stashableComposerAttachments.length > 0;
  const renderButton = buttonVisible && (hasComposerContent || entries.length > 0);
  const attachmentSignature = attachments.map((attachment) => (
    `${attachment.type}:${attachment.path}`
  )).join("\n");

  const highlightedEntry = useMemo(
    () => entries.find((entry) => entry.id === highlightedId) ?? entries[0] ?? null,
    [entries, highlightedId],
  );

  const refresh = useCallback(async (
    bindingOverride?: OpenProjectBinding | null,
  ) => {
    const capturedBinding = bindingOverride === undefined
      ? composerMachineBinding
      : bindingOverride;
    const sequence = ++refreshSequenceRef.current;
    try {
      const next = await window.ade.agentChat.promptStashes.list(capturedBinding);
      if (sequence !== refreshSequenceRef.current) return;
      setStashSnapshot({
        entries: next,
        ownerBinding: capturedBinding,
      });
      setHighlightedId((current) => (
        current && next.some((entry) => entry.id === current)
          ? current
          : next[0]?.id ?? null
      ));
      setError(null);
    } catch (refreshError) {
      if (sequence !== refreshSequenceRef.current) return;
      if (await isStaleLocalPromptStashRequest(refreshError, capturedBinding)) {
        return;
      }
      if (sequence !== refreshSequenceRef.current) return;
      setError(refreshError instanceof Error ? refreshError.message : "Could not load stashed prompts.");
    }
  }, [composerMachineBinding]);

  useEffect(() => {
    if (active) void refresh(composerMachineBinding);
  }, [active, composerMachineBinding, refresh]);

  useEffect(() => {
    if (!saveReceiptVisible) return;
    const timer = window.setTimeout(() => setSaveReceiptVisible(false), 900);
    return () => window.clearTimeout(timer);
  }, [saveReceiptKey, saveReceiptVisible]);

  useEffect(() => {
    setError(null);
  }, [attachmentSignature, draft]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node) || menuRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [menuOpen]);

  useEffect(() => {
    if (menuOpen && hasComposerContent) {
      setMenuOpen(false);
    }
  }, [hasComposerContent, menuOpen]);

  useEffect(() => {
    if (menuOpen && entries.length === 0 && !busy && !error) {
      setMenuOpen(false);
    }
  }, [busy, entries.length, error, menuOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const updatePosition = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      const menu = menuRef.current;
      if (!anchor || !menu) return;
      const width = Math.min(STASH_MENU_MAX_WIDTH, window.innerWidth - (STASH_MENU_VIEWPORT_MARGIN * 2));
      const maxLeft = Math.max(STASH_MENU_VIEWPORT_MARGIN, window.innerWidth - width - STASH_MENU_VIEWPORT_MARGIN);
      const menuHeight = menu.getBoundingClientRect().height;
      const above = anchor.top - STASH_MENU_GAP - menuHeight;
      const below = anchor.bottom + STASH_MENU_GAP;
      const maxTop = Math.max(STASH_MENU_VIEWPORT_MARGIN, window.innerHeight - menuHeight - STASH_MENU_VIEWPORT_MARGIN);
      let top = above;
      if (above < STASH_MENU_VIEWPORT_MARGIN) {
        top = below + menuHeight <= window.innerHeight - STASH_MENU_VIEWPORT_MARGIN
          ? below
          : Math.min(Math.max(STASH_MENU_VIEWPORT_MARGIN, above), maxTop);
      }
      setMenuPosition({
        left: Math.min(Math.max(STASH_MENU_VIEWPORT_MARGIN, anchor.right - width), maxLeft),
        top,
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(updatePosition);
    if (resizeObserver && menuRef.current) {
      resizeObserver.observe(menuRef.current);
    }
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [entries.length, error, menuOpen]);

  useLayoutEffect(() => {
    if (!error || menuOpen) return;
    const updatePosition = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(320, window.innerWidth - (STASH_MENU_VIEWPORT_MARGIN * 2));
      const maxLeft = Math.max(STASH_MENU_VIEWPORT_MARGIN, window.innerWidth - width - STASH_MENU_VIEWPORT_MARGIN);
      setErrorNoticePosition({
        left: Math.min(Math.max(STASH_MENU_VIEWPORT_MARGIN, anchor.right - width), maxLeft),
        bottom: Math.max(STASH_MENU_VIEWPORT_MARGIN, window.innerHeight - anchor.top + STASH_MENU_GAP),
      });
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [error, menuOpen]);

  useEffect(() => {
    const handleFocus = () => {
      if ((active || menuOpen) && document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [active, menuOpen, refresh]);

  const save = useCallback(async () => {
    if (disabled || operationInFlightRef.current) return;
    const operationBinding = composerMachineBinding;
    const savedText = latestDraftRef.current;
    const savedComposerAttachments = [...latestAttachmentsRef.current];
    const savedAttachments = savedComposerAttachments.filter(isStashableAttachment);
    if (savedAttachments.length > MAX_PROMPT_STASH_ATTACHMENTS) {
      setError(`You can stash up to ${MAX_PROMPT_STASH_ATTACHMENTS} images at a time.`);
      return;
    }
    if (!savedText.trim() && savedAttachments.length === 0) {
      if (!entries.length) return;
      setMenuOpen(true);
      await refresh(operationBinding);
      return;
    }

    operationInFlightRef.current = true;
    refreshSequenceRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      const storedAttachments: AgentChatFileRef[] = [];
      for (const attachment of savedAttachments) {
        if (attachment.type === "image-url") {
          storedAttachments.push(attachment);
          continue;
        }
        let dataUrl: string;
        try {
          dataUrl = (await window.ade.agentChat.getImageDataUrl(
            attachment.path,
            operationBinding,
          )).dataUrl;
        } catch (runtimeReadError) {
          // A remote owner identifies a path on another machine. Never
          // reinterpret that path on the desktop running the renderer.
          if (operationBinding?.kind !== "local") throw runtimeReadError;
          const localRead = window.ade?.app?.getImageDataUrl;
          if (!localRead) throw runtimeReadError;
          dataUrl = (await localRead(attachment.path)).dataUrl;
        }
        const saved = await window.ade.agentChat.saveTempAttachment({
          data: base64FromDataUrl(dataUrl),
          filename: attachmentName(attachment.path),
        }, operationBinding);
        storedAttachments.push({ path: saved.path, type: "image" });
      }
      const created = await window.ade.agentChat.promptStashes.create({
        text: savedText,
        ...(storedAttachments.length ? { attachments: storedAttachments } : {}),
        provider,
        modelId,
      }, operationBinding);
      if (storedAttachments.length > 0) {
        const confirmedAttachments = stashAttachments(created);
        const runtimeConfirmedImages = storedAttachments.every((stored) => (
          confirmedAttachments.some((confirmed) => sameAttachment(confirmed, stored))
        ));
        if (!runtimeConfirmedImages) {
          try {
            await window.ade.agentChat.promptStashes.delete({ id: created.id }, operationBinding);
          } catch {
            // The composer remains intact even if an older runtime cannot
            // roll back the text-only compatibility write.
          }
          throw new Error("The connected ADE runtime could not preserve the attached images. They are still in your composer.");
        }
      }
      const operationBindingKey = operationBinding?.key ?? null;
      if ((latestComposerMachineBindingRef.current?.key ?? null) === operationBindingKey) {
        setStashSnapshot((current) => ({
          entries: [
            created,
            ...((current.ownerBinding?.key ?? null) === operationBindingKey
              ? current.entries.filter((entry) => entry.id !== created.id)
              : []),
          ].slice(0, MAX_PROMPT_STASHES),
          ownerBinding: operationBinding,
        }));
      }
      setHighlightedId(created.id);
      setSaveReceiptKey((current) => current + 1);
      setSaveReceiptVisible(true);
      setMenuOpen(false);
      // The runtime has durably accepted the stash. Only now is it safe to
      // clear the exact text that was saved. Input typed while a remote
      // runtime acknowledged the write belongs to a newer draft and stays.
      const composerUnchanged = (latestComposerMachineBindingRef.current?.key ?? null) === operationBindingKey
        && latestDraftRef.current === savedText
        && latestAttachmentsRef.current.length === savedComposerAttachments.length
        && latestAttachmentsRef.current.every((current, index) => (
          Boolean(savedComposerAttachments[index] && sameAttachment(current, savedComposerAttachments[index]!))
        ));
      if (composerUnchanged) {
        onDraftChange("");
        for (const savedAttachment of savedAttachments) {
          onRemoveAttachment(savedAttachment.path);
        }
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not stash this prompt.");
      setMenuOpen(true);
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }, [composerMachineBinding, disabled, entries.length, modelId, onDraftChange, onRemoveAttachment, provider, refresh]);

  const restore = useCallback(async (entry: PromptStashEntry) => {
    if (operationInFlightRef.current) return;
    const operationBinding = entriesOwnerBinding;
    if (stashAttachmentsUnavailable(entry)) {
      setError("These images live on the machine where this prompt was stashed. Connect to that machine to restore it.");
      return;
    }
    if (latestDraftRef.current.trim() || latestAttachmentsRef.current.length > 0) {
      setMenuOpen(false);
      return;
    }
    operationInFlightRef.current = true;
    refreshSequenceRef.current += 1;
    setBusy(true);
    setError(null);
    const operationBindingKey = operationBinding?.key ?? null;
    setStashSnapshot((current) => (
      (current.ownerBinding?.key ?? null) === operationBindingKey
        ? {
            ...current,
            entries: current.entries.filter((candidate) => candidate.id !== entry.id),
          }
        : current
    ));
    setHighlightedId(null);
    setMenuOpen(false);
    // Put the saved text into the composer before waiting on a remote delete.
    // The user can continue editing immediately, and the acknowledgement can
    // never overwrite those edits. A failed delete leaves a harmless duplicate
    // stash rather than losing either the stash or the in-progress prompt.
    onDraftChange(entry.text);
    for (const attachment of stashAttachments(entry)) {
      onAddAttachment(attachment);
    }
    try {
      const deleted = await window.ade.agentChat.promptStashes.delete({ id: entry.id }, operationBinding);
      if (!deleted) {
        if ((latestComposerMachineBindingRef.current?.key ?? null) === operationBindingKey) {
          await refresh(operationBinding);
        }
        setError("That stash was already restored or deleted on another desktop.");
        return;
      }
    } catch (restoreError) {
      setError(restoreError instanceof Error ? restoreError.message : "Could not restore this prompt.");
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }, [entriesOwnerBinding, onAddAttachment, onDraftChange, refresh]);

  const remove = useCallback(async (entry: PromptStashEntry) => {
    if (operationInFlightRef.current) return;
    const operationBinding = entriesOwnerBinding;
    operationInFlightRef.current = true;
    refreshSequenceRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      await window.ade.agentChat.promptStashes.delete({ id: entry.id }, operationBinding);
      const operationBindingKey = operationBinding?.key ?? null;
      setStashSnapshot((current) => (
        (current.ownerBinding?.key ?? null) === operationBindingKey
          ? {
              ...current,
              entries: current.entries.filter((candidate) => candidate.id !== entry.id),
            }
          : current
      ));
      setHighlightedId((current) => current === entry.id ? null : current);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete this prompt.");
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }, [entriesOwnerBinding]);

  const handleMenuKeyDown = useCallback((event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
  }): boolean => {
    if (!menuOpen) return false;
    if (event.key === "Escape") {
      setMenuOpen(false);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!entries.length) return true;
      const currentIndex = entries.findIndex((entry) => entry.id === highlightedEntry?.id);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const base = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
      const nextIndex = (base + direction + entries.length) % entries.length;
      setHighlightedId(entries[nextIndex]?.id ?? null);
      return true;
    }
    if (event.key === "Enter" && highlightedEntry) {
      void restore(highlightedEntry);
      return true;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey) && highlightedEntry) {
      void remove(highlightedEntry);
      return true;
    }
    return false;
  }, [entries, highlightedEntry, menuOpen, remove, restore]);

  useImperativeHandle(ref, () => ({
    activate: () => {
      void save();
    },
    handleMenuKeyDown,
  }), [handleMenuKeyDown, save]);

  return (
    <div ref={rootRef} className={cn("relative shrink-0", renderButton ? "w-7" : "w-0")}>
      {renderButton ? (
        <SmartTooltip
          forceEnabled
          content={{
            label: hasComposerContent ? "Stash prompt" : "Open stashed prompts",
            description: hasComposerContent
              ? "Save this prompt and its attachments across connected desktops."
              : `Restore a saved prompt. Press ${shortcutLabel} with text to create one.`,
            shortcut: shortcutLabel,
          }}
        >
          <button
            type="button"
            aria-label={hasComposerContent
              ? "Stash prompt"
              : `Open ${entries.length} stashed prompt${entries.length === 1 ? "" : "s"}`}
            aria-expanded={menuOpen}
            disabled={disabled || busy}
            className={cn(
              "relative inline-flex h-7 w-7 items-center justify-center rounded-lg transition-[color,background-color,transform] duration-150",
              "text-muted-fg/38 hover:bg-violet-500/[0.07] hover:text-violet-200/75",
              menuOpen && "bg-violet-500/[0.09] text-violet-100/80",
              saveReceiptVisible && "text-emerald-200/80",
              "disabled:cursor-not-allowed disabled:opacity-35",
            )}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void save()}
          >
            {busy ? (
              <SpinnerGap size={14} className="animate-spin" aria-hidden />
            ) : saveReceiptVisible && !menuOpen ? (
              <Check key={saveReceiptKey} size={14} weight="bold" className="animate-in zoom-in-75 fade-in duration-150" aria-hidden />
            ) : (
              <BookmarkSimple size={14} weight={entries.length ? "fill" : "regular"} aria-hidden />
            )}
            {entries.length > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-3.5 items-center justify-center rounded-full border border-[color:var(--chat-panel-border)] bg-[var(--chat-panel-bg)] px-1 font-mono text-[8px] font-bold leading-3.5 tabular-nums text-fg/68">
                {entries.length}
              </span>
            ) : null}
          </button>
        </SmartTooltip>
      ) : null}

      {menuOpen ? createPortal((
        <div
          ref={menuRef}
          data-prompt-stash-menu=""
          role="dialog"
          aria-label="Stashed prompts"
          className="fixed z-[120] flex max-h-[calc(100vh-32px)] w-[min(380px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-white/[0.09] bg-[#111116]/96 shadow-[0_24px_72px_-28px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
          style={{ left: menuPosition.left, top: menuPosition.top }}
        >
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-3.5 py-2.5">
            <div className="min-w-0">
              <div className="font-sans text-[11px] font-semibold text-fg/82">Stashed prompts</div>
              <div className="mt-0.5 font-sans text-[9.5px] text-muted-fg/42">Shared through this project’s ADE runtime</div>
            </div>
            <button
              type="button"
              className="rounded-md px-1.5 py-1 font-sans text-[10px] text-muted-fg/45 transition-colors hover:bg-white/[0.05] hover:text-fg/70"
              onClick={() => setMenuOpen(false)}
            >
              Close
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
            {entries.length ? entries.map((entry) => {
              const highlighted = highlightedEntry?.id === entry.id;
              const source = providerLabel(entry);
              const entryAttachments = stashAttachments(entry);
              const attachmentCount = stashAttachmentCount(entry);
              const attachmentsUnavailable = stashAttachmentsUnavailable(entry);
              const imageAttachment = entryAttachments.find((attachment) => (
                attachment.type === "image" || attachment.type === "image-url"
              ));
              return (
                <div
                  key={entry.id}
                  className={cn(
                    "group flex cursor-default items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors",
                    highlighted ? "bg-white/[0.075]" : "hover:bg-white/[0.04]",
                  )}
                  onMouseMove={() => setHighlightedId(entry.id)}
                >
                  {imageAttachment ? (
                    <StashImageThumbnail
                      attachment={imageAttachment}
                      composerMachineBinding={entriesOwnerBinding}
                    />
                  ) : attachmentCount ? (
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-black/25 text-muted-fg/35">
                      {attachmentsUnavailable ? <Image size={15} aria-hidden /> : <File size={15} aria-hidden />}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => void restore(entry)}
                    title={attachmentsUnavailable ? "Images unavailable on this machine" : undefined}
                  >
                    <div className="truncate font-sans text-[11.5px] leading-5 text-fg/78">
                      {stashEntryLabel(entry, entryAttachments)}
                    </div>
                    <div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px] text-muted-fg/38">
                      {attachmentCount ? (
                        <span>
                          {attachmentCount} image{attachmentCount === 1 ? "" : "s"}
                          {attachmentsUnavailable ? " on another machine" : ""}
                        </span>
                      ) : null}
                      {attachmentCount && source ? <span aria-hidden>·</span> : null}
                      {source ? <span>{source}</span> : null}
                      {source ? <span aria-hidden>·</span> : null}
                      <span>{relativeTime(entry.createdAt)}</span>
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label="Delete stashed prompt"
                    disabled={busy}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-fg/28 opacity-0 transition-[opacity,color,background-color] hover:bg-red-500/10 hover:text-red-300/75 focus:opacity-100 group-hover:opacity-100 disabled:opacity-30"
                    onClick={() => void remove(entry)}
                  >
                    <Trash size={12} aria-hidden />
                  </button>
                </div>
              );
            }) : (
              <div className="px-3 py-6 text-center">
                <BookmarkSimple size={18} className="mx-auto text-muted-fg/24" aria-hidden />
                <div className="mt-2 font-sans text-[11px] text-fg/55">Nothing stashed yet</div>
                <div className="mt-1 font-sans text-[10px] leading-4 text-muted-fg/38">Type a prompt and press {shortcutLabel}.</div>
              </div>
            )}
          </div>

          {error ? (
            <div className="border-t border-red-300/[0.08] bg-red-500/[0.04] px-3.5 py-2 font-sans text-[10px] leading-4 text-red-200/72" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      ), document.body) : null}
      {error && !menuOpen ? createPortal((
        <div
          role="alert"
          className="fixed z-[120] flex w-[min(320px,calc(100vw-32px))] items-start gap-2 rounded-xl border border-red-300/[0.12] bg-[#171116]/98 px-3 py-2.5 font-sans text-[10.5px] leading-4 text-red-100/82 shadow-[0_18px_54px_-24px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
          style={{ left: errorNoticePosition.left, bottom: errorNoticePosition.bottom }}
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            aria-label="Dismiss stash error"
            className="shrink-0 rounded px-1 text-red-100/45 transition-colors hover:bg-white/[0.05] hover:text-red-100/80"
            onClick={() => setError(null)}
          >
            Close
          </button>
        </div>
      ), document.body) : null}
    </div>
  );
});

ComposerPromptStash.displayName = "ComposerPromptStash";
