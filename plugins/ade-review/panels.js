// The four panel schemas, built on this machine.
//
// Every sentence a reader sees is here rather than in four renderers. The copy
// is ported from the compiled Review tab (`ReviewPage.tsx`,
// `ReviewLearningsPanel.tsx`, `PrRequestAiReviewDialog.tsx`).

"use strict";

const {
  COLLECTION_FINDINGS,
  COLLECTION_RUNS,
  COLLECTION_SUPPRESSIONS,
  DEEPLINK_LAUNCH,
  DEEPLINK_LEARNINGS,
  DEEPLINK_RUN,
  DEEPLINK_RUNS,
  FINDING_ROW_ACTIONS,
  RUN_ROW_ACTIONS,
  STATE_LANE,
  STATE_STATUS,
  SUPPRESSION_ROW_ACTIONS,
  formatTime,
  readString,
  statusLabel,
  statusTone,
  targetModeLabel,
} = require("./format");
const { REASONING_EFFORTS, TARGET_MODES, TARGET_MODE_LABELS, commitOptions, laneOptions } = require("./launch");

function fallback(title, text, deeplink) {
  return { title, text, deeplink };
}

function runsWhere() {
  return [
    { field: "status", in: { $state: STATE_STATUS } },
    { field: "laneId", in: { $state: STATE_LANE } },
  ];
}

function filterRow(input = {}) {
  const lanes = Array.isArray(input.laneOptions) ? input.laneOptions : [];
  const children = [
    {
      component: "segmented",
      stateKey: STATE_STATUS,
      label: "Status",
      default: "",
      options: [
        { value: "", label: "All" },
        { value: "active", label: "Active", ...(input.counts?.active ? { badge: String(input.counts.active) } : {}) },
        { value: "completed", label: "Completed" },
        { value: "failed", label: "Failed" },
      ],
    },
  ];
  if (lanes.length >= 1) {
    children.push({
      component: "segmented",
      stateKey: STATE_LANE,
      label: "Lane",
      default: "",
      options: [
        { value: "", label: "All lanes" },
        ...lanes.slice(0, 7).map((lane) => ({ value: lane.id, label: lane.name })),
      ],
    });
  }
  return { component: "stack", direction: "horizontal", gap: "sm", wrap: true, children };
}

function buildRunsPanel(input = {}) {
  if (input.state === "error") {
    return {
      v: 1,
      title: "Review",
      fallback: fallback("Review", input.error ?? "Could not load review runs.", DEEPLINK_RUNS),
      body: [{
        component: "emptyState",
        title: "Could not load reviews",
        description: input.error ?? "The host did not answer.",
        icon: "git-pull-request",
        action: { label: "Try again", onPress: { action: "refreshRuns" } },
      }],
    };
  }

  const empty = !input.hasRuns;
  const body = [];

  if (!empty) body.push(filterRow(input));

  body.push({
    component: "list",
    bind: {
      collection: COLLECTION_RUNS,
      keyPrefix: "run:",
      limit: 100,
      allowActions: RUN_ROW_ACTIONS,
      where: runsWhere(),
    },
    emptyText: "No review runs yet. Launch one to inspect a lane, a commit range, or uncommitted changes.",
  });

  return {
    v: 1,
    title: "Review",
    fallback: fallback(
      "Review",
      "Open ADE on the computer that holds this plugin to run and read AI reviews.",
      DEEPLINK_RUNS,
    ),
    chrome: {
      navActions: [
        { action: "openLaunch", label: "Launch", icon: "play" },
        { action: "openLearnings", label: "Learnings", icon: "sparkle" },
      ],
    },
    body,
  };
}

function buildRunPanel(input = {}) {
  const run = input.run;
  if (!run) {
    return {
      v: 1,
      title: "Review run",
      fallback: fallback("Review run", input.error ?? "That run is not in this project.", DEEPLINK_RUN),
      body: [{
        component: "emptyState",
        title: input.error ? "Could not load this run" : "That run is not here",
        description: input.error ?? "It is not in this project's review history.",
        icon: "git-pull-request",
        action: { label: "Back to runs", onPress: { action: "openRuns" } },
      }],
    };
  }

  const status = readString(run.status) ?? "queued";
  const live = status === "queued" || status === "running";
  const rows = [
    { key: "Status", value: statusLabel(status), tone: statusTone(status) },
    { key: "Scope", value: readString(run.targetLabel) ?? targetModeLabel(run.target?.mode) },
  ];
  if (readString(run.summary)) rows.push({ key: "Summary", value: run.summary });
  if (readString(run.errorMessage)) rows.push({ key: "Error", value: run.errorMessage, tone: "danger" });
  const started = formatTime(run.startedAt);
  const ended = formatTime(run.endedAt);
  if (started) rows.push({ key: "Started", value: started });
  if (ended) rows.push({ key: "Ended", value: ended });
  if (run.config?.publishBehavior === "auto_publish") {
    rows.push({ key: "Publish", value: "Post findings to GitHub" });
  }

  const publications = Array.isArray(run.publications) ? run.publications : [];
  const publication = publications[0];
  if (publication) {
    rows.push({
      key: "GitHub review",
      value: readString(publication.status) === "published"
        ? (readString(publication.reviewUrl) ?? "Published")
        : (readString(publication.errorMessage) ?? "Not published"),
      tone: readString(publication.status) === "published" ? "success" : "warning",
    });
  }

  const reviewers = Array.isArray(run.reviewerRuns) ? run.reviewerRuns : [];
  const passRows = reviewers.map((pass) => ({
    key: readString(pass.label) ?? readString(pass.reviewerKey) ?? "Pass",
    value: statusLabel(pass.status),
    tone: statusTone(pass.status),
  }));

  const finding = input.finding;
  const body = [
    { component: "keyValue", rows },
  ];
  if (passRows.length) {
    body.push({ component: "divider", label: "Specialist passes" });
    body.push({ component: "keyValue", rows: passRows });
  }
  if (finding) {
    body.push({ component: "divider", label: "Finding" });
    body.push({
      component: "markdown",
      text: `# ${readString(finding.title) ?? "Finding"}\n\n${readString(finding.body) ?? ""}`.slice(0, 4000),
    });
  }
  body.push({ component: "divider", label: "Findings" });
  body.push({
    component: "list",
    bind: {
      collection: COLLECTION_FINDINGS,
      keyPrefix: `finding:${run.id}:`,
      limit: 100,
      allowActions: FINDING_ROW_ACTIONS,
    },
    emptyText: live ? "The reviewers are still working." : "No findings on this run.",
  });

  const navActions = [{ action: "openRuns", label: "Runs" }];
  if (live) {
    navActions.push({ action: "cancelRun", label: "Cancel", args: { runId: run.id } });
  } else {
    navActions.push({ action: "rerun", label: "Rerun", args: { runId: run.id } });
  }
  if (readString(run.chatSessionId)) {
    navActions.push({ action: "openChat", label: "Transcript", args: { runId: run.id } });
  }

  return {
    v: 1,
    title: readString(run.summary) || "Review run",
    fallback: fallback("Review run", "Open ADE on the computer that holds this plugin to read this run.", DEEPLINK_RUN),
    chrome: { navActions },
    body,
  };
}

function buildLaunchPanel(input = {}) {
  if (input.error) {
    return {
      v: 1,
      title: "Launch a review",
      fallback: fallback("Launch a review", input.error, DEEPLINK_LAUNCH),
      body: [{
        component: "emptyState",
        title: "Cannot launch a review",
        description: input.error,
        icon: "play",
        action: { label: "Back to runs", onPress: { action: "openRuns" } },
      }],
    };
  }

  const lanes = laneOptions(input.lanes);
  const form = input.form ?? {};
  const targetMode = TARGET_MODES.includes(form.targetMode) ? form.targetMode : "lane_diff";
  const fromPr = targetMode === "pr";
  const fields = [
    {
      kind: "select",
      id: "laneId",
      label: "Lane",
      help: "The review runs inside this lane's worktree.",
      options: lanes,
      ...(form.laneId ? { value: form.laneId } : lanes[0] ? { value: lanes[0].value } : {}),
    },
  ];

  if (!fromPr) {
    fields.push({
      kind: "select",
      id: "targetMode",
      label: "What to review",
      options: TARGET_MODES.filter((mode) => mode !== "pr").map((mode) => ({
        value: mode,
        label: TARGET_MODE_LABELS[mode],
      })),
      value: targetMode === "pr" ? "lane_diff" : targetMode,
    });
  }

  if (targetMode === "lane_diff") {
    fields.push({
      kind: "select",
      id: "compareKind",
      label: "Compare against",
      options: [
        { value: "default_branch", label: "Default branch" },
        { value: "lane", label: "Another lane" },
      ],
      value: form.compareKind === "lane" ? "lane" : "default_branch",
    });
    if (form.compareKind === "lane") {
      fields.push({
        kind: "select",
        id: "compareLaneId",
        label: "Comparison lane",
        options: lanes.filter((lane) => lane.value !== form.laneId),
        ...(form.compareLaneId ? { value: form.compareLaneId } : {}),
      });
    }
  }

  if (targetMode === "commit_range") {
    const commits = commitOptions(input.commits);
    fields.push({
      kind: "select",
      id: "baseCommit",
      label: "Earlier commit (excluded)",
      options: commits,
      ...(form.baseCommit ? { value: form.baseCommit } : {}),
    });
    fields.push({
      kind: "select",
      id: "headCommit",
      label: "Later commit (included)",
      options: commits,
      ...(form.headCommit ? { value: form.headCommit } : {}),
    });
  }

  if (fromPr) {
    fields.push({
      kind: "text",
      id: "prId",
      label: "Pull request",
      value: form.prId ?? "",
    });
  }

  fields.push({
    kind: "text",
    id: "modelId",
    label: "Model",
    value: form.modelId ?? "",
    help: "Leave as ADE's default unless you want a specific model.",
  });
  fields.push({
    kind: "select",
    id: "reasoningEffort",
    label: "Reasoning",
    options: REASONING_EFFORTS,
    value: form.reasoningEffort ?? "low",
  });
  fields.push({
    kind: "toggle",
    id: "fastMode",
    label: "Fast mode",
    value: form.fastMode === true,
  });
  fields.push({
    kind: "select",
    id: "publishBehavior",
    label: "Publish",
    options: [
      { value: "local_only", label: "Keep findings local" },
      { value: "auto_publish", label: "Post to GitHub as a review" },
    ],
    value: form.publishBehavior ?? (fromPr ? "auto_publish" : "local_only"),
  });

  const caption = fromPr
    ? "ADE reviews this PR's lane and can post findings back as GitHub review comments from your account."
    : "The review agent is read-only. It inspects the chosen diff and returns findings; it never edits, commits, or pushes.";

  return {
    v: 1,
    title: fromPr ? "Request AI review" : "Launch a review",
    fallback: fallback("Launch a review", "Reviews launch from the computer that holds this plugin.", DEEPLINK_LAUNCH),
    body: [
      { component: "text", variant: "caption", text: caption },
      {
        component: "form",
        fields: fields.slice(0, 24),
        applyOnChange: { action: "redrawLaunch" },
        submit: { label: fromPr ? "Request AI review" : "Start review", onPress: { action: "startRun" } },
      },
    ],
  };
}

function buildLearningsPanel(input = {}) {
  const report = input.report;
  const rows = report
    ? [
      { key: "Runs", value: String(report.totalRuns ?? 0) },
      { key: "Findings", value: String(report.totalFindings ?? 0) },
      { key: "Acknowledged", value: String(report.addressedCount ?? 0) },
      { key: "Dismissed", value: String(report.dismissedCount ?? 0) },
      { key: "Snoozed", value: String(report.snoozedCount ?? 0) },
      { key: "Suppressed", value: String(report.suppressedCount ?? 0) },
      { key: "Published", value: String(report.publishedCount ?? 0) },
    ]
    : [];
  if (report && Number.isFinite(report.noiseRate)) {
    rows.push({ key: "Noise rate", value: `${Math.round(report.noiseRate * 100)}%` });
  }

  return {
    v: 1,
    title: "Review learnings",
    fallback: fallback("Review learnings", "Open ADE on the computer that holds this plugin to manage suppressions.", DEEPLINK_LEARNINGS),
    chrome: { navActions: [{ action: "openRuns", label: "Runs" }] },
    body: [
      ...(rows.length ? [{ component: "keyValue", rows }] : [{
        component: "emptyState",
        title: "No learnings yet",
        description: "Run a review and acknowledge or dismiss findings to build this report.",
        icon: "sparkle",
      }]),
      { component: "divider", label: "Suppressions" },
      {
        component: "list",
        bind: {
          collection: COLLECTION_SUPPRESSIONS,
          keyPrefix: "suppression:",
          limit: 100,
          allowActions: SUPPRESSION_ROW_ACTIONS,
        },
        emptyText: "No suppressions. Suppress a finding from a run to skip similar ones later.",
      },
    ],
  };
}

function build(panelId, view = {}) {
  switch (panelId) {
    case "runs":
      return buildRunsPanel(view);
    case "run":
      return buildRunPanel(view);
    case "launch":
      return buildLaunchPanel(view);
    case "learnings":
      return buildLearningsPanel(view);
    default:
      return null;
  }
}

module.exports = {
  build,
  buildLaunchPanel,
  buildLearningsPanel,
  buildRunPanel,
  buildRunsPanel,
  filterRow,
  runsWhere,
};
