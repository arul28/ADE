---
name: ade-pr-workflows
description: Use this skill before you open a pull request or write its description, and when working with ADE PR workflows including PR tab data, GitHub stacked PRs, checks/comments, rebase resolution, CI fixes, or landing a PR.
---

# ADE PR workflows

## Start with typed PR commands

```bash
ade prs list --text
ade prs show <pr-id-or-number-or-url> --text
ade prs checks <pr-id-or-number-or-url> --text
ade prs comments <pr-id-or-number-or-url> --text
```

Use `ade help prs` and `ade help git rebase` before guessing PR or rebase flags.

## Open a PR with `ade prs create`

`ade prs create` is the best way to open a pull request from an ADE lane. It
links the PR to the lane and to your chat, so the person who reads it can reach
you from the PR, it uploads the proof you cite, and it tells you what a reader
will miss in your text. Use `gh pr create` only when `ade prs create` fails
after a real attempt. A project's own instructions about PRs come first.

It pushes the branch for you. When this computer's git has no GitHub sign-in,
the push retries with ADE's GitHub credential (GitHub CLI or the personal
access token in Settings), so it works where a bare `git push` or `gh` fails.
Push later commits with `ade git push --lane <lane>` for the same reason.

```bash
ade prs create --lane <lane> --base main \
  --title "fix(web): new chats no longer spike CPU" --body-file "$TMPDIR/pr.md" --text
ade prs body <pr> --body-file "$TMPDIR/pr.md" --text     # replace the text later
```

## Write the PR for a person

Almost nobody reads a pull request to the end. Write for a person who has two
minutes, did not see your work, and must decide if the change is safe.

The title says what is different for the person who uses the product, in plain
words: `fix(web): new chats no longer spike CPU`.

The text has these parts, with these headings. ADE's PR view draws each one;
GitHub shows them as ordinary text.

```markdown
## Why
The problem, in one or two sentences. What went wrong, and for whom.

## What changed
What is different now for the person who uses it. Before, then after.
Say what you left alone on purpose, when a reader would expect it to change.

## Evidence
How you checked the change and what you saw. One line for each claim.

## Not checked
What you could not check. Write "Nothing" when that is true.

## Choices I made
Optional. A trade-off you settled alone that the reader may want to overrule,
with the other option. Leave the part out when you made none.
```

Rules for the words:

- **Plain words first.** A reader must understand each sentence without
  stopping. Say what happens to the person, then how the code does it.
- **Explain a technical term where it first appears, in the same sentence.**
  Not "changed how `orders-by-customer` works". Write: "`orders-by-customer` is
  a second lookup table the database keeps, so the app can find a customer's
  orders. It sorted them by the wrong date, so the newest order was missing. It
  now sorts by the order date."
- **Keep code names out of Why and What changed** unless the reader needs the
  name. File paths, function names and commands belong in Evidence.
- **Short.** Cut what the reader does not need to decide. The diff holds the
  rest. A one-line fix needs two sentences and a line on how you checked it,
  not five headings.
- **One problem for each PR.** If the text says "also", that is a second PR.
- Read the text once more as the person who never saw the code. Fix each
  sentence that person would stop on.

Rules for the evidence:

- **Match the evidence to the change.** A layout change needs a picture. Motion
  or timing needs a short video. A speed change needs the numbers, before and
  after. A crash fix needs the steps that caused the crash. A change with no
  screen needs no picture.
- **"Tests pass" is not evidence.** Say what you ran, on what, and what you saw.
- **Use what you already have.** Cite the proof you filed while you checked
  your work. Do not do the work again to get a picture. When you have no
  "before" picture, say so and show the "after".
- **Say what you did not check.** A reader trusts a text that names its gaps.

## Put proof in the PR text

Cite proof in the text the way you cite it in a chat answer, under the claim it
proves:

```markdown
![The new strip above the description](ade-proof://<artifact-id>)
```

Before and after, side by side:

````markdown
```proof-compare
before: <artifact-id> The old overview
after: <artifact-id> The new overview
caption: The description is now a Brief.
```
````

`ade prs create` and `ade prs body` upload each cited file to GitHub and
rewrite the citation, so GitHub shows the picture in place and ADE shows it
side by side. An item that cannot go up (no file on this machine, over
GitHub's size limit) keeps its citation, and the command says so. To run the
upload again on a PR that exists:

```bash
ade proof publish --pr <number or URL> --in-body --text
```

It needs `gh` 2.99.0 or later.

After `ade prs create` makes the PR, it prints a short list under "For the
reader": the parts your text lacks. The PR is made in each case. Fix the text
with `ade prs body`.

## Get woken when your PR changes — don't poll

After you open a PR, have ADE wake you instead of sleeping and re-checking:

```bash
ade prs watch <pr>     # wake me on a failed check, checks passing, new comments, a conflict, merge/close
ade prs ship <pr>      # watch + standing orders to take it to merged; waits for CI and review bots
ade prs unwatch <pr>   # stop
ade prs watch-status   # what this chat is watching
```

`<pr>` is a PR number, URL, or ADE PR id; the watch is for your own chat. Each
wake lists exactly what changed; act on it and end your turn — ADE wakes you
on the next change. Comments you post through `ade prs` never wake you.

## Close out every review thread you handle

ADE's PR view shows each open review thread under "Needs you", as work that
waits for a person. A thread you fixed and left open is a false alarm for
every person who opens the PR after you. So, in the same turn that you handle
a thread:

```bash
ade prs comments <pr> --text                                  # the open threads and their ids
ade prs reply <pr> --thread <id> --body "Fixed in <sha>. <what changed>"
ade prs resolve-thread <pr> --thread <id>
```

- **Fixed it:** reply with what changed, then resolve.
- **Not changing it:** reply with the reason, then resolve. A rejected comment
  with a reason is closed work too.
- **A person must decide:** reply with what you need from them, and leave the
  thread open. This is the only case for an open thread.
- A review comment that is not a thread (a bot's summary, a general comment)
  has nothing to resolve. Answer it with `ade prs comment <pr> --body "..."`
  when it asked for something.

Do this for bot comments and for people's comments alike, and before you say
the PR is ready.

## GitHub stacked PRs

A stack is two or more dependency-ordered, independently reviewable PRs. ADE
creates and tracks them through built-in commands; users and agents do not need
the `gh-stack` extension:

```bash
ade prs stacks list --text
ade prs stacks sync --text
ade prs stacks create --pulls 120,121,122 --text
ade prs stacks add --stack 8 --pulls 123 --text
ade prs stacks unstack --stack 8 --text
```

Mechanics specific to ADE stacks:

1. Order the layers bottom to top and keep foundations below their consumers.
2. Create one deliberate branch and PR per layer. Each layer can own a child
   ADE lane and its own agent, so every layer gets an
   isolated worktree and ship loop; alternatively one lead keeps the whole
   branch chain and delegates only non-overlapping work.
3. `ade prs stacks create` expects every PR base to already match the previous
   PR's head branch — create the stack only after the bases line up.
4. Fix a root-layer failure once, then rebase and repoll every layer above it
   instead of applying duplicate fixes.
5. Report readiness bottom to top from one stack progress view.

GitHub owns stack membership, review requirements, rebases performed on GitHub,
merge queue state, and final merging. ADE enforces this: `ade prs land` (the
`pr.land` action) refuses any PR that ADE knows is in a GitHub stack, failing
with `github_stack_requires_github_merge` and "PR #N is in GitHub Stack #M.
Review and merge the stack on GitHub." For an unstacked PR, `land` still merges
directly via `gh pr merge`. So send review and merge decisions for a stacked PR
to GitHub.

## PR creation closeout links

When you create or adopt a GitHub PR, include both the GitHub URL
(`githubUrl` / `html_url`) and the ADE PR link in your final handoff. The
`adeUrl` printed by `ade prs create` is the ADE link; for a PR adopted through
another path, mint it as described in the **ade-deeplinks** skill, which is also
where the HTTPS-vs-`ade://` guidance lives.

## Post proof as a comment

Proof you make after the PR text is final (a fix for a review comment, a
second check) goes on the PR as a comment. Pick the items yourself:

```bash
ade proof publish --pr <number or URL> <artifact-id> <artifact-id> --heading "Proof" --note "<one line>" --text
```

- One command posts one comment. Each picture and video goes up as a GitHub
  attachment under its caption; ADE hosts nothing and pushes no proof branch.
- Each posted item gets a `github_pr` link, and the proof drawer shows a
  "PR #N" chip on it.
- It needs `gh` 2.99.0 or later. An older `gh` is refused with the upgrade
  command. A number needs a repository with a GitHub remote; otherwise pass the
  PR's URL.
- GitHub limits: 10 MB for a picture; 10 MB for a video on GitHub Free,
  100 MB on paid plans. A larger item is skipped and the output says why.
- Post only what shows the change. Do not post every capture.

## Use actions for niche surfaces

```bash
ade actions list --domain pr --text
ade actions run <domain.action> --input-json '{"key":"value"}'
```

## Freshness

For review-thread or CI work, fetch current checks/comments with
`ade prs checks` / `ade prs comments` first; the PR tab snapshot can be stale.

Stack layers are lanes whose PRs target each other’s branches on GitHub.
