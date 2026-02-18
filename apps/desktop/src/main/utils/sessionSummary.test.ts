import { describe, expect, it } from "vitest";
import { summarizeTerminalSession } from "./sessionSummary";

describe("summarizeTerminalSession", () => {
  it("summarizes passing tests", () => {
    const transcript = [
      "$ npm test",
      " RUN  v1.0.0",
      " Tests  2 passed (2)",
      " Duration 72ms"
    ].join("\n");

    const summary = summarizeTerminalSession({ title: "Shell", exitCode: 0, transcript });
    expect(summary).toContain("PASS");
    expect(summary).toContain("2 tests");
    expect(summary).toContain("72ms");
  });

  it("summarizes failures with a useful hint", () => {
    const transcript = [
      "$ npm install",
      "npm ERR! code EACCES",
      "npm ERR! Error: EACCES: permission denied, open '/usr/local/lib/node_modules'",
    ].join("\n");

    const summary = summarizeTerminalSession({ title: "Shell", exitCode: 1, transcript });
    expect(summary).toContain("FAIL");
    expect(summary).toContain("exit code 1");
    expect(summary).toMatch(/EACCES/i);
  });

  it("does not mis-detect npm script headers as a prompt command", () => {
    const transcript = [
      "> mypkg@1.0.0 test",
      " RUN  v1.0.0",
      " Tests  2 passed (2)",
      " Duration 72ms"
    ].join("\n");

    const summary = summarizeTerminalSession({ title: "Shell", exitCode: 0, transcript });
    expect(summary).toContain("PASS");
    expect(summary).not.toMatch(/mypkg@1\.0\.0/i);
    expect(summary).toMatch(/npm run test|Ran/i);
  });

  it("parses scoped npm script headers", () => {
    const transcript = [
      "> @acme/pkg@1.0.0 test",
      " Tests  2 passed (2)",
      " Duration 72ms"
    ].join("\n");

    const summary = summarizeTerminalSession({ title: "Shell", exitCode: 0, transcript });
    expect(summary).toContain("npm run test");
    expect(summary).not.toMatch(/@acme\/pkg@1\.0\.0/i);
  });
});
