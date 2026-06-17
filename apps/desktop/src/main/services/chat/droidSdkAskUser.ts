import type * as DroidSdkTypes from "@factory/droid-sdk";
import type { DroidSdkAskUserRequest } from "./droidSdkProtocol";

// Droid's ask-user payload (`AskUserQuestion`) exposes only `topic`, `question`,
// and `options: string[]`; there is no per-option description, no multiSelect,
// and no default-value field in the SDK schema (the zod object is "passthrough",
// but no richer fields are documented or emitted). We trim display labels, but
// keep raw option strings as values because Droid expects exact answer text.
export function summarizeDroidAskUser(params: DroidSdkTypes.AskUserRequestParams): DroidSdkAskUserRequest {
  const questions = (params.questions ?? []).map((question, index) => {
    const topic = typeof question.topic === "string" ? question.topic.trim() : "";
    const options = (question.options ?? [])
      .filter((option): option is string => typeof option === "string" && option.length > 0)
      .map((option) => ({
        label: option.trim() || option,
        value: option,
      }));
    return {
      id: `q_${question.index ?? index + 1}`,
      ...(topic.length ? { header: topic } : {}),
      question: question.question,
      ...(options.length ? { options } : {}),
    };
  });
  return {
    id: params.toolCallId || `droid-ask-user-${Date.now()}`,
    toolCallId: params.toolCallId,
    title: questions.length === 1 ? "Question from Droid" : "Questions from Droid",
    questions,
    raw: params,
  };
}
