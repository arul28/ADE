import type { OpenCodeClient } from "@opencode/client";
import type {
  OpenCodeProviderAuthMethod,
  OpenCodeProviderAuthMethods,
  OpenCodeProviderAuthPrompt,
} from "../../../shared/types/config";

/**
 * OpenCode 2.0 integrations in the auth-method shape ADE's settings already
 * render: an OAuth method becomes `oauth` with prompts from its form, a key
 * method becomes `api`. Environment and command methods have no ADE flow and
 * are left out. The renderer addresses a method by its index in this list, so
 * the mapping is deterministic for a given integration.
 */

export type OpenCodeIntegrationInfo = Awaited<ReturnType<OpenCodeClient["integration"]["list"]>>["data"][number];
type IntegrationMethod = OpenCodeIntegrationInfo["methods"][number];
type FormField = NonNullable<Extract<IntegrationMethod, { type: "oauth" }>["form"]>[number];

export type MappedOpenCodeAuthMethod = {
  method: OpenCodeProviderAuthMethod;
  source: IntegrationMethod;
};

function promptFromField(field: FormField): OpenCodeProviderAuthPrompt | null {
  if ("hidden" in field && field.hidden) return null;
  const whenEntry = "when" in field ? field.when?.[0] : undefined;
  const when = whenEntry && (whenEntry.op === "eq" || whenEntry.op === "neq")
    ? { key: whenEntry.key, op: whenEntry.op, value: String(whenEntry.value) }
    : undefined;
  const message = field.title?.trim() || field.key;
  if (field.type === "string") {
    if (field.options?.length && !field.custom) {
      return {
        type: "select",
        key: field.key,
        message,
        options: field.options.map((option) => ({
          label: option.label,
          value: option.value,
          ...(option.description ? { hint: option.description } : {}),
        })),
        ...(when ? { when } : {}),
      };
    }
    return { type: "text", key: field.key, message, ...(field.placeholder ? { placeholder: field.placeholder } : {}), ...(when ? { when } : {}) };
  }
  if (field.type === "boolean") {
    return {
      type: "select",
      key: field.key,
      message,
      options: [{ label: "Yes", value: "true" }, { label: "No", value: "false" }],
      ...(when ? { when } : {}),
    };
  }
  if (field.type === "number" || field.type === "integer") {
    return { type: "text", key: field.key, message, ...(when ? { when } : {}) };
  }
  // Multi-select and external-link fields have no control in ADE's dialog.
  return null;
}

export function mapOpenCodeIntegrationAuthMethods(integration: OpenCodeIntegrationInfo): MappedOpenCodeAuthMethod[] {
  const out: MappedOpenCodeAuthMethod[] = [];
  for (const source of integration.methods) {
    if (source.type === "oauth") {
      const prompts = (source.form ?? []).flatMap((field) => {
        const prompt = promptFromField(field);
        return prompt ? [prompt] : [];
      });
      out.push({ source, method: { type: "oauth", label: source.label, ...(prompts.length ? { prompts } : {}) } });
    } else if (source.type === "key") {
      out.push({ source, method: { type: "api", label: source.label?.trim() || "API key" } });
    }
  }
  return out;
}

/** Only integrations with a sign-in (OAuth) method are listed; key-only providers already have API-key rows. */
export function openCodeAuthMethodsFromIntegrations(
  integrations: readonly OpenCodeIntegrationInfo[],
): OpenCodeProviderAuthMethods {
  const methods: OpenCodeProviderAuthMethods = {};
  for (const integration of integrations) {
    const mapped = mapOpenCodeIntegrationAuthMethods(integration);
    if (!mapped.some((entry) => entry.method.type === "oauth")) continue;
    methods[integration.id] = mapped.map((entry) => entry.method);
  }
  return methods;
}

/**
 * The renderer's string answers, typed back to the method's form. Answers to
 * fields the form does not have are dropped.
 */
export function openCodeFormAnswer(
  source: IntegrationMethod,
  inputs: Record<string, string> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!inputs || (source.type !== "oauth" && source.type !== "key")) return undefined;
  const answer: Record<string, string | number | boolean> = {};
  for (const field of source.form ?? []) {
    const raw = inputs[field.key];
    if (raw === undefined || raw === "") continue;
    if (field.type === "boolean") answer[field.key] = raw === "true";
    else if (field.type === "number" || field.type === "integer") {
      const value = Number(raw);
      if (Number.isFinite(value)) answer[field.key] = field.type === "integer" ? Math.trunc(value) : value;
    } else if (field.type === "string") answer[field.key] = raw;
  }
  return Object.keys(answer).length ? answer : undefined;
}
