import { showToast } from "../../app/toast/toastStore";

/**
 * How long a press may produce nothing before the reader is told it landed.
 *
 * Long enough that a warm plugin — which answers in milliseconds — never draws
 * a toast for an action that already finished, short enough to beat a person's
 * second press.
 */
export const PLUGIN_ACTION_SLOW_NOTICE_MS = 1_200;
import { navigateToAppTarget, revealPluginWorkRailPane } from "../../../lib/openExternal";
import {
  buildPluginActionPromptAnswer,
  hasPluginActionComposerRequest,
  hasPluginActionPromptRequest,
  hasPluginActionWebviewRequest,
  readPluginActionComposerEdit,
  readPluginActionNavigation,
  readPluginActionPrompt,
  readPluginActionWebview,
  type PluginActionNavigation,
} from "../../../../shared/plugins/sdk";
import { applyPluginActionOpenUrl } from "../pluginActionOpenUrl";
import type { PluginSurfaceContext } from "../../../../shared/plugins/context";
import {
  pluginSocketInvokeTimeoutMs,
  type PluginSocketKind,
} from "../../../../shared/plugins/sockets";
import { rootAppStoreApi } from "../../../state/appStore";
import { invokePluginSocketAction, manifestOf } from "./contributionBridge";
import { derivedSetFor, rowsStoreFor, sourcesStore } from "./contributionStores";
import { selectContributions } from "./contributionModel";
import { applyPluginComposerEdit } from "./composerTarget";
import { applyPluginDialogEdit } from "./dialogTarget";
import {
  resolvePluginNavigateTarget,
  type PluginNavigateResolution,
} from "./pluginNavigateTarget";
import { openPluginWebviewOverlay } from "./pluginWebviewOverlayStore";
import { openPluginPrompt, readPluginPromptAnchor } from "./pluginPromptStore";

/**
 * One invocation of a plugin action from a socket, response verbs included.
 *
 * A plain function rather than a hook because not every caller is a component:
 * the chat-card action bridge is a window listener installed once for the app,
 * and it has to honour `{navigate}` and `{composer:{…}}` exactly the way a
 * button press does. Two implementations of "what a plugin's answer means"
 * would drift, and the drift would be invisible — one surface honouring a verb
 * another silently drops.
 *
 * Failures surface as a toast rather than a console line: a plugin control that
 * appears to do nothing is indistinguishable from a plugin that is broken, and
 * the person who pressed it is the one who can act on the difference.
 *
 * The returned promise settles when the action and its response verbs are done,
 * so a caller drawing a busy state knows when to stop. It never rejects — the
 * toast is the error path.
 */
export function runPluginSocketAction(
  pluginId: string,
  actionId: string,
  context: PluginSurfaceContext,
  options?: {
    /**
     * Which socket the press came from. Sets the round-trip budget: a
     * `composer-action` that records or transcribes runs for minutes by design,
     * while a button on a row keeps the 60s default.
     */
    socket?: PluginSocketKind;
    /** Explicit budget, for a caller with no socket to name. Host-clamped. */
    timeoutMs?: number;
    /**
     * Extra arguments beside `context`. The one caller today is the chat-card
     * bridge, which sends the card the button belonged to — an action fired
     * from a transcript row has to know which row, and the session context
     * alone cannot say.
     */
    args?: Record<string, unknown>;
    /**
     * The word on the control that was pressed.
     *
     * Used only as the title of a `{prompt}` the action answers with, when the
     * plugin declared none: the reader just pressed "Log it", so "Log it" is a
     * better heading over the field than the plugin's name.
     */
    label?: string;
  },
): Promise<void> {
  // Sampled BEFORE the round trip. The prompt is anchored at the control that
  // was pressed, and by the time the plugin answers, the menu that control
  // lived in may have closed and taken the focus with it.
  const anchor = readPluginPromptAnchor();
  // A press right after launch can legitimately block for a long time with
  // nothing on screen: the menu closes on select, a row menu entry carries no
  // busy state, and the host waits up to PLUGIN_CHILD_READY_TIMEOUT_MS for the
  // child to spawn before the invoke's own budget even begins. A drawn control
  // that silently does nothing is indistinguishable from a broken plugin, and
  // spamming it is the rational response — which is exactly what a dogfood run
  // did for two minutes. This says the press landed.
  const slowNotice = setTimeout(() => {
    showToast({
      title: `${pluginId} is starting`,
      message: "The action runs as soon as the plugin is ready.",
    });
  }, PLUGIN_ACTION_SLOW_NOTICE_MS);
  const clearSlowNotice = (): void => clearTimeout(slowNotice);
  return invokePluginSocketAction(
    pluginId,
    actionId,
    { context, ...(options?.args ?? {}) },
    { timeoutMs: options?.timeoutMs ?? pluginSocketInvokeTimeoutMs(options?.socket) },
  )
    .then((result) => {
      clearSlowNotice();
      // Applied before navigation, which may take the composer off screen: an
      // action that writes a draft and then opens its own panel should do both,
      // in the order the plugin can predict.
      const edit = readPluginActionComposerEdit(result);
      if (edit) applyPluginComposerEdit(edit, { context, pluginId, actionId });
      else if (hasPluginActionComposerRequest(result)) {
        // The plugin asked and this client refused: a non-string verb, an empty
        // insert, or text over PLUGIN_COMPOSER_TEXT_MAX_BYTES.
        console.warn("[plugin composer] ignored a malformed composer edit", pluginId, actionId);
      }
      // The dialog verb, on the same footing and for the same reason: an
      // invocation made from one of ADE's dialogs may write one allowlisted
      // field of it. `applyPluginDialogEdit` is a no-op for every other
      // context, so this costs a `kind` check on a row menu item.
      applyPluginDialogEdit(result, { context, pluginId, actionId });
      // An action may ask to open its own webview surface as a focused overlay
      // over whatever the button sat on. The subject the host injects is THIS
      // button's context — unforgeable — and the verb's own `context` rides as
      // the page's plugin-authored pointer. Checked against the plugin's real
      // surfaces here so an unresolvable id never opens an empty frame.
      const overlay = readPluginActionWebview(result);
      if (overlay) {
        const plugin = rootAppStoreApi.getState().installedPlugins
          .find((entry) => entry.pluginId === pluginId);
        const surfaceExists = plugin?.enabled
          && plugin.tabs.some((tab) => tab.id === overlay.surfaceId);
        if (surfaceExists) {
          openPluginWebviewOverlay({
            pluginId,
            surfaceId: overlay.surfaceId,
            subject: context,
            ...(overlay.context ? { pointer: overlay.context } : {}),
          });
        } else {
          console.warn("[plugin webview] openWebview named an unknown surface", pluginId, overlay.surfaceId);
        }
      } else if (hasPluginActionWebviewRequest(result)) {
        console.warn("[plugin webview] ignored a malformed openWebview request", pluginId, actionId);
      }
      // An action may ask to send the reader somewhere on the open web. Before
      // navigation for the same reason the composer edit is: an action that
      // opens a link and then moves the panel should do both.
      applyPluginActionOpenUrl(result, { pluginId, actionId });

      // An action may ask to be followed: "I filed the issue, here it is."
      const navigation = readPluginActionNavigation(result);
      if (navigation) {
        applyPluginActionNavigation(navigation, { pluginId, context, socket: options?.socket });
      }

      // An action may ask ONE question before it can finish. Last of the verbs,
      // because the others describe what the press already did and this one is
      // the press asking to continue.
      //
      // One hop. A re-invocation already carries `args.prompt`, and a second
      // question from it is dropped rather than asked — a plugin cannot build a
      // wizard out of this verb, and cannot trap the reader in a loop it keeps
      // re-opening.
      if (options?.args?.prompt !== undefined) return;
      const prompt = readPluginActionPrompt(result);
      if (!prompt) {
        if (hasPluginActionPromptRequest(result)) {
          console.warn("[plugin prompt] ignored a malformed prompt", pluginId, actionId);
        }
        return;
      }
      openPluginPrompt({
        pluginId,
        actionId,
        prompt,
        fallbackTitle: options?.label ?? null,
        anchor,
        onSubmit: (text) => {
          const answer = buildPluginActionPromptAnswer(prompt, text);
          if (!answer) {
            // Refused, never truncated: the host caps the answer and the card
            // disables its own button, so this is the belt to that brace.
            showToast({
              title: "That answer is too long",
              message: `${pluginId} couldn’t save it. Shorten it and press the button again.`,
              tone: "error",
            });
            return;
          }
          void runPluginSocketAction(pluginId, actionId, context, {
            ...options,
            args: { ...(options?.args ?? {}), prompt: answer },
          });
        },
      });
    })
    .catch((cause: unknown) => {
      clearSlowNotice();
      showToast({
        title: "Plugin action failed",
        message: cause instanceof Error ? cause.message : `${pluginId} couldn’t run ${actionId}.`,
        tone: "error",
      });
    });
}


/**
 * Send the reader where the action asked, or say why nobody could.
 *
 * Exported for the test that pins the placement rule; every caller in the app
 * reaches it through {@link runPluginSocketAction}.
 */
export function applyPluginActionNavigation(
  navigation: PluginActionNavigation,
  press: {
    pluginId: string;
    /** The subject the button was pressed on — what selects per-chat rail rows. */
    context: PluginSurfaceContext | null;
    socket?: PluginSocketKind;
  },
): PluginNavigateResolution {
  const resolution = resolvePluginNavigateTarget({
    pluginId: press.pluginId,
    navigation,
    ...(press.socket ? { socket: press.socket } : {}),
    ...readPluginNavigateEnvironment(press.pluginId, press.context),
  });

  if (resolution.kind === "unreachable") {
    // The silence this replaces was the single most expensive bug of the alpha
    // run: a press that resolved to nothing looked exactly like a plugin that
    // had crashed, and neither the reader nor the author could tell which. A
    // packaged app older than a renderer fix still cannot detect ITSELF — but it
    // can always detect a panel that is not there, which is this branch.
    showToast({
      title: `${resolution.displayName} couldn’t open that panel`,
      message: resolution.reason,
      tone: "error",
    });
    return resolution;
  }

  if (resolution.kind === "tools-pane") {
    // Beside the conversation, not instead of it. Selects the plugin's pane in
    // the Work tools rail exactly as a click on the rail's own icon does.
    revealPluginWorkRailPane({
      pluginId: resolution.pluginId,
      panelId: resolution.panelId,
      slotId: resolution.slotId,
    });
    return resolution;
  }

  // Routed through the ordinary navigation target rather than a direct
  // `navigate`, so it passes the same installed-and-enabled gate a `plugin`
  // deeplink does and lands on the same addressable URL.
  navigateToAppTarget({
    kind: "plugin",
    pluginId: resolution.pluginId,
    panelId: resolution.panelId,
    context: resolution.context,
  });
  return resolution;
}

/**
 * The live facts the placement rule reads, off the same caches the UI draws from.
 *
 * `pluginsLoaded` rides along because an unresolved registry is an empty array,
 * and reading that as "uninstalled" would refuse a press made during startup.
 *
 * The rail panes are selected the way `WorkSidebar` selects them — the "work"
 * surface, the `work-rail-pane` socket, narrowed by the context the press
 * carried — so "the plugin has a pane here" cannot mean one thing to the rule
 * and another to the rail. A press whose Work surface has never been revealed
 * reads empty stores and falls back to the tab route, which is the right answer:
 * there is no rail on screen to open into.
 */
function readPluginNavigateEnvironment(
  pluginId: string,
  context: PluginSurfaceContext | null,
): {
  registryLoaded: boolean;
  plugin: { displayName: string; enabled: boolean; surfacePanelIds: string[] } | null;
  railPanelIds: string[];
  declaredPanelIds: string[] | null;
} {
  const registry = rootAppStoreApi.getState();
  const installed = registry.installedPlugins
    .find((entry) => entry.pluginId === pluginId) ?? null;
  const plugin = installed
    ? {
      displayName: installed.displayName,
      enabled: installed.enabled,
      surfacePanelIds: installed.tabs.map((tab) => tab.panelId),
    }
    : null;

  const sources = sourcesStore.getSnapshot().sources;
  const rows = rowsStoreFor("work").getSnapshot().rows;
  const set = derivedSetFor("work", sources, rows);
  const railPanelIds = selectContributions(set, "work-rail-pane", context)
    .filter((contribution) => contribution.pluginId === pluginId)
    .map((contribution) => contribution.payload.panelId);

  // Null, not empty, when the manifest is not in hand: an empty list would read
  // as "declares no panels" and refuse every navigation this plugin makes.
  const source = sources.find((entry) => entry.pluginId === pluginId) ?? null;
  const manifest = source ? manifestOf(source) : null;
  const declaredPanelIds = Array.isArray(manifest?.panels)
    ? manifest.panels.map((panel) => panel.id)
    : null;

  return { registryLoaded: registry.pluginsLoaded, plugin, railPanelIds, declaredPanelIds };
}
