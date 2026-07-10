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

  it.each([
    ["integer", ["1", "not-an-integer"], [1, "not-an-integer"]],
    ["number", ["1.25", "not-a-number"], [1.25, "not-a-number"]],
    ["boolean", ["true", "false"], [true, false]],
    ["string", ["01", "true"], ["01", "true"]],
  ])("coerces %s MCP array answers through the item schema", (itemType, raw, expected) => {
    const schema = {
      type: "object",
      properties: {
        values: { type: "array", items: { type: itemType } },
      },
    };

    expect(mcpElicitationContent(schema, { values: raw }, null)).toEqual({ values: expected });
  });

  it("keeps a single selected MCP array answer array-shaped", () => {
    const schema = {
      type: "object",
      properties: {
        values: { type: "array", items: { type: "integer" } },
      },
    };

    expect(mcpElicitationContent(schema, { values: "2" }, null)).toEqual({ values: [2] });
  });
});
