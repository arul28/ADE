import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { NormalizedLinearIssue } from "../../../shared/types";
import { isRecord, toOptionalString as asString } from "../shared/utils";

export type LinearMissionTemplate = {
  id: string;
  name: string;
  promptTemplate: string;
  defaultWorker?: string;
  phases?: string[];
  prStrategy?: string;
  budgetCents?: number;
};

export type RenderTemplateResult = {
  templateId: string;
  templateName: string;
  prompt: string;
  defaultWorker?: string;
  metadata: Record<string, unknown>;
};

const FALLBACK_TEMPLATE: LinearMissionTemplate = {
  id: "default",
  name: "Linear Intake",
  promptTemplate: [
    "Handle the following Linear issue end to end.",
    "",
    "Issue: {{ issue.identifier }} - {{ issue.title }}",
    "Project: {{ issue.projectSlug }}",
    "Priority: {{ issue.priorityLabel }}",
    "State: {{ issue.stateName }}",
    "",
    "Description:",
    "{{ issue.description }}",
    "",
    "Deliver implementation, tests, and clear completion notes.",
  ].join("\n"),
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function slugFromFilename(fileName: string): string {
  return fileName
    .replace(/\.(ya?ml)$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "template";
}

function parseTemplateFile(filePath: string): LinearMissionTemplate | null {
  let parsed: unknown = null;
  try {
    parsed = YAML.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const promptTemplate = asString(parsed.promptTemplate);
  if (!promptTemplate) return null;

  const fileName = path.basename(filePath);
  const id = asString(parsed.id) ?? slugFromFilename(fileName);
  const name = asString(parsed.name) ?? id;

  const budgetCentsRaw = Number(parsed.budgetCents);
  const budgetCents = Number.isFinite(budgetCentsRaw) ? Math.max(0, Math.floor(budgetCentsRaw)) : undefined;

  const defaultWorker = asString(parsed.defaultWorker);
  const prStrategy = asString(parsed.prStrategy);
  const phases = asStringArray(parsed.phases);

  return {
    id,
    name,
    promptTemplate,
    ...(defaultWorker ? { defaultWorker } : {}),
    ...(prStrategy ? { prStrategy } : {}),
    ...(phases.length ? { phases } : {}),
    ...(budgetCents != null ? { budgetCents } : {}),
  };
}

function getPathValue(source: Record<string, unknown>, dottedPath: string): unknown {
  const segments = dottedPath
    .split(".")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  let cursor: unknown = source;
  for (const segment of segments) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[segment];
  }
  return cursor;
}

function renderTemplateString(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath) => {
    const value = getPathValue(values, String(rawPath));
    if (value == null) return "";
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map((entry) => String(entry)).join(", ");
    }
    return JSON.stringify(value);
  });
}

export function createLinearTemplateService(args: { adeDir: string }) {
  const templatesDir = path.join(args.adeDir, "templates");

  const listTemplates = (): LinearMissionTemplate[] => {
    if (!fs.existsSync(templatesDir)) return [FALLBACK_TEMPLATE];

    const templates = fs
      .readdirSync(templatesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => parseTemplateFile(path.join(templatesDir, entry.name)))
      .filter((entry): entry is LinearMissionTemplate => entry != null)
      .sort((a, b) => a.name.localeCompare(b.name));

    const hasFallback = templates.some((entry) => entry.id === FALLBACK_TEMPLATE.id);
    if (!hasFallback) templates.unshift(FALLBACK_TEMPLATE);
    return templates;
  };

  const getTemplate = (templateId: string | null | undefined): LinearMissionTemplate => {
    const all = listTemplates();
    const key = String(templateId ?? "").trim().toLowerCase();
    if (!key.length) return all[0] ?? FALLBACK_TEMPLATE;
    return all.find((entry) => entry.id.toLowerCase() === key) ?? all[0] ?? FALLBACK_TEMPLATE;
  };

  const renderTemplate = (argsIn: {
    templateId?: string | null;
    issue: NormalizedLinearIssue;
    route?: Record<string, unknown>;
    worker?: Record<string, unknown>;
  }): RenderTemplateResult => {
    const template = getTemplate(argsIn.templateId);
    const values: Record<string, unknown> = {
      issue: argsIn.issue,
      route: argsIn.route ?? {},
      worker: argsIn.worker ?? {},
    };
    const prompt = renderTemplateString(template.promptTemplate, values).trim();
    return {
      templateId: template.id,
      templateName: template.name,
      prompt: prompt.length ? prompt : FALLBACK_TEMPLATE.promptTemplate,
      ...(template.defaultWorker ? { defaultWorker: template.defaultWorker } : {}),
      metadata: {
        templateId: template.id,
        templateName: template.name,
        ...(template.prStrategy ? { prStrategy: template.prStrategy } : {}),
        ...(template.phases ? { phases: template.phases } : {}),
        ...(template.budgetCents != null ? { budgetCents: template.budgetCents } : {}),
      },
    };
  };

  return {
    templatesDir,
    listTemplates,
    getTemplate,
    renderTemplate,
  };
}

export type LinearTemplateService = ReturnType<typeof createLinearTemplateService>;
