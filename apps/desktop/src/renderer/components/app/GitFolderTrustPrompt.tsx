/**
 * "Trust this folder?" — asked when the user opens a folder that git refuses
 * because it belongs to another account (safe.directory; routine on Windows
 * for folders made by an elevated shell, installer or SSH session).
 *
 * Trust adds that one folder to the user's global safe.directory list and
 * opens it; Cancel changes nothing. Only an open the user started gets here,
 * so ADE never trusts a folder on its own.
 */
import { useRef } from "react";
import { ShieldWarning } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { Dialog } from "../ui/dialog";

export function GitFolderTrustPromptHost(): JSX.Element | null {
  const prompt = useAppStore((state) => state.gitFolderTrustPrompt);
  if (!prompt) return null;
  return <GitFolderTrustPromptDialog key={prompt.rootPath} message={prompt.message} />;
}

function GitFolderTrustPromptDialog({ message }: { message: string }): JSX.Element {
  const trust = useAppStore((state) => state.trustGitFolderAndOpen);
  const dismiss = useAppStore((state) => state.dismissGitFolderTrustPrompt);
  const answered = useRef(false);
  const answerOnce = (run: () => void) => {
    if (answered.current) return;
    answered.current = true;
    run();
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) answerOnce(dismiss);
      }}
      role="alertdialog"
      size="md"
      tone="warning"
      icon={<ShieldWarning size={16} weight="fill" />}
      title="Trust this folder?"
      description={[
        message,
        "Trusting adds only this folder to Git's safe.directory list for your account, so Git and ADE can use it. Only trust folders you know.",
      ].join("\n")}
      hideClose
      closeOnScrimClick={false}
      testId="git-folder-trust-prompt"
      actions={[
        { label: "Cancel", variant: "secondary", onClick: () => answerOnce(dismiss) },
        {
          label: "Trust",
          variant: "solid",
          onClick: () => answerOnce(() => {
            // A failure lands in the project banner (see openRepoAtPath).
            void trust().catch(() => {});
          }),
        },
      ]}
    />
  );
}
