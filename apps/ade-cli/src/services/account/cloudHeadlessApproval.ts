/**
 * Approves a one-time sign-in link (`/device/approve`, or a server launch's
 * join) on a machine with nobody at it: the computer of a server launch
 * joining its account (`cloudBootLaunch.ts`), and a cloud machine approving
 * the sign-in of a machine it made itself (cloudBrainMaker.ts decides when).
 * One implementation for both; it lives in the CLI so a brain with no desktop
 * code path still has it.
 *
 * The link is a Clerk sign-in ticket on Clerk's hosted page
 * (`accounts.…/sign-in?__clerk_ticket=…&redirect_url=<oauth authorize>`).
 * From a datacenter address that page is behind a Cloudflare bot check
 * ("Just a moment…", Turnstile) that a headless browser often can't pass in
 * time, and the join then fell back to a person. So the link is first
 * completed without a browser (`approveSignInLinkDirectly`): the same ticket
 * sign-in through Clerk's Frontend API, which answers these computers, then
 * the authorize step with that session, then the account service's
 * `/device/callback`. A headless Chromium is the fallback, only while the
 * ticket is unused.
 *
 * It never types or clicks. A page that stops on something a person has to
 * confirm ends it as `closed`, and the caller falls back to the sign-in link
 * for the person.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

/** How the approval ended; the same values as the desktop's window (`CloudApprovalWindowResult`). */
export type HeadlessApprovalResult = "signed_in" | "closed" | "timed_out" | "cancelled";

type Logger = {
  info?(event: string, meta?: Record<string, unknown>): void;
  warn?(event: string, meta?: Record<string, unknown>): void;
};

const POLL_MS = 1_000;
/** A whole approval takes a few seconds; this bounds a page that never ends. */
const HEADLESS_APPROVAL_TIMEOUT_MS = 2 * 60_000;
/** No page change for this long, and not done: the page waits on a person. */
const STALLED_PAGE_MS = 25_000;
const DEVTOOLS_WAIT_MS = 20_000;
const POLL_READ_TIMEOUT_MS = 5_000;

function chromiumCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const configured = env.ADE_HEADLESS_CHROMIUM?.trim();
  if (configured) return [configured];
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((root): root is string => Boolean(root));
    return roots.flatMap((root) => [
      path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(root, "Chromium", "Application", "chrome.exe"),
    ]);
  }
  return ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
}

/** The Chromium (or Chrome) this machine can run headless, or null. */
export function findHeadlessChromium(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of chromiumCandidates(platform, env)) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Not installed there.
    }
  }
  return null;
}

/**
 * The user agent a visible Chrome of the same version sends. Headless
 * Chromium names itself "HeadlessChrome", and the sign-in pages answer that
 * name with a bot challenge that only a person can pass.
 */
function visibleChromeUserAgent(platform: NodeJS.Platform, version: string): string {
  const system = platform === "darwin"
    ? "Macintosh; Intel Mac OS X 10_15_7"
    : platform === "win32"
      ? "Windows NT 10.0; Win64; x64"
      : "X11; Linux x86_64";
  return `Mozilla/5.0 (${system}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
}

const FALLBACK_CHROME_VERSION = "140.0.0.0";

async function readChromiumVersion(binary: string): Promise<string> {
  return await new Promise((resolve) => {
    const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let out = "";
    // A binary that never answers must not hold the approval.
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve(FALLBACK_CHROME_VERSION);
    }, DEVTOOLS_WAIT_MS);
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); resolve(FALLBACK_CHROME_VERSION); });
    child.on("close", () => { clearTimeout(timer); resolve(/(\d+\.\d+\.\d+\.\d+)/.exec(out)?.[1] ?? FALLBACK_CHROME_VERSION); });
  });
}

type DevtoolsTarget = { type?: string; url?: string; title?: string; webSocketDebuggerUrl?: string };

/**
 * Sends the tab to `url` over the DevTools protocol. Not `/json/new?<url>`:
 * that endpoint re-reads the query, which breaks the nested, encoded
 * `redirect_url` the one-time link carries, and the sign-in then ends on the
 * site's home page instead of the account service's callback.
 */
async function navigateTab(webSocketUrl: string, url: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => { socket.terminate(); resolve(false); }, DEVTOOLS_WAIT_MS);
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.close();
      resolve(ok);
    };
    socket.on("open", () => socket.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } })));
    socket.on("message", (data) => {
      try {
        const reply = JSON.parse(String(data)) as { id?: number; error?: unknown; result?: { errorText?: string } };
        if (reply.id === 1) done(!reply.error && !reply.result?.errorText);
      } catch {
        // Not the reply.
      }
    });
    socket.on("error", () => done(false));
  });
}

/**
 * Opens `url` in a throwaway headless Chromium profile and waits for the
 * account service's `/device/callback` page. `signed_in` when it says so;
 * `closed` when the page stopped on something only a person can do, failed,
 * or Chromium could not run; `timed_out` past the bound; `cancelled` on
 * `signal`.
 */
export async function approveInHeadlessChromium(args: {
  url: string;
  binary: string;
  signal: AbortSignal;
  logger?: Logger;
  platform?: NodeJS.Platform;
}): Promise<HeadlessApprovalResult> {
  const platform = args.platform ?? process.platform;
  const logger = args.logger ?? {};
  if (args.signal.aborted) return "cancelled";
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ade-sign-in-"));
  const version = await readChromiumVersion(args.binary);
  const child = spawn(args.binary, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-blink-features=AutomationControlled",
    // A container (the provider sandbox) has no user namespaces for Chromium's
    // own sandbox. The page is the account's sign-in, in a profile that is
    // deleted when this ends.
    ...(platform === "linux" ? ["--no-sandbox"] : []),
    `--user-data-dir=${profile}`,
    `--user-agent=${visibleChromeUserAgent(platform, version)}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    // Only DevTools on 127.0.0.1 from this machine talks to it.
    "--remote-allow-origins=http://127.0.0.1",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });

  const cleanup = () => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    // Chromium may still hold files for a moment; a leftover temp folder is harmless.
    setTimeout(() => fs.rm(profile, { recursive: true, force: true }, () => undefined), 2_000).unref?.();
  };

  try {
    const port = await new Promise<number | null>((resolve) => {
      let stderr = "";
      const timer = setTimeout(() => resolve(null), DEVTOOLS_WAIT_MS);
      const onStderr = (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr);
        if (match) {
          clearTimeout(timer);
          // Only the port was wanted: stop keeping Chromium's output.
          child.stderr.off("data", onStderr);
          child.stderr.resume();
          resolve(Number(match[1]));
        }
      };
      child.stderr.on("data", onStderr);
      child.on("error", () => { clearTimeout(timer); resolve(null); });
      child.on("exit", () => { clearTimeout(timer); resolve(null); });
    });
    if (!port) {
      logger.warn?.("cloud.headless_approval_no_browser", { binary: path.basename(args.binary) });
      return "closed";
    }
    const devtools = `http://127.0.0.1:${port}`;
    // Bounded like every other DevTools read: a server that never answers ends as `closed`.
    const tab = await fetch(`${devtools}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.any([args.signal, AbortSignal.timeout(DEVTOOLS_WAIT_MS)]) })
      .then((response) => (response.ok ? response.json() as Promise<DevtoolsTarget> : null))
      .catch(() => null);
    // Never the URL itself in a log: it carries a one-time sign-in ticket.
    if (!tab?.webSocketDebuggerUrl || !(await navigateTab(tab.webSocketDebuggerUrl, args.url))) {
      logger.warn?.("cloud.headless_approval_open_failed", { tab: Boolean(tab) });
      return "closed";
    }
    const startedAt = Date.now();
    let lastPage = "";
    let lastChangeAt = Date.now();
    for (;;) {
      if (args.signal.aborted) return "cancelled";
      if (Date.now() - startedAt > HEADLESS_APPROVAL_TIMEOUT_MS) return "timed_out";
      // Each read is bounded, so a DevTools server that stops answering can't hold the loop past its timeout.
      const targets = await fetch(`${devtools}/json/list`, { signal: AbortSignal.any([args.signal, AbortSignal.timeout(POLL_READ_TIMEOUT_MS)]) })
        .then((response) => response.json() as Promise<DevtoolsTarget[]>)
        .catch(() => [] as DevtoolsTarget[]);
      const page = targets.find((target) => target.type === "page" && target.url && target.url !== "about:blank");
      if (page?.url) {
        let host = "";
        let pathname = "";
        try {
          const parsed = new URL(page.url);
          host = parsed.host;
          pathname = parsed.pathname;
        } catch {
          // Not a URL yet.
        }
        const at = `${host}${pathname}`;
        if (at !== lastPage) {
          lastPage = at;
          lastChangeAt = Date.now();
          logger.info?.("cloud.headless_approval_page", { host, path: pathname });
        }
        if (pathname === "/device/callback" && page.title) {
          if (/signed in/i.test(page.title)) return "signed_in";
          logger.warn?.("cloud.headless_approval_callback_failed", { title: page.title.slice(0, 80) });
          return "closed";
        }
        if (Date.now() - lastChangeAt > STALLED_PAGE_MS) {
          logger.warn?.("cloud.headless_approval_stalled", { host, path: pathname });
          return "closed";
        }
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  } finally {
    cleanup();
  }
}

/** Each request of the direct approval; the whole thing takes about a second. */
const DIRECT_STEP_TIMEOUT_MS = 20_000;
/** Redirects followed from the authorize step to the account service's callback. */
const DIRECT_MAX_REDIRECTS = 8;

/**
 * The direct approval's answer. `unused`: it stopped before the ticket was
 * spent (a link it doesn't know, Clerk unreachable or refusing the ticket), so
 * a browser may still open the same link.
 */
export type DirectApprovalResult = "signed_in" | "closed" | "cancelled" | "unused";

/**
 * Completes a sign-in link without a browser: the ticket sign-in through
 * Clerk's Frontend API (the origin of the link's `redirect_url`), the OAuth
 * authorize step with the session it made, and the account service's
 * `/device/callback`, which approves the device sign-in exactly as the page
 * does. Clerk's cookies only ever go back to Clerk's own host. Never the
 * link, ticket or code in a log.
 */
export async function approveSignInLinkDirectly(args: {
  url: string;
  signal: AbortSignal;
  logger?: Logger;
}): Promise<DirectApprovalResult> {
  const logger = args.logger ?? {};
  if (args.signal.aborted) return "cancelled";
  let link: URL;
  let authorize: URL;
  let ticket: string | null;
  try {
    link = new URL(args.url);
    ticket = link.searchParams.get("__clerk_ticket");
    authorize = new URL(link.searchParams.get("redirect_url") ?? "");
  } catch {
    return "unused";
  }
  if (!ticket || link.protocol !== "https:" || authorize.protocol !== "https:" || authorize.pathname !== "/oauth/authorize") {
    logger.info?.("cloud.direct_approval_unknown_link", { host: link.host });
    return "unused";
  }
  const step = (signal: AbortSignal) => AbortSignal.any([signal, AbortSignal.timeout(DIRECT_STEP_TIMEOUT_MS)]);
  const clerk = authorize.origin;
  const cookies = new Map<string, string>();
  const keepCookies = (response: Response) => {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const pair = line.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      if (at > 0) cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1));
    }
  };
  const cookieHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");

  // 1. The ticket sign-in, as Clerk's hosted page sends it.
  let signIn: Response;
  try {
    signIn = await fetch(`${clerk}/v1/client/sign_ins`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", origin: link.origin },
      body: new URLSearchParams({ strategy: "ticket", ticket }).toString(),
      redirect: "manual",
      signal: step(args.signal),
    });
  } catch {
    if (args.signal.aborted) return "cancelled";
    logger.warn?.("cloud.direct_approval_unreachable", { host: authorize.host });
    return "unused";
  }
  keepCookies(signIn);
  const signedIn = await signIn.json().catch(() => null) as { response?: { status?: unknown }; status?: unknown } | null;
  const signInStatus = signedIn?.response?.status ?? signedIn?.status;
  if (!signIn.ok || signInStatus !== "complete" || cookies.size === 0) {
    // Refused before it was spent (an expired or wrong ticket reads the same): a browser can try the link.
    logger.warn?.("cloud.direct_approval_sign_in_refused", { status: signIn.status, signIn: typeof signInStatus === "string" ? signInStatus : null });
    return "unused";
  }

  // 2. The authorize step with that session, to the account service's callback.
  let next = authorize;
  for (let hop = 0; hop < DIRECT_MAX_REDIRECTS; hop += 1) {
    if (args.signal.aborted) return "cancelled";
    let response: Response;
    try {
      response = await fetch(next.toString(), {
        headers: next.origin === clerk ? { cookie: cookieHeader() } : {},
        redirect: "manual",
        signal: step(args.signal),
      });
    } catch {
      if (args.signal.aborted) return "cancelled";
      logger.warn?.("cloud.direct_approval_step_failed", { host: next.host, path: next.pathname });
      return "closed";
    }
    if (next.origin === clerk) keepCookies(response);
    if (next.pathname === "/device/callback") {
      const html = await response.text().catch(() => "");
      const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
      if (response.status === 200 && /signed in/i.test(title)) return "signed_in";
      logger.warn?.("cloud.direct_approval_callback_failed", { status: response.status, title: title.slice(0, 80) });
      return "closed";
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    if (!location) {
      // Clerk answered with a page (a consent or a challenge): only a person goes on from here.
      logger.warn?.("cloud.direct_approval_stopped", { host: next.host, path: next.pathname, status: response.status });
      return "closed";
    }
    try {
      next = new URL(location, next);
    } catch {
      return "closed";
    }
    if (next.protocol !== "https:") return "closed";
  }
  logger.warn?.("cloud.direct_approval_too_many_redirects", {});
  return "closed";
}

/**
 * The one way a machine with nobody at it approves a sign-in link: without a
 * browser first, then a headless Chromium (`binary`, when this machine has
 * one) while the ticket is still unused.
 */
export async function approveSignInLink(args: {
  url: string;
  signal: AbortSignal;
  binary: string | null;
  logger?: Logger;
  platform?: NodeJS.Platform;
}): Promise<HeadlessApprovalResult> {
  const direct = await approveSignInLinkDirectly(args);
  args.logger?.info?.("cloud.direct_approval", { result: direct });
  if (direct !== "unused") return direct;
  if (!args.binary) return "closed";
  return await approveInHeadlessChromium({ url: args.url, signal: args.signal, binary: args.binary, logger: args.logger, platform: args.platform });
}
