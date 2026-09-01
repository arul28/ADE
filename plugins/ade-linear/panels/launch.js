// Turning an issue into a lane, and optionally into an agent working on it.
//
// The phone's `LinearLaunchScreen` as a `form`. Nearly all of it survives the
// translation — a session-type picker is a two-option select, a model picker is
// a select over models the plugin materialized, reasoning effort and Codex fast
// mode are a select and a toggle — and the derived lane name, branch name and
// kickoff prompt are plugin code, so they read exactly as they always did.
//
// Two things do not survive, and both are named where they are lost:
//
// - **The kickoff prompt is one line, not a text area.** `form` has `text`,
//   `secret`, `select`, `toggle` and `number`, and none of them is multi-line.
//   A reader who wants a paragraph writes it in the chat once the agent starts.
// - **The model picker is a flat select, not `WorkModelPickerSheet`.** It loses
//   search, grouping and the provider marks. Forty options is the ceiling, so a
//   workspace with more models than that gets the ones the plugin thinks are
//   likeliest and can change provider to see the rest.

"use strict";

const { ACTIONS } = require("./contract");
const { COPY, DEEPLINK_LAUNCH, LIMITS, clamp, fallback, label, prose, value } = require("./common");

/** `LinearLaunchSessionType.title`, in its order. */
const SESSION_TYPES = [
  { value: "chat", label: "Chat" },
  { value: "cli", label: "CLI" },
  { value: "laneOnly", label: "Lane only" },
];

/**
 * The note the phone shows when the session type is lane-only, verbatim except
 * for the issue identifier it names.
 */
function laneOnlyNote(identifier) {
  return `A lane will be created and attached to ${identifier}. No agent is launched — start one whenever you’re ready.`;
}

function launchFallback(text) {
  return fallback(
    text ?? "Lanes launch on the computer that holds this plugin. Open ADE there to start one.",
    DEEPLINK_LAUNCH,
  );
}

/**
 * The launch panel.
 *
 * One `form` with a submit, rather than `applyOnChange`: this is the shape with
 * a cost — it creates a lane and may start an agent — and a settings-style
 * apply-as-you-type form would fire on the way past every field.
 */
function buildLaunchPanel(input = {}) {
  const {
    state = "form",
    issue = null,
    models = [],
    permissionModes = [],
    reasoningEfforts = [],
    laneOnly = false,
    error = null,
    unavailable = null,
  } = input;

  if (state === "loading") {
    return {
      v: 1,
      title: "Launch",
      fallback: launchFallback(),
      body: [
        {
          component: "emptyState",
          title: "Getting ready…",
          description: "Reading this project's lanes and the models you can run.",
          icon: "rocket",
        },
      ],
    };
  }

  if (!issue) {
    return {
      v: 1,
      title: "Launch",
      fallback: launchFallback(),
      body: [
        {
          component: "emptyState",
          title: "Pick an issue first",
          description: "Open an issue from the list, then launch a lane from it.",
          icon: "kanban",
          action: { label: "Back to issues", onPress: { action: ACTIONS.backToIssues } },
        },
      ],
    };
  }

  const title = laneOnly ? `New lane · ${issue.identifier}` : `Launch ${issue.identifier}`;

  if (unavailable) {
    return {
      v: 1,
      title: value(title),
      fallback: launchFallback(unavailable),
      body: [
        {
          component: "emptyState",
          title: "This issue cannot be launched here",
          description: prose(unavailable),
          icon: "kanban",
          action: { label: COPY.retry, onPress: { action: ACTIONS.refreshIssue, args: { issueId: String(issue.id) } } },
        },
      ],
    };
  }

  const body = [
    { component: "text", variant: "subtitle", text: prose(issue.title) },
    {
      component: "stack",
      direction: "horizontal",
      gap: "sm",
      wrap: true,
      align: "center",
      children: [
        { component: "badge", text: value(issue.identifier), icon: "tag" },
        ...(issue.stateName ? [{ component: "badge", text: label(issue.stateName), tone: "accent" }] : []),
      ],
    },
  ];

  const fields = [
    {
      kind: "select",
      id: "sessionType",
      label: "Session",
      options: SESSION_TYPES,
      value: laneOnly ? "laneOnly" : String(input.sessionType ?? "chat"),
    },
    {
      kind: "text",
      id: "laneName",
      label: "Lane name",
      value: value(input.laneName ?? ""),
    },
  ];

  if (models.length > 0) {
    fields.push({
      kind: "select",
      id: "model",
      label: "Model",
      options: models.slice(0, LIMITS.maxSelectOptions).map((model) => ({
        value: String(model.id),
        label: label(model.name || model.id),
      })),
      value: String(input.model ?? models[0].id),
    });
  }

  if (permissionModes.length > 0) {
    fields.push({
      kind: "select",
      id: "permissionMode",
      label: "Permissions",
      options: permissionModes.slice(0, LIMITS.maxSelectOptions).map((mode) => ({
        value: String(mode.value),
        label: label(mode.label || mode.value),
      })),
      value: String(input.permissionMode ?? permissionModes[0].value),
    });
  }

  if (reasoningEfforts.length > 0) {
    fields.push({
      kind: "select",
      id: "reasoningEffort",
      label: "Reasoning effort",
      options: reasoningEfforts.slice(0, LIMITS.maxSelectOptions).map((effort) => ({
        value: String(effort.value),
        label: label(effort.label || effort.value),
      })),
      value: String(input.reasoningEffort ?? ""),
    });
  }

  if (input.fastModeSupported) {
    fields.push({
      kind: "toggle",
      id: "fastMode",
      label: "Fast mode",
      value: input.fastMode === true,
    });
  }

  fields.push({
    kind: "text",
    id: "kickoff",
    label: "Kickoff prompt",
    help: "One line here. Say the rest to the agent once it starts.",
    // Clamped to a field value rather than to prose: this is what the reader
    // edits, and a value the form cannot hold is a value the launch would lose.
    value: clamp(input.kickoff ?? "", LIMITS.maxValueChars),
  });

  body.push({
    component: "form",
    fields: fields.slice(0, LIMITS.maxFormFields),
    submit: {
      label: laneOnly ? "Create" : "Launch",
      onPress: { action: ACTIONS.submitLaunch, args: { issueId: String(issue.id) } },
    },
  });

  if (input.branchName) {
    body.push({ component: "text", variant: "caption", text: COPY.branch });
    body.push({ component: "text", variant: "code", text: value(input.branchName) });
  }

  if (laneOnly) {
    body.push({ component: "text", variant: "caption", text: prose(laneOnlyNote(issue.identifier)) });
  }

  if (error) {
    body.push({ component: "text", variant: "caption", tone: "warning", text: prose(error) });
  }

  return { v: 1, title: value(title), fallback: launchFallback(), body };
}

module.exports = { SESSION_TYPES, buildLaunchPanel, laneOnlyNote };
