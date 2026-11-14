import { afterEach, describe, expect, it, vi } from "vitest";
import { approveSignInLink, type SignInLinkTrust } from "./cloudHeadlessApproval";

// The headless browser is a child process: an untrusted link must never reach it either.
const spawned = vi.hoisted(() => [] as string[]);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: (command: string) => {
    spawned.push(command);
    throw new Error("no browser in this test");
  },
}));

const PROD: SignInLinkTrust = { clerkIssuer: "https://clerk.ade-app.dev", directoryBaseUrl: "https://directory.example.workers.dev" };
const DEV: SignInLinkTrust = { clerkIssuer: "https://coherent-foxhound-62.clerk.accounts.dev", directoryBaseUrl: "https://directory-dev.example.workers.dev" };

function signInLink(parts: { page: string; clerk: string; callback: string }): string {
  const authorize = `${parts.clerk}/oauth/authorize?${new URLSearchParams({ client_id: "client", redirect_uri: parts.callback, state: "state" })}`;
  return `${parts.page}/sign-in?${new URLSearchParams({ __clerk_ticket: "ticket", redirect_url: authorize })}`;
}

/** A stand-in for Clerk and the account directory at the network boundary; every request is recorded. */
function stubNetwork(args: { clerk: string; callback: string; authorizeRedirect?: string }): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    requested.push(`${url.origin}${url.pathname}`);
    if (url.origin === args.clerk && url.pathname === "/v1/client/sign_ins") {
      return new Response(JSON.stringify({ response: { status: "complete" } }), {
        status: 200,
        headers: [["content-type", "application/json"], ["set-cookie", "__client=session; Path=/"]],
      });
    }
    if (url.origin === args.clerk && url.pathname === "/oauth/authorize") {
      return new Response(null, { status: 302, headers: { location: args.authorizeRedirect ?? `${args.callback}?code=code&state=state` } });
    }
    if (`${url.origin}${url.pathname}` === args.callback) {
      return new Response("<html><head><title>You're signed in</title></head></html>", { status: 200 });
    }
    return new Response("<html><head><title>Elsewhere</title></head></html>", { status: 200 });
  });
  return requested;
}

afterEach(() => {
  vi.unstubAllGlobals();
  spawned.length = 0;
});

describe("approveSignInLink", () => {
  it.each([
    ["production", PROD, "https://accounts.ade-app.dev", "https://clerk.ade-app.dev"],
    ["a development instance", DEV, "https://coherent-foxhound-62.accounts.dev", "https://coherent-foxhound-62.clerk.accounts.dev"],
  ])("signs in a link on the machine's own hosts (%s), talking only to Clerk and the directory", async (_name, trust, page, clerk) => {
    const callback = `${trust.directoryBaseUrl}/device/callback`;
    const requested = stubNetwork({ clerk, callback });
    const result = await approveSignInLink({ url: signInLink({ page, clerk, callback }), signal: new AbortController().signal, binary: null, trust: () => trust });
    expect(result).toBe("signed_in");
    expect(requested).toEqual([`${clerk}/v1/client/sign_ins`, `${clerk}/oauth/authorize`, callback]);
  });

  const good = { page: "https://accounts.ade-app.dev", clerk: "https://clerk.ade-app.dev", callback: `${PROD.directoryBaseUrl}/device/callback` };
  it.each([
    ["the sign-in page is on another host", { ...good, page: "https://accounts.evil.example" }, PROD],
    ["the authorize step is on another host", { ...good, clerk: "https://clerk.evil.example" }, PROD],
    ["the callback is on another directory", { ...good, callback: "https://evil.example/device/callback" }, PROD],
    ["the callback is another path on the directory", { ...good, callback: `${PROD.directoryBaseUrl}/elsewhere` }, PROD],
    ["the machine has no directory", good, { ...PROD, directoryBaseUrl: null }],
    ["the machine's issuer has no known accounts host", good, { ...PROD, clerkIssuer: "https://auth.example.com" }],
    ["the link is a development instance's but the machine is production", { page: "https://coherent-foxhound-62.accounts.dev", clerk: "https://coherent-foxhound-62.clerk.accounts.dev", callback: good.callback }, PROD],
  ])("sends the ticket nowhere when %s", async (_name, parts, trust) => {
    const requested = stubNetwork({ clerk: parts.clerk, callback: parts.callback });
    const result = await approveSignInLink({ url: signInLink(parts), signal: new AbortController().signal, binary: "/usr/bin/chromium", trust: () => trust });
    expect(result).toBe("closed");
    expect(requested).toEqual([]);
    expect(spawned).toEqual([]);
  });

  it("follows no redirect to a host other than Clerk's or the directory's callback", async () => {
    const requested = stubNetwork({ clerk: good.clerk, callback: good.callback, authorizeRedirect: "https://evil.example/device/callback?code=code" });
    const result = await approveSignInLink({ url: signInLink(good), signal: new AbortController().signal, binary: null, trust: () => PROD });
    expect(result).toBe("closed");
    expect(requested.some((url) => url.startsWith("https://evil.example"))).toBe(false);
  });
});
