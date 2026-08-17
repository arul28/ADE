import { describe, expect, it } from "vitest";
import {
  buildDiagnosticIssueUrl,
  buildDiagnosticReport,
  projectPathLabel,
  redactDiagnosticText,
  tailLogText,
} from "./diagnosticReport";

const CONTEXT = {
  homeDir: "/Users/ada",
  username: "ada",
  hostname: "adas-macbook-pro.local",
  projectRoots: ["/Users/ada/Projects/Photon"],
};

describe("redactDiagnosticText", () => {
  it("collapses every spelling of the home directory", () => {
    const input = [
      "/Users/ada/.ade/runtime/brain.jsonl",
      "C:\\Users\\ada\\AppData\\Roaming\\ADE",
      "C:\\\\Users\\\\ada\\\\AppData",
      "file:///Users/ada/Library/Logs",
      "%2FUsers%2Fada%2FDownloads",
      "/home/ada/.ade",
    ].join("\n");

    const out = redactDiagnosticText(input, CONTEXT);

    expect(out).not.toMatch(/ada/i);
    expect(out).toContain("~/.ade/runtime/brain.jsonl");
    expect(out).toContain("~\\AppData\\Roaming\\ADE");
    expect(out).toContain("~/Library/Logs");
  });

  it("labels the project by name and hash instead of its path", () => {
    const out = redactDiagnosticText(
      "opening /Users/ada/Projects/Photon/.ade/ade.db",
      CONTEXT,
    );
    const label = projectPathLabel("/Users/ada/Projects/Photon");

    expect(out).toBe(`opening ${label}/.ade/ade.db`);
    expect(label).toMatch(/^<project:Photon#[0-9a-f]{6}>$/);
    // Same project, same label: two reports about one project correlate.
    expect(projectPathLabel("/Users/ada/Projects/Photon")).toBe(label);
    expect(projectPathLabel("/Users/bob/Projects/Photon")).not.toBe(label);
  });

  it("removes emails and every credential shape we have seen in logs", () => {
    // Assembled from its segments at runtime so secret scanners do not flag
    // this synthetic credential as a real leaked JWT.
    const jwtFixture = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxIn0", "abcdefghijklmnop"].join(".");
    const input = [
      "signed in as ada.lovelace+ade@example.com",
      "authorization: Bearer sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF",
      `token=${jwtFixture}`,
      "github token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      "posthog phc_ABCDEFGHIJKLMNOPQRSTUVWXYZ01",
      "GET /pair?token=8e1f2a3b4c5d6e7f&mode=relay",
      'cookie: "0123456789abcdef0123456789abcdef0123"',
      "https://ada:hunter2@relay.example.com/v1",
    ].join("\n");

    const out = redactDiagnosticText(input, CONTEXT);

    expect(out).not.toContain("example.com/v1".replace("/v1", "")); // userinfo host is fine, creds are not
    expect(out).not.toMatch(/hunter2|ghp_ABCDEF|phc_ABCDEF|eyJhbGciOiJ/);
    expect(out).not.toMatch(/sk-ant-api03/);
    expect(out).not.toContain("8e1f2a3b4c5d6e7f");
    expect(out).not.toContain("0123456789abcdef0123456789abcdef0123");
    expect(out).toContain("<email>");
    expect(out).toContain("<jwt>");
    expect(out).toContain("<token>");
    expect(out).toContain("<redacted>");
    // Structure survives: a maintainer can still tell which line was which.
    expect(out).toContain("github token");
    expect(out).toContain("mode=relay");
  });

  it("keeps loopback addresses and drops routable ones", () => {
    const input = [
      "brain answering on 127.0.0.1:8787",
      "peer 192.168.1.44 connected",
      "relay 2606:4700:4700::1111 handshake",
      "local ::1 ok",
      "chrome 140.0.7339.207",
      "at 2026-08-16T09:30:00.123Z",
    ].join("\n");

    const out = redactDiagnosticText(input, CONTEXT);

    expect(out).toContain("127.0.0.1:8787");
    expect(out).toContain("::1 ok");
    expect(out).not.toContain("192.168.1.44");
    expect(out).not.toContain("2606:4700");
    expect(out).toContain("<ip>");
    // A four-part version is not an address, and a timestamp is not IPv6.
    expect(out).toContain("chrome 140.0.7339.207");
    expect(out).toContain("2026-08-16T09:30:00.123Z");
  });

  it("removes this machine's name and any tailnet name", () => {
    const out = redactDiagnosticText(
      "adas-macbook-pro.local reached mini-desktop.tailnet-cafe.ts.net",
      CONTEXT,
    );

    expect(out).not.toContain("adas-macbook-pro");
    expect(out).not.toContain("ts.net");
    expect(out).toContain("<host>");
    expect(out).toContain("<tailnet-host>");
  });

  it("is idempotent, so re-redacting a stored report changes nothing", () => {
    const input = [
      "/Users/ada/Projects/Photon/.ade/ade.db",
      "ada@example.com Bearer sk-live-AAAABBBBCCCCDDDD",
      "peer 10.0.0.7 via adas-macbook-pro.local",
    ].join("\n");

    const once = redactDiagnosticText(input, CONTEXT);
    expect(redactDiagnosticText(once, CONTEXT)).toBe(once);
  });
});

describe("tailLogText", () => {
  it("keeps the newest lines within both caps", () => {
    const lines = Array.from({ length: 500 }, (_, index) => `line-${index}`);
    const out = tailLogText(lines.join("\n"), { maxLines: 5, maxBytes: 32 * 1024 });

    expect(out.split("\n")).toEqual(["line-495", "line-496", "line-497", "line-498", "line-499"]);
  });

  it("honours the byte cap even when the line cap allows more", () => {
    const lines = Array.from({ length: 40 }, () => "x".repeat(100));
    const out = tailLogText(lines.join("\n"), { maxLines: 40, maxBytes: 250 });

    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(250);
  });
});

describe("buildDiagnosticReport", () => {
  function build() {
    return buildDiagnosticReport({
      generatedAt: "2026-08-16T09:30:00.000Z",
      app: {
        version: "1.2.61",
        packageChannel: "stable",
        isPackaged: true,
        platform: "darwin",
        arch: "arm64",
        osRelease: "25.3.0",
        osProductVersion: "26.1",
        electronVersion: "38.0.0",
        nodeVersion: "22.14.0",
        chromeVersion: "140.0.7339.207",
        timezoneOffsetMinutes: -420,
      },
      identity: {
        installId: "ade_0123456789abcdef0123456789abcdef",
        accountHash: "a1b2c3d4e5f6",
      },
      context: {
        surface: "project_recovery",
        headline: "ADE couldn't open this project",
        code: "db_integrity",
        technicalDetail: "sqlite disk image is malformed at /Users/ada/Projects/Photon/.ade/ade.db",
        projectRoot: "/Users/ada/Projects/Photon",
      },
      state: {
        localRuntimeStatus: { connectionState: "disconnected", runtimeMode: "primary", pid: 4321 },
        machineLastFailure: { code: "db_integrity", message: "cannot open /Users/ada/.ade/ade.db" },
      },
      storage: [{ label: "ADE home", path: "/Users/ada/.ade", freeBytes: 5 * 1024 ** 3, totalBytes: 500 * 1024 ** 3 }],
      logs: [
        {
          label: "Brain",
          path: "/Users/ada/.ade/runtime/brain.jsonl",
          text: '{"msg":"peer 192.168.1.9 for ada@example.com"}',
        },
        { label: "Desktop updates", path: "/Users/ada/Library/ade-update.jsonl", error: "(not present)" },
      ],
      notes: ["doctor: not run"],
      redaction: CONTEXT,
    });
  }

  it("includes every section a maintainer needs, keyed by the install id", () => {
    const report = build();

    for (const heading of [
      "# ADE diagnostic report",
      "## What happened",
      "## Install",
      "## Technical detail",
      "## Runtime status",
      "## Last failure (machine)",
      "## Disk space",
      "## Logs",
      "## Notes",
    ]) {
      expect(report).toContain(heading);
    }
    // The correlation key must survive redaction — it is the whole point.
    expect(report).toContain("ade_0123456789abcdef0123456789abcdef");
    expect(report).toContain("Install id (PostHog distinct_id)");
    expect(report).toContain("Account hash: a1b2c3d4e5f6");
    expect(report).toContain("1.2.61");
    expect(report).toContain("db_integrity");
    expect(report).toContain("5.0 GB free of 500.0 GB");
  });

  it("redacts the assembled document, not just the log lines", () => {
    const report = build();

    expect(report).not.toMatch(/\/Users\/ada/);
    expect(report).not.toContain("ada@example.com");
    expect(report).not.toContain("192.168.1.9");
    expect(report).not.toContain("adas-macbook-pro");
    expect(report).toContain(projectPathLabel("/Users/ada/Projects/Photon"));
    // Redaction already ran, so running it again is a no-op.
    expect(redactDiagnosticText(report, CONTEXT)).toBe(report);
  });
});

describe("redactDiagnosticText hostnames", () => {
  // Regression: the machine-name rule used to hand an already-assembled
  // pattern to a helper that escapes what it is given, so the word-boundary
  // lookarounds became literal text and no hostname was ever replaced.
  it("replaces a suffix-less hostname and its mixed-case spellings", () => {
    const context = { hostname: "ARUL-DESKTOP" };
    const input = [
      "bound socket on ARUL-DESKTOP",
      "peer arul-desktop refused the handover",
      "Arul-Desktop:7777",
    ].join("\n");

    const out = redactDiagnosticText(input, context);

    expect(out).not.toMatch(/arul-desktop/i);
    expect(out).toBe(["bound socket on <host>", "peer <host> refused the handover", "<host>:7777"].join("\n"));
  });

  it("replaces both the fqdn and its short form, longest first", () => {
    const out = redactDiagnosticText(
      "adas-macbook-pro.local and adas-macbook-pro both answered",
      { hostname: "adas-macbook-pro.local" },
    );

    expect(out).toBe("<host> and <host> both answered");
  });

  it("leaves an unrelated word that merely contains the hostname alone", () => {
    const out = redactDiagnosticText("superhostname-extra", { hostname: "hostname" });
    expect(out).toBe("superhostname-extra");
  });
});

describe("buildDiagnosticIssueUrl", () => {
  it("targets the ADE repo with a title and a compact stub body", () => {
    const url = buildDiagnosticIssueUrl({
      surface: "project_recovery",
      headline: "ADE couldn't open this project",
      code: "db_integrity",
      appVersion: "1.2.61",
      platform: "darwin",
      arch: "arm64",
      installId: "ade_0123456789abcdef0123456789abcdef",
    });
    const parsed = new URL(url);

    expect(parsed.origin + parsed.pathname).toBe("https://github.com/arul28/ADE/issues/new");
    expect(parsed.searchParams.get("title")).toBe("[report] ADE couldn't open this project (db_integrity)");
    expect(parsed.searchParams.get("body")).toContain("clipboard");
    expect(parsed.searchParams.get("body")).toContain("ade_0123456789abcdef0123456789abcdef");
    // Well under GitHub's URL ceiling: the full report rides the clipboard.
    expect(url.length).toBeLessThan(2_000);
  });

  // Regression: the headline is renderer-supplied (an update failure message
  // carries OS paths) and used to reach the issue title and stub body raw.
  it("redacts the caller-supplied headline in the title and the stub body", () => {
    const url = buildDiagnosticIssueUrl({
      surface: "auto_update",
      headline: "Update failed writing /Users/ada/Library/Application Support/ADE on adas-macbook-pro.local",
      code: "update_write_failed",
      appVersion: "1.2.61",
      platform: "darwin",
      arch: "arm64",
      installId: "ade_0123456789abcdef0123456789abcdef",
      redaction: CONTEXT,
    });
    const parsed = new URL(url);
    const title = parsed.searchParams.get("title") ?? "";
    const body = parsed.searchParams.get("body") ?? "";

    expect(title).not.toContain("/Users/ada");
    expect(title).not.toMatch(/adas-macbook-pro/i);
    expect(title).toContain("~/Library/Application Support/ADE");
    expect(title).toContain("<host>");
    expect(body).not.toContain("/Users/ada");
    // The URL itself is still a normal encoded URL, not a redacted string.
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/arul28/ADE/issues/new");
  });

  it("leaves the title untouched when no redaction context is supplied", () => {
    const url = buildDiagnosticIssueUrl({ surface: "cli", headline: "plain headline" });
    expect(new URL(url).searchParams.get("title")).toBe("[report] plain headline");
  });
});
