/**
 * The two things the launch flow needs from outside itself: a preference and a
 * deeplink.
 *
 * Both were app-level facts in the compiled Linear and are page-level facts
 * here, and both are small enough that a file each would be worse than a file
 * for the pair — they are read from exactly one place, one line apart.
 */

import { bridge } from "../bridge";

/**
 * The plugin's own launch-prompt clipboard setting.
 *
 * The compiled flow read `useAppStore(s => s.launchPromptClipboardEnabled)`, an
 * ADE preference. A guest cannot see ADE's preferences and should not: the
 * setting belongs to whoever draws the toggle, and the toggle is in the LAUNCH
 * FORM — beside the prompt it copies, rather than in a settings section two
 * screens from the only act it affects. `plugin.json` declares
 * `launchPromptClipboard` with `default: true`, which is the same default the
 * app preference had.
 *
 * Defaults to true on a host that cannot answer. The failure mode of copying a
 * prompt nobody wanted is a clipboard entry; the failure mode of not copying
 * one somebody relied on is a lost prompt.
 */
export async function readLaunchPromptClipboardSetting(): Promise<boolean> {
  const api = bridge();
  if (!api) return true;
  try {
    const config = await api.config.get();
    return config?.launchPromptClipboard !== false;
  } catch {
    return true;
  }
}

/**
 * The Lanes tab, opened on a lane with the launch stack showing.
 *
 * The compiled panel navigated to `#/lanes?drawer=stack` after a launch, which
 * is a renderer route rather than a deeplink — so the page had nowhere to send
 * the reader and simply did not. `ade://lane/<id>?drawer=stack` is the deeplink
 * that says the same thing, and it names a lane because a deeplink has to name
 * the thing it opens.
 */
export function laneStackDeeplink(laneId: string): string {
  return `ade://lane/${encodeURIComponent(laneId)}?drawer=stack`;
}

/**
 * The project picker, which ADE calls the welcome screen.
 *
 * The compiled quick view's "pick a project" button called
 * `setShowWelcome(true)` and navigated to `#/work` — two renderer calls with no
 * page counterpart, so the button dismissed the popover and did nothing else.
 */
export const WELCOME_DEEPLINK = "ade://welcome";

/**
 * Write the launch-prompt clipboard setting.
 *
 * The form's toggle writes through the same config the launch flow reads, so a
 * reader who turns it off in one launch has it off in the next — a per-launch
 * checkbox that forgot itself would be a worse control than the preference it
 * replaced. Best effort: a host that refuses the write leaves the setting as it
 * was, and the launch reads the stored value rather than the toggle's.
 */
export async function writeLaunchPromptClipboardSetting(enabled: boolean): Promise<void> {
  const api = bridge();
  if (!api) return;
  try {
    await api.config.set("launchPromptClipboard", enabled);
  } catch {
    // The launch still reads the stored value; nothing here is load-bearing.
  }
}
