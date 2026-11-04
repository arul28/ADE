/* @vitest-environment jsdom */
import { createServer, type Server } from "node:http";
import { gunzipSync } from "node:zlib";
import { act, render } from "@testing-library/react";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Banner } from "../components/ui/notice/Banner";
import { ToastCard } from "../components/ui/notice/ToastCard";
import { rootAppStoreApi } from "../state/appStore";
import { startSessionReplay } from "./sessionReplay";

// The real posthog-js and rrweb record the page and post to a stand-in
// PostHog; the test reads what would have left the machine.
const uploads: string[] = [];
let server: Server;
let port = 0;

/** posthog-js compresses each event's data as a gzip string; open them all. */
function inflate(value: unknown): unknown {
  if (typeof value === "string" && value.charCodeAt(0) === 0x1f && value.charCodeAt(1) === 0x8b) {
    const text = gunzipSync(Buffer.from(value, "latin1")).toString("utf8");
    try {
      return inflate(JSON.parse(text));
    } catch {
      return text;
    }
  }
  if (Array.isArray(value)) return value.map(inflate);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, inflate(entry)]));
  }
  return value;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/s")) {
        uploads.push(JSON.stringify(inflate(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
        res.end("{}");
        return;
      }
      res.end(req.url?.includes("/config") ? JSON.stringify({ sessionRecording: { endpoint: "/s/" } }) : "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server.close();
});

it("a recording shows ADE's words and none of the person's content", async () => {
  // jsdom quirks, not ADE behaviour: posthog-js skips bot user agents and
  // hidden pages, and Node's fetch rejects jsdom's AbortSignal.
  Object.defineProperty(window.navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh) Chrome/140.0.0.0 Electron/38.0.0", configurable: true });
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  const nodeFetch = globalThis.fetch;
  window.fetch = globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nodeFetch(input, { ...init, signal: undefined })) as typeof fetch;
  window.ade = {
    analytics: { getReplayConfig: async () => ({ projectToken: "phc_test", apiHost: `http://127.0.0.1:${port}`, distinctId: "install-1" }) },
  } as unknown as typeof window.ade;
  rootAppStoreApi.setState({
    lanes: [{ id: "lane-1", name: "zebra-lane", branchRef: "refs/heads/zebra-branch" }] as never,
    project: { rootPath: "/Users/alice/code/okapi-repo", displayName: "okapi-repo", baseRef: "main" },
  });

  render(
    <div>
      <Banner
        layout="inline"
        model={{
          id: "brain",
          tone: "error",
          title: "ADE could not start the brain",
          detail: "Failed reading /Users/alice/code/okapi-repo/.ade/db.sqlite for alice@example.com with ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          report: false,
        }}
      />
      <Banner layout="inline" model={{ id: "rebase", tone: "warning", title: "Rebase stopped on zebra-lane", detail: "zebra-branch conflicts in src/giraffe.ts" }} />
      <ToastCard model={{ tone: "success", title: "Fix the pelican parser", message: "Lane created", replayMask: { title: true }, chips: [{ label: "walrus-chip" }] }} />
      <p>Please refactor the narwhal module</p>
      <textarea defaultValue="composer draft about the iguana" />
    </div>,
  );

  startSessionReplay();
  // Nothing uploads until the person interacts with the page.
  await vi.waitFor(() => {
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 4, clientY: 4 }));
    expect(uploads.join("")).toContain("\"type\":2");
  }, { timeout: 15_000, interval: 250 });
  await act(async () => {});

  const sent = uploads.join("\n");
  for (const visible of ["ADE could not start the brain", "Failed reading [path] for [email] with [redacted]", "Lane created"]) {
    expect(sent).toContain(visible);
  }
  for (const secret of ["alice", "okapi", "ghp_", "zebra", "giraffe", "pelican", "walrus", "narwhal", "iguana"]) {
    expect(sent).not.toContain(secret);
  }
}, 30_000);
