/**
 * "Connect your agents" as a rail: every agent's 3D logo hangs from a hook on
 * a cord. Brushing along the rail turns each one to face you and knocks its
 * neighbours; the strip under the rail wears the faced agent's banner, as its
 * Settings page does, with its name, where it stands, and its sign-in button.
 *
 * A prototype of the skate-deck-rail idea (21st.dev): the hanging, swinging
 * and facing come from it; the decks became the logos ADE already stands on
 * each provider page (`providerBrand`, the same stacked-in-depth marks).
 *
 * The rail reads the same status and signs in through the same flows the
 * tiles did: Claude Code and Codex through the account sheet, Cursor through
 * its browser login, Antigravity through the agent's own Google sign-in (the
 * Settings page's `ai.antigravitySignIn*`), Grok, Devin, Muse, Copilot, Droid
 * and Kimi through the agent CLI sheet (`ai.cliLogin*`); OpenCode, Qwen and Pi
 * (keys and in-app provider sign-ins) later in Settings.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { CircleNotch, SignIn } from "@phosphor-icons/react";
import { isAgentCliLoginProvider, type AgentCliLoginProvider, type AntigravitySignInState } from "../../../shared/types";
import { useAgentCliSignInSheet } from "../settings/providers/AgentCliSignInSheet";
import { ProviderLogo } from "../shared/ProviderLogos";
import { useAccountSignInSheet } from "../settings/providers/accounts/AddProviderAccountSheet";
import { useDefaultProviderInstance } from "../settings/providers/accounts/useProviderInstances";
import { providerBrand, type ProviderBrandLogo } from "../settings/providers/providerBrand";
import type { FirstRunAgent, FirstRunAgentStatus } from "./firstRunAgentModel";
import "./firstRunAgentRail.css";

export type RailTile = { agent: FirstRunAgent; status: FirstRunAgentStatus };

/** How a charm's click is answered: a sign-in it can start, or nothing. */
type Activation = { start: () => void; busy: boolean; busyLabel?: string } | null;

const EDGE = 16;
const DIVIDER = 26;
const RAIL_TOP = 18;
/** Cord lengths, varied so the charms hang at different heights as real ones do. */
const CORDS = [34, 44, 30, 48, 38];
/** Pendulum: stiffness falls with the cord's length, so long cords swing slower. */
const SWING_STIFFNESS = 2400;
const SWING_DAMP = 2.4;
const SWING_LIMIT = 18;
/** Depth layers of a mark: the side of the solid. */
const DEPTH = 10;
/**
 * Hover intent: a hand moving slowly along the rail faces the charm it is
 * over at once. A fast one, or one heading down toward the banner's button,
 * only swings the charms it passes, and faces one once it rests there this long.
 */
const SLOW_PX_PER_MS = 0.45;
/** Down per across: past this, the hand is on its way to the banner. */
const HEADING_DOWN = 0.2;
const INTENT_MS = 110;
/** A hand moving down rests longer before the charm under it faces: it is likely bound for the banner. */
const INTENT_DOWN_MS = 320;
/** Antigravity sign-in status poll while a flow runs (the Settings page uses 1s too). */
const ANTIGRAVITY_POLL_MS = 1_000;

type Sim = { swing: number[]; vswing: number[]; stiff: number[]; last: number; raf: number };

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function reducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return document.documentElement.dataset.motion === "reduced"
    || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export function FirstRunAgentRail({
  primary,
  later,
  onChanged,
}: {
  /** Connected, or signable from setup: big charms. */
  primary: RailTile[];
  /** Agents that sign in later in Settings: past the divider, dimmed. */
  later: RailTile[];
  onChanged: () => void;
}) {
  const tiles = useMemo(() => [...primary, ...later], [later, primary]);
  const count = tiles.length;
  const railRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const swings = useRef<(HTMLSpanElement | null)[]>([]);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const activations = useRef<Activation[]>([]);
  const sim = useRef<Sim>({ swing: [], vswing: [], stiff: [], last: 0, raf: 0 });
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const activeRef = useRef<number | null>(null);
  const [, setActivationTick] = useState(0);
  const pointer = useRef({ x: 0, y: 0, t: 0, v: 0, vy: 0, over: -1 });
  const intentTimer = useRef(0);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setWidth((old) => (Math.abs(old - stage.clientWidth) < 0.5 ? old : stage.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Every charm gets the same slot and size; the later ones only hang past the divider, dimmed.
  const layout = useMemo(() => {
    const divider = primary.length && later.length ? DIVIDER : 0;
    const usable = Math.max(0, width - 2 * EDGE - divider);
    const shares = primary.length + later.length;
    const unit = Math.min(140, usable / Math.max(1, shares));
    const big = Math.round(clamp(unit * 0.78, 36, 80));
    const centres: number[] = [];
    const slots: number[] = [];
    const cords: number[] = [];
    let cursor = EDGE + Math.max(0, (usable - unit * shares) / 2);
    tiles.forEach((_, index) => {
      if (index === primary.length && divider) cursor += divider;
      const slot = unit;
      centres.push(cursor + slot / 2);
      slots.push(slot);
      cords.push(CORDS[index % CORDS.length] ?? 34);
      cursor += slot;
    });
    const lastPrimary = primary.length - 1;
    const dividerX = divider ? (centres[lastPrimary] ?? 0) + (slots[lastPrimary] ?? 0) / 2 + divider / 2 : null;
    const deepest = Math.max(0, ...cords.map((cord) => cord + big));
    return { big, centres, slots, cords, dividerX, band: RAIL_TOP + deepest + 12, height: RAIL_TOP + deepest + 34 };
  }, [later.length, primary.length, tiles, width]);

  // A longer cord (or a bigger charm) is a longer pendulum: lower stiffness, a slower swing.
  useEffect(() => {
    sim.current.stiff = layout.cords.map((cord, index) =>
      SWING_STIFFNESS / (cord + layout.big * 0.6));
  }, [layout, primary.length]);

  const paint = useCallback((index: number) => {
    const swing = swings.current[index];
    if (swing) swing.style.transform = `rotate(${(sim.current.swing[index] ?? 0).toFixed(2)}deg)`;
  }, []);

  const step = useCallback((now: number) => {
    const s = sim.current;
    const dt = s.last ? Math.min(0.05, (now - s.last) / 1000) : 1 / 60;
    s.last = now;
    const sub = Math.max(1, Math.ceil(dt / 0.012));
    const h = dt / sub;
    const n = swings.current.length;
    for (let k = 0; k < sub; k++) {
      for (let i = 0; i < n; i++) {
        const a = -(s.stiff[i] ?? 40) * (s.swing[i] ?? 0) - SWING_DAMP * (s.vswing[i] ?? 0);
        s.vswing[i] = (s.vswing[i] ?? 0) + a * h;
        let next = (s.swing[i] ?? 0) + (s.vswing[i] ?? 0) * h;
        if (Math.abs(next) > SWING_LIMIT) {
          next = Math.sign(next) * SWING_LIMIT;
          s.vswing[i] = -(s.vswing[i] ?? 0) * 0.3;
        }
        s.swing[i] = next;
      }
    }
    let busy = false;
    for (let i = 0; i < n; i++) {
      paint(i);
      if (Math.abs(s.swing[i] ?? 0) > 0.03 || Math.abs(s.vswing[i] ?? 0) > 0.05) busy = true;
    }
    if (busy) {
      s.raf = requestAnimationFrame(step);
      return;
    }
    s.raf = 0;
    s.last = 0;
    for (let i = 0; i < n; i++) {
      s.swing[i] = 0;
      s.vswing[i] = 0;
      paint(i);
    }
  }, [paint]);

  const impulse = useCallback((index: number, amount: number) => {
    if (index < 0 || index >= swings.current.length || reducedMotion()) return;
    const s = sim.current;
    s.vswing[index] = clamp((s.vswing[index] ?? 0) + amount, -150, 150);
    if (!s.raf) {
      s.last = 0;
      s.raf = requestAnimationFrame(step);
    }
  }, [step]);

  useEffect(() => () => {
    cancelAnimationFrame(sim.current.raf);
    sim.current.raf = 0;
  }, []);

  // A light brush along the whole rail when it first has a width.
  const brushed = useRef(false);
  useEffect(() => {
    if (!width || brushed.current || !count) return;
    brushed.current = true;
    const timers = tiles.map((_, index) => window.setTimeout(() => impulse(index, 60 - index * 2.5), 140 + index * 50));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [count, impulse, tiles, width]);

  // A sign-in that lands swings its charm and turns it once on its cord, so the change is noticed.
  const lastStates = useRef(new Map<string, string>());
  const [celebrating, setCelebrating] = useState<string | null>(null);
  useEffect(() => {
    tiles.forEach((tile, index) => {
      const before = lastStates.current.get(tile.agent.id);
      if (before && before !== "connected" && tile.status.state === "connected") {
        impulse(index, 120);
        setCelebrating(tile.agent.id);
      }
      lastStates.current.set(tile.agent.id, tile.status.state);
    });
  }, [impulse, tiles]);
  useEffect(() => {
    if (!celebrating) return undefined;
    const timer = window.setTimeout(() => setCelebrating(null), 1_400);
    return () => window.clearTimeout(timer);
  }, [celebrating]);

  const face = useCallback((index: number | null, push: number) => {
    const old = activeRef.current;
    if (old === index) return;
    activeRef.current = index;
    setActive(index);
    if (index !== null) {
      impulse(index, push);
      impulse(index - 1, -30);
      impulse(index + 1, 30);
    }
    if (old !== null) {
      impulse(old - 1, 10);
      impulse(old + 1, -10);
    }
  }, [impulse]);

  const cancelIntent = useCallback(() => {
    window.clearTimeout(intentTimer.current);
    intentTimer.current = 0;
  }, []);
  useEffect(() => cancelIntent, [cancelIntent]);

  /** The charm under a point on the rail; null below the charms (the banner) or between slots. */
  const nearest = (clientX: number, clientY: number): number | null => {
    const stage = stageRef.current;
    if (!stage) return null;
    const box = stage.getBoundingClientRect();
    // ADE's UI scale zooms the page (`zoom` on the body): pointer and box
    // coordinates are zoomed, the layout's are not, and the gap between them
    // grows toward the rail's right end.
    const scale = stage.offsetWidth > 0 ? box.width / stage.offsetWidth : 1;
    const y = (clientY - box.top) / scale;
    if (y < 0 || y > layout.band) return null;
    const x = (clientX - box.left) / scale;
    let best: number | null = null;
    let distance = Infinity;
    layout.centres.forEach((centre, index) => {
      const d = Math.abs(x - centre);
      if (d <= (layout.slots[index] ?? 0) / 2 + 2 && d < distance) {
        best = index;
        distance = d;
      }
    });
    return best;
  };

  // On the whole rail (charms and banner): leaving the charms for the banner
  // keeps the faced agent, so its Sign in button stays reachable.
  const onPointerMove = (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const p = pointer.current;
    const now = performance.now();
    const dt = Math.max(1, now - p.t);
    const v = p.t ? (event.clientX - p.x) / dt : 0;
    const vy = p.t ? (event.clientY - p.y) / dt : 0;
    p.v = p.v * 0.5 + v * 0.5;
    p.vy = p.vy * 0.5 + vy * 0.5;
    p.x = event.clientX;
    p.y = event.clientY;
    p.t = now;
    // The light on the metal rail sits over the hand (one style write, no re-render).
    const rail = railRef.current;
    if (rail) {
      const box = rail.getBoundingClientRect();
      rail.style.setProperty("--rail-light", `${(((event.clientX - box.left) / Math.max(1, box.width)) * 100).toFixed(1)}%`);
    }
    const hit = nearest(event.clientX, event.clientY);
    // The brush: every charm the hand passes swings, pushed by the hand's speed.
    if (hit !== p.over) {
      p.over = hit ?? -1;
      if (hit !== null) impulse(hit, clamp(p.v * 80, -110, 110));
    }
    if (hit === null || hit === activeRef.current) {
      cancelIntent();
      return;
    }
    // Any steady drift downward counts, however slow: a hand easing off a charm toward the banner starts slow.
    const headingDown = p.vy > 0.004 && p.vy > Math.abs(p.v) * HEADING_DOWN;
    if (Math.abs(p.v) < SLOW_PX_PER_MS && !headingDown) {
      cancelIntent();
      face(hit, 0);
      return;
    }
    cancelIntent();
    intentTimer.current = window.setTimeout(() => {
      intentTimer.current = 0;
      face(hit, 0);
    }, headingDown ? INTENT_DOWN_MS : INTENT_MS);
  };

  const onPointerLeave = () => {
    cancelIntent();
    pointer.current = { x: 0, y: 0, t: 0, v: 0, vy: 0, over: -1 };
    if (!railRef.current?.contains(document.activeElement)) face(null, 0);
  };

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key) || !count) return;
    event.preventDefault();
    const from = activeRef.current ?? 0;
    const next = event.key === "Home" ? 0 : event.key === "End" ? count - 1 : clamp(from + (event.key === "ArrowRight" ? 1 : -1), 0, count - 1);
    buttons.current[next]?.focus();
  };

  const register = useCallback((index: number, activation: Activation) => {
    const old = activations.current[index];
    activations.current[index] = activation;
    if (!!old !== !!activation || old?.busy !== activation?.busy || old?.busyLabel !== activation?.busyLabel) {
      setActivationTick((tick) => tick + 1);
    }
  }, []);

  const activate = (index: number) => {
    const activation = activations.current[index];
    if (activation && !activation.busy) {
      activation.start();
      return;
    }
    // Nothing to start here: a nudge says the click landed.
    impulse(index, index % 2 ? 60 : -60);
  };

  const faced = active === null ? null : tiles[active] ?? null;
  const connected = tiles.filter((tile) => tile.status.state === "connected").length;

  return (
    <div
      ref={railRef}
      className="ade-fr-rail"
      data-testid="first-run-agent-rail"
      data-faced={faced ? "true" : undefined}
      style={faced ? ({ ["--rail-glow" as string]: providerBrand(faced.agent.id).accent } as CSSProperties) : undefined}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <div
        ref={stageRef}
        className="ade-fr-rail-stage"
        role="group"
        aria-label="Coding agents"
        style={{ height: layout.height }}
        onKeyDown={onKeyDown}
      >
        <div className="ade-fr-rail-bar" style={{ top: RAIL_TOP - 4 }} aria-hidden="true">
          <i data-side="left" />
          <i data-side="right" />
        </div>
        {layout.dividerX != null ? (
          <span className="ade-fr-rail-divider" style={{ left: layout.dividerX, top: RAIL_TOP - 10 }} aria-hidden="true" />
        ) : null}
        {width
          ? tiles.map((tile, index) => {
            const isPrimary = index < primary.length;
            const slot = layout.slots[index] ?? 0;
            return (
              <RailItem
                key={tile.agent.id}
                tile={tile}
                index={index}
                primary={isPrimary}
                size={layout.big}
                cord={layout.cords[index] ?? 30}
                left={(layout.centres[index] ?? 0) - slot / 2}
                slot={slot}
                facing={active === index}
                celebrating={celebrating === tile.agent.id}
                onChanged={onChanged}
                register={register}
                swingRef={(node) => { swings.current[index] = node; }}
                buttonRef={(node) => { buttons.current[index] = node; }}
                onFocus={() => face(index, 40)}
                onBlur={() => {
                  if (!railRef.current?.matches(":hover")) face(null, 0);
                }}
                onClick={() => activate(index)}
              />
            );
          })
          : null}
      </div>
      <RailCaption
        tile={faced}
        primary={active !== null && active < primary.length}
        activation={active === null ? null : activations.current[active] ?? null}
        onActivate={() => { if (active !== null) activate(active); }}
        connected={connected}
      />
    </div>
  );
}

type RailItemProps = {
  tile: RailTile;
  index: number;
  primary: boolean;
  size: number;
  cord: number;
  left: number;
  slot: number;
  facing: boolean;
  /** A sign-in just landed: the charm turns once. */
  celebrating?: boolean;
  onChanged: () => void;
  register: (index: number, activation: Activation) => void;
  swingRef: (node: HTMLSpanElement | null) => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
  onFocus: () => void;
  onBlur: () => void;
  onClick: () => void;
};

/** One charm, with the sign-in its agent can start from setup (if any). */
function RailItem(props: RailItemProps) {
  const { tile } = props;
  // A CLI's item stays mounted once its status reads connected: its sheet
  // lives there, and unmounting it would cancel the sign-in it is finishing.
  if (tile.agent.signIn === "cli" && isAgentCliLoginProvider(tile.agent.id)) {
    return <CliRailItem {...props} provider={tile.agent.id} />;
  }
  if (tile.status.state === "sign-in") {
    if (tile.agent.signIn === "cursor") return <CursorRailItem {...props} />;
    if (tile.agent.signIn === "antigravity") return <AntigravityRailItem {...props} />;
    if (tile.agent.id === "claude" || tile.agent.id === "codex") return <AccountRailItem {...props} provider={tile.agent.id} />;
  }
  return <PlainRailItem {...props} />;
}

function PlainRailItem(props: RailItemProps) {
  const { register, index } = props;
  useEffect(() => register(index, null), [index, register]);
  return <Charm {...props} />;
}

/** Claude Code and Codex: the account sheet Settings uses, on this computer. */
function AccountRailItem(props: RailItemProps & { provider: "claude" | "codex" }) {
  const { provider, tile, register, index, onChanged } = props;
  const { instance, reload } = useDefaultProviderInstance(provider);
  const sheet = useAccountSignInSheet({
    provider,
    providerLabel: tile.agent.label,
    onChanged: () => {
      void reload();
      onChanged();
    },
  });
  const open = sheet.open;
  useEffect(() => register(index, { start: () => open({ existing: instance }), busy: false }), [index, instance, open, register]);
  return (
    <>
      <Charm {...props} />
      {sheet.element}
    </>
  );
}

/** Cursor: its own browser login; the card re-reads status when the window comes back. */
function CursorRailItem(props: RailItemProps) {
  const { register, index, onChanged } = props;
  const [busy, setBusy] = useState(false);
  const start = useCallback(() => {
    setBusy(true);
    void window.ade.ai.cursorAuthLogin()
      .catch(() => {
        // The charm stays on "Sign in"; Settings shows the full error.
      })
      .finally(() => {
        setBusy(false);
        onChanged();
      });
  }, [onChanged]);
  useEffect(() => register(index, { start, busy }), [busy, index, register, start]);
  return <Charm {...props} busy={busy} />;
}

/**
 * Grok, Devin, Muse, Copilot, Droid and Kimi: the CLI's own login run by ADE
 * in a private PTY on this computer (`ai.cliLoginStart`), in the same sheet
 * Settings uses. Setup runs on the machine it sets up, so no pin.
 */
function CliRailItem(props: RailItemProps & { provider: AgentCliLoginProvider }) {
  const { provider, tile, register, index, onChanged } = props;
  const sheet = useAgentCliSignInSheet({
    provider,
    providerLabel: tile.agent.label,
    pin: null,
    isThisMachine: true,
    onChanged,
  });
  const open = sheet.open;
  const offered = tile.status.state === "sign-in";
  useEffect(() => register(index, offered ? { start: open, busy: false } : null), [index, offered, open, register]);
  return (
    <>
      <Charm {...props} />
      {sheet.element}
    </>
  );
}

function antigravityRunning(state: AntigravitySignInState | null): boolean {
  return state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying";
}

/**
 * Antigravity: the agent's own Google sign-in (its ACP `authenticate`), the
 * same `ai.antigravitySignIn*` actions Settings runs, on this computer.
 * Setup runs on the machine it sets up, so these calls take no pin. Google's
 * page opens once per flow; the other methods (Gemini Enterprise, keys) stay
 * in Settings.
 */
function AntigravityRailItem(props: RailItemProps) {
  const { register, index, onChanged } = props;
  const [state, setState] = useState<AntigravitySignInState | null>(null);
  const opened = useRef<string | null>(null);
  const finished = useRef<string | null>(null);
  const supported = typeof window.ade?.ai?.antigravitySignInStart === "function";
  const running = antigravityRunning(state);

  const apply = useCallback((next: AntigravitySignInState | null) => {
    if (!next) return;
    setState(next);
    if (next.phase === "waiting" && next.authorizationUrl && next.flowId && opened.current !== next.flowId) {
      opened.current = next.flowId;
      void window.ade?.app?.openExternal?.(next.authorizationUrl);
    }
    if ((next.phase === "succeeded" || next.phase === "failed" || next.phase === "cancelled") && next.flowId && finished.current !== next.flowId) {
      finished.current = next.flowId;
      onChanged();
    }
  }, [onChanged]);

  useEffect(() => {
    if (!running) return undefined;
    const read = window.ade?.ai?.antigravitySignInStatus;
    if (!read) return undefined;
    const timer = window.setInterval(() => {
      void read(null).then(apply).catch(() => undefined);
    }, ANTIGRAVITY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [apply, running]);

  const start = useCallback(() => {
    const begin = window.ade?.ai?.antigravitySignInStart;
    if (!begin) return;
    setState((old) => ({ ...(old ?? EMPTY_ANTIGRAVITY_STATE), phase: "starting" }));
    void begin({ method: "oauth-personal" }, null)
      .then(apply)
      .catch(() => {
        setState(null);
        onChanged();
      });
  }, [apply, onChanged]);

  const busyLabel = state?.phase === "waiting" ? "Finish in your browser…" : state?.phase === "verifying" ? "Checking…" : "Starting…";
  useEffect(() => register(index, supported ? { start, busy: running, busyLabel } : null), [busyLabel, index, register, running, start, supported]);
  return <Charm {...props} busy={running} />;
}

const EMPTY_ANTIGRAVITY_STATE: AntigravitySignInState = {
  flowId: null,
  method: "oauth-personal",
  phase: "idle",
  authorizationUrl: null,
  licensePickerUrl: null,
  acceptsCallbackUrl: false,
  message: null,
  expiresAt: null,
  recordedMethod: null,
  signedIn: false,
  agentPlatform: { project: null, location: null },
};

function Charm({
  tile,
  primary,
  size,
  cord,
  left,
  slot,
  facing,
  celebrating = false,
  busy = false,
  swingRef,
  buttonRef,
  onFocus,
  onBlur,
  onClick,
}: RailItemProps & { busy?: boolean }) {
  const brand = providerBrand(tile.agent.id);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="ade-fr-rail-item"
      data-primary={primary ? "true" : undefined}
      data-front={facing ? "true" : undefined}
      data-celebrate={celebrating ? "true" : undefined}
      data-state={busy ? "busy" : tile.status.state}
      data-logo={tile.agent.logo}
      style={{ left, width: slot, top: RAIL_TOP, ["--brand" as string]: brand.accent } as CSSProperties}
      aria-label={`${tile.agent.label}: ${tile.status.detail}`}
      aria-pressed={facing}
      onFocus={onFocus}
      onBlur={onBlur}
      onClick={onClick}
    >
      <span className="ade-fr-rail-hook" aria-hidden="true" />
      <span ref={swingRef} className="ade-fr-rail-swing">
        <span className="ade-fr-rail-cord" style={{ height: cord }} aria-hidden="true">
          {primary ? <i className="ade-fr-rail-eyelet" /> : null}
        </span>
        <span className="ade-fr-rail-turn" style={{ width: size, height: size }}>
          <BrandMark logo={brand.logo} family={tile.agent.logo} size={size} depth={DEPTH} />
        </span>
      </span>
    </button>
  );
}

/**
 * The logo as it stands on its provider page: a shaped mark stacked in depth
 * (side in a dark shade of the maker's color), or the maker's square tile.
 */
function BrandMark({ logo, family, size, depth }: { logo: ProviderBrandLogo; family: string; size: number; depth: number }) {
  if (logo.kind === "tile") {
    return (
      <span className="ade-fr-rail-tile" style={{ background: logo.background, color: logo.color, borderRadius: size * 0.24 }}>
        <ProviderLogo family={family} size={Math.round(size * 0.56)} />
      </span>
    );
  }
  // A mark drawn small inside its box (Muse, Devin) asks for a bigger size.
  const drawn = Math.round(size * ((logo.size ?? 84) / 84));
  const step = Math.max(0.45, size / 70);
  const layers = Array.from({ length: depth }, (_, index) => depth - index);
  return (
    <span className="ade-fr-rail-mark">
      {layers.map((d) => (
        <span
          key={d}
          className="ade-fr-rail-layer"
          style={{
            transform: `translate(${(d * step * 0.8).toFixed(2)}px, ${(d * step).toFixed(2)}px)`,
            ...(logo.fullColor
              ? { filter: `brightness(${0.32 + (depth - d) * 0.04}) saturate(1.3)` }
              : { color: logo.side, filter: `brightness(${0.7 + (depth - d) * 0.04})` }),
          }}
        >
          {logo.mark(drawn)}
        </span>
      ))}
      <span className="ade-fr-rail-layer" data-face="true" style={logo.face ? { color: logo.face } : undefined}>
        {logo.mark(drawn)}
      </span>
      <span className="ade-fr-rail-layer" data-gloss="true">
        {logo.mark(drawn)}
      </span>
    </span>
  );
}

/** Where an agent stands, in the banner's words. */
function standing(tile: RailTile, primary: boolean): { line: string; state: string } {
  const { status } = tile;
  if (status.state === "connected") {
    // Who it is signed in as, in so many words; a plan rides along after it.
    if (status.account) {
      return { line: `Signed in as ${status.account}${status.plan ? ` · ${status.plan}` : ""}`, state: "connected" };
    }
    return { line: `Connected · ${status.detail}`, state: "connected" };
  }
  if (status.state === "checking") return { line: "Checking this computer…", state: "checking" };
  if (primary) return { line: `${status.detail} on this computer`, state: "sign-in" };
  return { line: "Set this one up later, in Settings › Agents & Models", state: "later" };
}

/** Under the rail: the faced agent on its provider-page banner, with what it can do here. */
function RailCaption({
  tile,
  primary,
  activation,
  onActivate,
  connected,
}: {
  tile: RailTile | null;
  primary: boolean;
  activation: Activation;
  onActivate: () => void;
  connected: number;
}) {
  if (!tile) {
    return (
      <div className="ade-fr-rail-caption" data-empty="true" aria-live="polite">
        <span>
          {connected ? <><i data-state="connected" />{`${connected} connected · `}</> : null}
          {"Hover an agent to see where it stands; click one to sign in."}
        </span>
      </div>
    );
  }
  const brand = providerBrand(tile.agent.id);
  const { line, state } = standing(tile, primary);
  let action: ReactNode = null;
  if (activation) {
    action = (
      <button type="button" className="ade-fr-rail-action" disabled={activation.busy} onClick={onActivate} tabIndex={-1}>
        {activation.busy ? <CircleNotch size={13} weight="bold" className="animate-spin" /> : <SignIn size={13} weight="bold" />}
        {activation.busy ? activation.busyLabel ?? "Waiting…" : `Sign in to ${tile.agent.label}`}
      </button>
    );
  }
  return (
    <div
      key={tile.agent.id}
      className="ade-fr-rail-caption"
      data-light={brand.lightBanner ? "true" : undefined}
      data-shade={brand.softShade ? "soft" : undefined}
      data-action={action ? "true" : undefined}
      style={brand.banner}
      aria-live="polite"
    >
      <div className="ade-fr-rail-caption-shade" />
      {brand.bannerArt ? (
        <img
          className="ade-fr-rail-caption-art"
          src={brand.bannerArt.src}
          alt=""
          draggable={false}
          style={{ width: brand.bannerArt.width, ...(brand.bannerArt.opacity != null ? { opacity: brand.bannerArt.opacity } : {}) }}
        />
      ) : null}
      <span className="ade-fr-rail-caption-mark" aria-hidden="true">
        <BrandMark logo={brand.logo} family={tile.agent.logo} size={34} depth={6} />
      </span>
      <div className="ade-fr-rail-caption-text">
        <b>{tile.agent.label}</b>
        <span>
          <i data-state={state} />
          {line}
        </span>
      </div>
      {action}
    </div>
  );
}
