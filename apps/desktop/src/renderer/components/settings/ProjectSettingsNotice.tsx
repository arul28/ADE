import { ModernSection } from "./primitives";

/**
 * Stands in for settings that are saved in a project, when Settings is open
 * with no project: says what is missing and how to reach it, instead of a card
 * that can never load.
 */
export function ProjectSettingsNotice({ group, title, hint }: { group: string; title: string; hint: string }) {
  return <ModernSection group={group} title={title} hint={hint}>{null}</ModernSection>;
}
