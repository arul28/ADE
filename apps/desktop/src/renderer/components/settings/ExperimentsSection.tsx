import { useRootAppStore } from "../../state/appStore";
import { SettingsCard, SettingsGroup, SettingsToggle } from "./primitives";

/**
 * Unfinished surfaces users can opt into.
 *
 * Every card here changes a whole tab, not a detail, so each one says what it
 * replaces and admits it is experimental in its own description — the group
 * heading scrolls away, the card's copy does not. The prefs are app-scoped
 * (`appStore` localStorage): opting in on one install never follows the user
 * to another device, which is what we want while the feature is still moving.
 */
export function ExperimentsSection() {
  // Root store on purpose: app-scoped prefs live on the root store, and the
  // per-project surface stores only snapshot them at creation. Reading via the
  // context store would render a toggle that writes correctly but never
  // visually flips (same pattern as promptStashButtonEnabled in Appearance).
  const experimentsLanesStoryEnabled = useRootAppStore((s) => s.experimentsLanesStoryEnabled);
  const setExperimentsLanesStoryEnabled = useRootAppStore((s) => s.setExperimentsLanesStoryEnabled);

  return (
    <SettingsGroup title="Experiments">
      <SettingsCard
        anchor="experiments"
        title="Lanes tab overhaul"
        description="Replaces the lane panes with a story timeline of commits, PRs and agents. Experimental."
        control={
          <SettingsToggle
            label="Lanes tab overhaul"
            checked={experimentsLanesStoryEnabled}
            onChange={setExperimentsLanesStoryEnabled}
          />
        }
      />
    </SettingsGroup>
  );
}
