import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ArrowCounterClockwise, Eye, FloppyDisk, Moon, MoonStars, Plus, Shuffle, Sun, SunHorizon, X } from "@phosphor-icons/react";
import { applyScheduledLook, captureCurrentLook, useAppStore, type ThemeId } from "../../state/appStore";
import {
  ADE_THEME_FAMILIES,
  resolveTheme,
  resolveThemeById,
  themeFamilyForId,
  themeIdForMode,
  type AdeTheme,
  type ResolvedAdeThemePalette,
} from "../../../shared/theme";
import {
  MAX_SCHEDULE_SLOTS,
  MAX_SLOT_NAME,
  MINUTES_PER_DAY,
  activeSlotAt,
  formatSlotClock,
  formatSlotTime,
  markSlotApplied,
  newSlotId,
  parseSlotTime,
  readAppearanceSchedule,
  slotDayPart,
  slotLabel,
  subscribeAppearanceSchedule,
  updateAppearanceSchedule,
  type ScheduleSlot,
  type ScheduledLook,
} from "../../theme/appearanceSchedule";
import { BUNDLED_SCENES, findBundledScene } from "../../scene/sceneLibrary";
import { useUserScenes } from "../../scene/useScene";
import { SettingsToggle } from "./primitives";
import { MiniChrome, UserSceneThumb } from "./appearanceArt";

/**
 * Appearance › Schedule. A day cut into slots, each a whole look. The bar
 * shows the day; each card below is one slot: when it starts, what it looks
 * like, and buttons to save what is on screen into it or show it now. The
 * looks are made with the rest of this page and saved into a slot, so there
 * is no second editor to learn.
 */

const DAY_PART_ICON = { Morning: SunHorizon, Day: Sun, Evening: MoonStars, Night: Moon } as const;
const SANS_LABEL: Record<string, string> = { geist: "Geist", system: "System font", "geist-mono": "Geist Mono" };

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // The bar's "now" line and the active card only need minute precision.
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function minutesOfDay(at: number): number {
  const date = new Date(at);
  return date.getHours() * 60 + date.getMinutes();
}

function paintedThemeId(look: ScheduledLook, systemColorScheme: ThemeId): string {
  return look.followsSystem ? themeIdForMode(look.themeId, systemColorScheme) : look.themeId;
}

function lookPalette(look: ScheduledLook, customThemes: AdeTheme[], systemColorScheme: ThemeId): ResolvedAdeThemePalette {
  return resolveTheme(resolveThemeById(paintedThemeId(look, systemColorScheme), customThemes)).palette;
}

/** Two looks are the same on screen. Shuffle's pool and similar fine print do not count. */
function sameLook(a: ScheduledLook, b: ScheduledLook): boolean {
  const sa = a.scene;
  const sb = b.scene;
  return (
    a.themeId === b.themeId &&
    a.followsSystem === b.followsSystem &&
    a.sansFont === b.sansFont &&
    a.monoFont === b.monoFont &&
    sa.mode === sb.mode &&
    (sa.mode !== "image" || sa.imageId === sb.imageId) &&
    sa.showImage === sb.showImage &&
    sa.texture === sb.texture &&
    sa.dim === sb.dim &&
    sa.matchTheme === sb.matchTheme
  );
}

/** The first whole hour at or after `from` that no slot starts at. */
function freeStart(slots: readonly ScheduleSlot[], from: number): number {
  const taken = new Set(slots.map((slot) => slot.start));
  const first = Math.ceil(from / 60) * 60;
  for (let step = 0; step < 24; step += 1) {
    const start = (first + step * 60) % MINUTES_PER_DAY;
    if (!taken.has(start)) return start;
  }
  for (let start = 0; start < MINUTES_PER_DAY; start += 1) if (!taken.has(start)) return start;
  return 0;
}

/** Light by day, dark at night, in the current theme family, background and fonts. */
function starterSlots(current: ScheduledLook): ScheduleSlot[] {
  const family = themeFamilyForId(current.themeId) ?? ADE_THEME_FAMILIES[0]!;
  return [
    { id: newSlotId(), start: 8 * 60, name: "Day", look: { ...current, themeId: family.light.id, followsSystem: false } },
    { id: newSlotId(), start: 20 * 60, name: "Night", look: { ...current, themeId: family.dark.id, followsSystem: false } },
  ];
}

export function AppearanceScheduleSettings() {
  const schedule = useSyncExternalStore(subscribeAppearanceSchedule, readAppearanceSchedule);
  const now = useNow();
  const customThemes = useAppStore((s) => s.customThemes);
  const systemColorScheme = useAppStore((s) => s.systemColorScheme);
  // Read so the "changed by hand" note follows every change on this page.
  const themeId = useAppStore((s) => s.themeId);
  const followsSystem = useAppStore((s) => s.themeFollowsSystem);
  const interfacePreferences = useAppStore((s) => s.interfacePreferences);
  const userScenes = useUserScenes();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const onScreen = useMemo<ScheduledLook>(
    () => ({
      themeId,
      followsSystem,
      scene: interfacePreferences.scene,
      sansFont: interfacePreferences.sansFont,
      monoFont: interfacePreferences.monoFont,
    }),
    [themeId, followsSystem, interfacePreferences],
  );

  const { slots, enabled } = schedule;
  const active = activeSlotAt(slots, now);
  const overridden = enabled && active != null && !sameLook(active.slot.look, onScreen);

  const setEnabled = (on: boolean) => {
    updateAppearanceSchedule((prev) => ({
      ...prev,
      enabled: on,
      slots: on && prev.slots.length === 0 ? starterSlots(captureCurrentLook()) : prev.slots,
      // Turning it on shows the slot for now straight away.
      lastApplied: on ? null : prev.lastApplied,
    }));
  };

  const addSlot = () => {
    const look = captureCurrentLook();
    const id = newSlotId();
    updateAppearanceSchedule((prev) => {
      if (prev.slots.length >= MAX_SCHEDULE_SLOTS) return prev;
      const start = freeStart(prev.slots, minutesOfDay(Date.now()) + 1);
      return { ...prev, slots: [...prev.slots, { id, start, name: "", look }] };
    });
    setSelectedId(id);
  };

  const patchSlot = (id: string, patch: Partial<ScheduleSlot>) =>
    updateAppearanceSchedule((prev) => ({
      ...prev,
      slots: prev.slots.map((slot) => (slot.id === id ? { ...slot, ...patch } : slot)),
    }));

  const removeSlot = (id: string) => {
    updateAppearanceSchedule((prev) => ({ ...prev, slots: prev.slots.filter((slot) => slot.id !== id) }));
    if (selectedId === id) setSelectedId(null);
  };

  /** Show a slot now. Like a change by hand, it holds until the next slot starts. */
  const showSlot = (slot: ScheduleSlot) => {
    applyScheduledLook(slot.look);
    // The slot in charge shown again counts as applied, so the "by hand" note clears.
    if (active && active.slot.id === slot.id) markSlotApplied(active);
  };

  const backToSchedule = () => {
    if (!active) return;
    applyScheduledLook(active.slot.look);
    markSlotApplied(active);
  };

  return (
    <div className="ade-ap-sched">
      <div className="ade-ap-rowcard">
        <div>
          <div className="ade-ap-rowtitle">Switch looks by time of day</div>
          <div className="ade-ap-rowhint">
            {enabled
              ? "A change you make by hand holds until the next time below."
              : "Starts with light from 08:00 and dark from 20:00. Change both after."}
          </div>
        </div>
        <SettingsToggle label="Switch looks by time of day" checked={enabled} onChange={setEnabled} />
      </div>

      {enabled ? (
        <>
          {slots.length > 0 ? (
            <DayBar
              slots={slots}
              now={now}
              activeId={active?.slot.id ?? null}
              selectedId={selectedId}
              onSelect={setSelectedId}
              customThemes={customThemes}
              systemColorScheme={systemColorScheme}
            />
          ) : null}

          {active ? (
            <div className="ade-ap-sched-status" data-overridden={overridden || undefined} role="status">
              {overridden ? (
                <>
                  <span>
                    Changed by hand. <b>{slotLabel(active.next)}</b> takes over at {formatSlotClock(active.next.start)}.
                  </span>
                  <button type="button" className="ade-ap-shuffle-all" onClick={backToSchedule}>
                    <ArrowCounterClockwise size={11} weight="bold" /> Back to {slotLabel(active.slot)}
                  </button>
                </>
              ) : slots.length === 1 ? (
                <span>One look all day. Add another time to switch.</span>
              ) : (
                <span>
                  <b>{slotLabel(active.slot)}</b> until {formatSlotClock(active.next.start)}, then <b>{slotLabel(active.next)}</b>.
                </span>
              )}
            </div>
          ) : null}

          {slots.length === 0 ? (
            <div className="ade-ap-sched-empty">No times yet. Set up a look on this page, then add it to a time.</div>
          ) : (
            <div className="ade-ap-sched-list">
              {slots.map((slot, index) => (
                <SlotCard
                  key={slot.id}
                  slot={slot}
                  until={slots[(index + 1) % slots.length]!.start}
                  single={slots.length === 1}
                  isActive={active?.slot.id === slot.id}
                  selected={selectedId === slot.id}
                  matchesScreen={sameLook(slot.look, onScreen)}
                  takenStarts={slots.filter((other) => other.id !== slot.id).map((other) => other.start)}
                  customThemes={customThemes}
                  systemColorScheme={systemColorScheme}
                  userScenes={userScenes}
                  onSelect={() => setSelectedId(slot.id)}
                  onStart={(start) => patchSlot(slot.id, { start })}
                  onRename={(name) => patchSlot(slot.id, { name })}
                  onSave={() => patchSlot(slot.id, { look: captureCurrentLook() })}
                  onShow={() => showSlot(slot)}
                  onRemove={() => removeSlot(slot.id)}
                />
              ))}
            </div>
          )}

          <div className="ade-ap-sched-foot">
            <button
              type="button"
              className="ade-ap-shuffle-now"
              onClick={addSlot}
              disabled={slots.length >= MAX_SCHEDULE_SLOTS}
              title={slots.length >= MAX_SCHEDULE_SLOTS ? `Up to ${MAX_SCHEDULE_SLOTS} times` : "Add a time that switches to the look on screen now"}
            >
              <Plus size={12} weight="bold" /> Add a time with this look
            </button>
            <span className="ade-ap-rowhint">Each look runs until the next time starts, past midnight too.</span>
          </div>
        </>
      ) : null}
    </div>
  );
}

/* ── the day bar ────────────────────────────────────────────────────── */

function DayBar({
  slots,
  now,
  activeId,
  selectedId,
  onSelect,
  customThemes,
  systemColorScheme,
}: {
  slots: ScheduleSlot[];
  now: number;
  activeId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  customThemes: AdeTheme[];
  systemColorScheme: ThemeId;
}) {
  // Each slot runs from its start to the next; the last wraps, so it draws twice:
  // from its start to midnight and from midnight to the first start.
  const pieces: { slot: ScheduleSlot; from: number; to: number; labelled: boolean }[] = [];
  slots.forEach((slot, index) => {
    const next = slots[index + 1];
    pieces.push({ slot, from: slot.start, to: next ? next.start : MINUTES_PER_DAY, labelled: true });
  });
  const last = slots[slots.length - 1]!;
  if (slots[0]!.start > 0) pieces.unshift({ slot: last, from: 0, to: slots[0]!.start, labelled: false });
  const nowMinutes = minutesOfDay(now);
  const pct = (minutes: number) => `${(minutes / MINUTES_PER_DAY) * 100}%`;

  return (
    <div className="ade-ap-sched-day">
      <div className="ade-ap-sched-bar" role="group" aria-label="Looks across the day">
        {pieces.map((piece) => {
          const palette = lookPalette(piece.slot.look, customThemes, systemColorScheme);
          const Icon = DAY_PART_ICON[slotDayPart(piece.slot.start)];
          const span = piece.to - piece.from;
          return (
            <button
              key={`${piece.slot.id}-${piece.from}`}
              type="button"
              className="ade-ap-sched-seg"
              data-active={piece.slot.id === activeId || undefined}
              data-selected={piece.slot.id === selectedId || undefined}
              style={{
                left: pct(piece.from),
                width: pct(piece.to - piece.from),
                background: `linear-gradient(135deg, color-mix(in srgb, ${palette.accent} 38%, ${palette.bg}), ${palette.bg} 70%)`,
                color: palette.fg,
              }}
              onClick={() => onSelect(piece.slot.id)}
              title={`${slotLabel(piece.slot)} · from ${formatSlotClock(piece.slot.start)}`}
            >
              {piece.labelled && span >= 90 ? (
                <span className="ade-ap-sched-seg-label">
                  <Icon size={12} weight="fill" style={{ color: palette.accent }} />
                  {span >= 300 ? <span className="ade-ap-sched-seg-name">{slotLabel(piece.slot)}</span> : null}
                  <span className="ade-ap-sched-seg-time">{formatSlotClock(piece.slot.start)}</span>
                </span>
              ) : null}
            </button>
          );
        })}
        <span className="ade-ap-sched-now" style={{ left: pct(nowMinutes) }} aria-label={`Now, ${formatSlotClock(nowMinutes)}`}>
          <span className="ade-ap-sched-now-tag">{formatSlotClock(nowMinutes)}</span>
        </span>
      </div>
      <div className="ade-ap-sched-ticks" aria-hidden>
        {[0, 6, 12, 18, 24].map((hour) => (
          <span key={hour} className="kit-num" style={{ left: pct(hour * 60) }}>{String(hour).padStart(2, "0")}</span>
        ))}
      </div>
    </div>
  );
}

/* ── one slot ───────────────────────────────────────────────────────── */

function SlotCard({
  slot,
  until,
  single,
  isActive,
  selected,
  matchesScreen,
  takenStarts,
  customThemes,
  systemColorScheme,
  userScenes,
  onSelect,
  onStart,
  onRename,
  onSave,
  onShow,
  onRemove,
}: {
  slot: ScheduleSlot;
  until: number;
  single: boolean;
  isActive: boolean;
  selected: boolean;
  matchesScreen: boolean;
  takenStarts: number[];
  customThemes: AdeTheme[];
  systemColorScheme: ThemeId;
  userScenes: { id: string; name: string }[];
  onSelect: () => void;
  onStart: (start: number) => void;
  onRename: (name: string) => void;
  onSave: () => void;
  onShow: () => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(formatSlotTime(slot.start));
  const [clash, setClash] = useState(false);
  useEffect(() => {
    setDraft(formatSlotTime(slot.start));
    setClash(false);
  }, [slot.start]);

  const part = slotDayPart(slot.start);
  const label = slotLabel(slot);
  const Icon = DAY_PART_ICON[part];
  const [nameDraft, setNameDraft] = useState(slot.name);
  useEffect(() => setNameDraft(slot.name), [slot.name]);
  const look = slot.look;
  const theme = resolveThemeById(paintedThemeId(look, systemColorScheme), customThemes);
  const family = themeFamilyForId(look.themeId);
  // A theme deleted since it was saved paints as the default.
  const themeMissing = !family && !customThemes.some((custom) => custom.id === look.themeId);
  const themeLabel = look.followsSystem && family ? `${family.name} · Auto` : theme.name;
  const palette = resolveTheme(theme).palette;
  const background = backgroundLabel(look, userScenes);

  // Saved when the field is left, not per keystroke: typing "19" passes
  // through "01", and each saved time can switch the whole app's look.
  const editTime = (value: string) => {
    setDraft(value);
    const start = parseSlotTime(value);
    setClash(start != null && takenStarts.includes(start));
  };
  const commitTime = (input: HTMLInputElement) => {
    const start = parseSlotTime(input.value);
    if (start != null && start !== slot.start && !takenStarts.includes(start)) {
      onStart(start);
    } else {
      // A half-typed time can leave the field showing "--:--" without a change
      // event, so the stored time is put back on the element itself as well.
      input.value = formatSlotTime(slot.start);
      setDraft(formatSlotTime(slot.start));
    }
    setClash(false);
  };

  return (
    <div className="ade-ap-sched-slot" data-active={isActive || undefined} data-selected={selected || undefined} onClick={onSelect}>
      <div className="ade-ap-sched-art" aria-hidden>
        <LookBackdrop look={look} palette={palette} />
        <div className="ade-ap-sched-art-win">
          <MiniChrome palette={palette} />
        </div>
      </div>

      <div className="ade-ap-sched-body">
        <div className="ade-ap-sched-title">
          <Icon size={14} weight="fill" style={{ color: palette.accent }} />
          <input
            className="ade-ap-sched-name"
            value={nameDraft}
            placeholder={part}
            maxLength={MAX_SLOT_NAME}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => {
              const name = nameDraft.trim();
              if (name !== slot.name) onRename(name);
              else setNameDraft(slot.name);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setNameDraft(slot.name);
            }}
            onClick={(event) => event.stopPropagation()}
            aria-label="Name of this look"
            title="Rename"
            size={Math.max(4, (nameDraft || part).length)}
          />
          {isActive ? <span className="ade-ap-sched-badge">Now</span> : null}
          <button
            type="button"
            className="ade-ap-sched-remove"
            onClick={(event) => {
              event.stopPropagation();
              onRemove();
            }}
            aria-label={`Remove ${label}`}
            title="Remove"
          >
            <X size={11} weight="bold" />
          </button>
        </div>
        <div className="ade-ap-sched-time">
          <label className="ade-ap-sched-time-field" data-clash={clash || undefined}>
            <span className="kit-eyebrow">From</span>
            <input
              type="time"
              value={draft}
              onChange={(event) => editTime(event.target.value)}
              onBlur={(event) => commitTime(event.currentTarget)}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setDraft(formatSlotTime(slot.start));
                  setClash(false);
                }
              }}
              onClick={(event) => event.stopPropagation()}
              aria-label={`${label} starts at`}
              aria-invalid={clash || undefined}
            />
          </label>
          <span className="ade-ap-sched-until">
            {single ? "all day" : `until ${formatSlotClock(until)}`}
          </span>
        </div>
        {clash ? <div className="ade-ap-sched-error" role="alert">Another look already starts then. Pick another time.</div> : null}
        <div className="ade-ap-sched-summary" title={`${themeLabel} · ${background} · ${SANS_LABEL[look.sansFont] ?? look.sansFont}`}>
          {themeMissing ? <span className="ade-ap-sched-missing">Theme removed, uses ADE</span> : <span>{themeLabel}</span>}
          <span aria-hidden>·</span>
          <span>{background}</span>
          <span aria-hidden>·</span>
          <span>{SANS_LABEL[look.sansFont] ?? look.sansFont}</span>
        </div>
      </div>

      <div className="ade-ap-sched-actions">
        <button
          type="button"
          className="ade-ap-shuffle-all"
          onClick={(event) => {
            event.stopPropagation();
            onSave();
          }}
          disabled={matchesScreen}
          title={matchesScreen ? "This is the look on screen" : "Replace this look with what is on screen now"}
        >
          <FloppyDisk size={11} weight="bold" /> {matchesScreen ? "Matches screen" : "Save screen here"}
        </button>
        <button
          type="button"
          className="ade-ap-shuffle-all"
          onClick={(event) => {
            event.stopPropagation();
            onShow();
          }}
          disabled={matchesScreen}
          title={isActive ? "Show this look again" : "Show this look now. It holds until the next time starts."}
        >
          <Eye size={11} weight="bold" /> Show now
        </button>
      </div>
    </div>
  );
}

function backgroundLabel(look: ScheduledLook, userScenes: { id: string; name: string }[]): string {
  const scene = look.scene;
  if (scene.mode === "plain") return "Plain";
  if (scene.mode === "gradient") return "Gradient";
  if (scene.mode === "shuffle") return "Shuffle";
  const name = findBundledScene(scene.imageId)?.name ?? userScenes.find((user) => user.id === scene.imageId)?.name;
  if (!name) return "Picture removed";
  return scene.showImage ? name : `${name} colours`;
}

/** The slot's background, small: its picture, the shuffle, or the theme's gradient or flat colour. */
function LookBackdrop({ look, palette }: { look: ScheduledLook; palette: ResolvedAdeThemePalette }) {
  const scene = look.scene;
  if (scene.mode === "plain" || (scene.mode !== "gradient" && !scene.showImage)) {
    return <div className="ade-ap-sched-art-bg" style={{ background: palette.bg }} />;
  }
  if (scene.mode === "gradient") {
    return (
      <div
        className="ade-ap-sched-art-bg"
        style={{
          background: `radial-gradient(120% 90% at 20% 15%, color-mix(in srgb, ${palette.accentDeep} 70%, transparent), transparent 62%), radial-gradient(110% 90% at 85% 85%, color-mix(in srgb, ${palette.accent} 55%, transparent), transparent 60%), ${palette.bg}`,
        }}
      />
    );
  }
  if (scene.mode === "shuffle") {
    return (
      <div className="ade-ap-sched-art-bg ade-ap-scene-mosaic">
        {BUNDLED_SCENES.slice(0, 4).map((picture) => (
          <img key={picture.id} src={picture.thumb} alt="" draggable={false} style={{ objectPosition: picture.position }} />
        ))}
        <span className="ade-ap-scene-badge"><Shuffle size={11} weight="bold" /></span>
      </div>
    );
  }
  const bundled = findBundledScene(scene.imageId);
  return (
    <div className="ade-ap-sched-art-bg">
      {bundled ? (
        <img src={bundled.thumb} alt="" draggable={false} style={{ objectPosition: bundled.position }} />
      ) : scene.imageId ? (
        <UserSceneThumb id={scene.imageId} />
      ) : null}
    </div>
  );
}
