import {
  jsonResponse,
  logTunnel,
  MACHINE_KEY_PATTERN,
  MCP_ACCOUNT_FRONT_PATH,
  MCP_ACCOUNT_MAX_MEMBERS,
  MCP_ACCOUNT_PATH,
  mcpAccountKeyForSecret,
  mcpAccountObjectName,
  type McpAccountState,
  type TunnelRelayEnv,
} from "./relayShared";
import { fetchDurableObject } from "./cloudflareTransient";

/**
 * ADE MCP account membership. Two halves live in the same Durable Object
 * class: the `mcp-account:<accountKey>` object (the membership store), and a
 * machine object bringing its own membership in line with what its brain
 * asked for. See the README's "The account address".
 */

/** Machine object storage: the account it last joined, so a fresh control socket can still leave it. */
const JOINED_KEY = "mcpAccountKey";
/** Machine object storage: accounts a `remove` failed for, retried until they take. */
const LEAVING_KEY = "mcpAccountLeaving";
// A machine moves between accounts rarely; this only bounds a pathological list.
const MAX_LEAVING = 8;

/**
 * The `mcp-account:<accountKey>` object: the machines (relay keys) serving an
 * account, most recent registration last, and the one that last answered.
 */
export async function handleMcpAccount(
  storage: DurableObjectStorage,
  request: Request,
  pathname: string,
): Promise<Response> {
  const members = (await storage.get<string[]>("members")) ?? [];
  const front = (await storage.get<string>("front")) ?? null;
  if (pathname === MCP_ACCOUNT_PATH && request.method === "GET") {
    return jsonResponse({ members, front } satisfies McpAccountState, { headers: { "cache-control": "no-store" } });
  }
  const expected = pathname === MCP_ACCOUNT_PATH ? "PUT" : "POST";
  if (request.method !== expected) return new Response("method not allowed", { status: 405 });
  let parsed: { machineKey?: unknown; op?: unknown };
  try {
    parsed = (await request.json()) as typeof parsed;
  } catch {
    return new Response("invalid json", { status: 400 });
  }
  const machineKey = typeof parsed?.machineKey === "string" ? parsed.machineKey.toLowerCase() : "";
  if (!MACHINE_KEY_PATTERN.test(machineKey)) return new Response("bad machine key", { status: 400 });

  if (pathname === MCP_ACCOUNT_FRONT_PATH) {
    if (!members.includes(machineKey)) return new Response("not a member", { status: 409 });
    if (front !== machineKey) await storage.put("front", machineKey);
    return new Response(null, { status: 204 });
  }
  if (parsed.op !== "add" && parsed.op !== "remove") return new Response("bad op", { status: 400 });
  let next = members.filter((key) => key !== machineKey);
  if (parsed.op === "add") {
    next.push(machineKey);
    if (next.length > MCP_ACCOUNT_MAX_MEMBERS) next = next.slice(next.length - MCP_ACCOUNT_MAX_MEMBERS);
  }
  await storage.put("members", next);
  if (front && !next.includes(front)) await storage.put("front", null);
  return new Response(null, { status: 204 });
}

/**
 * The account an `mcp_state` asks for: on with a well-formed account secret →
 * the account derived from it; anything else → none. The secret is never
 * stored or logged.
 */
export async function desiredMcpAccount(machineKey: string, enabled: boolean, account: unknown): Promise<string | null> {
  const secret = account && typeof account === "object" ? (account as { secret?: unknown }).secret : undefined;
  if (!enabled || secret === undefined) return null;
  const desired = await mcpAccountKeyForSecret(secret);
  if (!desired) logTunnel("mcp_account_rejected", { machineKey: machineKey.slice(0, 8), reason: "bad_secret" });
  return desired;
}

/** Adds this machine to, or removes it from, an account object. True when it took. */
async function putMcpAccountMember(
  env: TunnelRelayEnv,
  accountKey: string,
  machineKey: string,
  op: "add" | "remove",
): Promise<boolean> {
  const id = env.TUNNEL.idFromName(mcpAccountObjectName(accountKey));
  try {
    // Adding or removing twice leaves the same list, so a retry is safe.
    const response = await fetchDurableObject(
      () => env.TUNNEL.get(id),
      new Request(`https://relay.internal${MCP_ACCOUNT_PATH}`, {
        method: "PUT",
        body: JSON.stringify({ machineKey, op }),
      }),
      { retry: "replayable" },
    );
    await response.body?.cancel();
    if (response.ok) return true;
    logTunnel(`mcp_account_${op}_failed`, { machineKey: machineKey.slice(0, 8), account: accountKey.slice(0, 8), status: response.status });
  } catch (error) {
    logTunnel(`mcp_account_${op}_failed`, {
      machineKey: machineKey.slice(0, 8),
      account: accountKey.slice(0, 8),
      error: error instanceof Error ? error.name : "unknown",
    });
  }
  return false;
}

type McpAccountReconcile = {
  /** The account this machine is now a member of, or null. */
  joined: string | null;
  /** False when a join or leave failed and must be retried. */
  settled: boolean;
};

/**
 * Brings a machine's account membership in line with `desired`: leaves every
 * other account it may still be listed on (the one joined on this socket, the
 * one last joined in storage, any whose `remove` failed before, and `stale`,
 * an account that just routed a request here), then joins `desired`. A failed
 * leave stays in storage and a failed join leaves `joined` null, so the next
 * call retries both; `settled` says whether one is needed.
 */
export async function reconcileMcpAccount(
  storage: DurableObjectStorage,
  env: TunnelRelayEnv,
  args: { machineKey: string; desired: string | null; joined: string | null; stale?: string },
): Promise<McpAccountReconcile> {
  const { machineKey, desired, joined, stale } = args;
  const stored = (await storage.get<string>(JOINED_KEY)) ?? null;
  const previouslyLeaving = (await storage.get<string[]>(LEAVING_KEY)) ?? [];
  const leaving = new Set(previouslyLeaving);
  for (const key of [joined, stored, stale]) if (key) leaving.add(key);
  if (desired) leaving.delete(desired);
  if (leaving.size === 0 && joined === desired && stored === desired) return { joined, settled: true };

  let settled = true;
  for (const key of [...leaving]) {
    if (await putMcpAccountMember(env, key, machineKey, "remove")) {
      leaving.delete(key);
      logTunnel("mcp_account_left", { machineKey: machineKey.slice(0, 8), account: key.slice(0, 8) });
    } else {
      settled = false;
    }
  }
  if (leaving.size > 0) await storage.put(LEAVING_KEY, [...leaving].slice(-MAX_LEAVING));
  else if (previouslyLeaving.length > 0) await storage.delete(LEAVING_KEY);
  // Still listed in LEAVING_KEY when its remove failed.
  if (stored && stored !== desired) await storage.delete(JOINED_KEY);

  if (!desired) return { joined: null, settled };
  if (joined === desired && stored === desired) return { joined, settled };
  if (!(await putMcpAccountMember(env, desired, machineKey, "add"))) return { joined: null, settled: false };
  if (stored !== desired) await storage.put(JOINED_KEY, desired);
  logTunnel("mcp_account_joined", { machineKey: machineKey.slice(0, 8), account: desired.slice(0, 8) });
  return { joined: desired, settled };
}
