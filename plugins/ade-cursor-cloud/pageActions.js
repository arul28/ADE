// The second action table: what the plugin's own HTML page invokes.
//
// `index.js` answers the MANIFEST and the PANELS — tools, steps, the CLI words,
// a row's `onPress` — and what those return is vocabulary: `{navigate}`,
// `{openUrl}`, `{resetState}`, a panel id. This file answers a PAGE, and a page
// wants none of those. It wants DATA, in exactly the shapes
// `page/src/types.ts` declares, and for a form the `{ok, message}` it can draw
// beside the control the reader just touched.
//
// `page/test/fakeBridge.ts` is the contract written out: every id it scripts is
// defined here, and the answer it scripts is the shape these handlers build.
//
// ## Why a page handler does not throw
//
// A press on a PANEL that fails renders as a banner, because the host turns
// `{message, ok: false}` into one. A page's `invoke` has no such chrome: a
// rejected promise reaches the page as an exception beside a form the reader
// has already filled in, and the page would have to invent the banner itself.
// So every MUTATION here answers `{ok: false, message}` for anything Cursor or
// ADE refused, and throws only when this plugin itself is wrong.
//
// The reads degrade instead. `pageFleet` carries its failure in `state:
// "error"` and `error`; `pageAgent` carries it in `error` with a null `entry`;
// `pageLaunchContext` carries it in `unavailable`; `pageConnection` carries it
// in `message`. A page opened on a machine that cannot reach Cursor draws its
// own empty state rather than a crash.
//
// ## Why nothing here carries a credential
//
// The webview bridge deliberately exposes no `secrets` verb: a page that could
// read the Cursor API key would be a page that could exfiltrate it, and a
// plugin page is ordinary web content. So nothing this file returns carries a
// key or any part of one — including inside an error message. `pageConnection`
// answers `hasKey: true` and the key's NAME, which is the whole of what a
// connection card needs. `test/pageActions.test.js` walks every handler's
// result and fails on a credential-shaped field.
//
// ## Why the child pre-formats
//
// A phone, the web client and the desktop all draw the object this process
// shaped. `age`, `cost`, `status`, `active`, `footer` and `repoCaption` are
// computed here, through `format.js`'s own helpers, so three renderers cannot
// drift on what "30m" or "finished" means. The page does no date maths and no
// currency maths, because two of the three clients would get it subtly wrong.
//
// ## Why `deps` is read through getters
//
// `index.js` holds `sdk`, `api` and `runtime` in bindings that are null until
// `activate` runs, and this table is built at LOAD so a page that opens the
// instant its tab is drawn gets a real handler rather than "no such action". A
// table that captured them by value would capture the nulls; a handler that
// runs before the bindings exist answers its own empty shape instead.

"use strict";

const {
  fleetDisplayStatus,
  formatAge,
  formatCost,
  isFleetEntryActive,
} = require("./format");
const {
  agentNameFromPrompt,
  isInjectableSecretName,
  laneSecretsKey,
  launchUnavailableReason,
  MAX_ATTACHED_SECRETS,
  repoCaption,
} = require("./launch");
const { repoLabel } = require("./repoMatch");

/** Runs one agent's detail pane shows. Cursor caps a page at 100 either way. */
const AGENT_RUNS_PAGE = 20;
/** Artifact rows one detail pane mints a signed URL for. */
const MAX_ARTIFACT_ROWS = 50;
/** Lanes the launch form's picker offers. */
const MAX_LANE_CHOICES = 40;

/** The one sentence for a page call that arrived before `activate` finished. */
const STARTING_UP = "Cursor Cloud is still starting up on this machine.";

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integer(value) {
  if (Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

/** The empty `groups` every fleet state carries, so a page never branches on undefined. */
function emptyGroups() {
  return { active: [], lanes: [], unlinked: [] };
}

/**
 * One assembled fleet row, decorated with what a page must not compute.
 *
 * `fleet.js:assembleFleet` stops at the facts; `age`, `status` and `active` are
 * the three DISPLAY fields `CloudFleetEntry` declares, and they are added here
 * rather than there so the panel path and the page path share one assembly and
 * one set of display rules.
 */
function decorate(entry, now) {
  return {
    ...entry,
    age: formatAge(entry.agent.lastModified ?? entry.agent.createdAt, now),
    status: fleetDisplayStatus(entry),
    active: isFleetEntryActive(entry),
  };
}

/** The same decoration over a whole group tree. */
function decorateGroups(grouped, now) {
  if (!grouped) return emptyGroups();
  return {
    active: (grouped.active ?? []).map((entry) => decorate(entry, now)),
    lanes: (grouped.lanes ?? []).map((group) => ({
      laneId: group.laneId,
      laneName: group.laneName,
      entries: group.entries.map((entry) => decorate(entry, now)),
    })),
    unlinked: (grouped.unlinked ?? []).map((group) => ({
      key: group.key,
      label: group.label,
      entries: group.entries.map((entry) => decorate(entry, now)),
    })),
  };
}

/** One `CloudRun`, from whatever `GET /v1/agents/:id/runs` gave. */
function pageRun(raw, now) {
  const runId = text(raw?.id) ?? text(raw?.runId);
  if (!runId) return null;
  const branches = Array.isArray(raw?.git?.branches) ? raw.git.branches : [];
  const branch = text(branches.find((row) => text(row?.branch))?.branch) ?? text(raw?.git?.branch);
  const prUrl = text(branches.find((row) => text(row?.prUrl))?.prUrl) ?? text(raw?.git?.prUrl);
  const createdAt = text(raw?.createdAt);
  const status = text(raw?.status)?.toLowerCase() ?? null;
  return {
    runId,
    // The page's `CloudRunStatus` union, or null. An unknown status is null
    // rather than a raw string, because the page colours on this field.
    status: ["creating", "running", "finished", "error", "cancelled", "expired"].includes(status)
      ? status
      : null,
    modelId: text(raw?.model?.id) ?? text(raw?.modelId),
    branch: branch ?? null,
    prUrl: prUrl ?? null,
    createdAt,
    age: formatAge(createdAt, now),
  };
}

/**
 * Build the page's action table.
 *
 * Every collaborator arrives through a getter or a function on `deps`, for the
 * reason the header gives. Nothing here reaches a module-level binding.
 */
function createPageActions(deps) {
  const log = deps.log ?? (() => {});

  /** Are the lifecycle's bindings there yet? See the header. */
  function ready() {
    return Boolean(deps.sdk && deps.api && deps.runtime);
  }

  /**
   * One sentence for whatever refused, worded for a form.
   *
   * The message is Cursor's own or ADE's own, never a key: `CursorApiError`
   * carries a code, a status and the sentence the API returned, and the
   * credential never reaches it.
   */
  function failure(error, fallback) {
    return { ok: false, message: text(error?.message) ?? fallback };
  }

  /** The agent id behind whatever the page sent. */
  function readAgentId(args) {
    const frame = args && typeof args === "object" ? args : {};
    const context = frame.context && typeof frame.context === "object" ? frame.context : {};
    const pointer = context.pointer && typeof context.pointer === "object" ? context.pointer : {};
    return text(frame.agentId) ?? text(context.agentId) ?? text(pointer.agentId);
  }

  /** The lane a page press means: the row's own, then the caller's, then none. */
  function laneFor(entry, args) {
    return text(entry?.ownership?.laneId)
      ?? text(args?.laneId)
      ?? text(args?.context?.laneId)
      ?? null;
  }

  /* ── Shared reads ──────────────────────────────────────────────────────── */

  /**
   * Cursor's repositories, the lane's remote, and whether they meet.
   *
   * One function because the launch form and Enter must agree, and they can
   * only agree by asking the same question in the same order — which is what
   * `launchUnavailableReason` then answers.
   */
  async function launchProbe(laneId) {
    let repositories = [];
    let repoProbe = "ready";
    let repoProbeMessage = null;
    try {
      const listed = await deps.api.listRepositories();
      repositories = Array.isArray(listed?.items) ? listed.items : [];
    } catch (error) {
      repoProbe = "error";
      repoProbeMessage = text(error?.message) ?? "Cursor Cloud request failed.";
    }

    let laneRemote = null;
    let branch = null;
    let remoteProbe = "ready";
    let remoteError = null;
    if (laneId) {
      try {
        const remote = await deps.readLaneRemote(laneId);
        laneRemote = text(remote?.remoteUrl);
        branch = text(remote?.branch);
      } catch (error) {
        remoteProbe = "error";
        remoteError = text(error?.message) ?? "The git remote read failed.";
      }
    }

    const repoUrl = deps.findConnectedRepo(repositories, laneRemote);
    return { repositories, repoProbe, repoProbeMessage, laneRemote, branch, remoteProbe, remoteError, repoUrl };
  }

  /**
   * Run one of the plugin's OWN handlers and keep only what a page can draw.
   *
   * The mutations a page presses — stop, pull, archive, delete, copy — are the
   * same acts a panel row presses, and defining second copies of them here is
   * how two code paths for one act drift apart. What differs is the SHAPE: a
   * panel handler answers vocabulary (`{message}`, `{resetState}`,
   * `{navigate}`) and `PageActionResult` promises `{ok, message}`. So this
   * table invokes the one implementation and drops the rest — and it drops it
   * HERE, in the file that made the promise, rather than in the caller.
   */
  async function own(id, args) {
    let result;
    try {
      result = await deps.invokeOwnAction(id, args ?? {});
    } catch (error) {
      return failure(error, "Cursor Cloud request failed.");
    }
    return {
      ok: result?.ok !== false,
      message: typeof result?.message === "string" ? result.message : null,
    };
  }

  /** The pull request already open on a lane's branch, or null. */
  async function openPrFor(laneId, branch) {
    if (!laneId || !branch) return null;
    try {
      const result = await deps.sdk.actions.invoke("git", "getOpenPrForBranch", { laneId, branch });
      const prUrl = text(result?.prUrl);
      if (!prUrl) return null;
      return {
        prUrl,
        prNumber: integer(result?.prNumber),
        title: text(result?.title),
      };
    } catch (error) {
      // A repo with no `gh` credential answers nothing here, and a launch form
      // that refused to draw over it would be a form nobody could use.
      log("debug", `Could not read the open PR: ${error?.message ?? error}`);
      return null;
    }
  }

  return {
    /* ── Reads ───────────────────────────────────────────────────────────── */

    /**
     * The whole fleet page: five states, and every field present in each.
     *
     * `state` is what the page branches on; `entries`, `groups`, `counts` and
     * `footer` are populated for `list` and empty-but-present otherwise, which
     * is the contract `CloudFleetPage` states and the reason the page never has
     * to test a field for undefined.
     */
    async pageFleet(args = {}) {
      const now = Date.now();
      const empty = {
        state: "loading",
        error: null,
        entries: [],
        groups: emptyGroups(),
        laneOptions: [],
        archivedCount: 0,
        counts: { active: 0, lanes: 0, unlinked: 0, total: 0, archived: 0 },
        webhook: null,
        footer: "",
        fetchedAt: new Date(now).toISOString(),
      };
      if (!ready()) return empty;

      const webhook = await deps.readWebhookSnapshot().catch(() => null);
      const result = await deps.refreshFleet({ limit: args?.limit }).catch((error) => ({
        state: "error",
        error: text(error?.message) ?? "Cursor Cloud request failed.",
      }));
      if (result.state === "no-key") return { ...empty, state: "no-key", webhook };
      if (result.state === "error") {
        return { ...empty, state: "error", error: result.error ?? null, webhook };
      }

      const snapshot = deps.fleetSnapshot();
      // Archived rows are assembled but not drawn: the page's own "Show
      // archived (n)" affordance is a filter over `entries`, and `counts`
      // carries the number so the label can be written without a second read.
      const visible = snapshot.items.filter((entry) => !entry.agent.archived);
      const groups = decorateGroups(deps.groupFleet(visible), now);
      const counts = {
        active: groups.active.length,
        lanes: groups.lanes.length,
        unlinked: groups.unlinked.length,
        total: visible.length,
        archived: snapshot.archivedCount,
      };
      return {
        state: visible.length === 0 ? "empty" : "list",
        error: null,
        entries: visible.map((entry) => decorate(entry, now)),
        groups,
        laneOptions: snapshot.lanes,
        archivedCount: snapshot.archivedCount,
        counts,
        webhook,
        footer: deps.fleetFooter({ shown: counts.total, age: "just now" }),
        fetchedAt: new Date(snapshot.at || now).toISOString(),
      };
    },

    /**
     * One agent's detail pane.
     *
     * `entry` is null with a sentence in `error` for an agent this project's
     * fleet does not hold — deleted on cursor.com, or somebody else's — which
     * is a state the page draws rather than a rejection it has to catch.
     */
    async pageAgent(args = {}) {
      const now = Date.now();
      const empty = { entry: null, usage: null, runs: [], artifacts: [], sessionId: null, error: null };
      if (!ready()) return { ...empty, error: STARTING_UP };
      const agentId = readAgentId(args);
      if (!agentId) return { ...empty, error: "This action needs an agent id." };

      const entry = await deps.findEntry(agentId).catch(() => null);
      if (!entry) return { ...empty, error: "It is not in this project's fleet." };

      let usage = null;
      try {
        const raw = await deps.api.getAgentUsage(agentId);
        const costCents = Number.isFinite(raw?.cost?.chargedCents) ? raw.cost.chargedCents : null;
        usage = {
          totalTokens: integer(raw?.totalUsage?.totalTokens),
          inputTokens: integer(raw?.totalUsage?.inputTokens),
          outputTokens: integer(raw?.totalUsage?.outputTokens),
          costCents,
          cost: formatCost(costCents),
        };
      } catch {
        // Usage is a decoration. A key without the usage scope must not cost
        // the page the rest of the pane.
      }

      let runs = [];
      try {
        const page = await deps.api.listRuns(agentId, { limit: AGENT_RUNS_PAGE });
        runs = (Array.isArray(page?.items) ? page.items : [])
          .map((raw) => pageRun(raw, now))
          .filter(Boolean);
      } catch (error) {
        log("debug", `Could not list the runs for ${agentId}: ${error?.message ?? error}`);
      }

      const artifacts = [];
      try {
        const listed = await deps.api.listArtifacts(agentId);
        for (const raw of (Array.isArray(listed?.items) ? listed.items : []).slice(0, MAX_ARTIFACT_ROWS)) {
          const artifactPath = String(raw?.path ?? "").replace(/^\/+/, "");
          if (!artifactPath) continue;
          let url = null;
          try {
            const download = await deps.api.getArtifactDownloadUrl(agentId, artifactPath);
            const signed = text(download?.url);
            // HTTPS only. A `file:` or `data:` URL from a compromised answer
            // would be a link the page hands the reader's browser.
            if (signed && signed.startsWith("https:")) url = signed;
          } catch {
            // A signed URL this child cannot mint still lists the file. The row
            // draws the path with no download rather than vanishing.
          }
          artifacts.push({ path: artifactPath, bytes: integer(raw?.sizeBytes), url });
        }
      } catch (error) {
        log("debug", `Could not list the artifacts for ${agentId}: ${error?.message ?? error}`);
      }

      const link = await deps.links.get(agentId).catch(() => null);
      return {
        entry: decorate(entry, now),
        usage,
        runs,
        artifacts,
        sessionId: text(link?.sessionId) ?? entry.ownership.sessionId ?? null,
        error: null,
      };
    },

    /**
     * Everything the launch form draws, including why it may not draw at all.
     *
     * `unavailable` runs the SAME ladder `launchFromComposer` runs before a
     * Send, through `launch.js:launchUnavailableReason` — so the form and Enter
     * can never disagree about whether this lane can go to Cursor Cloud. The
     * model rungs are off here: the form is where a model gets picked, and a
     * form that refused to draw because no model was picked would be a form
     * that could never be used.
     */
    async pageLaunchContext(args = {}) {
      const empty = {
        unavailable: STARTING_UP,
        repoUrl: null,
        repoLabel: null,
        repoCaption: null,
        laneRemote: null,
        lanes: [],
        laneId: null,
        branch: null,
        models: [],
        showSpeed: false,
        reasoningOptions: [],
        secretNames: [],
        selectedSecrets: [],
        rememberSecretNames: false,
        autoOpenPr: false,
        existingPr: null,
        draft: typeof args?.draft === "string" ? args.draft : "",
      };
      if (!ready()) return empty;

      if (!(await deps.api.hasKey())) {
        return { ...empty, unavailable: "Add a Cursor API key in Settings → AI connections, then try again." };
      }

      const lanes = (await deps.listLanes().catch(() => []))
        .filter((row) => text(row?.id))
        .map((row) => ({ id: row.id, name: text(row?.name) ?? row.id }));
      const wanted = text(args?.laneId) ?? text(args?.context?.laneId);
      const lane = lanes.find((row) => row.id === wanted) ?? lanes[0] ?? null;

      const probe = await launchProbe(lane?.id ?? null);
      const unavailable = launchUnavailableReason({
        repoProbe: probe.repoProbe,
        repoProbeMessage: probe.repoProbeMessage,
        laneId: lane?.id ?? null,
        remoteProbe: probe.remoteProbe,
        remoteError: probe.remoteError,
        laneRemote: probe.laneRemote,
        repoConnected: Boolean(probe.repoUrl),
      });

      // The catalog, the remembered secrets and the open PR are read even when
      // `unavailable` is set, because the page draws the reason WITH the fields
      // greyed rather than an empty card — and a reader who fixes the reason
      // then has the form already populated.
      let models = [];
      let reasoningOptions = [];
      let showSpeed = false;
      try {
        const listed = await deps.api.listModels();
        const catalog = deps.readCatalog(listed?.items);
        const controls = deps.catalogControlOptions(catalog);
        reasoningOptions = controls.reasoning;
        showSpeed = controls.speed;
        models = catalog.map((row) => ({
          id: row.id,
          label: row.id,
          // Per-model, not per-catalog: `reasoningOptions` above is the union
          // the form's shared control offers, and this is what THIS model can
          // actually express. A page that offered a tier the row cannot take
          // would fail-close the launch at verify time.
          reasoningEfforts: deps.catalogControlOptions([row]).reasoning,
          speed: deps.catalogControlOptions([row]).speed,
        }));
      } catch (error) {
        // A key without the models scope draws the form without a picker, and
        // Cursor picks its own default — the same run, one tap later.
        log("debug", `Could not read Cursor's model catalog: ${error?.message ?? error}`);
      }

      const remembered = lane
        ? await deps.sdk.collections.get("laneSecrets", laneSecretsKey(lane.id)).catch(() => null)
        : null;
      const rememberedNames = (Array.isArray(remembered?.names) ? remembered.names : [])
        .filter((name) => isInjectableSecretName(name))
        .slice(0, MAX_ATTACHED_SECRETS);
      const config = await deps.sdk.config.get().catch(() => ({}));
      const existingPr = await openPrFor(lane?.id ?? null, probe.branch);

      return {
        unavailable,
        repoUrl: probe.repoUrl,
        repoLabel: probe.repoUrl ? repoLabel(probe.repoUrl) : null,
        repoCaption: probe.repoUrl ? repoCaption(probe.repoUrl) : null,
        laneRemote: probe.laneRemote,
        lanes: lanes.slice(0, MAX_LANE_CHOICES),
        laneId: lane?.id ?? null,
        branch: probe.branch,
        models,
        showSpeed,
        reasoningOptions,
        // Names only. A value never crosses this seam — see the header.
        secretNames: rememberedNames,
        selectedSecrets: rememberedNames,
        rememberSecretNames: rememberedNames.length > 0,
        autoOpenPr: config?.autoOpenPr === true,
        existingPr,
        draft: typeof args?.draft === "string" ? args.draft : "",
      };
    },

    /** Is there a Cursor key on this machine, and whose. NEVER the key. */
    async pageConnection() {
      if (!ready()) return { hasKey: false, apiKeyName: null, userEmail: null, message: STARTING_UP };
      if (!(await deps.api.hasKey())) {
        return {
          hasKey: false,
          apiKeyName: null,
          userEmail: null,
          message: "Connect a Cursor API key in Settings → AI connections.",
        };
      }
      try {
        const who = await deps.api.getMe();
        return {
          hasKey: true,
          apiKeyName: text(who?.apiKeyName),
          userEmail: text(who?.userEmail),
          message: null,
        };
      } catch (error) {
        // The key EXISTS; Cursor would not describe it. Saying "no key" here
        // would send the reader to Settings to fix something that is not wrong.
        return {
          hasKey: true,
          apiKeyName: null,
          userEmail: null,
          message: text(error?.message) ?? "Cursor Cloud request failed.",
        };
      }
    },

    /* ── Mutations ───────────────────────────────────────────────────────── */

    /**
     * The launch form's submit.
     *
     * The whole act runs in `index.js:runLaunch`, which is the same function
     * Enter runs — one launch path, two gestures — so the page's answer and the
     * composer's answer come out of the same code and the same sentences.
     */
    async pageLaunch(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      try {
        return await deps.runLaunch({
          prompt: text(args?.prompt) ?? "",
          laneId: text(args?.laneId),
          model: text(args?.model),
          reasoningEffort: text(args?.reasoningEffort),
          fastMode: args?.fastMode === true ? true : args?.fastMode === false ? false : null,
          openPr: args?.openPr === true,
          secretNames: Array.isArray(args?.secretNames) ? args.secretNames : [],
          rememberSecretNames: args?.rememberSecretNames === true,
        });
      } catch (error) {
        return failure(error, "Cursor refused the launch.");
      }
    },

    /** Adopt a cloud agent as an ADE chat, and say which chat it became. */
    async pageOpenInAde(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const agentId = readAgentId(args);
      if (!agentId) return { ok: false, message: "This action needs an agent id." };
      const entry = await deps.findEntry(agentId).catch(() => null);
      const laneId = laneFor(entry, args);
      if (!laneId) {
        return {
          ok: false,
          message: "Open a lane first — a cloud chat belongs to the lane whose branch it works on.",
        };
      }
      try {
        const ref = await deps.runtime.openAgent({
          agentId,
          laneId,
          title: text(entry?.agent?.name) ?? `Cursor Cloud ${agentId.slice(0, 8)}`,
        });
        void deps.refreshFleet();
        return {
          ok: true,
          message: ref.created
            ? "Opened this cloud agent as a chat in ADE."
            : "This cloud agent already has a chat in ADE.",
          sessionId: ref.sessionId ?? null,
        };
      } catch (error) {
        return failure(error, "Could not open this agent in ADE.");
      }
    },

    async pageStopRun(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const agentId = readAgentId(args);
      if (!agentId) return { ok: false, message: "This action needs an agent id." };
      return await own("stopRun", { agentId });
    },

    /**
     * A follow-up turn from the page.
     *
     * A follow-up is a new RUN on an agent that already exists, which is how
     * Cursor spells "keep going". It goes straight to Cursor rather than
     * through `chat.turn`: the page may be open on an agent with no ADE chat
     * bound to it at all, and refusing there would make Open-in-ADE a
     * precondition for answering a question.
     */
    async pageFollowUp(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const agentId = readAgentId(args);
      if (!agentId) return { ok: false, message: "This action needs an agent id." };
      const prompt = text(args?.prompt) ?? text(args?.message);
      if (!prompt) return { ok: false, message: "Say what the agent should do next." };
      try {
        const created = await deps.api.createRun(agentId, { prompt: { text: prompt } });
        const runId = text(created?.run?.id) ?? text(created?.id);
        void deps.refreshFleet();
        return { ok: true, message: "Sent to Cursor Cloud.", runId: runId ?? null };
      } catch (error) {
        return failure(error, "Cursor refused the follow-up.");
      }
    },

    async pagePullIntoLane(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const agentId = readAgentId(args);
      if (!agentId) return { ok: false, message: "This action needs an agent id." };
      return await own("pullIntoLane", { agentId, laneId: text(args?.laneId) });
    },

    async pageArchiveAgent(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const agentId = readAgentId(args);
      if (!agentId) return { ok: false, message: "This action needs an agent id." };
      return await own("archiveAgent", { agentId });
    },

    async pageUnarchiveAgent(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const agentId = readAgentId(args);
      if (!agentId) return { ok: false, message: "This action needs an agent id." };
      return await own("unarchiveAgent", { agentId });
    },

    async pageDeleteAgent(args = {}) {
      if (!ready()) return { ok: false, message: STARTING_UP };
      const agentId = readAgentId(args);
      if (!agentId) return { ok: false, message: "This action needs an agent id." };
      return await own("deleteAgent", { agentId });
    },

    /**
     * The page is on screen, so the unread pill is answered.
     *
     * Answers `null`, not `{ok}`. It is a notification, not a mutation the page
     * reports on — there is nothing for a reader to see either way, and a
     * `{ok: true}` would invite a toast for having looked at a list.
     */
    async pageAckBadge(args = {}) {
      if (!ready()) return null;
      await deps.ackTabBadge({ viewed: args?.viewed !== false }).catch(() => {});
      return null;
    },

    /** The webhook URL onto the clipboard. The tile's register action, from a page. */
    async pageCopyWebhookUrl() {
      if (!ready()) return { ok: false, message: STARTING_UP };
      return await own("copyWebhookUrl", {});
    },
  };
}

module.exports = {
  AGENT_RUNS_PAGE,
  MAX_ARTIFACT_ROWS,
  STARTING_UP,
  createPageActions,
  decorate,
  decorateGroups,
  pageRun,
};
