import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  Check,
  Desktop,
  ImageSquare,
  Moon,
  PaintBrush,
  Plus,
  Shuffle,
  Sun,
  X,
} from "@phosphor-icons/react";
import {
  DEFAULT_TERMINAL_FONT_FAMILY,
  selectEffectiveThemeId,
  useAppStore,
  type InterfaceMonoFont,
  type InterfaceSansFont,
} from "../../state/appStore";
import { DEFAULT_SCENE_PREFERENCES, type SceneShuffleEvery, type SceneTexture } from "../../scene/scenePreferences";
import type {
  ChatChromeTint,
  ChatShellGeometry,
  ChatTranscriptDensity,
  CodeBlockCopyButtonPosition,
} from "../../state/appStore";
import {
  TERMINAL_FONT_FAMILY_OPTIONS,
  TERMINAL_FONT_SIZE_OPTIONS,
  TERMINAL_LINE_HEIGHT_OPTIONS,
  TERMINAL_SCROLLBACK_OPTIONS,
} from "./terminalOptions";
import {
  ADE_THEME_FAMILIES,
  resolveTheme,
  resolveThemeById,
  type AdeTerminalPalette,
  type ResolvedAdeThemePalette,
} from "../../../shared/theme";
import { ModernSection, SettingsColumn, SettingsSectionAction, SettingsSelect, SettingsToggle } from "./primitives";
import { ThemeGallery, useThemeMode, type ThemeMode } from "./ThemeGallery";
import { ThemeCustomizer } from "./ThemeCustomizer";
import { ThemeFilesHelp, ThemeImportExport } from "./ThemeImportExport";
import { BUNDLED_SCENES } from "../../scene/sceneLibrary";
import { reshuffleScene, useActiveScene, useSetScene, useUserScenes, type ActiveScene } from "../../scene/useScene";
import { addUserScene, removeUserScene, userSceneUrl } from "../../scene/userScenes";
import { backdropThemeFromScene } from "../../scene/scenePalette";
import "./AppearanceSection.css";

/**
 * Appearance settings.
 *
 * Everything here is per computer and applies the moment it is picked. The
 * page is two columns: the choices on the left, each a short heading and a
 * row of visual options (mode cards, theme swatches, background pictures,
 * type specimens), and on the right a live preview that stays in view — a
 * small ADE window painted with the real theme tokens and the active scene.
 * On a narrow window the preview moves above the choices.
 */

export const COPY_POSITION_META: Record<CodeBlockCopyButtonPosition, { label: string; hint: string }> = {
  top: { label: "Top", hint: "Pinned to the corner" },
  bottom: { label: "Bottom", hint: "Easier after scrolling" },
  auto: { label: "Auto-float", hint: "Follows the viewport" },
};

export const TRANSCRIPT_DENSITY_LABEL: Record<ChatTranscriptDensity, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
  spacious: "Spacious",
};

export const CHAT_CHROME_TINT_LABEL: Record<ChatChromeTint, string> = {
  neutral: "No tint",
  colored: "Colored",
};

export const SHELL_GEOMETRY_LABEL: Record<ChatShellGeometry, string> = {
  soft: "Soft",
  default: "Default",
  sharp: "Sharp",
};

const SANS_SPECIMENS: { value: InterfaceSansFont; label: string; stack: string }[] = [
  { value: "geist", label: "Geist", stack: '"Geist", system-ui, sans-serif' },
  { value: "system", label: "System", stack: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { value: "geist-mono", label: "Geist Mono", stack: '"Geist Mono", ui-monospace, monospace' },
];

const MONO_SPECIMENS: { value: InterfaceMonoFont; label: string; stack: string }[] = [
  { value: "jetbrains", label: "JetBrains Mono", stack: '"JetBrains Mono", ui-monospace, monospace' },
  { value: "geist-mono", label: "Geist Mono", stack: '"Geist Mono", ui-monospace, monospace' },
  { value: "system", label: "System mono", stack: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
];

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function AppearanceSection() {
  const resetThemeAndChatFontDefaults = useAppStore((s) => s.resetThemeAndChatFontDefaults);
  const [customizerOpen, setCustomizerOpen] = useState(false);
  const interfacePreferences = useAppStore((s) => s.interfacePreferences);
  const setInterfacePreferences = useAppStore((s) => s.setInterfacePreferences);
  const setTheme = useAppStore((s) => s.setTheme);
  const mode = useAppStore((s) => s.theme);
  const setScene = useSetScene();
  const { activeMode, choose } = useThemeMode();

  // A few single-key shortcuts while this page is open, as on a playground:
  // r = a random theme, b = shuffle the background, m = cycle the mode.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "r") {
        const family = ADE_THEME_FAMILIES[Math.floor(Math.random() * ADE_THEME_FAMILIES.length)];
        if (family) setTheme(family[mode].id);
      } else if (key === "b") {
        const scene = useAppStore.getState().interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES;
        if (scene.mode !== "shuffle") setScene({ mode: "shuffle" });
        reshuffleScene();
      } else if (key === "m") {
        const order: ThemeMode[] = ["system", "light", "dark"];
        choose(order[(order.indexOf(activeMode ?? "dark") + 1) % order.length]!);
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeMode, choose, mode, setScene, setTheme]);

  const resetAll = () => {
    resetThemeAndChatFontDefaults();
    setInterfacePreferences({ sansFont: "geist", monoFont: "jetbrains", scene: DEFAULT_SCENE_PREFERENCES });
  };

  return (
    <SettingsColumn wide>
      <div className="ade-appearance">
       <div className="ade-ap-layout">
        <div className="ade-ap-main">
          <ModernSection group="Theme" anchor="theme" title="Mode" hint="Light, dark, or follow your system.">
            <ModeCards />
          </ModernSection>

          <ModernSection
            group="Theme"
            title="Theme"
            hint="Colours, corners, depth and type for the whole app, the editor and the terminal."
            actions={(
              <>
                <SettingsSectionAction
                  icon={<PaintBrush size={13} />}
                  label="Customize"
                  title="Change colours and save the result as your own theme"
                  onClick={() => setCustomizerOpen(true)}
                />
                <ThemeImportExport />
              </>
            )}
          >
            <ThemeGallery compact />
            <ThemeFilesHelp />
          </ModernSection>

          <ModernSection
            group="Background"
            anchor="background"
            title="Background"
            hint="What fills the window behind the top bar, the home screen and new chats."
          >
            <BackgroundPicker />
          </ModernSection>

          <ModernSection group="Interface" anchor="interface-font" title="Interface font" hint="Everything outside code and the terminal.">
            <SpecimenGrid
              options={SANS_SPECIMENS}
              value={interfacePreferences.sansFont}
              onChange={(sansFont) => setInterfacePreferences({ sansFont })}
              sample="Ship the lane"
              ariaLabel="Interface font"
            />
          </ModernSection>

          <ModernSection group="Interface" anchor="code-font" title="Code font" hint="Code blocks, diffs and file previews.">
            <SpecimenGrid
              options={MONO_SPECIMENS}
              value={interfacePreferences.monoFont}
              onChange={(monoFont) => setInterfacePreferences({ monoFont })}
              sample="fn main() {}"
              ariaLabel="Code font"
            />
          </ModernSection>

          <ModernSection group="Interface" anchor="reduce-motion" title="Motion">
            <div className="ade-ap-rowcard">
              <div>
                <div className="ade-ap-rowtitle">Reduce motion</div>
                <div className="ade-ap-rowhint">Turn off animations and transitions everywhere, including the background.</div>
              </div>
              <SettingsToggle
                label="Reduce motion"
                checked={interfacePreferences.reduceMotion}
                onChange={(reduceMotion) => setInterfacePreferences({ reduceMotion })}
              />
            </div>
          </ModernSection>

          <ModernSection group="Terminal" anchor="terminal-text" title="Terminal" hint="Work terminals, lane shells and the chat drawer.">
            <TerminalSettings />
          </ModernSection>
        </div>

        <aside className="ade-ap-aside">
          <div className="ade-ap-aside-head">
            <span className="kit-eyebrow">Preview</span>
            <button type="button" className="ade-ap-reset" onClick={resetAll} title="Restore ADE, dark, Geist, and the picture shuffle">
              <ArrowCounterClockwise size={11} weight="bold" /> Reset
            </button>
          </div>
          <AppearancePreview />
          <div className="ade-ap-keys" aria-label="Shortcuts on this page">
            <span><kbd>r</kbd> random theme</span>
            <span><kbd>b</kbd> shuffle background</span>
            <span><kbd>m</kbd> mode</span>
          </div>
        </aside>
       </div>
      </div>

      <ThemeCustomizer open={customizerOpen} onOpenChange={setCustomizerOpen} />
    </SettingsColumn>
  );
}

/* ── Mode ───────────────────────────────────────────────────────────── */

function usePalettes(): { light: ResolvedAdeThemePalette; dark: ResolvedAdeThemePalette; active: ResolvedAdeThemePalette } {
  const { family } = useThemeMode();
  const themeId = useAppStore(selectEffectiveThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  return useMemo(() => {
    const base = family ?? ADE_THEME_FAMILIES[0]!;
    return {
      light: resolveTheme(base.light).palette,
      dark: resolveTheme(base.dark).palette,
      active: resolveTheme(resolveThemeById(themeId, customThemes)).palette,
    };
  }, [family, themeId, customThemes]);
}

function ModeCards() {
  const { activeMode, choose } = useThemeMode();
  const { light, dark } = usePalettes();
  const cards: { mode: ThemeMode; label: string; Icon: typeof Sun }[] = [
    { mode: "light", label: "Light", Icon: Sun },
    { mode: "dark", label: "Dark", Icon: Moon },
    { mode: "system", label: "Auto", Icon: Desktop },
  ];
  return (
    <div className="ade-ap-grid3" role="radiogroup" aria-label="Mode">
      {cards.map(({ mode, label, Icon }) => {
        const active = activeMode === mode;
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={active}
            className="ade-ap-choice"
            data-active={active}
            onClick={() => choose(mode)}
          >
            <div className="ade-ap-mode-art">
              {mode === "system" ? (
                <>
                  <div className="ade-ap-split" style={{ clipPath: "polygon(0 0, 100% 0, 0 100%)" }}>
                    <MiniChrome palette={light} />
                  </div>
                  <div className="ade-ap-split" style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}>
                    <MiniChrome palette={dark} />
                  </div>
                </>
              ) : (
                <MiniChrome palette={mode === "light" ? light : dark} />
              )}
            </div>
            <div className="ade-ap-choice-foot">
              <Icon size={13} />
              <span>{label}</span>
              {active ? <Check size={12} weight="bold" className="ade-ap-check" /> : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/** A tiny ADE window in a given palette: top bar, sidebar, a card and a composer. */
function MiniChrome({ palette }: { palette: ResolvedAdeThemePalette }) {
  const p = palette;
  return (
    <div className="ade-ap-mini" style={{ background: p.bg }}>
      <div className="ade-ap-mini-top" style={{ background: `color-mix(in srgb, ${p.accent} 22%, ${p.bg})` }}>
        <span style={{ background: p.fg, opacity: 0.55 }} />
        <span style={{ background: p.accent }} />
      </div>
      <div className="ade-ap-mini-body">
        <div className="ade-ap-mini-side" style={{ background: p.surface, borderColor: `color-mix(in srgb, ${p.fg} 10%, transparent)` }}>
          <span style={{ background: p.accent, opacity: 0.9 }} />
          <span style={{ background: p.fg, opacity: 0.25 }} />
          <span style={{ background: p.fg, opacity: 0.18 }} />
        </div>
        <div className="ade-ap-mini-main">
          <span className="ade-ap-mini-line" style={{ background: p.fg, opacity: 0.4 }} />
          <div className="ade-ap-mini-card" style={{ background: p.surface, borderColor: `color-mix(in srgb, ${p.fg} 10%, transparent)` }}>
            <span style={{ background: p.fg, opacity: 0.3 }} />
            <span style={{ background: p.accent }} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Background ─────────────────────────────────────────────────────── */

function BackgroundPicker() {
  const scenePrefs = useAppStore((s) => s.interfacePreferences.scene ?? DEFAULT_SCENE_PREFERENCES);
  const setScene = useSetScene();
  const userScenes = useUserScenes();
  const active = useActiveScene();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const { active: palette } = usePalettes();

  const importFiles = async (files: FileList | File[] | null) => {
    const list = files ? Array.from(files).filter((file) => file.type.startsWith("image/")) : [];
    if (list.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      let last: string | null = null;
      for (const file of list) last = (await addUserScene(file)).id;
      if (last) setScene({ mode: "image", imageId: last });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add that picture");
    } finally {
      setBusy(false);
    }
  };

  const pickedId = scenePrefs.mode === "image" ? scenePrefs.imageId : null;
  const usingPicture = scenePrefs.mode !== "gradient";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="ade-ap-scenes" role="radiogroup" aria-label="Background">
        <button
          type="button"
          role="radio"
          aria-checked={scenePrefs.mode === "gradient"}
          className="ade-ap-scene"
          data-active={scenePrefs.mode === "gradient"}
          onClick={() => setScene({ mode: "gradient" })}
        >
          <div
            className="ade-ap-scene-art"
            style={{
              background: `radial-gradient(120% 90% at 20% 15%, color-mix(in srgb, ${palette.accentDeep} 70%, transparent), transparent 62%), radial-gradient(110% 90% at 85% 85%, color-mix(in srgb, ${palette.accent} 55%, transparent), transparent 60%), ${palette.bg}`,
            }}
          />
          <SceneLabel name="Gradient" sub="Animated, from the theme" active={scenePrefs.mode === "gradient"} />
        </button>

        <button
          type="button"
          role="radio"
          aria-checked={scenePrefs.mode === "shuffle"}
          className="ade-ap-scene"
          data-active={scenePrefs.mode === "shuffle"}
          onClick={() => {
            if (scenePrefs.mode === "shuffle") reshuffleScene();
            else setScene({ mode: "shuffle" });
          }}
          title={scenePrefs.mode === "shuffle" ? "Pick another picture now" : "A new picture on a schedule"}
        >
          <div className="ade-ap-scene-art ade-ap-scene-mosaic">
            {BUNDLED_SCENES.slice(0, 4).map((scene) => (
              <img key={scene.id} src={scene.src} alt="" draggable={false} style={{ objectPosition: scene.position }} />
            ))}
            <span className="ade-ap-scene-badge"><Shuffle size={13} weight="bold" /></span>
          </div>
          <SceneLabel
            name="Shuffle"
            sub={scenePrefs.mode === "shuffle" && active.kind === "image" ? `Now: ${active.name}` : "New picture each launch"}
            active={scenePrefs.mode === "shuffle"}
          />
        </button>

        {BUNDLED_SCENES.map((scene) => (
          <button
            key={scene.id}
            type="button"
            role="radio"
            aria-checked={pickedId === scene.id}
            className="ade-ap-scene"
            data-active={pickedId === scene.id}
            onClick={() => setScene({ mode: "image", imageId: scene.id })}
          >
            <div className="ade-ap-scene-art">
              <img src={scene.src} alt="" draggable={false} style={{ objectPosition: scene.position }} />
            </div>
            <SceneLabel name={scene.name} sub="ADE" active={pickedId === scene.id} />
          </button>
        ))}

        {userScenes.map((scene) => (
          <UserSceneTile
            key={scene.id}
            id={scene.id}
            name={scene.name}
            active={pickedId === scene.id}
            onPick={() => setScene({ mode: "image", imageId: scene.id })}
            onRemove={() => {
              if (pickedId === scene.id) setScene({ mode: "gradient", imageId: null });
              void removeUserScene(scene.id);
            }}
          />
        ))}

        <button
          type="button"
          className="ade-ap-scene ade-ap-scene-add"
          data-drag={dragOver || undefined}
          onClick={() => fileRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragOver(false);
            void importFiles(event.dataTransfer.files);
          }}
          disabled={busy}
        >
          <div className="ade-ap-scene-art">
            <span className="ade-ap-add-icon">{busy ? <ImageSquare size={18} /> : <Plus size={18} />}</span>
          </div>
          <SceneLabel name={busy ? "Adding…" : "Your picture"} sub="Click or drop a file" active={false} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(event) => {
            void importFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {error ? <p className="ade-ap-error">{error}</p> : null}

      {scenePrefs.mode === "shuffle" ? (
        <ShuffleOptions
          every={scenePrefs.shuffleEvery}
          exclude={scenePrefs.shuffleExclude}
          userScenes={userScenes}
          activeId={active.kind === "image" ? active.id : null}
          onEvery={(shuffleEvery) => setScene({ shuffleEvery })}
          onExclude={(shuffleExclude) => setScene({ shuffleExclude })}
        />
      ) : null}

      {usingPicture ? (
        <div className="ade-ap-options">
          <div className="ade-ap-option">
            <span className="kit-eyebrow">App colours</span>
            <div className="kit-seg" role="group" aria-label="Whether the picture sets the app's colours">
              <button type="button" aria-pressed={scenePrefs.matchTheme} onClick={() => setScene({ matchTheme: true })}>From picture</button>
              <button type="button" aria-pressed={!scenePrefs.matchTheme} onClick={() => setScene({ matchTheme: false })}>From theme</button>
            </div>
          </div>
          <div className="ade-ap-option">
            <span className="kit-eyebrow">Show</span>
            <div className="kit-seg" role="group" aria-label="How the picture shows">
              <button type="button" aria-pressed={scenePrefs.showImage} onClick={() => setScene({ showImage: true })}>Picture</button>
              <button type="button" aria-pressed={!scenePrefs.showImage} onClick={() => setScene({ showImage: false })}>Colours only</button>
            </div>
          </div>
          {scenePrefs.showImage ? (
            <>
              <div className="ade-ap-option">
                <span className="kit-eyebrow">Texture</span>
                <div className="kit-seg" role="group" aria-label="Texture">
                  {(["none", "dots", "grain"] as SceneTexture[]).map((texture) => (
                    <button key={texture} type="button" aria-pressed={scenePrefs.texture === texture} onClick={() => setScene({ texture })}>
                      {texture === "none" ? "None" : texture === "dots" ? "Halftone" : "Grain"}
                    </button>
                  ))}
                </div>
              </div>
              <label className="ade-ap-option">
                <span className="kit-eyebrow">Veil</span>
                <input
                  type="range"
                  min={0}
                  max={60}
                  step={2}
                  value={scenePrefs.dim}
                  onChange={(event) => setScene({ dim: Number(event.target.value) })}
                  className="ade-ap-range"
                  aria-label="How much the theme veils the picture"
                />
                <span className="kit-num ade-ap-range-value">{scenePrefs.dim}%</span>
              </label>
            </>
          ) : (
            <p className="ade-ap-rowhint" style={{ margin: 0 }}>
              The animated gradient takes its colours from the picture.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

const SHUFFLE_EVERY_OPTIONS: { value: SceneShuffleEvery; label: string }[] = [
  { value: "wake", label: "On wake" },
  { value: "launch", label: "Each launch" },
  { value: "hour", label: "Hourly" },
  { value: "day", label: "Daily" },
];

/**
 * Shuffle's own settings: when it changes, and which pictures are in the
 * rotation. Every picture is in by default; a new picture joins on its own.
 */
function ShuffleOptions({
  every,
  exclude,
  userScenes,
  activeId,
  onEvery,
  onExclude,
}: {
  every: SceneShuffleEvery;
  exclude: string[];
  userScenes: { id: string; name: string }[];
  activeId: string | null;
  onEvery: (next: SceneShuffleEvery) => void;
  onExclude: (next: string[]) => void;
}) {
  const pictures = [
    ...BUNDLED_SCENES.map((scene) => ({ id: scene.id, name: scene.name, src: scene.src as string | null, position: scene.position })),
    ...userScenes.map((scene) => ({ id: scene.id, name: scene.name, src: null, position: "50% 50%" })),
  ];
  const included = pictures.filter((picture) => !exclude.includes(picture.id)).length;
  const toggle = (id: string) => {
    const next = exclude.includes(id) ? exclude.filter((value) => value !== id) : [...exclude, id];
    // Leaving every picture out would leave nothing to shuffle; keep at least one.
    if (pictures.every((picture) => next.includes(picture.id))) return;
    onExclude(next);
  };
  return (
    <div className="ade-ap-shuffle">
      <div className="ade-ap-shuffle-head">
        <div className="ade-ap-option">
          <span className="kit-eyebrow">Change</span>
          <div className="kit-seg" role="group" aria-label="When shuffle changes the picture">
            {SHUFFLE_EVERY_OPTIONS.map((option) => (
              <button key={option.value} type="button" aria-pressed={every === option.value} onClick={() => onEvery(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <button type="button" className="ade-ap-shuffle-now" onClick={() => reshuffleScene()}>
          <Shuffle size={12} weight="bold" /> Shuffle now
        </button>
      </div>
      <div className="ade-ap-shuffle-label">
        <span className="kit-eyebrow">In the shuffle</span>
        <span className="kit-num">{included} of {pictures.length}</span>
        {exclude.length > 0 ? (
          <button type="button" className="ade-ap-shuffle-all" onClick={() => onExclude([])}>Include all</button>
        ) : null}
      </div>
      <div className="ade-ap-shuffle-grid" role="group" aria-label="Pictures in the shuffle">
        {pictures.map((picture) => {
          const on = !exclude.includes(picture.id);
          return (
            <button
              key={picture.id}
              type="button"
              role="checkbox"
              aria-checked={on}
              className="ade-ap-shuffle-item"
              data-on={on || undefined}
              data-current={picture.id === activeId || undefined}
              onClick={() => toggle(picture.id)}
              title={on ? `${picture.name}: in the shuffle` : `${picture.name}: left out`}
            >
              <span className="ade-ap-shuffle-thumb">
                {picture.src ? <img src={picture.src} alt="" draggable={false} style={{ objectPosition: picture.position }} /> : <UserSceneThumb id={picture.id} />}
                <span className="ade-ap-shuffle-check" aria-hidden>{on ? <Check size={10} weight="bold" /> : null}</span>
              </span>
              <span className="ade-ap-shuffle-name">{picture.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function UserSceneThumb({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void userSceneUrl(id).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return url ? <img src={url} alt="" draggable={false} /> : null;
}

function SceneLabel({ name, sub, active }: { name: string; sub: string; active: boolean }) {
  return (
    <div className="ade-ap-scene-label">
      <span className="ade-ap-scene-name">{name}</span>
      {active ? <Check size={11} weight="bold" className="ade-ap-check" /> : null}
      <span className="ade-ap-scene-sub">{sub}</span>
    </div>
  );
}

function UserSceneTile({
  id,
  name,
  active,
  onPick,
  onRemove,
}: {
  id: string;
  name: string;
  active: boolean;
  onPick: () => void;
  onRemove: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void userSceneUrl(id).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return (
    <div className="ade-ap-scene-wrap">
      <button type="button" role="radio" aria-checked={active} className="ade-ap-scene" data-active={active} onClick={onPick}>
        <div className="ade-ap-scene-art">{url ? <img src={url} alt="" draggable={false} /> : null}</div>
        <SceneLabel name={name} sub="Yours" active={active} />
      </button>
      <button type="button" className="ade-ap-scene-remove" aria-label={`Remove ${name}`} title="Remove" onClick={onRemove}>
        <X size={10} weight="bold" />
      </button>
    </div>
  );
}

/* ── Type ───────────────────────────────────────────────────────────── */

function SpecimenGrid<T extends string>({
  options,
  value,
  onChange,
  sample,
  ariaLabel,
}: {
  options: { value: T; label: string; stack: string }[];
  value: T;
  onChange: (next: T) => void;
  sample: string;
  ariaLabel: string;
}) {
  return (
    <div className="ade-ap-grid3" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className="ade-ap-choice ade-ap-specimen"
            data-active={active}
            onClick={() => onChange(option.value)}
          >
            <span className="ade-ap-specimen-big" style={{ fontFamily: option.stack }}>Aa 0123</span>
            <span className="ade-ap-specimen-sample" style={{ fontFamily: option.stack }}>{sample}</span>
            <span className="ade-ap-specimen-name kit-eyebrow">
              {option.label}
              {active ? <Check size={11} weight="bold" className="ade-ap-check" /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ── Terminal ───────────────────────────────────────────────────────── */

function TerminalSettings() {
  const terminalPreferences = useAppStore((s) => s.terminalPreferences);
  const setTerminalPreferences = useAppStore((s) => s.setTerminalPreferences);
  const usingCustomTerminalFont = !TERMINAL_FONT_FAMILY_OPTIONS.some((option) => option.value === terminalPreferences.fontFamily);
  return (
    <div className="ade-ap-terminal">
      <TerminalPreview
        fontFamily={terminalPreferences.fontFamily}
        fontSize={terminalPreferences.fontSize}
        lineHeight={terminalPreferences.lineHeight}
      />
      <div className="ade-ap-terminal-controls">
        <label className="ade-ap-field">
          <span className="kit-eyebrow">Font</span>
          <SettingsSelect
            ariaLabel="Terminal font family"
            value={usingCustomTerminalFont ? "__custom__" : terminalPreferences.fontFamily}
            onChange={(next) => {
              if (next === "__custom__") return;
              setTerminalPreferences({ fontFamily: next });
            }}
            options={[
              ...TERMINAL_FONT_FAMILY_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
              { value: "__custom__", label: "Custom stack…" },
            ]}
          />
        </label>
        <label className="ade-ap-field">
          <span className="kit-eyebrow">Size</span>
          <SettingsSelect
            ariaLabel="Terminal font size"
            value={String(terminalPreferences.fontSize)}
            onChange={(next) => setTerminalPreferences({ fontSize: Number(next) })}
            options={TERMINAL_FONT_SIZE_OPTIONS.map((value) => ({
              value: String(value),
              label: `${value.toFixed(1).replace(/\.0$/, "")} px`,
            }))}
          />
        </label>
        <label className="ade-ap-field">
          <span className="kit-eyebrow">Line height</span>
          <SettingsSelect
            ariaLabel="Terminal line height"
            value={String(terminalPreferences.lineHeight)}
            onChange={(next) => setTerminalPreferences({ lineHeight: Number(next) })}
            options={TERMINAL_LINE_HEIGHT_OPTIONS.map((value) => ({
              value: String(value),
              label: value.toFixed(2).replace(/0$/, ""),
            }))}
          />
        </label>
        <label className="ade-ap-field">
          <span className="kit-eyebrow">Scrollback</span>
          <SettingsSelect
            ariaLabel="Terminal scrollback"
            value={String(terminalPreferences.scrollback)}
            onChange={(next) => setTerminalPreferences({ scrollback: Number(next) })}
            options={TERMINAL_SCROLLBACK_OPTIONS.map((value) => ({
              value: String(value),
              label: `${value.toLocaleString()} lines`,
            }))}
          />
        </label>
      </div>
      {usingCustomTerminalFont ? (
        <input
          id="terminal-custom-font"
          aria-label="Custom font stack"
          className="ade-ap-input"
          value={terminalPreferences.fontFamily}
          onChange={(event) => setTerminalPreferences({ fontFamily: event.target.value })}
          placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
        />
      ) : null}
    </div>
  );
}

/* ── Preview ────────────────────────────────────────────────────────── */

/**
 * The live preview: a small ADE window. It is painted with the app's own CSS
 * variables, so it is always exactly the active theme; the backdrop is the
 * active scene's picture (veiled and textured the same way) or the theme mesh.
 */
function AppearancePreview() {
  const scene = useActiveScene();
  const themeId = useAppStore(selectEffectiveThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const sansFont = useAppStore((s) => s.interfacePreferences.sansFont);
  const painted = useMemo(() => resolveThemeById(themeId, customThemes), [themeId, customThemes]);
  const palette = useMemo(() => resolveTheme(painted).palette, [painted]);
  const sceneLabel = sceneStatus(scene);

  return (
    <div className="ade-ap-preview" data-active-theme={painted.id}>
      <div className="ade-ap-preview-stage">
        <PreviewBackdrop scene={scene} palette={palette} />
        <div className="ade-ap-preview-top">
          <span className="ade-ap-dots"><i /><i /><i /></span>
          <span className="ade-ap-preview-tab">ADE</span>
          <span className="ade-ap-preview-tab" data-dim="true">New tab</span>
        </div>
        <div className="ade-ap-preview-hero">
          {scene.kind === "image" && scene.showImage ? null : <img src="./logo.png" alt="" className="ade-ap-preview-logo" draggable={false} />}
          <div className="ade-ap-preview-composer">
            <span className="ade-ap-preview-placeholder">Describe a task…</span>
            <div className="ade-ap-preview-composer-row">
              <span className="ade-ap-preview-pill"><i style={{ background: "#D97757" }} />Opus</span>
              <span className="ade-ap-preview-pill">Auto</span>
              <span className="ade-ap-preview-send" />
            </div>
          </div>
        </div>
        <div className="ade-ap-preview-cards">
          <div className="kit-card">
            <div className="kit-card-head" style={{ height: 30, fontSize: 11 }}>Usage</div>
            <div className="kit-card-body" style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {[
                ["Claude", 56],
                ["Codex", 31],
                ["Cursor", 88],
              ].map(([name, pct]) => (
                <div key={name} className="ade-ap-preview-meter">
                  <span>{name}</span>
                  <div className="kit-meter" data-level={Number(pct) >= 80 ? "warn" : undefined}>
                    <span style={{ width: `${pct}%` }} />
                  </div>
                  <b className="kit-num">{pct}%</b>
                </div>
              ))}
            </div>
          </div>
          <div className="kit-card">
            <div className="kit-card-head" style={{ height: 30, fontSize: 11 }}>Running</div>
            <div className="kit-card-body" style={{ display: "flex", gap: 10 }}>
              <div className="ade-ap-preview-run"><span className="kit-dot" data-state="ok" />Tune judge</div>
              <div className="ade-ap-preview-run"><span className="kit-dot" data-state="warn" />Fix flaky e2e</div>
            </div>
          </div>
        </div>
      </div>
      <div className="ade-ap-preview-foot">
        <span className="kit-eyebrow">{painted.name} · {painted.baseMode}</span>
        <span className="kit-eyebrow">{sceneLabel} · {sansFont === "geist-mono" ? "mono" : sansFont}</span>
      </div>
    </div>
  );
}

function sceneStatus(scene: ActiveScene): string {
  if (scene.kind === "gradient") return "Gradient";
  return scene.showImage ? scene.name : `${scene.name} colours`;
}

function PreviewBackdrop({ scene, palette }: { scene: ActiveScene; palette: ResolvedAdeThemePalette }) {
  const mode = useAppStore((s) => s.theme);
  if (scene.kind === "image" && scene.showImage && scene.url) {
    return (
      <div className="ade-ap-preview-bg">
        <img src={scene.url} alt="" draggable={false} style={{ objectPosition: scene.position }} />
        <div style={{ position: "absolute", inset: 0, background: `color-mix(in srgb, var(--color-bg) ${scene.dim}%, transparent)` }} />
        {scene.texture === "dots" ? <div className="ade-ap-preview-dots" /> : null}
      </div>
    );
  }
  // The same ramp the window mesh paints, light or dark.
  const ramp =
    scene.kind === "image" && scene.palette
      ? backdropThemeFromScene(scene.palette, mode).colors.map(
          ([r, g, b]) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`,
        )
      : null;
  const deep = ramp?.[1] ?? palette.accentDeep;
  const bright = ramp?.[3] ?? palette.accent;
  const glow = ramp?.[4] ?? palette.accentBright;
  const base = ramp?.[0] ?? palette.bg;
  return (
    <div
      className="ade-ap-preview-bg"
      style={{
        background: `radial-gradient(110% 80% at 15% 10%, color-mix(in srgb, ${deep} 80%, transparent), transparent 60%), radial-gradient(90% 80% at 90% 30%, color-mix(in srgb, ${glow} 40%, transparent), transparent 55%), radial-gradient(120% 90% at 60% 100%, color-mix(in srgb, ${bright} 55%, transparent), transparent 60%), ${base}`,
      }}
    />
  );
}

/**
 * A few lines of a real-looking session in the active theme's terminal colours
 * and the chosen font, so a font or theme change shows before a terminal opens.
 */
function TerminalPreview({
  fontFamily,
  fontSize,
  lineHeight,
}: {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}) {
  const themeId = useAppStore(selectEffectiveThemeId);
  const customThemes = useAppStore((s) => s.customThemes);
  const t: AdeTerminalPalette = useMemo(
    () => resolveTheme(resolveThemeById(themeId, customThemes)).terminal,
    [themeId, customThemes],
  );
  const c = (color: string | undefined, children: React.ReactNode, bold = false) => (
    <span style={{ color, fontWeight: bold ? 700 : undefined }}>{children}</span>
  );
  return (
    <div
      aria-hidden
      className="ade-ap-terminal-preview"
      style={{
        background: t.background,
        color: t.foreground,
        fontFamily,
        fontSize,
        lineHeight,
      }}
    >
      <div>{c(t.green, "➜", true)} {c(t.cyan, "ade", true)} {c(t.blue, "git:(")}{c(t.red, "main")}{c(t.blue, ")")} npm run dev</div>
      <div>{" "}</div>
      <div>  {c(t.green, "VITE", true)} {c(t.green, "v7.1.1")}  ready in {c(t.foreground, "1.24s", true)}</div>
      <div>  {c(t.green, "➜")}  Local:   {c(t.cyan, "http://127.0.0.1:5173/")}</div>
      <div>  {c(t.brightBlack, "✓")} {c(t.green, "85 passed")}  {c(t.yellow, "△ 2 warnings")}  {c(t.red, "✗ 0 failed")}</div>
      <div>
        {c(t.green, "➜", true)} {c(t.cyan, "ade", true)}{" "}
        <span style={{ display: "inline-block", width: "0.6em", height: "1.1em", verticalAlign: "text-bottom", background: t.cursor }} />
      </div>
    </div>
  );
}
