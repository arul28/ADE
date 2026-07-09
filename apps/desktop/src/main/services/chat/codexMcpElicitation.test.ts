import { describe, expect, it } from "vitest";
import {
  mcpElicitationAllowsAlways,
  mcpElicitationContent,
  mcpElicitationQuestions,
} from "./codexMcpElicitation";

describe("Codex MCP elicitation mapping", () => {
  it("recognizes persistent approval metadata", () => {
    expect(mcpElicitationAllowsAlways({ persist: "always" })).toBe(true);
    expect(mcpElicitationAllowsAlways({ persist: ["session", "always"] })).toBe(true);
    expect(mcpElicitationAllowsAlways({ persist: "session" })).toBe(false);
  });

  it("maps titled and multi-select enum schemas to native questions", () => {
    const questions = mcpElicitationQuestions({
      type: "object",
      required: ["app"],
      properties: {
        app: {
          type: "string",
          title: "Application",
          oneOf: [
            { const: "calculator", title: "Calculator" },
            { const: "notes", title: "Notes" },
          ],
        },
        scopes: {
          type: "array",
          title: "Scopes",
          items: { type: "string", enum: ["read", "write"] },
        },
      },
    });

    expect(questions).toMatchObject([
      {
        id: "app",
        impact: "Required",
        options: [
          { label: "Calculator", value: "calculator" },
          { label: "Notes", value: "notes" },
        ],
      },
      {
        id: "scopes",
        multiSelect: true,
        options: [
          { label: "read", value: "read" },
          { label: "write", value: "write" },
        ],
      },
    ]);
  });

  it("returns schema-shaped primitive, array, and JSON values", () => {
    const schema = {
      type: "object",
      properties: {
        enabled: { type: "boolean" },
        count: { type: "integer" },
        scopes: { type: "array", items: { type: "string" } },
        settings: { type: "object" },
      },
    };
    expect(mcpElicitationContent(schema, {
      enabled: "true",
      count: "3",
      scopes: ["read", "write"],
      settings: "{\"safe\":true}",
    }, null)).toEqual({
      enabled: true,
      count: 3,
      scopes: ["read", "write"],
      settings: { safe: true },
    });
  });
});
