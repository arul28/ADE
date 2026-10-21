import { useCallback, useEffect, useMemo, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Check, GitBranch } from "@phosphor-icons/react";
import { ONBOARDING_CHAT_WINDOW_DAYS } from "../../../shared/onboardingChatWindow";
import { EXTERNAL_SESSION_PROVIDER_LABELS, type OnboardingProjectChat } from "../../../shared/types";
import { chatImportKey } from "../../onboarding/pendingChatImports";
import { ProviderLogo } from "../shared/ProviderLogos";
import { formatPromptCount, formatUpdatedAtCompact } from "../terminals/importSessions/sessionPresentation";
import { AnchoredMenu } from "../ui/AnchoredMenu";
import { Z_LAYERS } from "../ui/zLayers";
import { MAX_IMPORTED_CHATS } from "./useOnboardingChatImport";

/** A project's chat list for the picker: read when the picker first opens. */
export type ChatListState =
  | { phase: "loading" }
  | { phase: "ready"; chats: OnboardingProjectChat[] }
  | { phase: "error" };

/** Where a chat ran, when that is not the project's own folder: its lane's folder name, or a subfolder. */
function folderLabel(cwd: string | null, rootPath: string): string | null {
  if (!cwd) return null;
  const clean = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");
  const folder = clean(cwd);
  const root = clean(rootPath);
  if (folder === root) return null;
  if (folder.startsWith(`${root}/`)) {
    const relative = folder.slice(root.length + 1);
    return relative.match(/^\.ade\/worktrees\/([^/]+)/)?.[1] ?? relative;
  }
  return folder.split("/").pop() || null;
}

/**
 * The picker behind a project's "N chats" count in setup: every chat its
 * import would bring in, each with its own box.
 *
 * Its state is the project's import choice and nothing else: `importOn` with
 * `excluded` (the chats left out). Off, every box is empty, and ticking one
 * turns the import on with just that chat. Unticking the last one turns the
 * import off. "Select all" and the pill's own box both mean every chat.
 *
 * Portalled (into the gate, see `FirstRunProjects`) so the card's scrolling
 * rows never clip it. Escape closes the picker only, never setup: setup's
 * Escape-to-skip ignores keys while a menu or popover is open over it.
 */
export function FirstRunChatPicker({
  projectName,
  rootPath,
  anchorRef,
  returnFocusRef,
  chatList,
  importOn,
  excluded,
  onChange,
  onClose,
}: {
  projectName: string;
  rootPath: string;
  anchorRef: RefObject<HTMLElement | null>;
  /** The count button that opened the picker; focus goes back there on Escape. */
  returnFocusRef: RefObject<HTMLElement | null>;
  chatList: ChatListState | undefined;
  importOn: boolean;
  excluded: ReadonlySet<string> | undefined;
  /** The project's new import choice: `null` is off, a set is on with those chats left out. */
  onChange: (leftOut: ReadonlySet<string> | null) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const phase = chatList?.phase ?? "loading";
  const chats = useMemo(() => (chatList?.phase === "ready" ? chatList.chats : []), [chatList]);
  const keys = useMemo(() => chats.map((chat) => chatImportKey(chat.provider, chat.id)), [chats]);
  const includedCount = importOn ? keys.filter((key) => !excluded?.has(key)).length : 0;
  const allIncluded = keys.length > 0 && includedCount === keys.length;

  const toggleChat = useCallback((key: string) => {
    if (!importOn) {
      onChange(new Set(keys.filter((other) => other !== key)));
      return;
    }
    const next = new Set(excluded ?? []);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onChange(keys.every((other) => next.has(other)) ? null : next);
  }, [excluded, importOn, keys, onChange]);

  const closeAndReturn = useCallback(() => {
    onClose();
    returnFocusRef.current?.focus();
  }, [onClose, returnFocusRef]);

  // Focus moves in on open, and onto the first chat once the list is there,
  // unless the user has already moved it somewhere else. A frame later: the
  // menu stays hidden (unfocusable) until it has been placed.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const active = document.activeElement;
      const focusIsOurs = !active || active === document.body || panel.contains(active) || anchorRef.current?.contains(active);
      if (!focusIsOurs) return;
      (panel.querySelector<HTMLElement>("[data-chat-row]") ?? panel).focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [anchorRef, phase]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Escape from inside the picker closes it and puts focus back on its
    // pill. Setup's own Escape-to-skip leaves keys from an open picker alone,
    // and `AnchoredMenu` closes it on an Escape from anywhere else.
    if (event.key === "Escape") {
      closeAndReturn();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(panelRef.current?.querySelectorAll<HTMLElement>("[data-chat-row]") ?? []);
    if (!rows.length) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    rows[(at + step + rows.length) % rows.length]?.focus();
  };

  return (
    <AnchoredMenu
      open
      anchorRef={anchorRef}
      onClose={onClose}
      placement="bottom-end"
      offset={6}
      zIndex={Z_LAYERS.popover}
      remeasureKey={`${phase}:${chats.length}`}
      className="ade-fr-picker"
      role="dialog"
      aria-label={`Chats to import from ${projectName}`}
    >
      <div
        ref={panelRef}
        className="ade-fr-picker-panel"
        tabIndex={-1}
        aria-busy={phase === "loading" || undefined}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          // Tabbing out of the picker closes it, as a click outside does.
          const next = event.relatedTarget as Node | null;
          if (next && !event.currentTarget.contains(next) && !anchorRef.current?.contains(next)) onClose();
        }}
      >
        <div className="ade-fr-picker-head">
          <span className="ade-fr-picker-title">Last {ONBOARDING_CHAT_WINDOW_DAYS} days</span>
          {phase === "ready" && keys.length ? (
            <>
              <span className="ade-fr-picker-count" aria-live="polite">
                {includedCount} of {keys.length} {keys.length === 1 ? "chat" : "chats"}
              </span>
              <button
                type="button"
                className="ade-fr-text-btn"
                onClick={() => onChange(allIncluded ? null : new Set())}
              >
                {allIncluded ? "Select none" : "Select all"}
              </button>
            </>
          ) : null}
        </div>

        {phase === "loading" ? (
          <div className="ade-fr-picker-rows" aria-label="Reading this project's chats">
            {[0, 1, 2].map((index) => <div key={index} className="ade-fr-picker-skeleton" aria-hidden="true" />)}
          </div>
        ) : phase === "error" ? (
          <p className="ade-fr-picker-note">
            Couldn't read this project's chats. The box still brings them all in.
          </p>
        ) : !chats.length ? (
          <p className="ade-fr-picker-note">No chats from the last {ONBOARDING_CHAT_WINDOW_DAYS} days to choose from.</p>
        ) : (
          <div className="ade-fr-picker-rows" role="group" aria-label={`${projectName} chats`}>
            {chats.map((chat, index) => {
              const key = keys[index]!;
              const on = importOn && !excluded?.has(key);
              const folder = folderLabel(chat.cwd, rootPath);
              const prompts = formatPromptCount(chat.messageCount);
              const providerLabel = EXTERNAL_SESSION_PROVIDER_LABELS[chat.provider];
              return (
                <button
                  key={key}
                  type="button"
                  role="checkbox"
                  aria-checked={on}
                  data-chat-row=""
                  data-on={on ? "true" : undefined}
                  className="ade-fr-chat"
                  title={chat.cwd ?? undefined}
                  onClick={() => toggleChat(key)}
                >
                  <span className="ade-fr-chat-box" aria-hidden="true">
                    <Check size={10} weight="bold" />
                  </span>
                  <span className="ade-fr-chat-logo" aria-hidden="true">
                    <ProviderLogo family={chat.provider} size={14} />
                  </span>
                  <span className="ade-fr-chat-text">
                    <span className="ade-fr-chat-title">{chat.title ?? `Untitled ${providerLabel} chat`}</span>
                    <span className="ade-fr-chat-sub">
                      <span>{providerLabel}</span>
                      {folder ? (
                        <span className="ade-fr-chat-folder">
                          <GitBranch size={10} weight="bold" aria-hidden="true" />
                          {folder}
                        </span>
                      ) : null}
                      {prompts ? <span>{prompts}</span> : null}
                    </span>
                  </span>
                  <span className="ade-fr-chat-when">{formatUpdatedAtCompact(chat.lastActiveAt)}</span>
                </button>
              );
            })}
          </div>
        )}

        {phase === "ready" && chats.length ? (
          <p className="ade-fr-picker-foot">
            {includedCount > MAX_IMPORTED_CHATS
              ? `The newest ${MAX_IMPORTED_CHATS} come in when ${projectName} first opens. The rest stay in Work's import list.`
              : `Each comes into the lane it ran in when ${projectName} first opens.`}
          </p>
        ) : null}
      </div>
    </AnchoredMenu>
  );
}
