import React from "react";

import { COLORS, RADII, SANS_FONT } from "../../lanes/laneDesignTokens";
import type { PluginDialogContext } from "../../../../shared/plugins/context";
import type {
  PluginDialogField,
  PluginDialogKind,
  PluginSurfaceId,
} from "../../../../shared/plugins/sockets";
import { PluginPanelHost } from "../PluginPanelHost";
import { contributionKey } from "./contributionModel";
import { registerPluginDialogTarget, type PluginDialogTarget } from "./dialogTarget";
import { SocketBoundary } from "./SocketBoundary";
import { SocketIcon } from "./socketUi";
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
                <SocketIcon name={identity?.icon ?? undefined} size={12} color={COLORS.textMuted} />
                <span style={{ fontWeight: 600, color: COLORS.textSecondary }}>{title}</span>
                {title === name ? null : <span style={{ opacity: 0.7 }}>· {name}</span>}
              </header>
              <PluginPanelHost
                pluginId={contribution.pluginId}
                panelId={contribution.payload.panelId}
                active={active}
                surfaceContext={context}
                onNavigate={(navigation) => {
                  // A dialog cannot follow a plugin anywhere: the user is
                  // mid-form and the form is modal, so leaving would discard
                  // what they have typed. Said out loud rather than dropped in
                  // silence, because the plugin author has no other way to
                  // learn that this one verb does not apply here.
                  console.warn(
                    "[plugin dialog] a dialog section cannot navigate",
                    contribution.pluginId,
                    navigation.panelId,
                  );
                }}
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
