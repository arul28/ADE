---
name: daex-lanes-git
description: "Create, inspect, sync, commit, push, archive or rebase Daex lanes and lane worktrees (`daex lanes`, `daex git`)."
---

# Daex lanes and git

Daex was called ADE: the CLI is `daex`, and `ade …` still works the same (older transcripts and prompts use it).

## Lanes

Lanes are Daex-managed git worktrees and branches. Work in your current lane.
Create a lane only when the user asks for one. When they do:

| Situation | Command |
|---|---|
| New work off the project default | `daex lanes create --name <n>` |
| Continue work that is in another lane / branch | `daex lanes create --name <n> --from <branch> --on local` |
| ...and bring its uncommitted changes too (copied) | `daex lanes create --name <n> --from <branch> --on uncommitted` |
| Work directly on an existing branch | `daex lanes create --name <n> --existing-branch <branch>` |
| See what a bare create would do | `daex lanes defaults --text` |

`daex new chat --auto-create-lane` uses the same defaults and accepts `--from` and `--on`. Defaults and templates are saved per account and repository; repositories without a remote use this computer. Stacked PRs are GitHub's (`daex prs stacks`): each PR targets the branch below it.

```bash
daex lanes list --text
daex lanes show <lane> --text
daex lanes create --name <name> --text
daex lanes archive <lane> --text
```

`archive` is destructive to a user's workspace: it retires the lane and its
worktree, taking any uncommitted work in it with them. Archive a lane only when
the user asked for cleanup, or a workflow that owns lane lifecycle requires it.
Archived lanes are listed by `daex archive list --kind lane --text`. The user
restores or deletes them in Settings → Archive; see the `daex-cli-control-plane`
skill for the archive commands.

## Sharing a lane with another person

```bash
daex lanes share --lane <lane> --text                       # who has access, state, access level, made by
daex lanes share --lane <lane> --add <email> [--ends 1w]    # a Watch share: they see, they cannot act
daex lanes share --lane <lane> --remove <email|grant id>
```

An agent can make only a Watch share: the person sees the lane's chats and
sessions and cannot send, run or approve anything. The lane's computer
refuses more rights, and at most 5 shares an hour. To give more rights or
change a share, ask the user to open the share sheet in the Daex app.

## Lane templates and dependencies

New lanes are plain git worktrees. Daex does not copy, link, or install packages
by itself. A project's default lane template runs for each new lane. A template
can copy env files and paths, install dependencies, and run a setup script. If
`injectPrimaryPath` is true, the script receives `$PRIMARY_WORKTREE_PATH`.

Templates are saved per account and repository. Repositories without a remote use this computer.

```bash
daex lanes templates list --text
daex lanes templates show <id>
daex lanes templates save --json '{"id":"web","name":"Web","dependencies":[{"command":["npm","install"],"cwd":"apps/web"}],"setupScript":{"unixCommands":["npm run codegen"],"windowsCommands":["npm run codegen"],"injectPrimaryPath":true}}'
daex lanes templates default [<id>] [--clear]
daex lanes templates apply <id> --lane <lane>
daex lanes templates delete <id>
daex lanes deps [--refresh] --text
daex lanes create --name <name> --template <id>   # waits for setup; --no-template skips it
```

A dependency command runs directly, without a shell, so pipes, `&&` and `$VARS`
need `setupScript`. Each dependency command and each setup command can run for
up to 20 minutes.

To check a template, create a throwaway lane with
`daex lanes create --name tmpl-test --template <id>`. Inspect the copied folders
and run one quick check in that lane. Then remove it with
`daex lanes delete <lane> --force`.

Older lanes can still have `node_modules` symlinks into the main checkout.
Do not delete one with a trailing slash (`rm -rf node_modules/`): that deletes
the main checkout's packages. Remove the link itself with `rm node_modules`.

## Daex-aware Git

Use plain `git` for local work (status, diff, add, commit). Use `daex git` for
anything that talks to the remote (push, pull, fetch, sync), because it signs
in with Daex's GitHub credential when git cannot (below). The `daex git` forms
of the local commands also exist and refresh the lane's status in Daex:

```bash
daex git status --lane <lane> --text
daex git status --full --lane <lane> --text
daex git sync --lane <lane> --rebase --base main --text
daex git stage --lane <lane> <path>
daex git stage-all --lane <lane>
daex git commit --lane <lane> -m "message"
daex git push --lane <lane> --set-upstream --text
```

## Push, pull and fetch sign in through Daex

Git signs in on its own (keychain, GitHub CLI, SSH), not with Daex's GitHub
connection. When this computer's git has no GitHub sign-in, a bare `git push`
fails with `could not read Username for 'https://github.com'`, even though Daex
can still open PRs. `daex git push`, `daex git pull`, `daex git fetch`,
`daex git sync` and `daex prs create` try git's own sign-in first and then retry
with Daex's GitHub credential (GitHub CLI or the personal access token in
Settings), the same fallback Daex's GitHub API calls use. This covers GitHub
HTTPS remotes; an SSH remote signs in with the SSH key only, and a token cannot
fix it. So:

- Push, pull and fetch with the `daex git` commands, not bare `git`, whenever a
  bare one fails to sign in. Do not paste a token into a remote URL, write a
  credential helper, or change git config to get around it.
- If the `daex` command still fails to sign in, Daex has no credential that can
  write to the repository. Tell the user; the fix is `gh auth login` or a
  personal access token in Settings → GitHub (Daex shows a banner for it).
- `daex github issue …` and `daex prs …` use Daex's GitHub connection the same
  way, so prefer them over `gh` when `gh` is not signed in.

## Rebase and conflicts

```bash
daex git rebase --lane <lane> --text
daex git conflict show --lane <lane> --text
daex git rebase continue --lane <lane> --text
```

`daex git conflict show` prints Daex's view of the conflicted files. Resolve
them yourself, then `daex git rebase continue`.

A branch that is already pushed should not be rebased (that rewrites it).
Merge its base in instead:

```bash
daex git merge --lane <lane> --text
```

It fetches, then merges `origin/<base>` (the lane's compare base) into the
lane. On a conflict it undoes the merge and reports the files, so the lane is
left as it was; resolve by hand with `git merge origin/<base>` if you need to.

## Gotchas

- Use `--lane` for anything other than the active workspace.
- Use `daex diff changes --lane <lane> --text` when you need Daex's view of file changes.
