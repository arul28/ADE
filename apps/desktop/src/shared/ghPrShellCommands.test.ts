import { describe, expect, it } from "vitest";
import { readGhPrBodyEdits, readGhPrShellActions } from "./ghPrShellCommands";

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

describe("readGhPrBodyEdits", () => {
  // Each answer is a PR whose text ADE then rereads and repairs; a wrong
  // number would repair the wrong PR, so anything unsure reads as nothing.
  it.each([
    ["an edit by number", `gh pr edit 42 --body-file pr.md`, 0, [{ owner: null, repo: null, number: 42 }]],
    ["an edit by URL", `gh pr edit ${URL} -b "new text"`, 0, [{ owner: "acme", repo: "app", number: 42 }]],
    ["the current branch's PR", `gh pr edit --body-file=pr.md`, 0, [{ owner: null, repo: null, number: null }]],
    ["a repo flag", `gh -R acme/app pr edit 42 -F pr.md && gh pr view 42`, 0, [{ owner: "acme", repo: "app", number: 42 }]],
    ["flag values before the PR", `gh pr edit --add-label bug --title "Fix 9" 42 --body x`, 0, [{ owner: null, repo: null, number: 42 }]],
    ["a title-only edit", `gh pr edit 42 --title "x"`, 0, []],
    ["a PR named by branch", `gh pr edit my-branch --body-file pr.md`, 0, []],
    ["a failed edit", `gh pr edit 42 --body-file pr.md`, 1, []],
    ["an edit only inside a quoted string", `echo "gh pr edit 42 --body x"`, 0, []],
    ["an edit only in a heredoc body", `cat <<'EOF' > pr.md\ngh pr edit 3 --body y\nEOF\ngh pr edit 4 -F pr.md`, 0, [{ owner: null, repo: null, number: 4 }]],
  ])("%s", (_label, command, exitCode, expected) => {
    expect(readGhPrBodyEdits({ command, exitCode })).toEqual(expected);
  });
});
