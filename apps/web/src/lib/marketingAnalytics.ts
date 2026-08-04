export const MARKETING_ANALYTICS_EVENTS = {
  APP_OPENED: "ade_marketing_app_opened",
  SCREEN_VIEWED: "ade_marketing_screen_viewed",
  CTA_CLICKED: "ade_marketing_cta_clicked",
  FEATURE_USED: "ade_marketing_feature_used",
  ERROR: "ade_marketing_error",
  ANALYTICS_BUDGET: "ade_marketing_analytics_budget",
} as const;

export type MarketingAnalyticsEvent =
  (typeof MARKETING_ANALYTICS_EVENTS)[keyof typeof MARKETING_ANALYTICS_EVENTS];

export const MARKETING_SCREENS = {
  HOME: "home",
  DOWNLOAD: "download",
  OPEN_LINK: "open_link",
  PAIR: "pair",
  PRIVACY: "privacy",
  TERMS: "terms",
  NOT_FOUND: "not_found",
} as const;

export type MarketingScreen = (typeof MARKETING_SCREENS)[keyof typeof MARKETING_SCREENS];

export const MARKETING_FEATURES = {
  DOWNLOAD_MAC: "download_mac",
  DOWNLOAD_WINDOWS: "download_windows",
  DOWNLOAD_IOS: "download_ios",
  OPEN_WEB_CLIENT: "open_web_client",
  VIEW_DOCS: "view_docs",
  VIEW_GITHUB: "view_github",
  VIEW_RELEASES: "view_releases",
  VIEW_DOWNLOAD_PAGE: "view_download_page",
  VIEW_PRD: "view_prd",
  VIEW_FEATURES: "view_features",
  GET_STARTED: "get_started",
  OPEN_IN_DESKTOP: "open_in_desktop",
  PAIR_IN_WEB_CLIENT: "pair_in_web_client",
  // Install dialog. The dialog captures its own open event so every trigger
  // (hero, back cover, header, footer) reports the same feature regardless of
  // which CTA label it also carries.
  INSTALL_DIALOG_MAC: "install_dialog_mac",
  INSTALL_DIALOG_WINDOWS: "install_dialog_windows",
  INSTALL_DIALOG_LINUX: "install_dialog_linux",
  COPY_INSTALL_COMMAND_MAC: "copy_install_command_mac",
  COPY_INSTALL_COMMAND_WINDOWS: "copy_install_command_windows",
  COPY_INSTALL_COMMAND_LINUX: "copy_install_command_linux",
  COPY_BREW_COMMAND: "copy_brew_command",
  DEMO_GRID_VIEW: "demo_grid_view",
  DEMO_SUBAGENTS: "demo_subagents",
  DEMO_AUTO_CREATE_WORKTREES: "demo_auto_create_worktrees",
  DEMO_PR_FROM_CHAT: "demo_pr_from_chat",
  DEMO_WORKTREE_GRAPH: "demo_worktree_graph",
  DEMO_ADE_CODE: "demo_ade_code",
  DEMO_BROWSER: "demo_browser",
  DEMO_REMOTE_RUNTIMES: "demo_remote_runtimes",
  DEMO_LINEAR: "demo_linear",
  SHOWCASE_WORKTREES: "showcase_worktrees",
  SHOWCASE_AGENT_CHAT: "showcase_agent_chat",
  SHOWCASE_PULL_REQUESTS: "showcase_pull_requests",
  SHOWCASE_WORK_TOOLS: "showcase_work_tools",
} as const;

export type MarketingFeature = (typeof MARKETING_FEATURES)[keyof typeof MARKETING_FEATURES];

export const MARKETING_CTA_LABELS = {
  // Triggers that open the install dialog.
  DOWNLOAD_MAC: "download_for_mac",
  DOWNLOAD_WINDOWS: "download_for_windows",
  DOWNLOAD_IOS: "download_for_ios",
  // Direct-download buttons inside the install dialog. Architecture is always
  // an explicit visitor choice, never sniffed, so each one is its own label.
  DOWNLOAD_MAC_ARM64: "download_mac_arm64",
  DOWNLOAD_MAC_X64: "download_mac_x64",
  DOWNLOAD_WINDOWS_X64: "download_windows_x64",
  GET_STARTED_FREE: "get_started_free",
  OPEN_WEB_CLIENT: "open_web_client",
} as const;

export type MarketingCtaLabel = (typeof MARKETING_CTA_LABELS)[keyof typeof MARKETING_CTA_LABELS];

export const MARKETING_CTA_POSITIONS = {
  HERO: "hero",
  NAVBAR: "navbar",
  FOOTER: "footer",
  DOWNLOAD_PAGE: "download_page",
  INSTALL_DIALOG: "install_dialog",
} as const;

export type MarketingCtaPosition =
  (typeof MARKETING_CTA_POSITIONS)[keyof typeof MARKETING_CTA_POSITIONS];

export const MARKETING_ERROR_KINDS = {
  WINDOW_ERROR: "window_error",
  UNHANDLED_REJECTION: "unhandled_rejection",
} as const;

export type MarketingErrorKind = (typeof MARKETING_ERROR_KINDS)[keyof typeof MARKETING_ERROR_KINDS];

export const ANALYTICS_FEATURE_ATTRIBUTE = "data-ade-analytics-feature";
export const ANALYTICS_CTA_ATTRIBUTE = "data-ade-analytics-cta";
export const ANALYTICS_CTA_POSITION_ATTRIBUTE = "data-ade-analytics-position";

export const MARKETING_ANALYTICS_LIMITS = Object.freeze({
  daily: 40,
  perEvent: {
    [MARKETING_ANALYTICS_EVENTS.APP_OPENED]: 1,
    [MARKETING_ANALYTICS_EVENTS.SCREEN_VIEWED]: 12,
    [MARKETING_ANALYTICS_EVENTS.CTA_CLICKED]: 12,
    [MARKETING_ANALYTICS_EVENTS.FEATURE_USED]: 16,
    [MARKETING_ANALYTICS_EVENTS.ERROR]: 3,
    [MARKETING_ANALYTICS_EVENTS.ANALYTICS_BUDGET]: 1,
  },
  perKey: {
    [MARKETING_ANALYTICS_EVENTS.APP_OPENED]: 1,
    [MARKETING_ANALYTICS_EVENTS.SCREEN_VIEWED]: 2,
    [MARKETING_ANALYTICS_EVENTS.CTA_CLICKED]: 3,
    [MARKETING_ANALYTICS_EVENTS.FEATURE_USED]: 3,
    [MARKETING_ANALYTICS_EVENTS.ERROR]: 1,
    [MARKETING_ANALYTICS_EVENTS.ANALYTICS_BUDGET]: 1,
  },
  dedupeMs: {
    [MARKETING_ANALYTICS_EVENTS.APP_OPENED]: 86_400_000,
    [MARKETING_ANALYTICS_EVENTS.SCREEN_VIEWED]: 30_000,
    [MARKETING_ANALYTICS_EVENTS.CTA_CLICKED]: 1_500,
    [MARKETING_ANALYTICS_EVENTS.FEATURE_USED]: 1_500,
    [MARKETING_ANALYTICS_EVENTS.ERROR]: 60_000,
    [MARKETING_ANALYTICS_EVENTS.ANALYTICS_BUDGET]: 86_400_000,
  },
});

const SCREEN_BY_PATH: Readonly<Record<string, MarketingScreen | null>> = Object.freeze({
  "/": MARKETING_SCREENS.HOME,
  "/download": MARKETING_SCREENS.DOWNLOAD,
  "/open": MARKETING_SCREENS.OPEN_LINK,
  "/pair": MARKETING_SCREENS.PAIR,
  "/privacy": MARKETING_SCREENS.PRIVACY,
  "/terms": MARKETING_SCREENS.TERMS,
  "/_og": null,
});

const ALLOWED_FEATURES = new Set<string>(Object.values(MARKETING_FEATURES));
const ALLOWED_CTA_LABELS = new Set<string>(Object.values(MARKETING_CTA_LABELS));
const ALLOWED_CTA_POSITIONS = new Set<string>(Object.values(MARKETING_CTA_POSITIONS));

export function normalizeMarketingScreen(pathname: string): MarketingScreen | null {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return Object.prototype.hasOwnProperty.call(SCREEN_BY_PATH, normalized)
    ? SCREEN_BY_PATH[normalized] ?? null
    : MARKETING_SCREENS.NOT_FOUND;
}

export function isMarketingFeature(value: string | null | undefined): value is MarketingFeature {
  return typeof value === "string" && ALLOWED_FEATURES.has(value);
}

export function isMarketingCtaLabel(value: string | null | undefined): value is MarketingCtaLabel {
  return typeof value === "string" && ALLOWED_CTA_LABELS.has(value);
}

export function isMarketingCtaPosition(
  value: string | null | undefined,
): value is MarketingCtaPosition {
  return typeof value === "string" && ALLOWED_CTA_POSITIONS.has(value);
}

type AnalyticsAttributeTarget = {
  getAttribute(name: string): string | null;
};

export type MarketingAnalyticsClickTarget = {
  closest(selector: string): AnalyticsAttributeTarget | null;
};

export type MarketingAnalyticsClickCaptures = {
  captureCta(
    ctaLabel: MarketingCtaLabel,
    screen: MarketingScreen,
    position: MarketingCtaPosition,
  ): void;
  captureFeature(feature: MarketingFeature, screen?: MarketingScreen): void;
};

export function routeMarketingAnalyticsClick(
  target: MarketingAnalyticsClickTarget,
  pathname: string,
  captures: MarketingAnalyticsClickCaptures,
): "cta" | "feature" | null {
  const screen = normalizeMarketingScreen(pathname) ?? undefined;
  const ctaTarget = target.closest(`[${ANALYTICS_CTA_ATTRIBUTE}]`);
  const ctaLabel = ctaTarget?.getAttribute(ANALYTICS_CTA_ATTRIBUTE);
  const ctaPosition = ctaTarget?.getAttribute(ANALYTICS_CTA_POSITION_ATTRIBUTE);
  if (isMarketingCtaLabel(ctaLabel) && isMarketingCtaPosition(ctaPosition) && screen) {
    captures.captureCta(ctaLabel, screen, ctaPosition);
    return "cta";
  }

  const featureTarget = target.closest(`[${ANALYTICS_FEATURE_ATTRIBUTE}]`);
  const feature = featureTarget?.getAttribute(ANALYTICS_FEATURE_ATTRIBUTE);
  if (!isMarketingFeature(feature)) return null;
  captures.captureFeature(feature, screen);
  return "feature";
}

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type DropReason = "daily_cap" | "event_cap" | "key_cap" | "duplicate" | "transport";

type DayState = {
  day: string;
  sent: number;
  eventCounts: Partial<Record<MarketingAnalyticsEvent, number>>;
  keyCounts: Record<string, number>;
  dropped: Partial<Record<DropReason, number>>;
  lastCapturedAt: Record<string, number>;
};

type PendingBudgetSummary = {
  sentCount: number;
  droppedCount: number;
  dropReason: DropReason | "none";
};

type PersistedState = {
  version: 1;
  current: DayState;
  pending?: PendingBudgetSummary;
};

export type PostHogCapturePayload = {
  api_key: string;
  distinct_id: string;
  event: MarketingAnalyticsEvent;
  properties: Record<string, string | number | boolean>;
};

export type MarketingAnalyticsTransport = (payload: PostHogCapturePayload) => Promise<void> | void;

export type CaptureDisposition = "sent" | "disabled" | "dropped";

type MarketingAnalyticsOptions = {
  projectToken: string;
  storage: StorageLike;
  transport: MarketingAnalyticsTransport;
  isEnabled: () => boolean;
  now?: () => Date;
  idFactory?: () => string;
};

const STATE_STORAGE_KEY = "ade.analytics.marketing.budget.v1";
const DISTINCT_ID_STORAGE_KEY = "ade.analytics.marketing.id.v1";
const VALID_DISTINCT_ID = /^[A-Za-z0-9_-]{16,128}$/;

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function freshDay(day: string): DayState {
  return {
    day,
    sent: 0,
    eventCounts: {},
    keyCounts: {},
    dropped: {},
    lastCapturedAt: {},
  };
}

function totalDropped(state: DayState): number {
  return Object.values(state.dropped).reduce((sum, value) => sum + (value ?? 0), 0);
}

function primaryDropReason(state: DayState): DropReason | "none" {
  let selected: DropReason | "none" = "none";
  let count = 0;
  for (const [reason, value] of Object.entries(state.dropped) as Array<[DropReason, number]>) {
    if (value > count) {
      selected = reason;
      count = value;
    }
  }
  return selected;
}

function parseState(raw: string | null, day: string): PersistedState {
  if (!raw) return { version: 1, current: freshDay(day) };
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (parsed.version !== 1 || !parsed.current || typeof parsed.current.day !== "string") {
      return { version: 1, current: freshDay(day) };
    }
    const current: DayState = {
      day: parsed.current.day,
      sent: Number.isFinite(parsed.current.sent) && parsed.current.sent >= 0 ? parsed.current.sent : 0,
      eventCounts: parsed.current.eventCounts ?? {},
      keyCounts: parsed.current.keyCounts ?? {},
      dropped: parsed.current.dropped ?? {},
      lastCapturedAt: parsed.current.lastCapturedAt ?? {},
    };
    return { version: 1, current, ...(parsed.pending ? { pending: parsed.pending } : {}) };
  } catch {
    return { version: 1, current: freshDay(day) };
  }
}

function mergePending(previous: PendingBudgetSummary | undefined, state: DayState): PendingBudgetSummary {
  const droppedCount = totalDropped(state);
  if (!previous) {
    return {
      sentCount: state.sent,
      droppedCount,
      dropReason: primaryDropReason(state),
    };
  }
  return {
    sentCount: previous.sentCount + state.sent,
    droppedCount: previous.droppedCount + droppedCount,
    dropReason: previous.dropReason === "none" ? primaryDropReason(state) : previous.dropReason,
  };
}

export class MarketingAnalytics {
  private readonly projectToken: string;
  private readonly storage: StorageLike;
  private readonly transport: MarketingAnalyticsTransport;
  private readonly isEnabled: () => boolean;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private storageHealthy = true;

  constructor(options: MarketingAnalyticsOptions) {
    this.projectToken = options.projectToken;
    this.storage = options.storage;
    this.transport = options.transport;
    this.isEnabled = options.isEnabled;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => crypto.randomUUID());
  }

  captureAppOpened(): CaptureDisposition {
    return this.capture(
      MARKETING_ANALYTICS_EVENTS.APP_OPENED,
      { action: "opened", runtime_mode: "web" },
      "app",
    );
  }

  captureScreen(screen: MarketingScreen): CaptureDisposition {
    return this.capture(
      MARKETING_ANALYTICS_EVENTS.SCREEN_VIEWED,
      { action: "viewed", screen },
      screen,
    );
  }

  captureFeature(feature: MarketingFeature, screen?: MarketingScreen): CaptureDisposition {
    return this.capture(
      MARKETING_ANALYTICS_EVENTS.FEATURE_USED,
      { action: "clicked", feature, ...(screen ? { screen } : {}) },
      feature,
    );
  }

  captureCta(
    ctaLabel: MarketingCtaLabel,
    screen: MarketingScreen,
    position: MarketingCtaPosition,
  ): CaptureDisposition {
    return this.capture(
      MARKETING_ANALYTICS_EVENTS.CTA_CLICKED,
      { action: "clicked", cta_label: ctaLabel, screen, position },
      `${ctaLabel}:${screen}:${position}`,
    );
  }

  captureError(errorKind: MarketingErrorKind): CaptureDisposition {
    return this.capture(
      MARKETING_ANALYTICS_EVENTS.ERROR,
      { action: "observed", error_kind: errorKind },
      errorKind,
    );
  }

  reset(): void {
    // Opting out rotates the anonymous identity without resetting quota state;
    // repeated off/on cycles therefore cannot bypass the daily event ceiling.
    this.safeRemove(DISTINCT_ID_STORAGE_KEY);
  }

  private capture(
    event: MarketingAnalyticsEvent,
    properties: Record<string, string | number | boolean>,
    key: string,
  ): CaptureDisposition {
    if (!this.projectToken || !this.isEnabled() || !this.storageHealthy) return "disabled";
    const now = this.now();
    const state = this.readState(now);
    if (!this.storageHealthy) return "disabled";
    this.emitPendingBudget(state, now);
    if (!this.storageHealthy) return "disabled";
    return this.reserveAndSend(state, event, properties, key, now);
  }

  private readState(now: Date): PersistedState {
    const day = utcDay(now);
    const state = parseState(this.safeGet(STATE_STORAGE_KEY), day);
    if (state.current.day === day) return state;
    const next: PersistedState = {
      version: 1,
      current: freshDay(day),
      pending: mergePending(state.pending, state.current),
    };
    this.writeState(next);
    return next;
  }

  private emitPendingBudget(state: PersistedState, now: Date): void {
    const pending = state.pending;
    if (!pending) return;
    delete state.pending;
    this.writeState(state);
    this.reserveAndSend(
      state,
      MARKETING_ANALYTICS_EVENTS.ANALYTICS_BUDGET,
      {
        action: "daily_rollup",
        sent_count: pending.sentCount,
        dropped_count: pending.droppedCount,
        drop_reason: pending.dropReason,
      },
      "daily_rollup",
      now,
    );
  }

  private reserveAndSend(
    state: PersistedState,
    event: MarketingAnalyticsEvent,
    properties: Record<string, string | number | boolean>,
    key: string,
    now: Date,
  ): CaptureDisposition {
    const current = state.current;
    const eventKey = `${event}:${key}`;
    const nowMs = now.getTime();
    const lastCapturedAt = current.lastCapturedAt[eventKey] ?? 0;
    if (nowMs - lastCapturedAt < MARKETING_ANALYTICS_LIMITS.dedupeMs[event]) {
      return this.recordDrop(state, "duplicate");
    }
    if (current.sent >= MARKETING_ANALYTICS_LIMITS.daily) {
      return this.recordDrop(state, "daily_cap");
    }
    const eventCount = current.eventCounts[event] ?? 0;
    if (eventCount >= MARKETING_ANALYTICS_LIMITS.perEvent[event]) {
      return this.recordDrop(state, "event_cap");
    }
    const keyCount = current.keyCounts[eventKey] ?? 0;
    if (keyCount >= MARKETING_ANALYTICS_LIMITS.perKey[event]) {
      return this.recordDrop(state, "key_cap");
    }

    current.sent += 1;
    current.eventCounts[event] = eventCount + 1;
    current.keyCounts[eventKey] = keyCount + 1;
    current.lastCapturedAt[eventKey] = nowMs;
    this.writeState(state);
    if (!this.storageHealthy) return "disabled";

    const distinctId = this.distinctId();
    if (!distinctId) return "disabled";

    const payload: PostHogCapturePayload = {
      api_key: this.projectToken,
      distinct_id: distinctId,
      event,
      properties: {
        surface: "web",
        route_kind: "marketing",
        $process_person_profile: false,
        $geoip_disable: true,
        ...properties,
      },
    };

    try {
      void Promise.resolve(this.transport(payload)).catch(() => this.recordTransportFailure());
    } catch {
      this.recordTransportFailure();
    }
    return "sent";
  }

  private recordDrop(state: PersistedState, reason: DropReason): CaptureDisposition {
    state.current.dropped[reason] = (state.current.dropped[reason] ?? 0) + 1;
    this.writeState(state);
    return "dropped";
  }

  private recordTransportFailure(): void {
    if (!this.isEnabled()) return;
    const state = this.readState(this.now());
    state.current.dropped.transport = (state.current.dropped.transport ?? 0) + 1;
    this.writeState(state);
  }

  private distinctId(): string | null {
    const existing = this.safeGet(DISTINCT_ID_STORAGE_KEY);
    if (!this.storageHealthy) return null;
    if (existing && VALID_DISTINCT_ID.test(existing)) return existing;
    const created = this.idFactory().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 128);
    const value = VALID_DISTINCT_ID.test(created) ? created : `adeweb_${Math.random().toString(36).slice(2)}_${Date.now()}`;
    this.safeSet(DISTINCT_ID_STORAGE_KEY, value);
    return this.storageHealthy ? value : null;
  }

  private writeState(state: PersistedState): void {
    this.safeSet(STATE_STORAGE_KEY, JSON.stringify(state));
  }

  private safeGet(key: string): string | null {
    try {
      return this.storage.getItem(key);
    } catch {
      this.storageHealthy = false;
      return null;
    }
  }

  private safeSet(key: string, value: string): void {
    try {
      this.storage.setItem(key, value);
    } catch {
      // Without durable quota state, analytics fails closed so reloads cannot
      // reset and bypass the browser/day ceiling.
      this.storageHealthy = false;
    }
  }

  private safeRemove(key: string): void {
    try {
      this.storage.removeItem(key);
    } catch {
      this.storageHealthy = false;
    }
  }
}
