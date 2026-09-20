import { describe, expect, it } from "vitest";
import { formatProxyStatus } from "./proxy";

describe("formatProxyStatus", () => {
  it("shows safe proxy state and subscription logins", () => {
    expect(formatProxyStatus({
      installed: true,
      running: true,
      port: 43123,
      version: "7.3.7",
      logins: [{
        loginId: "claude-login",
        provider: "claude",
        email: "user@example.test",
        plan: "pro",
        prefix: "sub-ab12cd34",
        disabled: false,
      }],
    })).toBe([
      "ADE subscription proxy",
      "installed: yes",
      "running: yes",
      "port: 43123",
      "version: 7.3.7",
      "logins: 1",
      "  claude · user@example.test · pro · sub-ab12cd34 · enabled · claude-login",
    ].join("\n"));
  });

  it("does not invent a login row when the proxy is not running", () => {
    expect(formatProxyStatus({
      installed: false,
      running: false,
      port: null,
      version: null,
      logins: [],
    })).toContain("logins: 0");
  });
});
