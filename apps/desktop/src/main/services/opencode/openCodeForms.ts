import type { FormField, FormField1, FormOption } from "@opencode/client";
import type { PendingInputOption, PendingInputQuestion } from "../../../shared/types/chat";
import type { OpenCodeProviderAuthPrompt } from "../../../shared/types/config";

/**
 * OpenCode 2.0 forms in ADE's shapes. One form type backs both the `question`
 * tool (a chat's question card) and an integration's sign-in method (the
 * settings sign-in dialog); the client generates its field type twice, once
 * per wire, so both variants are accepted.
 */

export type OpenCodeFormField = FormField | FormField1;

export type OpenCodeFormAnswer = Record<string, string | number | boolean | string[]>;

const BOOLEAN_OPTIONS = [{ label: "Yes", value: "true" }, { label: "No", value: "false" }] as const;

function trimmedOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mapOptions(options: readonly FormOption[] | undefined): PendingInputOption[] {
  return (options ?? []).map((option) => ({
    label: option.label.trim() || option.value,
    value: option.value,
    ...(option.description?.trim() ? { description: option.description.trim() } : {}),
  }));
}

/** A form as the questions on ADE's structured question card, hidden fields left out. */
export function openCodeFormQuestions(fields: readonly OpenCodeFormField[]): PendingInputQuestion[] {
  const questions: PendingInputQuestion[] = [];
  fields.forEach((field, index) => {
    if ("hidden" in field && field.hidden) return;
    const title = trimmedOrNull(field.title);
    const description = trimmedOrNull(field.description);
    const options = field.type === "boolean"
      ? [...BOOLEAN_OPTIONS]
      : field.type === "string" || field.type === "multiselect" ? mapOptions(field.options) : [];
    const external = field.type === "external" ? field.url : null;
    const custom = field.type === "string" || field.type === "multiselect" ? field.custom : undefined;
    questions.push({
      id: field.key,
      header: title ?? `Question ${index + 1}`,
      question: [description ?? title ?? "OpenCode needs an answer.", external ? `(${external})` : null]
        .filter(Boolean)
        .join(" "),
      ...(field.type === "multiselect" ? { multiSelect: true } : {}),
      allowsFreeform: custom !== false || options.length === 0,
      ...(options.length ? { options } : {}),
    });
  });
  return questions;
}

/**
 * One field as a sign-in dialog prompt. Null for a field the dialog has no
 * control for (multi-select, external link) or one that is hidden.
 */
export function openCodeFormPrompt(field: OpenCodeFormField): OpenCodeProviderAuthPrompt | null {
  if (field.type === "external" || field.type === "multiselect" || field.hidden) return null;
  const whenEntry = field.when?.[0];
  const when = whenEntry ? { key: whenEntry.key, op: whenEntry.op, value: String(whenEntry.value) } : undefined;
  const message = trimmedOrNull(field.title) ?? field.key;
  const shared = { key: field.key, message, ...(when ? { when } : {}) };
  if (field.type === "string" && field.options?.length && !field.custom) {
    return {
      type: "select",
      ...shared,
      options: field.options.map((option) => ({
        label: option.label,
        value: option.value,
        ...(option.description ? { hint: option.description } : {}),
      })),
    };
  }
  if (field.type === "boolean") return { type: "select", ...shared, options: [...BOOLEAN_OPTIONS] };
  if (field.type === "string" && field.placeholder) return { type: "text", ...shared, placeholder: field.placeholder };
  return { type: "text", ...shared };
}

/**
 * ADE's string answers typed back to the form: one entry per answered field,
 * `valuesFor` giving the strings entered for a key. External fields take no
 * answer, and an unparseable number is dropped.
 */
export function openCodeFormAnswer(
  fields: readonly OpenCodeFormField[],
  valuesFor: (key: string) => readonly string[],
): OpenCodeFormAnswer {
  const answer: OpenCodeFormAnswer = {};
  for (const field of fields) {
    if (field.type === "external") continue;
    const values = valuesFor(field.key);
    if (!values.length) continue;
    if (field.type === "multiselect") answer[field.key] = [...values];
    else if (field.type === "boolean") answer[field.key] = values[0] === "true";
    else if (field.type === "number" || field.type === "integer") {
      const parsed = Number(values[0]);
      if (Number.isFinite(parsed)) answer[field.key] = field.type === "integer" ? Math.trunc(parsed) : parsed;
    } else answer[field.key] = values[0]!;
  }
  return answer;
}
