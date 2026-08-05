export const MANAGED_TAG = "ade-managed";
export const SPEC_VERSION_TAG = "ade-spec:v1";
export const SYSTEM_EVENTS = Object.freeze(["$identify"]);

export const EVENTS = Object.freeze({
  APP_INSTALLED: "ade_app_installed",
  APP_OPENED: "ade_app_opened",
  ACTIVATED: "ade_activated",
  SCREEN_VIEWED: "ade_screen_viewed",
  PROJECT_OPENED: "ade_project_opened",
  FEATURE_USED: "ade_feature_used",
  WORK_SESSION_STARTED: "ade_work_session_started",
  WORK_SESSION_COMPLETED: "ade_work_session_completed",
  ERROR: "ade_error",
  DAILY_USAGE_SUMMARY: "ade_daily_usage_summary",
  ANALYTICS_BUDGET: "ade_analytics_budget",
  UPDATE_INSTALL_ABORTED: "ade_update_install_aborted",
  UPDATE_QUIT_ESCALATED: "ade_update_quit_escalated",
  UPDATE_INSTALL_DID_NOT_LAND: "ade_update_install_did_not_land",
  UPDATE_AUTO_APPLIED: "ade_update_auto_applied",
  UPDATE_AUTO_APPLY_CANCELLED: "ade_update_auto_apply_cancelled",
  UPDATE_PROMPTED: "ade_update_prompted",
  TOOL_FETCHED: "ade_tool_fetched",
  BRAIN_RECOVERED: "ade_brain_recovered",
  PUBLISH_FAILING: "ade_publish_failing",
  RELAY_SUPPRESSED: "ade_relay_suppressed",
  ACCOUNT_SESSION_UNREADABLE: "ade_account_session_unreadable",
  MARKETING_APP_OPENED: "ade_marketing_app_opened",
  MARKETING_SCREEN_VIEWED: "ade_marketing_screen_viewed",
  MARKETING_CTA_CLICKED: "ade_marketing_cta_clicked",
  MARKETING_FEATURE_USED: "ade_marketing_feature_used",
  MARKETING_ERROR: "ade_marketing_error",
  MARKETING_ANALYTICS_BUDGET: "ade_marketing_analytics_budget",
  MOBILE_APP_OPENED: "ade_mobile_app_opened",
  MOBILE_SCREEN_VIEWED: "ade_mobile_screen_viewed",
  MOBILE_FEATURE_USED: "ade_mobile_feature_used",
  MOBILE_ERROR: "ade_mobile_error",
  MOBILE_ANALYTICS_BUDGET: "ade_mobile_analytics_budget",
});

const ALL_INGESTED_EVENTS = Object.freeze([...Object.values(EVENTS), ...SYSTEM_EVENTS]);
const INGESTED_EVENT_CHUNKS = Object.freeze(
  Array.from({ length: Math.ceil(ALL_INGESTED_EVENTS.length / 26) }, (_, index) =>
    Object.freeze(ALL_INGESTED_EVENTS.slice(index * 26, (index + 1) * 26))),
);
const eventFormula = (events) => events
  .map((_, index) => String.fromCharCode("A".charCodeAt(0) + index))
  .join("+");

export const PROPERTIES = Object.freeze({
  SURFACE: "surface",
  SCREEN: "screen",
  FEATURE: "feature",
  ACTION: "action",
  OUTCOME: "outcome",
  APP_VERSION: "app_version",
  RUNTIME_MODE: "runtime_mode",
  PROVIDER: "provider",
  MODEL_FAMILY: "model_family",
  PROJECT_ID: "project_id",
  SESSION_ID: "session_id",
  DURATION_BUCKET: "duration_bucket",
  ERROR_KIND: "error_kind",
  RECOVERABLE: "recoverable",
  SENT_COUNT: "sent_count",
  DROPPED_COUNT: "dropped_count",
  DROP_REASON: "drop_reason",
  SUMMARY_KIND: "summary_kind",
  INSTALL_SOURCE: "install_source",
  TRIGGER: "trigger",
  TIME_SINCE_INSTALL_SECONDS: "time_since_install_seconds",
  USER_ACTION: "user_action",
  CTA_LABEL: "cta_label",
  POSITION: "position",
});

const dateRange = (dateFrom) => ({ date_from: dateFrom, explicitDate: false });

const eventNode = (event, customName, options = {}) => ({
  kind: "EventsNode",
  event,
  custom_name: customName,
  ...(options.properties ? { properties: options.properties } : {}),
  ...(options.math ? { math: options.math } : {}),
  ...(options.mathProperty ? { math_property: options.mathProperty } : {}),
});

const eventProperty = (key, value, operator = "exact") => ({
  key,
  value,
  operator,
  type: "event",
});

function trends({
  series,
  interval = "week",
  dateFrom = "-90d",
  display = "ActionsLineGraph",
  breakdown,
  breakdownLimit = 20,
  properties = [],
  formula,
  aggregationAxisFormat = "numeric",
  goalLines,
}) {
  return {
    kind: "InsightVizNode",
    source: {
      kind: "TrendsQuery",
      series,
      interval,
      dateRange: dateRange(dateFrom),
      properties,
      trendsFilter: {
        display,
        showLegend: !formula && (series.length > 1 || Boolean(breakdown)),
        showValuesOnSeries: display === "ActionsBarValue",
        aggregationAxisFormat,
        ...(formula ? { formula } : {}),
        ...(goalLines ? { goalLines } : {}),
      },
      ...(breakdown
        ? {
            breakdownFilter: {
              breakdown,
              breakdown_type: "event",
              breakdown_limit: breakdownLimit,
            },
          }
        : {}),
      filterTestAccounts: false,
    },
  };
}

function funnel({ series, dateFrom = "-90d", windowInterval = 7, windowUnit = "day" }) {
  return {
    kind: "InsightVizNode",
    source: {
      kind: "FunnelsQuery",
      series,
      dateRange: dateRange(dateFrom),
      properties: [],
      funnelsFilter: {
        layout: "horizontal",
        funnelVizType: "steps",
        funnelOrderType: "ordered",
        funnelStepReference: "total",
        funnelWindowInterval: windowInterval,
        funnelWindowIntervalUnit: windowUnit,
      },
      filterTestAccounts: false,
    },
  };
}

function retention({ event, dateFrom = "-12w", period = "Week", intervals = 12 }) {
  const entity = {
    kind: "EventsNode",
    id: event,
    name: event,
    type: "events",
    properties: [],
  };

  return {
    kind: "InsightVizNode",
    source: {
      kind: "RetentionQuery",
      dateRange: dateRange(dateFrom),
      properties: [],
      retentionFilter: {
        period,
        targetEntity: entity,
        returningEntity: entity,
        retentionType: "retention_recurring",
        retentionReference: "total",
        totalIntervals: intervals,
      },
      filterTestAccounts: false,
    },
  };
}

function insight(key, name, description, query) {
  return { key, name, description, query };
}

export const dashboardSpec = Object.freeze({
  version: 1,
  dashboards: [
    {
      key: "growth-retention",
      name: "ADE · Growth and retention",
      description: "Activation, first value, work-session starts, and recurring weekly use across ADE.",
      pinned: true,
      insights: [
        insight(
          "weekly-active-installations",
          "Weekly active installations",
          "Unique installations that used an ADE feature in each week.",
          trends({
            series: [eventNode(EVENTS.FEATURE_USED, "Active installations", { math: "dau" })],
          }),
        ),
        insight(
          "first-value-funnel",
          "Install to activation funnel",
          "Fresh desktop install → project open → first completed work session within seven days. Existing installations are intentionally not backfilled as new installs.",
          funnel({
            series: [
              eventNode(EVENTS.APP_INSTALLED, "Installed ADE"),
              eventNode(EVENTS.PROJECT_OPENED, "Opened a project"),
              eventNode(EVENTS.ACTIVATED, "Completed first work session"),
            ],
          }),
        ),
        insight(
          "activation-time",
          "Average time to activation",
          "Average seconds from fresh install to the first completed work session.",
          trends({
            series: [eventNode(EVENTS.ACTIVATED, "Time to activation", {
              math: "avg",
              mathProperty: PROPERTIES.TIME_SINCE_INSTALL_SECONDS,
            })],
            interval: "week",
          }),
        ),
        insight(
          "weekly-feature-retention",
          "Weekly feature-use retention",
          "Installations that use a feature and return to use any feature in a later week.",
          retention({ event: EVENTS.FEATURE_USED }),
        ),
        insight(
          "completed-work-sessions",
          "Started work sessions by feature",
          "Work-session starts per week, split by the allowlisted chat or CLI feature category.",
          trends({
            series: [eventNode(EVENTS.WORK_SESSION_STARTED, "Started sessions")],
            breakdown: PROPERTIES.FEATURE,
          }),
        ),
        insight(
          "project-adoption",
          "Installations opening projects",
          "Unique installations that opened at least one project in each week.",
          trends({
            series: [eventNode(EVENTS.PROJECT_OPENED, "Project-opening installations", { math: "dau" })],
          }),
        ),
      ],
    },
    {
      key: "surface-feature-adoption",
      name: "ADE · Surface and feature adoption",
      description: "Which ADE surfaces, screens, runtime modes, providers, and product features people actually use.",
      pinned: true,
      insights: [
        insight(
          "active-installations-by-surface",
          "Feature-active installations by surface",
          "Unique installations with successful feature activity on desktop, mobile, TUI, web, or API surfaces.",
          trends({
            series: [eventNode(EVENTS.FEATURE_USED, "Feature-active installations", { math: "dau" })],
            breakdown: PROPERTIES.SURFACE,
          }),
        ),
        insight(
          "screen-adoption",
          "Screen adoption",
          "Unique installations viewing each allowlisted screen over the last 30 days.",
          trends({
            series: [eventNode(EVENTS.SCREEN_VIEWED, "Screen viewers", { math: "dau" })],
            dateFrom: "-30d",
            interval: "month",
            display: "ActionsBarValue",
            breakdown: PROPERTIES.SCREEN,
          }),
        ),
        insight(
          "feature-adoption",
          "Feature adoption",
          "Unique installations using each allowlisted ADE feature over the last 30 days.",
          trends({
            series: [eventNode(EVENTS.FEATURE_USED, "Feature users", { math: "dau" })],
            dateFrom: "-30d",
            interval: "month",
            display: "ActionsBarValue",
            breakdown: PROPERTIES.FEATURE,
          }),
        ),
        insight(
          "runtime-mode-adoption",
          "Runtime mode adoption",
          "Weekly app opens split by packaged, development, web, project-runtime, or other coarse runtime mode.",
          trends({
            series: [eventNode(EVENTS.APP_OPENED, "Active installations", { math: "dau" })],
            breakdown: PROPERTIES.RUNTIME_MODE,
          }),
        ),
        insight(
          "provider-adoption",
          "Provider adoption",
          "Unique installations reporting daily usage, split by privacy-safe agent provider category.",
          trends({
            series: [eventNode(EVENTS.DAILY_USAGE_SUMMARY, "Provider users", { math: "dau" })],
            breakdown: PROPERTIES.PROVIDER,
            properties: [eventProperty(PROPERTIES.SUMMARY_KIND, "provider")],
          }),
        ),
        insight(
          "model-family-adoption",
          "Model-family adoption",
          "Unique installations reporting daily usage, split by privacy-safe model family.",
          trends({
            series: [eventNode(EVENTS.DAILY_USAGE_SUMMARY, "Model-family users", { math: "dau" })],
            breakdown: PROPERTIES.MODEL_FAMILY,
            properties: [eventProperty(PROPERTIES.SUMMARY_KIND, "model")],
          }),
        ),
      ],
    },
    {
      key: "native-mobile-engagement",
      name: "ADE · Native mobile engagement",
      description: "Direct iOS app reach, screen and native-control adoption, reliability, and its device-local event budget.",
      pinned: true,
      insights: [
        insight(
          "weekly-native-mobile-installations",
          "Weekly native mobile installations",
          "Unique anonymous iOS installation IDs that opened the app in each week. Host-executed mobile mutations remain in the product dashboards under the host installation ID.",
          trends({
            series: [eventNode(EVENTS.MOBILE_APP_OPENED, "Native mobile installations", { math: "dau" })],
          }),
        ),
        insight(
          "native-mobile-screen-adoption",
          "Native mobile screen adoption",
          "Unique anonymous iOS installation IDs viewing each allowlisted native screen over the last 30 days.",
          trends({
            series: [eventNode(EVENTS.MOBILE_SCREEN_VIEWED, "Native screen viewers", { math: "dau" })],
            dateFrom: "-30d",
            interval: "month",
            display: "ActionsBarValue",
            breakdown: PROPERTIES.SCREEN,
          }),
        ),
        insight(
          "native-mobile-feature-adoption",
          "Native mobile control adoption",
          "Unique anonymous iOS installation IDs using each allowlisted phone-local control, such as pairing, deep links, notifications, or dictation.",
          trends({
            series: [eventNode(EVENTS.MOBILE_FEATURE_USED, "Native control users", { math: "dau" })],
            dateFrom: "-30d",
            interval: "month",
            display: "ActionsBarValue",
            breakdown: PROPERTIES.FEATURE,
          }),
        ),
        insight(
          "native-mobile-feature-outcomes",
          "Native mobile control outcomes",
          "Allowlisted outcomes for direct iOS controls, split into opened, started, completed, cancelled, failure, approved, or denied.",
          trends({
            series: [eventNode(EVENTS.MOBILE_FEATURE_USED, "Native control outcomes")],
            breakdown: PROPERTIES.OUTCOME,
          }),
        ),
        insight(
          "native-mobile-errors",
          "Native mobile errors by kind",
          "Coarse recoverable iOS error categories. Raw messages and stack traces are never captured.",
          trends({
            series: [eventNode(EVENTS.MOBILE_ERROR, "Native mobile errors")],
            breakdown: PROPERTIES.ERROR_KIND,
          }),
        ),
        insight(
          "native-mobile-event-budget",
          "Native mobile analytics attempts accepted vs dropped",
          "Delayed device-budget rollups for iOS's 20-event/day ceiling; a rollup appears only after a later-day capture.",
          trends({
            series: [
              eventNode(EVENTS.MOBILE_ANALYTICS_BUDGET, "Accepted", {
                math: "sum",
                mathProperty: PROPERTIES.SENT_COUNT,
              }),
              eventNode(EVENTS.MOBILE_ANALYTICS_BUDGET, "Dropped", {
                math: "sum",
                mathProperty: PROPERTIES.DROPPED_COUNT,
              }),
            ],
            interval: "day",
            dateFrom: "-30d",
          }),
        ),
      ],
    },
    {
      key: "marketing-acquisition",
      name: "ADE · Marketing acquisition",
      description: "Public-site reach, page interest, conversion intent, reliability, and its isolated event budget.",
      pinned: true,
      insights: [
        insight(
          "weekly-marketing-visitors",
          "Weekly marketing visitors",
          "Unique anonymous visitors who opened the public ADE website in each week.",
          trends({
            series: [eventNode(EVENTS.MARKETING_APP_OPENED, "Marketing visitors", { math: "dau" })],
          }),
        ),
        insight(
          "homepage-get-started-funnel",
          "Homepage to get-started funnel",
          "Public-site visit → homepage view → Get started click within seven days. Marketing identities never enter product-retention metrics.",
          funnel({
            series: [
              eventNode(EVENTS.MARKETING_APP_OPENED, "Visited the site"),
              eventNode(EVENTS.MARKETING_SCREEN_VIEWED, "Viewed the homepage", {
                properties: [eventProperty(PROPERTIES.SCREEN, "home")],
              }),
              eventNode(EVENTS.MARKETING_CTA_CLICKED, "Clicked Get started", {
                properties: [eventProperty(PROPERTIES.CTA_LABEL, "get_started_free")],
              }),
            ],
          }),
        ),
        insight(
          "marketing-page-interest",
          "Marketing page interest",
          "Unique anonymous visitors to each allowlisted public-site page over the last 30 days.",
          trends({
            series: [eventNode(EVENTS.MARKETING_SCREEN_VIEWED, "Page visitors", { math: "dau" })],
            dateFrom: "-30d",
            interval: "month",
            display: "ActionsBarValue",
            breakdown: PROPERTIES.SCREEN,
          }),
        ),
        insight(
          "marketing-cta-interest",
          "Marketing CTA interest",
          "Unique anonymous visitors using each allowlisted public-site call to action over the last 30 days.",
          trends({
            series: [eventNode(EVENTS.MARKETING_CTA_CLICKED, "CTA visitors", { math: "dau" })],
            dateFrom: "-30d",
            interval: "month",
            display: "ActionsBarValue",
            breakdown: PROPERTIES.CTA_LABEL,
          }),
        ),
        insight(
          "marketing-errors-by-kind",
          "Marketing errors by kind",
          "Coarse public-site error categories. Raw messages and stack traces are never captured.",
          trends({
            series: [eventNode(EVENTS.MARKETING_ERROR, "Marketing errors")],
            breakdown: PROPERTIES.ERROR_KIND,
          }),
        ),
        insight(
          "marketing-event-budget",
          "Marketing analytics attempts accepted vs dropped",
          "Daily browser-budget rollups, isolated from the desktop/runtime installation budget.",
          trends({
            series: [
              eventNode(EVENTS.MARKETING_ANALYTICS_BUDGET, "Accepted", {
                math: "sum",
                mathProperty: PROPERTIES.SENT_COUNT,
              }),
              eventNode(EVENTS.MARKETING_ANALYTICS_BUDGET, "Dropped", {
                math: "sum",
                mathProperty: PROPERTIES.DROPPED_COUNT,
              }),
            ],
            interval: "day",
            dateFrom: "-30d",
          }),
        ),
      ],
    },
    {
      key: "reliability-budget",
      name: "ADE · Reliability and analytics budget",
      description: "Product errors, successful feature activity, and hard visibility into PostHog event-volume guardrails.",
      pinned: true,
      insights: [
        insight(
          "errors-by-surface",
          "Errors by surface",
          "Allowlisted error events by ADE surface. Error messages and stack traces are never included.",
          trends({
            series: [eventNode(EVENTS.ERROR, "Errors")],
            breakdown: PROPERTIES.SURFACE,
          }),
        ),
        insight(
          "errors-by-kind",
          "Errors by kind",
          "Allowlisted error categories over the last 30 days.",
          trends({
            series: [eventNode(EVENTS.ERROR, "Errors")],
            dateFrom: "-30d",
            interval: "month",
            display: "ActionsBarValue",
            breakdown: PROPERTIES.ERROR_KIND,
          }),
        ),
        insight(
          "unrecoverable-errors",
          "Errors by action",
          "Allowlisted error counts split by the coarse action category; raw messages and stack traces are excluded.",
          trends({
            series: [eventNode(EVENTS.ERROR, "Errors")],
            breakdown: PROPERTIES.ACTION,
          }),
        ),
        insight(
          "work-session-outcomes",
          "First agent-turn outcomes",
          "The first persisted terminal agent turn in each work session, split into completed, cancelled, or failed outcomes.",
          trends({
            series: [eventNode(EVENTS.WORK_SESSION_COMPLETED, "Settled work sessions")],
            breakdown: PROPERTIES.OUTCOME,
          }),
        ),
        insight(
          "reliability-incidents",
          "Reliability incidents",
          "Brain wedge recoveries, sustained route-publish failures, unreadable brain account sessions, relay suppression by a rival process, and update-flow aborts/escalations. Coarse counts only; command names are closed action slugs and no payload content is ever attached.",
          trends({
            series: [
              eventNode(EVENTS.BRAIN_RECOVERED, "Brain recovered from wedge"),
              eventNode(EVENTS.PUBLISH_FAILING, "Route publish failing"),
              eventNode(EVENTS.RELAY_SUPPRESSED, "Relay suppressed by rival process"),
              eventNode(EVENTS.ACCOUNT_SESSION_UNREADABLE, "Brain account session unreadable"),
              eventNode(EVENTS.UPDATE_INSTALL_ABORTED, "Update install aborted"),
              eventNode(EVENTS.UPDATE_QUIT_ESCALATED, "Update quit escalated"),
              eventNode(EVENTS.UPDATE_INSTALL_DID_NOT_LAND, "Update did not land"),
              eventNode(EVENTS.UPDATE_AUTO_APPLIED, "Update auto-applied"),
              eventNode(EVENTS.UPDATE_PROMPTED, "Manual update decision"),
            ],
            interval: "day",
            dateFrom: "-30d",
          }),
        ),
        insight(
          "update-prompt-decisions",
          "Manual update prompt decisions",
          "Accepted, deferred, and dismissed decisions for downloaded desktop updates.",
          trends({
            series: [eventNode(EVENTS.UPDATE_PROMPTED, "Update decisions")],
            breakdown: PROPERTIES.USER_ACTION,
            interval: "day",
            dateFrom: "-30d",
          }),
        ),
        insight(
          "analytics-sent-vs-dropped",
          "Delayed local budget rollups",
          "A local rollup appears only when an installation captures again on a later UTC day. Accepted means admitted to ADE's bounded queue, not confirmed delivered by PostHog; the current day and installations that do not return are intentionally absent.",
          trends({
            series: [
              eventNode(EVENTS.ANALYTICS_BUDGET, "Accepted/enqueued", {
                math: "sum",
                mathProperty: PROPERTIES.SENT_COUNT,
              }),
              eventNode(EVENTS.ANALYTICS_BUDGET, "Dropped", {
                math: "sum",
                mathProperty: PROPERTIES.DROPPED_COUNT,
              }),
            ],
            interval: "day",
            dateFrom: "-30d",
          }),
        ),
        insight(
          "analytics-drop-reasons",
          "Analytics drops by reason",
          "Delayed dropped-event rollups by daily/event/key cap, rate limit, duplicate, invalid input, transport, or other coarse reason. Current-day and non-returning-installation drops are not represented.",
          trends({
            series: [
              eventNode(EVENTS.ANALYTICS_BUDGET, "Dropped", {
                math: "sum",
                mathProperty: PROPERTIES.DROPPED_COUNT,
              }),
            ],
            dateFrom: "-30d",
            interval: "month",
            display: "ActionsBarValue",
            breakdown: PROPERTIES.DROP_REASON,
          }),
        ),
        insight(
          "monthly-analytics-volume",
          "30-day ingested analytics volume · events 1–26",
          "First segment of PostHog's actual ingested count across ADE's closed event catalog. Add this value to the companion segment for the total. The goal line marks the current 1,000,000-event monthly Product Analytics free allowance.",
          trends({
            series: INGESTED_EVENT_CHUNKS[0].map((event) => eventNode(event, event)),
            formula: eventFormula(INGESTED_EVENT_CHUNKS[0]),
            interval: "month",
            dateFrom: "-30d",
            display: "BoldNumber",
            goalLines: [{ label: "PostHog free allowance", value: 1_000_000 }],
          }),
        ),
        insight(
          "monthly-analytics-volume-overflow",
          "30-day ingested analytics volume · remaining events",
          "Companion segment for the remaining ADE events, including pseudonymous identify calls. Add this value to events 1–26 for the total.",
          trends({
            series: INGESTED_EVENT_CHUNKS[1].map((event) => eventNode(event, event)),
            formula: eventFormula(INGESTED_EVENT_CHUNKS[1]),
            interval: "month",
            dateFrom: "-30d",
            display: "BoldNumber",
          }),
        ),
      ],
    },
  ],
});
