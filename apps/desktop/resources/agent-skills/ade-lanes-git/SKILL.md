---
name: ade-lanes-git
description: Use this skill when creating, inspecting, syncing, committing, pushing, archiving, or rebasing ADE lanes and lane worktrees through `ade lanes` and `ade git`.
---

# ADE lanes and git

## Lanes

Lanes are ADE-managed git worktrees and branches.

New lanes default to remote main (`git.newLaneBaseSource: "remote"`). Pass
`--base` or set local mode to override that default. A child lane is based on
the parent lane's HEAD, so it carries the parent's commits that have not landed
on main yet.

| situation | do |
|---|---|
| continue MY unmerged work in a new lane | `ade lanes child --lane <current> --name <n>` (carries your commits) |
| fresh, unrelated feature | `ade lanes create --name <n>` (off remote main by default) |
| build on ANOTHER lane's unlanded work | `ade lanes child --lane <that-lane> --name <n>` |

```bash
ade lanes list --text
ade lanes show <lane> --text
ade lanes create --name <name> --description "..." --text
ade lanes child --lane <parent> --name <name> --text
ade lanes archive <lane> --text
```

`archive` is destructive to a user's workspace: it retires the lane and its
worktree, taking any uncommitted work in it with them. Archive a lane only when
the user asked for cleanup, or a workflow that owns lane lifecycle requires it.
Archived lanes are listed by `ade archive list --kind lane --text`. The user
restores or deletes them in Settings → Archive; see the `ade-cli-control-plane`
skill for the archive commands.

## Lane templates and dependencies

New lanes are plain git worktrees. ADE does not copy, link, or install packages
by itself. A project's default lane template runs for each new lane. A template
can copy env files and paths, install dependencies, and run a setup script. If
`injectPrimaryPath` is true, the script receives `$PRIMARY_WORKTREE_PATH`.

Templates live in that machine's `.ade/local.yaml`. They do not sync. Use
`--machine <name>` to read or write templates on another machine.

```bash
ade lanes templates list --text
ade lanes templates show <id>
ade lanes templates save --json '{"id":"web","name":"Web","dependencies":[{"command":["npm","install"],"cwd":"apps/web"}],"setupScript":{"unixCommands":["npm run codegen"],"windowsCommands":["npm run codegen"],"injectPrimaryPath":true}}'
ade lanes templates default [<id>] [--clear]
ade lanes templates apply <id> --lane <lane>
ade lanes templates delete <id>
ade lanes deps [--refresh] --text
ade lanes create --name <name> --template <id>   # waits for setup; --no-template skips it
```

A dependency command runs directly, without a shell, so pipes, `&&` and `$VARS`
need `setupScript`. Each dependency command and each setup command can run for
up to 20 minutes.

To check a template, create a throwaway lane with
`ade lanes create --name tmpl-test --template <id>`. Inspect the copied folders
and run one quick check in that lane. Then remove it with
`ade lanes delete <lane> --force`.

Older lanes can still have `node_modules` symlinks into the main checkout.
Do not delete one with a trailing slash (`rm -rf node_modules/`): that deletes
the main checkout's packages. Remove the link itself with `rm node_modules`.

## ADE-aware Git

Use ADE git commands when the operation should update ADE operation state and refresh lane status:

```bash
ade git status --lane <lane> --text
ade git status --full --lane <lane> --text
ade git sync --lane <lane> --rebase --base main --text
ade git stage --lane <lane> <path>
ade git stage-all --lane <lane>
ade git commit --lane <lane> -m "message"
ade git push --lane <lane> --set-upstream --text
```

## Push, pull and fetch sign in through ADE

Git signs in on its own (keychain, GitHub CLI, SSH), not with ADE's GitHub
connection. When this computer's git has no GitHub sign-in, a bare `git push`
fails with `could not read Username for 'https://github.com'`, even though ADE
can still open PRs. `ade git push`, `ade git pull`, `ade git fetch`,
`ade git sync` and `ade prs create` try git's own sign-in first and then retry
with ADE's GitHub credential (GitHub CLI or the personal access token in
Settings), the same fallback ADE's GitHub API calls use. This covers GitHub
HTTPS remotes; an SSH remote signs in with the SSH key only, and a token cannot
fix it. So:

- Push, pull and fetch with the `ade git` commands, not bare `git`, whenever a
  bare one fails to sign in. Do not paste a token into a remote URL, write a
  credential helper, or change git config to get around it.
- If the `ade` command still fails to sign in, ADE has no credential that can
  write to the repository. Tell the user; the fix is `gh auth login` or a
  personal access token in Settings → GitHub (ADE shows a banner for it).
- `ade github issue …` and `ade prs …` use ADE's GitHub connection the same
  way, so prefer them over `gh` when `gh` is not signed in.

## Rebase and conflicts

```bash
ade git rebase --lane <lane> --ai --text
ade git conflict show --lane <lane> --text
ade git rebase continue --lane <lane> --text
```

`--ai` runs the rebase with ADE's AI-assisted conflict support;
`ade git conflict show` prints ADE's view of the conflicted files.

## Gotchas

- Use `--lane` for anything other than the active workspace.
- Use `ade diff changes --lane <lane> --text` when you need ADE's view of file changes.
