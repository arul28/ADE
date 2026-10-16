import {
  BookmarkSimple,
  CalendarBlank,
  Check,
  File,
  Image,
  SpinnerGap,
  Trash,
  WarningCircle,
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
import {
  type AgentChatFileRef,
  type DraftEntry,
  type DraftScheduleInput,
  MAX_DRAFT_ATTACHMENTS,
  MAX_DRAFTS,
  MAX_SCHEDULED_DRAFTS,
  type OpenProjectBinding,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { readAttachmentImageDataUrl } from "../../lib/attachmentImage";
import { SmartTooltip } from "../ui/SmartTooltip";
import { ViewportOverlayPortal } from "../ui/ViewportOverlayHost";
import { Banner } from "../ui/notice/Banner";
import { DraftDetailPanel } from "./DraftDetailPanel";
import {
  attachmentName,
  base64FromDataUrl,
  draftAttachmentCount,
  draftAttachments,
  draftAttachmentsUnavailable,
  draftEntryLabel,
  draftMetaLine,
  isDraftableAttachment,
  isPendingSchedule,
  isScheduledEntry,
  needsAttention,
  providerLabel,
  sameAttachment,
} from "./draftsFormat";

const DRAFTS_MENU_MAX_WIDTH = 380;
const DRAFTS_MENU_VIEWPORT_MARGIN = 16;
const DRAFTS_MENU_GAP = 10;
const LOCAL_RUNTIME_PROJECT_UNAVAILABLE_MESSAGE =
  "Local runtime project is not available for this window.";

export type ComposerDraftsHandle = {
  activate: () => void;
  /** Save without clearing the active draft; used by keyboard history recall. */
  activatePreservingDraft: () => Promise<DraftEntry | null>;
  /** Save the composer as a scheduled draft, with its attachments staged. */
  activateScheduled: (input: DraftScheduleInput) => Promise<DraftEntry | null>;
  /** Consume the auto-saved entry when keyboard history restores its draft. */
  consume: (entry: DraftEntry) => Promise<boolean>;
  /** Re-read the list from the runtime (after an edit made elsewhere). */
  reload: () => void;
  handleMenuKeyDown: (event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
  }) => boolean;
};

export type DraftFilter = "all" | "scheduled" | "needs-you";

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

async function isStaleLocalDraftRequest(
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

function draftErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message.trim() : "";
  if (!raw) return fallback;
  if (/requires elevated role|(?:list|create|delete|update|claim)Drafts?/i.test(raw)) {
    return "Drafts are temporarily unavailable on this computer.";
  }
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim() || fallback;
}

function DraftImageThumbnail({
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
    void readAttachmentImageDataUrl(attachment.path, capturedBinding)
      .then(({ dataUrl }) => {
        if (!cancelled) setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [attachment, composerMachineBinding, directUrl]);

  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-fg/[0.08] bg-black/25 text-muted-fg/35">
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

export type ComposerDraftsProps = {
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
  /** Opens the schedule form for a draft the user picked out of the list. */
  onRequestSchedule?: ((entry: DraftEntry) => void) | undefined;
};

export const ComposerDrafts = forwardRef<ComposerDraftsHandle, ComposerDraftsProps>(function ComposerDrafts({
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
  onRequestSchedule,
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
  const [draftSnapshot, setDraftSnapshot] = useState<{
    entries: DraftEntry[];
    ownerBinding: OpenProjectBinding | null;
  }>({
    entries: [],
    ownerBinding: null,
  });
  const [menuOpen, setMenuOpen] = useState(false);
  const [filter, setFilter] = useState<DraftFilter>("all");
  const [openEntry, setOpenEntry] = useState<DraftEntry | null>(null);
  const [editText, setEditText] = useState<string>("");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveReceiptKey, setSaveReceiptKey] = useState(0);
  const [saveReceiptVisible, setSaveReceiptVisible] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const draftableComposerAttachments = useMemo(
    () => attachments.filter(isDraftableAttachment),
    [attachments],
  );
  const currentBindingKey = composerMachineBinding?.key ?? null;
  const entriesOwnerBinding = draftSnapshot.ownerBinding;
  const entriesOwnerBindingKey = entriesOwnerBinding?.key ?? null;
  const entries = entriesOwnerBindingKey === currentBindingKey ? draftSnapshot.entries : [];
  const hasComposerContent = draft.trim().length > 0 || draftableComposerAttachments.length > 0;
  const renderButton = buttonVisible && (hasComposerContent || entries.length > 0);
  const attachmentSignature = attachments.map((attachment) => (
    `${attachment.type}:${attachment.path}`
  )).join("\n");

  const scheduledCount = entries.filter((entry) => isScheduledEntry(entry) && isPendingSchedule(entry)).length;
  const needsYouCount = entries.filter(needsAttention).length;
  const visibleEntries = useMemo(() => {
    if (filter === "scheduled") return entries.filter(isScheduledEntry);
    if (filter === "needs-you") return entries.filter(needsAttention);
    return entries;
  }, [entries, filter]);

  const highlightedEntry = useMemo(
    () => visibleEntries.find((entry) => entry.id === highlightedId) ?? visibleEntries[0] ?? null,
    [visibleEntries, highlightedId],
  );

  const refresh = useCallback(async (
    bindingOverride?: OpenProjectBinding | null,
  ) => {
    const capturedBinding = bindingOverride === undefined
      ? composerMachineBinding
      : bindingOverride;
    const sequence = ++refreshSequenceRef.current;
    try {
      const next = await window.ade.agentChat.drafts.list(capturedBinding);
      if (sequence !== refreshSequenceRef.current) return;
      setDraftSnapshot({
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
      if (await isStaleLocalDraftRequest(refreshError, capturedBinding)) {
        return;
      }
      if (sequence !== refreshSequenceRef.current) return;
      setError(draftErrorMessage(refreshError, "Could not load drafts."));
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
    if (menuOpen && hasComposerContent && !error) {
      setMenuOpen(false);
    }
  }, [error, hasComposerContent, menuOpen]);

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
      const width = Math.min(DRAFTS_MENU_MAX_WIDTH, window.innerWidth - (DRAFTS_MENU_VIEWPORT_MARGIN * 2));
      const maxLeft = Math.max(DRAFTS_MENU_VIEWPORT_MARGIN, window.innerWidth - width - DRAFTS_MENU_VIEWPORT_MARGIN);
      const menuHeight = menu.getBoundingClientRect().height;
      const above = anchor.top - DRAFTS_MENU_GAP - menuHeight;
      const below = anchor.bottom + DRAFTS_MENU_GAP;
      const maxTop = Math.max(DRAFTS_MENU_VIEWPORT_MARGIN, window.innerHeight - menuHeight - DRAFTS_MENU_VIEWPORT_MARGIN);
      let top = above;
      if (above < DRAFTS_MENU_VIEWPORT_MARGIN) {
        top = below + menuHeight <= window.innerHeight - DRAFTS_MENU_VIEWPORT_MARGIN
          ? below
          : Math.min(Math.max(DRAFTS_MENU_VIEWPORT_MARGIN, above), maxTop);
      }
      setMenuPosition({
        left: Math.min(Math.max(DRAFTS_MENU_VIEWPORT_MARGIN, anchor.right - width), maxLeft),
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

  /**
   * Persist the composer as a draft. Shared by the plain save and the
   * scheduled save: the only difference is whether a schedule rides along.
   */
  const persistComposerDraft = useCallback(async (
    schedule: DraftScheduleInput | null,
    preserveDraft: boolean,
  ): Promise<DraftEntry | null> => {
    if (disabled || operationInFlightRef.current) return null;
    const operationBinding = composerMachineBinding;
    const savedText = latestDraftRef.current;
    const savedComposerAttachments = [...latestAttachmentsRef.current];
    const savedAttachments = savedComposerAttachments.filter(isDraftableAttachment);
    if (savedAttachments.length > MAX_DRAFT_ATTACHMENTS) {
      setError(`A draft can hold up to ${MAX_DRAFT_ATTACHMENTS} images.`);
      setMenuOpen(true);
      return null;
    }
    if (!savedText.trim() && savedAttachments.length === 0) {
      if (!entries.length) return null;
      setMenuOpen(true);
      await refresh(operationBinding);
      return null;
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
        const { dataUrl } = await readAttachmentImageDataUrl(attachment.path, operationBinding);
        const saved = await window.ade.agentChat.saveTempAttachment({
          data: base64FromDataUrl(dataUrl),
          filename: attachmentName(attachment.path),
        }, operationBinding);
        storedAttachments.push({ path: saved.path, type: "image" });
      }
      const created = await window.ade.agentChat.drafts.create({
        text: savedText,
        ...(storedAttachments.length ? { attachments: storedAttachments } : {}),
        provider,
        modelId,
        ...(schedule ? { schedule } : {}),
      }, operationBinding);
      if (storedAttachments.length > 0) {
        const confirmedAttachments = draftAttachments(created);
        const runtimeConfirmedImages = storedAttachments.every((stored) => (
          confirmedAttachments.some((confirmed) => sameAttachment(confirmed, stored))
        ));
        if (!runtimeConfirmedImages) {
          try {
            await window.ade.agentChat.drafts.delete({ id: created.id }, operationBinding);
          } catch {
            // The composer remains intact even if an older runtime cannot roll
            // back the text-only compatibility write.
          }
          throw new Error("The connected ADE runtime could not preserve the attached images. They are still in your composer.");
        }
      }
      const operationBindingKey = operationBinding?.key ?? null;
      if ((latestComposerMachineBindingRef.current?.key ?? null) === operationBindingKey) {
        setDraftSnapshot((current) => ({
          entries: [
            created,
            ...((current.ownerBinding?.key ?? null) === operationBindingKey
              ? current.entries.filter((entry) => entry.id !== created.id)
              : []),
          ].slice(0, MAX_DRAFTS + MAX_SCHEDULED_DRAFTS),
          ownerBinding: operationBinding,
        }));
      }
      setHighlightedId(created.id);
      setSaveReceiptKey((current) => current + 1);
      setSaveReceiptVisible(true);
      setMenuOpen(false);
      // The runtime has durably accepted the draft. Only now is it safe to
      // clear the exact text that was saved. Input typed while a remote
      // runtime acknowledged the write belongs to a newer draft and stays.
      const composerUnchanged = (latestComposerMachineBindingRef.current?.key ?? null) === operationBindingKey
        && latestDraftRef.current === savedText
        && latestAttachmentsRef.current.length === savedComposerAttachments.length
        && latestAttachmentsRef.current.every((current, index) => (
          Boolean(savedComposerAttachments[index] && sameAttachment(current, savedComposerAttachments[index]!))
        ));
      if (composerUnchanged && !preserveDraft) {
        onDraftChange("");
        for (const savedAttachment of savedAttachments) {
          onRemoveAttachment(savedAttachment.path);
        }
      }
      return created;
    } catch (saveError) {
      setError(draftErrorMessage(saveError, "Could not save this draft."));
      setMenuOpen(true);
      return null;
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }, [composerMachineBinding, disabled, entries.length, modelId, onDraftChange, onRemoveAttachment, provider, refresh]);

  const save = useCallback(
    (preserveDraft = false) => persistComposerDraft(null, preserveDraft),
    [persistComposerDraft],
  );

  /**
   * One shape for every draft mutation: refuse while another is in flight,
   * mark busy, clear the error, and turn any throw into the row's message.
   * Five operations had copied this block, which is how one of them ends up
   * forgetting the `finally`.
   */
  const runDraftOperation = useCallback(async (
    fallback: string,
    operation: () => Promise<void>,
  ): Promise<void> => {
    if (operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (operationError) {
      setError(draftErrorMessage(operationError, fallback));
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }, []);

  /**
   * Claim a draft and put it in the composer.
   *
   * The claim — a delete on the runtime — happens BEFORE the composer is
   * filled, so the machine that loses the race never receives the text. The
   * old order filled first and deleted after, which left the same draft in two
   * composers and could send it twice.
   */
  const attach = useCallback(async (entry: DraftEntry) => {
    const operationBinding = entriesOwnerBinding;
    if (draftAttachmentsUnavailable(entry)) {
      setError("These images live on the machine where this draft was made. Connect to that machine to use it.");
      return;
    }
    await runDraftOperation("Could not attach this draft.", async () => {
      refreshSequenceRef.current += 1;
      const claimed = await window.ade.agentChat.drafts.claim({ id: entry.id }, operationBinding);
      if (!claimed) {
        if ((latestComposerMachineBindingRef.current?.key ?? null) === (operationBinding?.key ?? null)) {
          await refresh(operationBinding);
        }
        setError("That draft was taken on another machine.");
        return;
      }
      const operationBindingKey = operationBinding?.key ?? null;
      setDraftSnapshot((current) => (
        (current.ownerBinding?.key ?? null) === operationBindingKey
          ? { ...current, entries: current.entries.filter((candidate) => candidate.id !== claimed.id) }
          : current
      ));
      setHighlightedId(null);
      setMenuOpen(false);
      setOpenEntry(null);
      onDraftChange(claimed.text);
      for (const attachment of draftAttachments(claimed)) {
        onAddAttachment(attachment);
      }
    });
  }, [entriesOwnerBinding, onAddAttachment, onDraftChange, refresh, runDraftOperation]);

  const remove = useCallback(async (entry: DraftEntry): Promise<boolean> => {
    if (operationInFlightRef.current) return false;
    const operationBinding = entriesOwnerBinding;
    const operationBindingKey = operationBinding?.key ?? null;
    operationInFlightRef.current = true;
    refreshSequenceRef.current += 1;
    setBusy(true);
    setError(null);
    try {
      const deleted = await window.ade.agentChat.drafts.delete({ id: entry.id }, operationBinding);
      if (!deleted) {
        if ((latestComposerMachineBindingRef.current?.key ?? null) === operationBindingKey) {
          await refresh(operationBinding);
        }
        return false;
      }
      setDraftSnapshot((current) => (
        (current.ownerBinding?.key ?? null) === operationBindingKey
          ? { ...current, entries: current.entries.filter((candidate) => candidate.id !== entry.id) }
          : current
      ));
      setHighlightedId((current) => current === entry.id ? null : current);
      setOpenEntry((current) => current?.id === entry.id ? null : current);
      return true;
    } catch (deleteError) {
      setError(draftErrorMessage(deleteError, "Could not delete this draft."));
      return false;
    } finally {
      operationInFlightRef.current = false;
      setBusy(false);
    }
  }, [entriesOwnerBinding, refresh]);

  const saveEdit = useCallback(async (entry: DraftEntry, text: string) => {
    const operationBinding = entriesOwnerBinding;
    await runDraftOperation("Could not save this draft.", async () => {
      const updated = await window.ade.agentChat.drafts.update({ id: entry.id, text }, operationBinding);
      if (!updated) {
        setError("That draft was taken on another machine.");
        await refresh(operationBinding);
        setOpenEntry(null);
        return;
      }
      setDraftSnapshot((current) => (
        (current.ownerBinding?.key ?? null) === (operationBinding?.key ?? null)
          ? { ...current, entries: current.entries.map((candidate) => (
            candidate.id === updated.id ? updated : candidate
          )) }
          : current
      ));
      setOpenEntry(updated);
    });
  }, [entriesOwnerBinding, refresh, runDraftOperation]);

  /**
   * Deliver a draft immediately. The row keeps whatever schedule it had, so a
   * manual send that fails leaves the armed send alone rather than cancelling
   * it as a side effect.
   */
  const sendNow = useCallback(async (entry: DraftEntry) => {
    const operationBinding = entriesOwnerBinding;
    await runDraftOperation("Could not send this draft.", async () => {
      const result = await window.ade.agentChat.drafts.sendNow({ id: entry.id }, operationBinding);
      if (!result.ok) {
        throw new Error(result.error?.trim() || "Could not send this draft.");
      }
      await refresh(operationBinding);
      setOpenEntry(null);
    });
  }, [entriesOwnerBinding, refresh, runDraftOperation]);

  /** Copy a draft to the top of the list; the copy is a plain draft. */
  const duplicate = useCallback(async (entry: DraftEntry) => {
    const operationBinding = entriesOwnerBinding;
    await runDraftOperation("Could not duplicate this draft.", async () => {
      const attachments = draftAttachments(entry);
      const created = await window.ade.agentChat.drafts.create({
        text: entry.text,
        ...(attachments.length ? { attachments } : {}),
        provider: entry.provider,
        modelId: entry.modelId,
        originSessionId: entry.originSessionId ?? null,
      }, operationBinding);
      await refresh(operationBinding);
      setOpenEntry(created);
    });
  }, [entriesOwnerBinding, refresh, runDraftOperation]);

  const handleMenuKeyDown = useCallback((event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
  }): boolean => {
    if (!menuOpen) return false;
    if (event.key === "Escape") {
      if (openEntry) {
        setOpenEntry(null);
        return true;
      }
      setMenuOpen(false);
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!visibleEntries.length) return true;
      const currentIndex = visibleEntries.findIndex((entry) => entry.id === highlightedEntry?.id);
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const base = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
      const nextIndex = (base + direction + visibleEntries.length) % visibleEntries.length;
      setHighlightedId(visibleEntries[nextIndex]?.id ?? null);
      return true;
    }
    if (event.key === "Enter" && highlightedEntry) {
      setOpenEntry(highlightedEntry);
      return true;
    }
    if (event.key === "Backspace" && (event.metaKey || event.ctrlKey) && highlightedEntry) {
      void remove(highlightedEntry);
      return true;
    }
    return false;
  }, [highlightedEntry, menuOpen, openEntry, remove, visibleEntries]);

  useImperativeHandle(ref, () => ({
    activate: () => {
      void save();
    },
    activatePreservingDraft: () => save(true),
    activateScheduled: (input: DraftScheduleInput) => persistComposerDraft(input, false),
    consume: remove,
    reload: () => {
      void refresh();
    },
    handleMenuKeyDown,
  }), [handleMenuKeyDown, persistComposerDraft, refresh, remove, save]);

  useEffect(() => {
    if (openEntry) setEditText(openEntry.text);
  }, [openEntry]);

  const openDetail = useCallback((entry: DraftEntry) => {
    setHighlightedId(entry.id);
    setOpenEntry(entry);
  }, []);

  return (
    <div ref={rootRef} className={cn("relative shrink-0", renderButton ? "w-7" : "w-0")}>
      {renderButton ? (
        <SmartTooltip
          forceEnabled
          content={{
            label: hasComposerContent ? "Save draft" : "Open drafts",
            description: hasComposerContent
              ? "Save this prompt and its images across connected machines."
              : `Open your drafts and scheduled sends. Press ${shortcutLabel} with text to save one.`,
            shortcut: shortcutLabel,
          }}
        >
          <button
            type="button"
            aria-label={hasComposerContent
              ? "Save draft"
              : `Open ${entries.length} draft${entries.length === 1 ? "" : "s"}`}
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

      {menuOpen ? (
        // The composer's other menus anchor inside the named popover layer
        // rather than carrying their own fixed positioning and stacking
        // number; matching that keeps one idiom for the pane instead of two.
        <ViewportOverlayPortal layer="popover">
        <div
          ref={menuRef}
          data-drafts-menu=""
          role="dialog"
          aria-label="Drafts"
          className="pointer-events-auto absolute flex max-h-[calc(100vh-32px)] w-[min(380px,calc(100vw-32px))] flex-col overflow-hidden rounded-2xl border border-fg/[0.09] bg-(color:--work-popover-bg) shadow-[0_24px_72px_-28px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
          style={{ left: menuPosition.left, top: menuPosition.top }}
        >
          {openEntry ? (
            <DraftDetailPanel
              entry={openEntry}
              text={editText}
              onTextChange={setEditText}
              busy={busy}
              composerMachineBinding={entriesOwnerBinding}
              onBack={() => setOpenEntry(null)}
              onClose={() => { setOpenEntry(null); setMenuOpen(false); }}
              onSaveEdit={(entry, text) => { void saveEdit(entry, text); }}
              onAttach={(entry) => { void attach(entry); }}
              onSendNow={(entry) => { void sendNow(entry); }}
              onDuplicate={(entry) => { void duplicate(entry); }}
              onSchedule={onRequestSchedule ? (entry) => {
                onRequestSchedule(entry);
                setOpenEntry(null);
                setMenuOpen(false);
              } : undefined}
            />
          ) : (
            <>
              <div className="border-b border-fg/[0.06] px-3.5 pt-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-sans text-[11px] font-semibold text-fg/82">Drafts</div>
                    <div className="mt-0.5 font-sans text-[9.5px] text-muted-fg/42">Shared through this project’s ADE runtime</div>
                  </div>
                  <button
                    type="button"
                    className="rounded-md px-1.5 py-1 font-sans text-[10px] text-muted-fg/45 transition-colors hover:bg-fg/[0.05] hover:text-fg/70"
                    onClick={() => setMenuOpen(false)}
                  >
                    Close
                  </button>
                </div>
                <div className="mt-2 flex items-center gap-1 pb-2">
                  {([
                    ["all", "All", entries.length],
                    ["scheduled", "Scheduled", scheduledCount],
                    ["needs-you", "Needs you", needsYouCount],
                  ] as const).map(([value, label, count]) => (
                    <button
                      key={value}
                      type="button"
                      className={cn(
                        "rounded-full px-2 py-1 font-sans text-[10px] transition-colors",
                        filter === value
                          ? "bg-fg/[0.09] text-fg/85"
                          : "text-muted-fg/48 hover:bg-fg/[0.04] hover:text-fg/70",
                        value === "needs-you" && count > 0 && filter !== value && "text-amber-200/70",
                      )}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                      {count > 0 ? <span className="ml-1 font-mono text-[9px] tabular-nums opacity-70">{count}</span> : null}
                    </button>
                  ))}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
                {visibleEntries.length ? visibleEntries.map((entry) => {
                  const highlighted = highlightedEntry?.id === entry.id;
                  const source = providerLabel(entry);
                  const entryAttachments = draftAttachments(entry);
                  const attachmentCount = draftAttachmentCount(entry);
                  const attachmentsUnavailable = draftAttachmentsUnavailable(entry);
                  const imageAttachment = entryAttachments.find((attachment) => (
                    attachment.type === "image" || attachment.type === "image-url"
                  ));
                  const attention = needsAttention(entry);
                  const scheduled = isScheduledEntry(entry);
                  return (
                    <div
                      key={entry.id}
                      className={cn(
                        "group flex cursor-default items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors",
                        highlighted ? "bg-fg/[0.075]" : "hover:bg-fg/[0.04]",
                      )}
                      onMouseMove={() => setHighlightedId(entry.id)}
                    >
                      {imageAttachment ? (
                        <DraftImageThumbnail
                          attachment={imageAttachment}
                          composerMachineBinding={entriesOwnerBinding}
                        />
                      ) : attachmentCount ? (
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-fg/[0.08] bg-black/25 text-muted-fg/35">
                          {attachmentsUnavailable ? <Image size={15} aria-hidden /> : <File size={15} aria-hidden />}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onPointerDown={(event) => event.preventDefault()}
                        onClick={() => openDetail(entry)}
                        title={attachmentsUnavailable ? "Images unavailable on this machine" : undefined}
                      >
                        <div className="flex items-center gap-1.5">
                          {attention ? (
                            <WarningCircle size={12} className="shrink-0 text-amber-300/85" aria-hidden />
                          ) : scheduled ? (
                            <CalendarBlank size={12} className="shrink-0 text-violet-300/70" aria-hidden />
                          ) : null}
                          <span className="truncate font-sans text-[11.5px] leading-5 text-fg/78">
                            {draftEntryLabel(entry, entryAttachments)}
                          </span>
                        </div>
                        <div className={cn(
                          "mt-0.5 flex items-center gap-1.5 font-mono text-[9px]",
                          attention ? "text-amber-200/60" : "text-muted-fg/38",
                        )}>
                          <span className="truncate">{draftMetaLine(entry)}</span>
                          {attachmentCount ? (
                            <>
                              <span aria-hidden>·</span>
                              <span>
                                {attachmentCount} image{attachmentCount === 1 ? "" : "s"}
                                {attachmentsUnavailable ? " elsewhere" : ""}
                              </span>
                            </>
                          ) : null}
                          {source ? <span aria-hidden>·</span> : null}
                          {source ? <span>{source}</span> : null}
                        </div>
                      </button>
                      <button
                        type="button"
                        aria-label="Delete draft"
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
                    <div className="mt-2 font-sans text-[11px] text-fg/55">
                      {filter === "all"
                        ? "No drafts yet"
                        : filter === "scheduled"
                          ? "Nothing scheduled"
                          : "Nothing needs you"}
                    </div>
                    <div className="mt-1 font-sans text-[10px] leading-4 text-muted-fg/38">
                      {filter === "all"
                        ? `Type a prompt and press ${shortcutLabel}.`
                        : filter === "scheduled"
                          ? "Use Scheduled send from the send menu to arm one."
                          : "Blocked and missed sends show up here."}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {error ? (
            <Banner
              layout="inline"
              style={{ margin: 6 }}
              model={{ id: "draft-error", tone: "error", title: error }}
            />
          ) : null}
        </div>
        </ViewportOverlayPortal>
      ) : null}
    </div>
  );
});

ComposerDrafts.displayName = "ComposerDrafts";
