import React from "react";

import { COLORS, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import type { PluginDialogContext } from "../../../../shared/plugins/context";
import type {
  PluginDialogField,
  PluginDialogKind,
  PluginSurfaceId,
} from "../../../../shared/plugins/sockets";
import type { LaneLinearIssue } from "../../../../shared/types/lanes";
import { useRootAppStore } from "../../../state/appStore";
import { PluginPanelHost } from "../PluginPanelHost";
import { PluginWebviewHost, supportsPluginWebviews } from "../PluginWebviewHost";
import { contributionKey } from "./contributionModel";
import { resolvePluginDeclaredWebview } from "./pluginDeclaredWebview";
import { readPluginDialogIssueAnswer } from "./pluginDialogIssue";
import {
  PLUGIN_SETTINGS_SECTION_DEFAULT_HEIGHT,
  PLUGIN_SETTINGS_SECTION_MIN_HEIGHT,
} from "./PluginSettingsSections";
import { registerPluginWebviewDialogHandler } from "./pluginWebviewDialogStore";
import { registerPluginDialogTarget, type PluginDialogTarget } from "./dialogTarget";
import { SocketBoundary } from "./SocketBoundary";
import { SocketIcon } from "./socketUi";
import { brandIconsProp, usePluginBrandIcons } from "./usePluginBrandIcons";
import { pluginDialogContext } from "./surfaceContexts";
import { usePluginSurfaceContributions, useSurfaceContributions } from "./useSurfaceContributions";

/**
 * The `dialog-section` socket: a plugin's panel inside one of ADE's own dialogs.
 *
 * This is the seam that makes "pick an issue, fill in the lane name and the
 * base branch" a thing a third-party plugin can build rather than a thing only
 * the built-in Linear integration can do. The section sits AFTER the dialog's
 * own fields — a plugin joins the form, it does not reorganize it — and its
 * buttons reach the dialog through exactly one verb, `{dialog:{setField}}`,
 * whose allowlist lives in `shared/plugins/sockets`.
 *
 * Two properties the surrounding dialog is entitled to rely on:
 *
 * - **The plugin prefills; the user submits.** A response can write a field the
 *   user could have typed or picked themselves and nothing else. It cannot
 *   press Create, and the confirmation controls are not in the allowlist for it
 *   to reach in the first place.
 * - **The context is read at INVOKE time.** `PluginPanelHost` dispatches with
 *   whatever context this component last rendered with, so a section invoked
 *   after the user renamed the lane sees the new name — not the one that was
 *   there when the dialog opened.
 */

/**
 * The surface each dialog's contributions are declared on.
 *
 * A fact about the dialogs rather than a caller's choice: manage-lane opens
 * from Lanes, from Work and from the PRs tab, and a plugin should declare it
 * once. `dialog` in the payload is what separates create-lane from manage-lane,
 * which share this surface.
 */
const DIALOG_SURFACE: Record<PluginDialogKind, PluginSurfaceId> = {
  "create-lane": "lanes",
  "manage-lane": "lanes",
  "create-pr": "prs",
};

export function PluginDialogSections<K extends PluginDialogKind>({
  dialog,
  laneId = null,
  laneName = null,
  branch = null,
  projectKey = null,
  onSetField,
  onSelectIssue,
  active = true,
}: {
  dialog: K;
  /** The lane the dialog is about, or the PR's source lane. Null on create-lane. */
  laneId?: string | null;
  /** Current value, not the mount-time one — see the note about invoke time. */
  laneName?: string | null;
  /** Current value, not the mount-time one. */
  branch?: string | null;
  /** The open project binding's stable key, when the dialog's host has one. */
  projectKey?: string | null;
  /**
   * Write one allowlisted field into the dialog's controlled state. Returns
   * whether the value landed; `false` draws the quiet refusal line.
   */
  onSetField: (field: PluginDialogField<K>, value: string) => boolean;
  /**
   * Take the issue a `dialog-picker` page chose, exactly as this dialog takes
   * its own picker's.
   *
   * The SAME state, not a parallel one: Create-lane feeds
   * `setSelectedLinearIssue`, so the lane name and the branch derive as they
   * always did, and Create-PR fills the slot its magic word and its
   * close-on-merge argument already read. `null` clears the selection, which is
   * a real answer — a choice made inside a page has to be undoable from inside
   * it. Returns whether the value landed; `false` is what a form mid-submit
   * honestly reports, and the page hears it as a rejected promise.
   *
   * Absent on a dialog with no issue slot (manage-lane), which is what makes a
   * page's `dialog.submit` there a refusal rather than a silent success.
   */
  onSelectIssue?: (issue: LaneLinearIssue | null) => boolean;
  /** False while the dialog is mounted but not visible. */
  active?: boolean;
}) {
  const surface = DIALOG_SURFACE[dialog];

  /**
   * The context handed to the panel and to every action it dispatches.
   *
   * Rebuilt when a value changes and not otherwise, which is both halves of
   * what the socket promises: an action invoked after the user edits a field
   * sees the edit, and a render that changed nothing leaves the panel host's
   * dispatch alone. Selecting the plugin's dynamic rows costs nothing either
   * way — `pluginContextMemoKey` keys a dialog on its lane, not its fields.
   */
  const context = React.useMemo<PluginDialogContext>(
    () => pluginDialogContext({ dialog, laneId, laneName, branch, projectKey }),
    [branch, dialog, laneId, laneName, projectKey],
  );

  const all = useSurfaceContributions(surface, "dialog-section", { active, context });
  const contributions = React.useMemo(
    () => all.filter((entry) => entry.payload.dialog === dialog),
    [all, dialog],
  );
  const { identities } = usePluginSurfaceContributions(surface, active);
  const brandIconsFor = usePluginBrandIcons();
  // The registry, for resolving a section's `webviewSurfaceId` to a page — the
  // same read `PluginSettingsSections` makes, through the same resolver, so the
  // two placements cannot disagree about what an unresolvable id means.
  const installedPlugins = useRootAppStore((state) => state.installedPlugins);
  const webviewSupported = supportsPluginWebviews();

  const [refused, setRefused] = React.useState(false);
  React.useEffect(() => {
    setRefused(false);
  }, [dialog, laneId]);

  const setField = React.useCallback((field: PluginDialogField<K>, value: string) => {
    const applied = onSetField(field, value);
    if (applied) setRefused(false);
    return applied;
  }, [onSetField]);

  const registrationId = React.useId();
  const hasSections = contributions.length > 0;
  React.useEffect(() => {
    // Nothing declared means no panel here can invoke anything, so there is
    // nothing for an edit to land in either.
    if (!hasSections || !active) return;
    return registerPluginDialogTarget(registrationId, {
      dialog,
      // `applyPluginDialogEdit` validates the field against THIS dialog's
      // allowlist before calling, so the narrow handler cannot be handed a
      // field it has never heard of. The cast is that guarantee, written down.
      setField: setField as PluginDialogTarget["setField"],
      onRefused: () => setRefused(true),
    });
  }, [active, dialog, hasSections, registrationId, setField]);

  if (!hasSections) return null;

  return (
    <div
      data-tour={`plugin:${dialog}.dialog-section`}
      style={{ display: "flex", flexDirection: "column", gap: 12 }}
    >
      {contributions.map((contribution) => {
        const identity = identities.get(contribution.pluginId);
        const name = identity?.displayName ?? contribution.pluginId;
        const title = contribution.payload.title ?? name;
        return (
          <SocketBoundary key={contributionKey(contribution)}>
            <section
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                padding: 12,
                background: COLORS.recessedBg,
                border: `1px solid ${COLORS.borderMuted}`,
                borderRadius: RADII.md,
              }}
            >
              {/* Attribution is not optional here: this is the one socket that
                  puts third-party controls inside a form the user is about to
                  submit, and they are owed the name of whose controls they are. */}
              <header
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontFamily: SANS_FONT,
                  fontSize: 11,
                  color: COLORS.textMuted,
                }}
              >
                <SocketIcon
                  name={identity?.icon ?? undefined}
                  {...brandIconsProp(brandIconsFor(contribution.pluginId))}
                  size={12}
                  color={COLORS.textMuted}
                />
                <span style={{ fontWeight: 600, color: COLORS.textSecondary }}>{title}</span>
                {title === name ? null : <span style={{ opacity: 0.7 }}>· {name}</span>}
              </header>
              <PluginDialogSectionBody
                pluginId={contribution.pluginId}
                panelId={contribution.payload.panelId}
                page={resolvePluginDeclaredWebview({
                  pluginId: contribution.pluginId,
                  surfaceId: contribution.payload.webviewSurfaceId,
                  installed: installedPlugins,
                  supported: webviewSupported,
                })}
                active={active}
                context={context}
                {...(onSelectIssue ? { onSelectIssue } : {})}
              />
            </section>
          </SocketBoundary>
        );
      })}
      {refused ? (
        <p
          role="status"
          style={{ margin: 0, fontFamily: SANS_FONT, fontSize: 11, color: COLORS.textDim }}
        >
          This plugin couldn’t fill in a field here.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One section's body: the plugin's own page, or the panel it falls back to.
 *
 * The fallback is not announced, for the reason `PluginSettingsSectionBody`
 * states: a `dialog-section` names a `panelId` and MAY name a
 * `webviewSurfaceId`, the panel is what the manifest promised every client, and
 * a host that can draw the page draws the page.
 *
 * What is different here is that the page can ANSWER. A dialog picker is a
 * search box over a live list — the thing a vocabulary panel cannot be — and
 * the reader's choice has to reach the form the picker is sitting in. It does
 * that through `dialog.submit`, which arrives on the relay addressed by the
 * guest's own key, so this component registers the handler for exactly the
 * guest it put on screen and drops it the moment that guest goes.
 *
 * The height ceiling is the settings section's, imported rather than restated:
 * both are a page inside a taller ADE surface with no height of its own, both
 * grow from the same `ui.resize` report, and two ceilings for one behaviour is
 * how the two drift.
 */
function PluginDialogSectionBody({
  pluginId,
  panelId,
  page,
  active,
  context,
  onSelectIssue,
}: {
  pluginId: string;
  panelId: string;
  /** The resolved page, or null to draw the panel. */
  page: { surfaceId: string; entryHtml: string } | null;
  active: boolean;
  context: PluginDialogContext;
  onSelectIssue?: (issue: LaneLinearIssue | null) => boolean;
}) {
  const [height, setHeight] = React.useState<number | null>(null);

  /**
   * The live answer path, read at CALL time rather than captured.
   *
   * A page may submit at any moment after it loads, and the dialog's own
   * handler identity changes as the form's state does. A ref keeps the
   * registration stable — the guest is not recreated because a parent
   * re-rendered — while still routing the answer to the form as it is NOW,
   * which is the same rule the section's `{dialog:{setField}}` path keeps.
   */
  const selectRef = React.useRef(onSelectIssue);
  selectRef.current = onSelectIssue;

  /**
   * Registered synchronously as the guest announces its key, and unregistered
   * as it announces the loss of one.
   *
   * Not an effect: an effect runs a commit later, and the window between a page
   * becoming live and this component being told about it is a window where a
   * fast page's answer would find no listener and be refused. The host calls
   * back in the right order (key, then null), so the cleanup below is only for
   * an unmount that races it.
   */
  const unregisterRef = React.useRef<(() => void) | null>(null);
  const handleGuestKey = React.useCallback((guestKey: string | null) => {
    unregisterRef.current?.();
    unregisterRef.current = guestKey
      ? registerPluginWebviewDialogHandler(guestKey, (answer) => {
        const apply = selectRef.current;
        // No issue slot on this dialog: refused rather than swallowed, so the
        // page can say so instead of drawing a selection nothing took.
        if (!apply) return false;
        // Read for THIS plugin, so the link the dialog stores names whose it
        // is. A malformed record — no key, no title — is a refusal, never a
        // half-filled form.
        const read = readPluginDialogIssueAnswer(answer, pluginId);
        if (!read) return false;
        return apply(read.issue);
      })
      : null;
  }, [pluginId]);
  React.useEffect(() => () => {
    unregisterRef.current?.();
    unregisterRef.current = null;
  }, []);

  if (!page) {
    return (
      <PluginPanelHost
        pluginId={pluginId}
        panelId={panelId}
        active={active}
        surfaceContext={context}
        onNavigate={(navigation) => {
          // A dialog cannot follow a plugin anywhere: the user is mid-form and
          // the form is modal, so leaving would discard what they have typed.
          // Said out loud rather than dropped in silence, because the plugin
          // author has no other way to learn that this one verb does not apply
          // here.
          console.warn(
            "[plugin dialog] a dialog section cannot navigate",
            pluginId,
            navigation.panelId,
          );
        }}
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        minHeight: 0,
        height: Math.max(
          PLUGIN_SETTINGS_SECTION_MIN_HEIGHT,
          height ?? PLUGIN_SETTINGS_SECTION_DEFAULT_HEIGHT,
        ),
      }}
    >
      <PluginWebviewHost
        pluginId={pluginId}
        entryHtml={page.entryHtml}
        active={active}
        placement="dialog-picker"
        surfaceId={page.surfaceId}
        onContentHeight={setHeight}
        onGuestKey={handleGuestKey}
        context={{ subject: context }}
      />
    </div>
  );
}
