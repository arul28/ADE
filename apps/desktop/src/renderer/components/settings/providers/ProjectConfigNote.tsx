import { COLORS, SANS_FONT } from "../../lanes/laneDesignTokens";

/**
 * In place of a control for something a project copy saves (turning a
 * provider off, local model servers, custom providers and slugs, compaction),
 * on a computer this page reaches without a copy of the repository.
 * `sentence` says what it is, e.g. "Turning a provider off is saved per project."
 */
export function ProjectConfigNote({ machineName, sentence }: { machineName: string; sentence: string }) {
  return (
    <div
      data-testid="providers-project-config-note"
      style={{ fontSize: 11, fontFamily: SANS_FONT, color: COLORS.textMuted, lineHeight: 1.5 }}
    >
      {sentence} {machineName} has no copy of this repository, so this window can't change it there.
    </div>
  );
}
