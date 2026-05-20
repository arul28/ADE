import type { TerminalSessionSummary } from "../../shared/types";

export const ADE_WORK_PTY_CONTEXT_INSERTED_EVENT = "ade:work-pty-context-inserted";

export type WorkPtyContextInsertKind =
  | "attachment"
  | "ios"
  | "app-control"
  | "browser"
  | "draft";

export type WorkPtyContextInsertedDetail = {
  sessionId: string;
  ptyId: string;
  toolType: TerminalSessionSummary["toolType"];
  kind: WorkPtyContextInsertKind;
};

export function dispatchWorkPtyContextInserted(detail: WorkPtyContextInsertedDetail): void {
  window.dispatchEvent(new CustomEvent(ADE_WORK_PTY_CONTEXT_INSERTED_EVENT, { detail }));
}
