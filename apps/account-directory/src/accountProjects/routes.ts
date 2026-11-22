import { authenticate, type CallerTokenEnv } from "../callerToken";
import { UNREADABLE_REQUEST_MESSAGE, fail, json } from "../cloud/http";
import { parseMachineKey, parseRepoKey } from "../laneShares/shareRows";
import { logAccountProject } from "../logging";
import { readBoundedBody } from "../sinkUtils";
import { trustedHttpsOrigin } from "../trustedOrigin";
import {
  ACCOUNT_PROJECT_ID_PATTERN,
  ACCOUNT_PROJECT_MAX_BODY_BYTES,
  ACCOUNT_PROJECT_MAX_BRANCH,
  ACCOUNT_PROJECT_MAX_COPIES_PER_MACHINE,
  ACCOUNT_PROJECT_MAX_NAME,
  ACCOUNT_PROJECT_MAX_OWNER,
  ACCOUNT_PROJECT_MAX_ROOT_PATH,
  ACCOUNT_PROJECT_PATHS,
  type AccountProjectAddResponse,
  type AccountProjectCopiesResponse,
  type AccountProjectListResponse,
  type AccountProjectRemoveResponse,
} from "./contract";
import {
  AccountProjectLimitError,
  addProject,
  listProjects,
  readAccountProjectsCursor,
  readProject,
  removeProject,
  replaceMachineCopies,
  type CopyPlanInput,
  type IdentityInput,
} from "./store";

/**
 * The account's project list: list, add, remove, and a machine's copies
 * (README, "Account projects"; table in migration 0028; shapes in
 * `contract.ts`).
 *
 * Every route takes the account token as a bearer and reads only the
 * caller's own rows (`user_id` is in every statement). The phone (a Clerk
 * native session token, no audience), the web client (an OAuth access token
 * for the ADE client, from its exact origin) and a brain (an OAuth access
 * token, no Origin) all pass `authenticate`, as on the lane share and
 * machine directory routes.
 */

export type AccountProjectEnv = CallerTokenEnv & {
  DB: D1Database;
  WEB_CLIENT_ORIGIN?: string;
};

const PREFIX = ACCOUNT_PROJECT_PATHS.root;

export function isAccountProjectRequest(url: URL): boolean {
  return url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`);
}

type Route =
  | { kind: "collection" }
  | { kind: "copies" }
  | { kind: "remove"; id: string };

function matchRoute(path: string): Route | null {
  if (path === PREFIX) return { kind: "collection" };
  if (path === ACCOUNT_PROJECT_PATHS.copies) return { kind: "copies" };
  const [id, action, ...rest] = path.slice(PREFIX.length + 1).split("/");
  if (!id || rest.length || action !== "remove") return null;
  return { kind: "remove", id };
}

function methodsFor(route: Route): string[] {
  switch (route.kind) {
    case "collection":
      return ["GET", "POST"];
    case "copies":
      return ["PUT"];
    case "remove":
      return ["POST"];
  }
}

const ALLOWED_REQUEST_HEADERS = new Set(["authorization", "content-type", "x-ade-correlation-id"]);

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

const notFound = () => fail("not_found", "That project was not found on your ADE account.", 404);
const badRequest = (message: string) => fail("bad_request", message, 400);

/**
 * CORS is the directory's rule: only the hosted web client's exact origin,
 * never `*`; a native caller sends no Origin. The copies route is for
 * machines only, so no browser origin may call it. A refused origin is
 * answered before the token or D1 is touched.
 */
export async function handleAccountProjectRequest(request: Request, env: AccountProjectEnv): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const route = matchRoute(path);
  const requestOrigin = request.headers.get("origin");
  const allowedOrigin = trustedHttpsOrigin(env.WEB_CLIENT_ORIGIN, { requireExactOrigin: true });
  const machineOnly = route?.kind === "copies";
  const corsOrigin = route && !machineOnly && requestOrigin && allowedOrigin && requestOrigin === allowedOrigin
    ? allowedOrigin
    : null;

  if (request.method === "OPTIONS") {
    if (!route) return notFound();
    if (!corsOrigin) return fail("origin_not_allowed", "This origin can't call the ADE project list.", 403);
    const methods = methodsFor(route);
    const wanted = request.headers.get("access-control-request-method")?.toUpperCase() ?? "";
    if (!methods.includes(wanted)) return fail("bad_request", "That method isn't allowed here.", 405);
    const requestedHeaders = (request.headers.get("access-control-request-headers") ?? "")
      .split(",").map((header) => header.trim().toLowerCase()).filter(Boolean);
    if (requestedHeaders.some((header) => !ALLOWED_REQUEST_HEADERS.has(header))) {
      return fail("origin_not_allowed", "Those headers aren't allowed.", 403);
    }
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-headers": "authorization, content-type, x-ade-correlation-id",
        "access-control-allow-methods": `${methods.join(", ")}, OPTIONS`,
        "access-control-max-age": "600",
        vary: "Origin",
      },
    });
  }
  if (requestOrigin && !corsOrigin) return fail("origin_not_allowed", "This origin can't call the ADE project list.", 403);

  const response = await routeRequest(request, env, route, url);
  return corsOrigin ? withCors(response, corsOrigin) : response;
}

async function routeRequest(request: Request, env: AccountProjectEnv, route: Route | null, url: URL): Promise<Response> {
  if (!route || !methodsFor(route).includes(request.method)) return notFound();
  const caller = await authenticate(request, env);
  if (!caller.ok) {
    return caller.reason === "authentication unavailable"
      ? fail("unavailable", "ADE can't check your sign-in right now. Try again soon.", 503)
      : fail("unauthorized", "Sign in to ADE to see your projects.", 401);
  }
  const userId = caller.userId;
  const now = Date.now();
  try {
    switch (route.kind) {
      case "collection":
        return request.method === "GET" ? await handleList(env, userId, url) : await handleAdd(request, env, userId, now);
      case "copies":
        return await handleCopies(request, env, userId, now);
      case "remove":
        return await handleRemove(env, userId, route.id, now);
    }
  } catch (error) {
    if (error instanceof AccountProjectLimitError) {
      logAccountProject({ event: "account_project.refused", userId, code: error.limit });
      return error.limit === "live_projects"
        ? fail("too_many_projects", "Your ADE account has as many projects as it can hold. Remove one first.", 409)
        : fail("too_many_projects", "Your ADE account can't hold more projects right now.", 409);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Input

async function readBody(request: Request): Promise<Record<string, unknown> | "too_large" | null> {
  let read: Awaited<ReturnType<typeof readBoundedBody>>;
  try {
    read = await readBoundedBody(request, ACCOUNT_PROJECT_MAX_BODY_BYTES);
  } catch {
    return null;
  }
  if (!read.ok) return "too_large";
  if (!read.text) return {};
  try {
    const value = JSON.parse(read.text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Text with no control or format characters, at most `max` characters, or null. */
function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\p{Cc}\p{Cf}]/u.test(trimmed)) return null;
  return trimmed;
}

const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;
/** GitHub's own rule for owner and repository names, a little wider. */
const REPO_PART = /^[A-Za-z0-9_.-]+$/;
const CHECKOUT_ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;

/** The host a `repo:` address names. */
const repoKeyHost = (repoKey: string): string => repoKey.slice("repo:".length).split("/")[0] ?? "";

/** One repository as a request names it, or a sentence saying what is wrong. */
function parseIdentity(raw: Record<string, unknown>): IdentityInput | string {
  const repoKey = parseRepoKey(raw.repoKey);
  if (!repoKey) return "The repository address is missing or isn't one ADE reads.";
  const host = typeof raw.host === "string" && HOST.test(raw.host) && raw.host.length <= 255 ? raw.host : null;
  if (!host) return "The repository host is missing or isn't one ADE reads.";
  // `ssh.github.com` (GitHub's SSH on port 443) is github.com.
  const keyHost = repoKeyHost(repoKey);
  if (keyHost !== host && !(host === "github.com" && keyHost === "ssh.github.com")) {
    return "The repository host and address don't match.";
  }
  let canonicalRepoKey: string | null = null;
  if (raw.canonicalRepoKey !== undefined && raw.canonicalRepoKey !== null) {
    canonicalRepoKey = parseRepoKey(raw.canonicalRepoKey);
    if (!canonicalRepoKey || repoKeyHost(canonicalRepoKey) !== host) return "The repository's current address isn't one ADE reads.";
  }
  const owner = boundedText(raw.owner, ACCOUNT_PROJECT_MAX_OWNER);
  const name = boundedText(raw.name, ACCOUNT_PROJECT_MAX_NAME);
  if (!owner || !name || !REPO_PART.test(owner) || !REPO_PART.test(name)) return "The repository owner or name isn't one ADE reads.";
  let repoId: number | null = null;
  if (raw.repoId !== undefined && raw.repoId !== null) {
    if (typeof raw.repoId !== "number" || !Number.isSafeInteger(raw.repoId) || raw.repoId <= 0) return "The repository id isn't one ADE reads.";
    repoId = raw.repoId;
  }
  // The id is the only thing that makes a current address trustworthy.
  if (canonicalRepoKey && repoId == null) canonicalRepoKey = null;
  let defaultBranch: string | null = null;
  if (raw.defaultBranch !== undefined && raw.defaultBranch !== null) {
    defaultBranch = boundedText(raw.defaultBranch, ACCOUNT_PROJECT_MAX_BRANCH);
    if (!defaultBranch) return "The default branch isn't one ADE reads.";
  }
  return { host, owner, name, repoKey, canonicalRepoKey, repoId, defaultBranch };
}

function parseSince(url: URL): number | null {
  const raw = url.searchParams.get("since");
  if (raw == null || raw === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Handlers

async function handleList(env: AccountProjectEnv, userId: string, url: URL): Promise<Response> {
  const page = await listProjects(env.DB, userId, parseSince(url));
  return json(page satisfies AccountProjectListResponse);
}

async function handleAdd(request: Request, env: AccountProjectEnv, userId: string, now: number): Promise<Response> {
  const body = await readBody(request);
  if (body === "too_large") return fail("too_large", "That request is too large.", 413);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const identity = parseIdentity(body);
  if (typeof identity === "string") return badRequest(identity);
  const added = await addProject(env.DB, userId, identity, now);
  const project = await readProject(env.DB, userId, added.projectId);
  if (!project) throw new Error("account_project_row_missing");
  if (added.created || added.revived) {
    logAccountProject({ event: added.created ? "account_project.added" : "account_project.revived", userId, projectId: project.id });
  }
  const response: AccountProjectAddResponse = {
    project,
    created: added.created,
    revived: added.revived,
    cursor: await readAccountProjectsCursor(env.DB, userId),
  };
  return json(response, added.created ? 201 : 200);
}

async function handleRemove(env: AccountProjectEnv, userId: string, id: string, now: number): Promise<Response> {
  if (!ACCOUNT_PROJECT_ID_PATTERN.test(id)) return notFound();
  const removedId = await removeProject(env.DB, userId, id, now);
  if (!removedId) return notFound();
  const project = await readProject(env.DB, userId, removedId);
  if (!project) throw new Error("account_project_row_missing");
  logAccountProject({ event: "account_project.removed", userId, projectId: removedId });
  const response: AccountProjectRemoveResponse = { project, cursor: await readAccountProjectsCursor(env.DB, userId) };
  return json(response);
}

async function handleCopies(request: Request, env: AccountProjectEnv, userId: string, now: number): Promise<Response> {
  const body = await readBody(request);
  if (body === "too_large") return fail("too_large", "That request is too large.", 413);
  if (!body) return badRequest(UNREADABLE_REQUEST_MESSAGE);
  const machineKey = parseMachineKey(body.machineKey);
  if (!machineKey) return badRequest("The machine key is missing or isn't one ADE reads.");
  if (!Array.isArray(body.copies)) return badRequest("The copies are missing.");
  if (body.copies.length > ACCOUNT_PROJECT_MAX_COPIES_PER_MACHINE) {
    return fail("too_many_copies", `A computer can publish at most ${ACCOUNT_PROJECT_MAX_COPIES_PER_MACHINE} project folders.`, 413);
  }
  const owned = await env.DB.prepare("select 1 as found from machines where user_id = ? and machine_key = ?")
    .bind(userId, machineKey).first<{ found: number }>();
  if (!owned) return fail("unknown_machine", "That computer isn't on your ADE account.", 400);

  const copies: CopyPlanInput[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of body.copies.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return badRequest(`Copy ${index + 1} can't be read.`);
    const record = raw as Record<string, unknown>;
    const identity = parseIdentity(record);
    if (typeof identity === "string") return badRequest(`Copy ${index + 1}: ${identity}`);
    const checkoutId = typeof record.checkoutId === "string" && CHECKOUT_ID.test(record.checkoutId) ? record.checkoutId : null;
    if (!checkoutId) return badRequest(`Copy ${index + 1}: the folder id isn't one ADE reads.`);
    if (seen.has(checkoutId)) return badRequest(`Copy ${index + 1}: that folder is listed twice.`);
    seen.add(checkoutId);
    const rootPath = boundedText(record.rootPath, ACCOUNT_PROJECT_MAX_ROOT_PATH);
    if (!rootPath) return badRequest(`Copy ${index + 1}: the folder path isn't one ADE reads.`);
    const add = record.add === undefined || record.add === "none" ? "none" : record.add === "auto" ? "auto" : null;
    if (!add) return badRequest(`Copy ${index + 1}: the add mode isn't one ADE reads.`);
    copies.push({ ...identity, checkoutId, rootPath, isMain: record.isMain === true, add });
  }
  const results = await replaceMachineCopies(env.DB, userId, machineKey, copies, now);
  const response: AccountProjectCopiesResponse = { copies: results, cursor: await readAccountProjectsCursor(env.DB, userId) };
  return json(response);
}
