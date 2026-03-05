import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NormalizedLinearIssue } from "../../../shared/types";
import { createLinearTemplateService } from "./linearTemplateService";

const issueFixture: NormalizedLinearIssue = {
  id: "issue-1",
  identifier: "ABC-12",
  title: "Fix auth token refresh",
  description: "Refresh token flow fails when access token is expired.",
  url: "https://linear.app/acme/issue/ABC-12",
  projectId: "proj-1",
  projectSlug: "acme-platform",
  teamId: "team-1",
  teamKey: "ACME",
  stateId: "state-1",
  stateName: "Todo",
  stateType: "unstarted",
  priority: 2,
  priorityLabel: "high",
  labels: ["bug", "auth"],
  assigneeId: null,
  assigneeName: null,
  ownerId: "user-1",
  blockerIssueIds: [],
  hasOpenBlockers: false,
  createdAt: "2026-03-05T00:00:00.000Z",
  updatedAt: "2026-03-05T00:00:00.000Z",
  raw: {},
};

describe("linearTemplateService", () => {
  it("renders placeholders from template yaml", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-template-"));
    const templatesDir = path.join(root, ".ade", "templates");
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.writeFileSync(
      path.join(templatesDir, "bug.yaml"),
      [
        "id: bug-fix",
        "name: Bug Fix",
        "promptTemplate: |-",
        "  Issue {{ issue.identifier }}",
        "  Worker {{ worker.name }}",
        "  Reason {{ route.reason }}",
      ].join("\n"),
      "utf8"
    );

    const service = createLinearTemplateService({ adeDir: path.join(root, ".ade") });
    const rendered = service.renderTemplate({
      templateId: "bug-fix",
      issue: issueFixture,
      route: { reason: "Matched bug rule" },
      worker: { name: "Backend Dev" },
    });

    expect(rendered.templateId).toBe("bug-fix");
    expect(rendered.prompt).toContain("Issue ABC-12");
    expect(rendered.prompt).toContain("Worker Backend Dev");
    expect(rendered.prompt).toContain("Reason Matched bug rule");
  });

  it("falls back to default template when no template files exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-linear-template-empty-"));
    const service = createLinearTemplateService({ adeDir: path.join(root, ".ade") });

    const rendered = service.renderTemplate({
      templateId: "missing-template",
      issue: issueFixture,
    });

    expect(rendered.templateId).toBe("default");
    expect(rendered.prompt).toContain("Handle the following Linear issue end to end.");
    expect(rendered.prompt).toContain("ABC-12");
  });
});
