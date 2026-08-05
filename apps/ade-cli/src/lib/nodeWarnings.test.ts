import { describe, expect, it } from "vitest";
import { isSuppressedNodeWarning } from "./nodeWarnings";

describe("isSuppressedNodeWarning", () => {
  it("suppresses the node:sqlite experimental notice users saw on every command", () => {
    expect(
      isSuppressedNodeWarning(
        "SQLite is an experimental feature and might change at any time",
        ["ExperimentalWarning"],
      ),
    ).toBe(true);
  });

  it("reads the type from the options-object call form", () => {
    expect(
      isSuppressedNodeWarning("SQLite is an experimental feature", [
        { type: "ExperimentalWarning" },
      ]),
    ).toBe(true);
  });

  it("reads the type from an Error's name", () => {
    const warning = new Error("SQLite is an experimental feature");
    warning.name = "ExperimentalWarning";
    expect(isSuppressedNodeWarning(warning)).toBe(true);
  });

  it("keeps other experimental warnings -- only SQLite is known noise", () => {
    expect(
      isSuppressedNodeWarning("Fetch API is an experimental feature", [
        "ExperimentalWarning",
      ]),
    ).toBe(false);
  });

  it("keeps deprecations and every other warning class", () => {
    expect(
      isSuppressedNodeWarning("SQLite thing is deprecated", [
        "DeprecationWarning",
      ]),
    ).toBe(false);
    expect(isSuppressedNodeWarning("something broke")).toBe(false);
  });
});
