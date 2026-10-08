import { parse as parseYaml } from "yaml";

/**
 * GitHub issue templates, read from `.github/ISSUE_TEMPLATE`, and the issue
 * body an issue form produces.
 *
 * Two kinds exist. A markdown template (`*.md`) has YAML front matter (name,
 * about, title, labels, assignees) and a markdown body that pre-fills the
 * issue. An issue form (`*.yml` / `*.yaml`) describes fields; GitHub turns the
 * answers into a markdown body of `### Label` sections, and this module does
 * the same so an issue made in ADE reads like one made on github.com.
 *
 * Pure: the GitHub services fetch the files, the create form renders them.
 */

export type GitHubIssueFormField =
  | { type: "markdown"; id: string | null; value: string }
  | {
    type: "input" | "textarea";
    id: string | null;
    label: string;
    description: string | null;
    placeholder: string | null;
    value: string | null;
    /** A textarea's `render` language: the answer goes in a code fence. */
    render: string | null;
    required: boolean;
  }
  | {
    type: "dropdown";
    id: string | null;
    label: string;
    description: string | null;
    options: string[];
    multiple: boolean;
    defaultIndex: number | null;
    required: boolean;
  }
  | {
    type: "checkboxes";
    id: string | null;
    label: string;
    description: string | null;
    options: Array<{ label: string; required: boolean }>;
  };

export type GitHubIssueTemplate = {
  /** The file name, unique in the folder. */
  key: string;
  kind: "markdown" | "form";
  name: string;
  about: string | null;
  title: string | null;
  labels: string[];
  assignees: string[];
  /** An issue type name (org repositories), when the template sets one. */
  type: string | null;
  /** A markdown template's body. */
  body: string | null;
  /** An issue form's fields. */
  fields: GitHubIssueFormField[];
};

export type GitHubIssueTemplateSet = {
  templates: GitHubIssueTemplate[];
  /** `config.yml` `blank_issues_enabled`; GitHub's default is true. */
  blankIssuesEnabled: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** GitHub accepts a list or a comma-separated string for labels and assignees. */
function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(text).filter((entry): entry is string => Boolean(entry?.trim())).map((entry) => entry.trim());
  const single = text(value);
  return single ? single.split(",").map((entry) => entry.trim()).filter(Boolean) : [];
}

function parseYamlSafe(source: string): unknown {
  try {
    return parseYaml(source);
  } catch {
    return null;
  }
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseGitHubIssueTemplate(fileName: string, source: string): GitHubIssueTemplate | null {
  const lower = fileName.toLowerCase();
  if (lower === "config.yml" || lower === "config.yaml") return null;
  if (lower.endsWith(".md")) {
    const match = FRONT_MATTER.exec(source);
    const meta = record(match ? parseYamlSafe(match[1]!) : null) ?? {};
    return {
      key: fileName,
      kind: "markdown",
      name: text(meta.name)?.trim() || fileName.replace(/\.md$/i, ""),
      about: text(meta.about)?.trim() || null,
      title: text(meta.title) ?? null,
      labels: list(meta.labels),
      assignees: list(meta.assignees),
      type: text(meta.type)?.trim() || null,
      body: (match ? match[2] : source) ?? "",
      fields: [],
    };
  }
  if (!lower.endsWith(".yml") && !lower.endsWith(".yaml")) return null;
  const form = record(parseYamlSafe(source));
  if (!form || !Array.isArray(form.body)) return null;
  const fields: GitHubIssueFormField[] = [];
  for (const entry of form.body) {
    const field = record(entry);
    if (!field) continue;
    const attributes = record(field.attributes) ?? {};
    const required = record(field.validations)?.required === true;
    const id = text(field.id);
    const label = text(attributes.label)?.trim() ?? "";
    const description = text(attributes.description) ?? null;
    switch (field.type) {
      case "markdown":
        fields.push({ type: "markdown", id, value: text(attributes.value) ?? "" });
        break;
      case "input":
      case "textarea":
        if (!label) break;
        fields.push({
          type: field.type,
          id,
          label,
          description,
          placeholder: text(attributes.placeholder) ?? null,
          value: text(attributes.value) ?? null,
          render: field.type === "textarea" ? text(attributes.render) ?? null : null,
          required,
        });
        break;
      case "dropdown": {
        const options = list(attributes.options);
        if (!label || options.length === 0) break;
        const defaultIndex = typeof attributes.default === "number" ? attributes.default : null;
        fields.push({ type: "dropdown", id, label, description, options, multiple: attributes.multiple === true, defaultIndex, required });
        break;
      }
      case "checkboxes": {
        const options = (Array.isArray(attributes.options) ? attributes.options : [])
          .map((option) => record(option))
          .filter((option): option is Record<string, unknown> => option != null && Boolean(text(option.label)))
          .map((option) => ({ label: text(option.label)!, required: record(option.validations)?.required === true || option.required === true }));
        if (!label || options.length === 0) break;
        fields.push({ type: "checkboxes", id, label, description, options });
        break;
      }
      default:
        break;
    }
  }
  return {
    key: fileName,
    kind: "form",
    name: text(form.name)?.trim() || fileName.replace(/\.ya?ml$/i, ""),
    about: text(form.description)?.trim() || null,
    title: text(form.title) ?? null,
    labels: list(form.labels),
    assignees: list(form.assignees),
    type: text(form.type)?.trim() || null,
    body: null,
    fields,
  };
}

export function parseGitHubIssueTemplateConfig(source: string | null): { blankIssuesEnabled: boolean } {
  const config = record(source ? parseYamlSafe(source) : null);
  return { blankIssuesEnabled: config?.blank_issues_enabled !== false };
}

/** One answer per field, keyed by the field's index in `fields`. */
export type GitHubIssueFormAnswers = Record<number, string | string[] | boolean[]>;

/** A required field left empty, by its label, or null when the form can be sent. */
export function missingRequiredGitHubFormField(template: GitHubIssueTemplate, answers: GitHubIssueFormAnswers): string | null {
  for (const [index, field] of template.fields.entries()) {
    const answer = answers[index];
    if (field.type === "input" || field.type === "textarea" || field.type === "dropdown") {
      if (!field.required) continue;
      const empty = Array.isArray(answer) ? answer.length === 0 : !String(answer ?? "").trim();
      if (empty) return field.label;
    } else if (field.type === "checkboxes") {
      const checked = Array.isArray(answer) ? answer as boolean[] : [];
      const missing = field.options.find((option, optionIndex) => option.required && !checked[optionIndex]);
      if (missing) return missing.label;
    }
  }
  return null;
}

/** The markdown body GitHub builds from a form: `### Label`, then the answer. */
export function serializeGitHubIssueForm(template: GitHubIssueTemplate, answers: GitHubIssueFormAnswers): string {
  const sections: string[] = [];
  for (const [index, field] of template.fields.entries()) {
    if (field.type === "markdown") continue;
    const answer = answers[index];
    let value: string;
    if (field.type === "checkboxes") {
      const checked = Array.isArray(answer) ? answer as boolean[] : [];
      value = field.options.map((option, optionIndex) => `- [${checked[optionIndex] ? "X" : " "}] ${option.label}`).join("\n");
    } else if (field.type === "dropdown") {
      const chosen = Array.isArray(answer) ? answer as string[] : answer ? [String(answer)] : [];
      value = chosen.length > 0 ? chosen.join(", ") : "_No response_";
    } else {
      const raw = String(answer ?? "").trim();
      value = !raw
        ? "_No response_"
        : field.type === "textarea" && field.render
          ? `\`\`\`${field.render}\n${raw}\n\`\`\``
          : raw;
    }
    sections.push(`### ${field.label}\n\n${value}`);
  }
  return sections.join("\n\n");
}
