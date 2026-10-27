import { describe, expect, it } from "vitest";
import { readGhPrShellActions } from "./ghPrShellCommands";

const URL = "https://github.com/acme/app/pull/42";
const created = [{ kind: "create", owner: "acme", repo: "app", number: 42 }];
const merged = (owner: string | null, repo: string | null) => [{ kind: "merge", owner, repo, number: 42 }];

describe("readGhPrShellActions", () => {
  it.each([
    ["a plain create", `gh pr create --title "x" --body "y"`, `\n${URL}\n`, null, created],
    ["a create wrapped by the harness shell", `bash -lc 'git push -u origin HEAD && gh pr create --fill'`, URL, null, created],
    ["a create whose existing PR gh reports", `gh pr create --fill`, `a pull request for branch "x" into branch "main" already exists:\n${URL}`, 1, created],
    ["a Windows gh.exe path", `GH_PROMPT_DISABLED=1 C:\\tools\\gh.exe pr create -f`, `${URL}\r\n`, null, created],
    ["a quoted Windows path", `& "C:\\Program Files\\GitHub CLI\\gh.exe" pr create --fill`, URL, null, created],
    ["create only inside a quoted string", `echo "gh pr create" && gh pr list`, URL, null, []],
    ["create only in a comment", `# gh pr create\ngh pr list --json url`, URL, null, []],
    ["create only in a heredoc body", `cat <<'EOF'\ngh pr create\nEOF\ngh pr list`, URL, null, []],
    ["more PR URLs than creates", `gh pr create --fill; gh pr list`, `${URL}\nhttps://github.com/acme/app/pull/41`, null, []],
    ["a PR the command names itself", `gh pr view 42 && gh pr create --fill`, URL, null, []],
    ["a URL inside a sentence", `gh pr create --fill`, `Created ${URL} ok`, null, []],
    ["gh api", `gh api repos/acme/app/pulls -f head=x`, URL, null, []],
    ["a merge by number", `gh pr merge 42 --squash -d`, "", 0, merged(null, null)],
    ["a merge of the current branch, named in the output", `gh pr merge --squash`, "✓ Squashed and merged pull request acme/app#42 (x)", 0, merged("acme", "app")],
    ["a flag value is not the merge target", `gh pr merge -t "title 9" 42`, "", null, merged(null, null)],
    ["a merge with a repo flag", `gh -R acme/app pr merge 42`, "", 0, merged("acme", "app")],
    ["a failed merge", `gh pr merge 42`, "X Pull request acme/app#42 is not mergeable", 1, []],
  ])("%s", (_label, command, output, exitCode, expected) => {
    expect(readGhPrShellActions({ command, output, exitCode })).toEqual(expected);
  });
});
