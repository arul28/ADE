import type { OpenCodeClient } from "@opencode/client";
import type {
  OpenCodeProviderAuthMethod,
  OpenCodeProviderAuthMethods,
} from "../../../shared/types/config";
import { openCodeFormAnswer, openCodeFormPrompt, type OpenCodeFormAnswer } from "./openCodeForms";

/**
 * OpenCode 2.0 integrations in the auth-method shape ADE's settings already
 * render: an OAuth method becomes `oauth` with prompts from its form, a key
 * method becomes `api`. Environment and command methods have no ADE flow and
 * are left out. The renderer addresses a method by its index in this list, so
 * the mapping is deterministic for a given integration.
 */

export type OpenCodeIntegrationInfo = Awaited<ReturnType<OpenCodeClient["integration"]["list"]>>["data"][number];
type IntegrationMethod = OpenCodeIntegrationInfo["methods"][number];

export type MappedOpenCodeAuthMethod = {
  method: OpenCodeProviderAuthMethod;
  source: IntegrationMethod;
};

export function mapOpenCodeIntegrationAuthMethods(integration: OpenCodeIntegrationInfo): MappedOpenCodeAuthMethod[] {
  const out: MappedOpenCodeAuthMethod[] = [];
  for (const source of integration.methods) {
    if (source.type === "oauth") {
      const prompts = (source.form ?? []).flatMap((field) => {
        const prompt = openCodeFormPrompt(field);
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
export function openCodeMethodFormAnswer(
  source: IntegrationMethod,
  inputs: Record<string, string> | undefined,
): OpenCodeFormAnswer | undefined {
  if (!inputs || (source.type !== "oauth" && source.type !== "key")) return undefined;
  const answer = openCodeFormAnswer(source.form ?? [], (key) => {
    const raw = inputs[key];
    return raw === undefined || raw === "" ? [] : [raw];
  });
  return Object.keys(answer).length ? answer : undefined;
}
