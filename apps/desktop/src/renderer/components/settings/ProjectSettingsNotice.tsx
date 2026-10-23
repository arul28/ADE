import { Banner } from "../ui/notice";
import { ModernSection } from "./primitives";

/**
 * Stands in for settings that are saved in a project, when Settings is open
 * with no project: says what is missing and how to reach it, instead of a card
 * that can never load.
 */
export function ProjectSettingsNotice({ group, title, detail }: { group: string; title: string; detail: string }) {
  return (
    <ModernSection group={group} title={title}>
      <Banner layout="inline" model={{ id: `no-project-${group}`, tone: "info", title: "Open a project to change these.", detail }} />
    </ModernSection>
  );
}
