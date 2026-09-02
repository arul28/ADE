import { describe, expect, it } from "vitest";

import {
  firstStandalonePositionalIndex,
  firstStandalonePositionalWord,
  VALUE_CARRIER_FLAGS,
} from "./cliArgScan";

/**
 * The bug this file pins: a subcommand read as "the first token without a
 * dash" is a flag's VALUE whenever a value-carrying flag comes first, so
 * `ade review --repo runs launch` routed on the repository name and never read
 * `launch`.
 */
describe("the first standalone positional", () => {
  it("skips the value a flag carries", () => {
    expect(firstStandalonePositionalWord(["--repo", "runs", "launch"])).toBe("launch");
    expect(firstStandalonePositionalIndex(["--repo", "runs", "launch"])).toBe(2);
  });

  it("reads the word right after a --flag=value, which carries its own value", () => {
    expect(firstStandalonePositionalWord(["--repo=acme", "runs"])).toBe("runs");
  });

  it("does not skip the token after a boolean flag", () => {
    // `--json` carries nothing, so the word behind it is the subcommand.
    expect(VALUE_CARRIER_FLAGS.has("--json")).toBe(false);
    expect(firstStandalonePositionalWord(["--json", "runs"])).toBe("runs");
  });

  it("stops at the argument terminator", () => {
    expect(firstStandalonePositionalWord(["--", "runs"])).toBeNull();
    expect(firstStandalonePositionalIndex(["--", "runs"])).toBe(-1);
  });

  it("answers null for flags alone, and for nothing at all", () => {
    expect(firstStandalonePositionalWord(["--repo", "acme"])).toBeNull();
    expect(firstStandalonePositionalWord([])).toBeNull();
  });

  it("takes the first word when no flag precedes it", () => {
    expect(firstStandalonePositionalWord(["runs", "--repo", "acme"])).toBe("runs");
  });

  it("carries the repository flags, which the alias bug was reported against", () => {
    for (const flag of ["--repo", "--repo-name", "--repo-owner"]) {
      expect(VALUE_CARRIER_FLAGS.has(flag), flag).toBe(true);
    }
  });
});
