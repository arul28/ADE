import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type {
  ProductSurvey,
  ProductSurveyAnswer,
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
      const parsed = parseSurveyEventInput(input);
      return parsed ? args.surveyService.record(parsed) : { accepted: false };
    },
  );
}

/** The renderer's payload, narrowed to its shape; answers are checked against the survey later. */
function parseSurveyEventInput(input: unknown): ProductSurveyEventInput | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (typeof value.surveyId !== "string") return null;
  const surveyId = value.surveyId;
  if (value.kind === "shown") return { kind: "shown", surveyId };
  if (value.kind === "dismissed") return { kind: "dismissed", surveyId, partiallyCompleted: value.partiallyCompleted === true };
  if (value.kind === "sent" && value.answers && typeof value.answers === "object" && !Array.isArray(value.answers)) {
    return { kind: "sent", surveyId, answers: value.answers as Record<string, ProductSurveyAnswer> };
  }
  return null;
}
