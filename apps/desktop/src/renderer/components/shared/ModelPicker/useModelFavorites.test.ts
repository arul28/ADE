/* @vitest-environment jsdom */

/**
 * Model favorites on the ADE account, through the hook the picker uses. The
 * account server is faked at the network boundary (the real `cloudApiClient`
 * and account-call mapping run on top of it), and `window.ade` stands in for
 * the preload bridge. Each "start" is a fresh module, as a restarted window is.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createCloudApiClient } from "../../../../shared/cloudApiClient";
import { runAdeCloudAccountCall } from "../../../../shared/adeCloud/accountCalls";

type Hook = typeof import("./useModelFavorites");

const accounts = new Map<string, string[]>();
let signedIn: string | null = null;
let online = true;

/** The account server: `{add, remove}` applied to the caller's own list; a change named for another account is refused. */
async function accountServer(_url: string, init?: RequestInit): Promise<Response> {
  if (!online) throw new TypeError("Failed to fetch");
  const user = String(new Headers(init?.headers).get("authorization")).replace("Bearer ", "");
  let list = accounts.get(user) ?? [];
  if (init?.method === "PUT") {
    const change = JSON.parse(String(init.body)) as { add: string[]; remove: string[]; account?: string };
    if (change.account !== undefined && change.account !== user) {
      return new Response(JSON.stringify({ error: { code: "account_changed", message: "another account" } }), { status: 403 });
    }
    list = list.filter((id) => !change.remove.includes(id));
    for (const id of change.add) if (!list.includes(id)) list.push(id);
    accounts.set(user, list);
  }
  return new Response(JSON.stringify({ favorites: list, revision: 1 }), { status: 200 });
}

async function start(): Promise<Hook> {
  vi.resetModules();
  const api = createCloudApiClient({ baseUrl: "https://account.test", accessToken: () => signedIn, fetch: accountServer as never });
  (window as unknown as { ade: unknown }).ade = {
    account: { status: async () => ({ userId: signedIn }) },
    adeCloud: { accountCall: (call: unknown) => runAdeCloudAccountCall(signedIn ? api : null, call) },
  };
  return await import("./useModelFavorites");
}

afterEach(() => {
  window.localStorage.clear();
  accounts.clear();
});

it("keeps a star made offline until the account takes it, and never sends one account's stars to another", async () => {
  signedIn = "user_a";
  accounts.set("user_a", ["opus"]);
  const first = await start();
  const a = renderHook(() => first.useModelFavorites());
  await waitFor(() => expect(a.result.current.favorites).toEqual(["opus"]));

  // Offline: the star shows at once and waits; a restart keeps it.
  online = false;
  act(() => a.result.current.toggleFavorite("fable"));
  expect(a.result.current.favorites).toEqual(["opus", "fable"]);
  a.unmount();
  online = true;
  const restarted = await start();
  const a2 = renderHook(() => restarted.useModelFavorites());
  await waitFor(() => expect(accounts.get("user_a")).toEqual(["opus", "fable"]));

  // A star queued offline under user_a, then user_b signs in on this client.
  online = false;
  act(() => a2.result.current.toggleFavorite("sonnet"));
  a2.unmount();
  online = true;
  signedIn = "user_b";
  accounts.set("user_b", ["gpt-6"]);
  const switched = await start();
  const b = renderHook(() => switched.useModelFavorites());
  await waitFor(() => expect(b.result.current.favorites).toEqual(["gpt-6"]));
  expect(accounts.get("user_b")).toEqual(["gpt-6"]);
  expect(accounts.get("user_a")).toEqual(["opus", "fable"]);
});
