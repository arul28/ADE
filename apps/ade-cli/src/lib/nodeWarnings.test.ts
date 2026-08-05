import { describe, expect, it } from "vitest";
import {
  installNodeWarningFilter,
  isSuppressedNodeWarning,
  resetNodeWarningFilterForTests,
} from "./nodeWarnings";

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

describe("resetNodeWarningFilterForTests", () => {
  it("puts the original emitter back so a second install cannot double-wrap", () => {
    // The module self-installs on import, so the first reset is what gets this
    // process back to Node's own emitter.
    resetNodeWarningFilterForTests();
    const unwrapped = process.emitWarning;

    installNodeWarningFilter({});
    expect(process.emitWarning).not.toBe(unwrapped);

    resetNodeWarningFilterForTests();
    expect(process.emitWarning).toBe(unwrapped);
  });
});
