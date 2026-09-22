import { useCallback, useRef } from "react";
import type {
  AgentChatFileRef,
  AppControlContextItem,
  IosElementContextItem,
  OpenProjectBinding,
  TerminalToolType,
} from "../../../shared/types";
import type { WorkDraftKind } from "../../state/appStore";
import {
  formatAppControlContextForPrompt,
  formatBuiltInBrowserContextForPrompt,
  formatIosElementContextForPrompt,
  normalizeBuiltInBrowserContextItem,
} from "../../lib/visualContextFormatting";
import {
  dispatchWorkPtyContextInserted,
  type WorkPtyContextInsertKind,
} from "../../lib/workPtyContextEvents";

/**
 * "Insert this into the chat" for every Work tool, in one place.
 *
 * This used to live inside `WorkSidebar`, which was fine while the tools pane
 * was the only host. The Apple device column is a sibling pane now — its
 * inspect panel still has an "Insert into chat" button, and it is not inside
 * the sidebar's tree — so the dispatch had to become something two hosts can
 * call rather than something one of them owns.
 *
 * The rules it encodes are the ones the pane already had: a chat or draft
 * target gets a DOM event the composer listens for, a PTY target gets the same
 * text bracketed-pasted into the terminal, and an absent or disabled target
 * throws with the reason so the tool can surface it rather than silently
 * swallowing the click.
 */

export type WorkSidebarContextTarget =
  | { kind: "chat"; sessionId: string }
  | { kind: "draft"; draftTargetId: string; laneId: string; draftKind: WorkDraftKind }
  | { kind: "pty"; sessionId: string; ptyId: string; toolType: TerminalToolType | null };

export const NO_CONTEXT_TARGET_ERROR =
  "Open a chat, draft, or agent CLI session in this lane before inserting tool context.";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export function bracketedPaste(text: string): string {
  return `${BRACKETED_PASTE_START}${text.trimEnd()}\n${BRACKETED_PASTE_END}`;
}

export function formatAttachmentForPty(attachment: AgentChatFileRef): string {
  return [
    "ADE visual attachment saved by the Work sidebar.",
    `Path: ${attachment.path}`,
    `Type: ${attachment.type}`,
    "",
  ].join("\n");
}

export function dispatchAgentChatEvent<T>(
  eventName: string,
  target: Extract<WorkSidebarContextTarget, { kind: "chat" | "draft" }>,
  key: string,
  value: T,
): void {
  const targetDetail = target.kind === "chat"
    ? { sessionId: target.sessionId }
    : {
        draftTargetId: target.draftTargetId,
        laneId: target.laneId,
        draftKind: target.draftKind,
      };
  window.dispatchEvent(new CustomEvent(eventName, {
    detail: {
      ...targetDetail,
      [key]: value,
    },
  }));
}

export type WorkToolContextInsertion = {
  addAttachment: (attachment: AgentChatFileRef) => void;
  addIosContext: (item: IosElementContextItem) => void;
  addAppControlContext: (item: AppControlContextItem) => void;
  addBuiltInBrowserContext: (item: unknown) => void;
  insertDraft: (text: string) => void;
};

export function useWorkToolContextInsertion(args: {
  contextTarget: WorkSidebarContextTarget | null;
  contextDisabledReason: string | null;
  runtimePin: OpenProjectBinding | null;
}): WorkToolContextInsertion {
  const { contextTarget, contextDisabledReason, runtimePin } = args;

  // Read through a ref so every callback below keeps a stable identity: they
  // are handed to memoized panels, and a new function per target change would
  // re-render every tool for a value most of them never use.
  const targetRef = useRef({ contextTarget, contextDisabledReason });
  targetRef.current = { contextTarget, contextDisabledReason };

  const insertIntoPty = useCallback((
    target: Extract<WorkSidebarContextTarget, { kind: "pty" }>,
    text: string,
    kind: WorkPtyContextInsertKind,
  ) => {
    const payload = text.trimEnd();
    if (!payload) return;
    void window.ade.terminal.write({
      terminalId: target.sessionId,
      ptyId: target.ptyId,
      data: bracketedPaste(payload),
    }, runtimePin)
      .then(() => {
        dispatchWorkPtyContextInserted({
          sessionId: target.sessionId,
          ptyId: target.ptyId,
          toolType: target.toolType,
          kind,
        });
      })
      .catch((error: unknown) => {
        console.error("[WorkTools] Failed to insert context into PTY", {
          sessionId: target.sessionId,
          toolType: target.toolType,
          error,
        });
      });
  }, [runtimePin]);

  const withContextTarget = useCallback((
    fallbackError: string,
    action: (target: WorkSidebarContextTarget) => void,
  ) => {
    const { contextTarget: target, contextDisabledReason: targetReason } = targetRef.current;
    if (!target || targetReason) {
      throw new Error(targetReason ?? fallbackError);
    }
    action(target);
  }, []);

  const insertContext = useCallback(<T,>(
    eventName: string,
    key: string,
    value: T,
    kind: WorkPtyContextInsertKind,
    formatForPty: (value: T) => string | null,
  ) => {
    withContextTarget(NO_CONTEXT_TARGET_ERROR, (target) => {
      if (target.kind === "chat" || target.kind === "draft") {
        dispatchAgentChatEvent(eventName, target, key, value);
        return;
      }
      const text = formatForPty(value);
      if (text) insertIntoPty(target, text, kind);
    });
  }, [insertIntoPty, withContextTarget]);

  const addAttachment = useCallback((attachment: AgentChatFileRef) => {
    insertContext(
      "ade:agent-chat:add-attachment",
      "attachment",
      attachment,
      "attachment",
      formatAttachmentForPty,
    );
  }, [insertContext]);

  const addIosContext = useCallback((item: IosElementContextItem) => {
    insertContext(
      "ade:agent-chat:add-ios-context",
      "item",
      item,
      "ios",
      (value) => formatIosElementContextForPrompt([value]),
    );
  }, [insertContext]);

  const addAppControlContext = useCallback((item: AppControlContextItem) => {
    insertContext(
      "ade:agent-chat:add-app-control-context",
      "item",
      item,
      "app-control",
      (value) => formatAppControlContextForPrompt([value]),
    );
  }, [insertContext]);

  const addBuiltInBrowserContext = useCallback((item: unknown) => {
    insertContext(
      "ade:agent-chat:add-builtin-browser-context",
      "item",
      item,
      "browser",
      (value) => {
        const browserItem = normalizeBuiltInBrowserContextItem(value);
        return browserItem ? formatBuiltInBrowserContextForPrompt([browserItem]) : null;
      },
    );
  }, [insertContext]);

  const insertDraft = useCallback((text: string) => {
    withContextTarget(
      "Open a chat, draft, or agent CLI session in this lane before inserting draft text.",
      (target) => {
        if (target.kind === "chat" || target.kind === "draft") {
          dispatchAgentChatEvent("ade:agent-chat:insert-draft", target, "text", text);
          return;
        }
        insertIntoPty(target, text, "draft");
      },
    );
  }, [insertIntoPty, withContextTarget]);

  return { addAttachment, addIosContext, addAppControlContext, addBuiltInBrowserContext, insertDraft };
}
