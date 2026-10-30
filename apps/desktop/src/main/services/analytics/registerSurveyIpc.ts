import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type {
  ProductSurvey,
  ProductSurveyEventInput,
  ProductSurveyEventResult,
} from "../../../shared/types/productSurveys";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { SurveyService } from "./surveyService";

/**
 * Wires the in-app survey to IPC.
 *
 * No remote pin: a survey asks the person at THIS desktop app about ADE
 * itself. It reads this computer's own usage history and records through this
 * computer's analytics consent, so it is never about a chat, lane, session or
 * another machine, and there is nothing to route.
 */
export function registerSurveyIpc(args: {
  surveyService: SurveyService;
  logger: { warn: (event: string, data: Record<string, unknown>) => void };
}): void {
  ipcMain.handle(IPC.analyticsGetEligibleSurvey, async (event): Promise<ProductSurvey | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, args.logger, IPC.analyticsGetEligibleSurvey)) return null;
    return await args.surveyService.getEligibleSurvey();
  });
  ipcMain.handle(
    IPC.analyticsSurveyEvent,
    async (event, input: unknown): Promise<ProductSurveyEventResult> => {
      if (!isTrustedAdeRendererSenderOrWarn(event, args.logger, IPC.analyticsSurveyEvent)) return { accepted: false };
      if (!input || typeof input !== "object") return { accepted: false };
      const value = input as Record<string, unknown>;
      if (value.kind !== "shown" && value.kind !== "dismissed" && value.kind !== "sent") return { accepted: false };
      return args.surveyService.record(value as ProductSurveyEventInput);
    },
  );
}
