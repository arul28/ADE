import { describe, expect, it } from "vitest";

import {
  shellCommandIsReadOnly,
  shellCommandIsReadOnlyOnPlatform,
  shellInvocationIsReadOnly,
} from "./readOnlyShellCommand";

// Plan mode and side chats run every command this calls read-only, across
// Claude, Cursor, Pi, OpenCode, Copilot, Codex and the ACP agents: a false
// "read-only" is a write the chat was promised not to make.
describe("shellCommandIsReadOnly (bash)", () => {
  it.each([
    ["ls -la", true],
    ["git status", true],
    ["git log --oneline | head -5", true],
    ["rg foo src | wc -l", true],
    ["find . -name '*.ts'", true],
    ["git -C ../other log -3", true],
    ["git branch --show-current", true],
    ["cd apps/desktop && git diff --stat", true],
    ["git status; git log -1", true],
    ["ade linear issue ADE-296 --text", true],
    ["ade linear issues --text", true],
    ["ade linear issue-comments --issue-id ADE-296 --text", true],
    ["ade help linear", true],
    ["ade linear comment --help", true],
    ["ade prs show 2655 --text", true],
    ["ade github issue view 12", true],
    ["ade search \"plan mode\" --text", true],
    ["ade status", true],
    ["ade --project-root /x lanes list --text", true],
    ["\"$ADE_CLI_PATH\" linear issue ADE-296", true],
    ["ade linear issue ADE-296 2>&1", true],
    ["git stash list", true],
    ["git log -3 > /dev/null", true],
    ["ade linear issue ADE-296 2>/dev/null | jq .title", true],
    ["gh pr view 12 --json title", true],
    ["gh api repos/o/r/pulls/1", true],
    ["git commit -m x", false],
    ["git push", false],
    ["git branch -D old", false],
    ["git -c core.pager=sh log", false],
    ["git diff --ext-diff", false],
    ["rm -rf build", false],
    ["npm install", false],
    ["echo hi > notes.txt", false],
    ["echo hi >> notes.txt", false],
    ["cat a; rm b", false],
    ["ls && rm x", false],
    ["ls\nrm x", false],
    ["echo $(rm x)", false],
    ["echo `rm x`", false],
    ["cat a | xargs rm", false],
    ["ls &", false],
    ["(rm x)", false],
    ["cat <<EOF", false],
    ["FOO=1 ls", false],
    ["find . -name x -delete", false],
    ["find . -exec rm {} +", false],
    ["git diff --output=patch.diff", false],
    ["sort -o out.txt in.txt", false],
    ["rg --pre ./run.sh foo", false],
    ["ade linear comment ADE-296 \"done\"", false],
    ["ade linear set-state ADE-296 Done", false],
    ["ade linear graphql --query 'mutation { x }'", false],
    ["ade devices use ios@cloud", false],
    ["ade chat send x hi", false],
    ["ade --socket lanes list", false],
    ["ade linear --team issue create --title x", false],
    ["ade github issue --repo view create", false],
    ["sort a | uniq -c", true],
    ["uniq in.txt out.txt", false],
    ["date -s 2020-01-01", false],
    // Review findings: each of these runs or writes something.
    ["find . $'-delete'", false],
    ["find . $\"-delete\"", false],
    ["find . $D", false],
    ["find . \"$D\"", false],
    ["find . *", false],
    ["./scripts/ls", false],
    ["/usr/local/bin/ade linear issue ADE-296", false],
    ["sort -S1b --compress-program=./payload big.txt", false],
    ["echo hi > NUL", false],
    ["echo hi 2>$null", false],
    ["git stash", false],
    ["git stash -p", false],
    ["git worktree", false],
    ["git worktree add ../x", false],
    ["sort -uo out.txt in.txt", false],
    ["sort --outp=out.txt in.txt", false],
    ["sort --com=./payload in.txt", false],
    ["git diff --outp=patch.diff", false],
    ["sort -u a", true],
    ["cat .ade/*/*", false],
    ["ls src/*.ts", false],
    ["ls # \"\nrm x\n# \"", false],
    ["ls # '\nrm x\n# '", false],
    ["echo a#b", true],
    ["echo '#'", true],
    ["ade", false],
    ["gh pr merge 12", false],
    ["gh api -X POST repos/o/r/issues", false],
    ["echo \"unterminated", false],
    ["", false],
  ])("%j is read-only: %s", (command, readOnly) => {
    expect(shellCommandIsReadOnly(command, "bash")).toBe(readOnly);
  });
});

describe("shellCommandIsReadOnly (powershell)", () => {
  it.each([
    ["& \"$env:ADE_CLI_PATH\" linear issue ADE-296 --text", true],
    ["Get-Content README.md | Select-Object -First 5", true],
    ["git log -3 2>$null", true],
    ["Remove-Item x", false],
    ["Get-ChildItem | ForEach-Object { Remove-Item $_ }", false],
    ["Get-Content (Remove-Item x)", false],
    ["Write-Output @(rm x)", false],
    ["Set-Content x y", false],
    ["git log -3 > NUL", true],
    ["Get-Content $path", false],
    ["git log -3 > /dev/null", false],
    ["Get-Content '.ade/*/*'", false],
    ["ls # \"\nRemove-Item x\n# \"", false],
    ["echo a#b", true],
  ])("%j is read-only: %s", (command, readOnly) => {
    expect(shellCommandIsReadOnly(command, "powershell")).toBe(readOnly);
  });
});

describe("shellCommandIsReadOnlyOnPlatform", () => {
  it("needs a Windows command to read under both shells", () => {
    // bash reads `a\;rm` as one word; PowerShell runs `rm x` after the `;`.
    expect(shellCommandIsReadOnly("echo a\\;rm x", "bash")).toBe(true);
    expect(shellCommandIsReadOnlyOnPlatform("echo a\\;rm x", "win32")).toBe(false);
    expect(shellCommandIsReadOnlyOnPlatform("echo a\\;rm x", "linux")).toBe(true);
    expect(shellCommandIsReadOnlyOnPlatform("ade linear issue ADE-296", "win32")).toBe(true);
  });
});

describe("shellInvocationIsReadOnly", () => {
  it.each([
    ["/bin/zsh -lc 'ade linear issue ADE-296 --text'", true],
    ["bash -c \"git log -3\"", true],
    ["\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -Command \"ade linear issue ADE-296\"", true],
    ["pwsh -NoProfile -ExecutionPolicy Bypass -Command \"Get-Content a.txt\"", true],
    ["ade linear issue ADE-296", true],
    ["/bin/zsh -lc 'ade lanes create x'", false],
    ["bash -c \"rm -rf build\"", false],
    ["bash ./script.sh", false],
    ["powershell -File run.ps1", false],
    ["powershell -Command \"Remove-Item x\"", false],
  ])("%j is read-only: %s", (command, readOnly) => {
    expect(shellInvocationIsReadOnly(command, "linux")).toBe(readOnly);
  });
});
