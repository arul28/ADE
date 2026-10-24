import { randomUUID } from "node:crypto";
import type {
  ProductAnalyticsCapture,
  ProductAnalyticsCaptureResult,
} from "../../../desktop/src/shared/types/productAnalytics";
import type { AdeCodeConnection, RightPaneContent } from "./types";

export type TuiAnalyticsScreenInput = {
  activePane: "drawer" | "chat" | "details" | "addMode";
  /** Kind of row the sessions pane has selected, when that pane is focused. */
  workSelectionKind: "session" | "lane" | "new-chat" | "shelf" | null;
  rightPaneKind: RightPaneContent["kind"];
  gridViewActive: boolean;
  addModeActive: boolean;
  terminalControlActive: boolean;
};

export function deriveTuiAnalyticsScreen(input: TuiAnalyticsScreenInput): string {
  if (input.terminalControlActive) return "terminal_control";
  if (input.activePane === "drawer") {
    return input.workSelectionKind
      ? `work_${input.workSelectionKind.replaceAll("-", "_")}`
      : "work";
  }
  if (input.activePane === "details") {
    return input.rightPaneKind === "empty"
      ? "details"
      : `details_${input.rightPaneKind.replaceAll("-", "_")}`;
  }
  if (input.activePane === "addMode" || input.addModeActive) return "add_chat";
  if (input.gridViewActive) return "multi_chat_grid";
  return "chat";
}

export async function captureTuiProductAnalytics(
  connection: AdeCodeConnection,
  input: Omit<ProductAnalyticsCapture, "surface">,
): Promise<ProductAnalyticsCaptureResult> {
  return await connection.action<ProductAnalyticsCaptureResult>("analytics", "capture", {
    ...input,
    surface: "tui",
    clientEventId: input.clientEventId ?? randomUUID(),
  });
}
