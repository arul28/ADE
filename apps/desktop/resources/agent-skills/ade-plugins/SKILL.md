---
name: ade-plugins
description: Use this skill to build, extend, debug, or publish an ADE plugin — whenever the task is to add a tab, panel, row badge, toolbar action, row menu item, filter chip, empty state, file viewer, chat composer button, theme, or `ade` CLI command to ADE; to write or fix a `plugin.json` manifest; to author a panel schema in ADE's declarative UI vocabulary; to build a desktop-only custom UI page (a `webview` surface) against the `window.adePlugin` bridge; to link to a plugin panel or hand it a context; to call the plugin SDK (collections, secrets, contributions, config, actions, panels, events); to declare an agent tool, an automation trigger or step, a universal-search provider, or a keyboard shortcut from a plugin manifest; to run `ade plugin create|install|dev|logs|list`; or to make something a plugin renders show up on desktop, web, iOS, and the `ade code` TUI at once. Also use it to answer what a plugin can and cannot do — what its code is allowed to reach, which surfaces it may claim, and which budgets and reserved bindings will refuse it. It opens with a four-phase runbook — prove the platform is in this checkout, place the request in a real socket before building, install and verify per surface, then state what was actually delivered — and that runbook is the procedure, not a suggestion.
---

# Authoring ADE plugins

# The runbook

Four phases, in order. Phase 0 and Phase 1 happen **before you write a line of code**, and Phase 3 is the deliverable rather than closing pleasantries. The reference half of this document — everything from *The model, in seven lines* down — is what you consult **inside** Phase 2. It is not where you start.

This ordering exists because of one recorded run. An agent reasoned fluently about sockets, budgets and mobile parity in a checkout that did not contain the plugin host at all; built a button in a place the user had not asked for; shipped it with a fallback icon; claimed desktop and iOS without looking at either; and let the user discover every gap themselves. Nothing in that run was a platform defect. All of it was procedure.

## Phase 0 — Prove the platform is here

Before you make **any** claim about what an ADE plugin can do — including a bare "yes, that's possible" — establish two facts and state them.

**1. This checkout contains the plugin host.**

```bash
ls apps/desktop/src/shared/plugins/sockets.ts     # the socket taxonomy
ls apps/desktop/src/main/services/plugins/        # host, supervisor, SDK server
```

If `sockets.ts` is not there, this checkout has no plugin platform. **Say so and stop.** Do not describe sockets, panels or budgets from memory — including from this skill, which describes a platform that may not be in front of you. Ask which branch or ref carries it. The plugin platform has landed on a branch ahead of `main` more than once, and a lane cut from `main` looks exactly like a lane that has it; a user who tells you "the alpha has code that isn't on main" has handed you the most important fact in the task.

When it is there, read the taxonomy out of the file rather than out of this skill:

```bash
rg -n "PLUGIN_SOCKET_KINDS|PLUGIN_SOCKET_CLIENT_SUPPORT" -A 40 apps/desktop/src/shared/plugins/sockets.ts
```

That file is the authority for which socket kinds exist and which clients draw them. The tables below are its prose and can lag it.

**2. Which app you are about to test against — YOUR chat's app, not `PATH`.**

A machine routinely has more than one ADE. They are separate apps with separate CLIs, separate `ADE_HOME`s and separate install registries:

| App | CLI inside it | `ADE_HOME` |
|---|---|---|
| `/Applications/ADE.app` | `/Applications/ADE.app/Contents/Resources/ade-cli/bin/ade` | `~/.ade` |
| `/Applications/ADE Alpha.app` | `/Applications/ADE Alpha.app/Contents/Resources/ade-cli/bin/ade` | `~/.ade-alpha` |
| `/Applications/ADE Beta.app` | `/Applications/ADE Beta.app/Contents/Resources/ade-cli/bin/ade` | `~/.ade-beta` |

**`PATH` does not decide which app your chat belongs to, and it is regularly the wrong one.** A user's shell profile puts `~/.local/bin/ade` — a symlink to whichever app installed the Terminal command, usually stable ADE — ahead of everything, and a login shell re-applies that on every command you run. So `which ade` can answer stable ADE while your chat is running inside ADE Alpha.

The app that launched your chat tells you which CLI is its own. Resolve it FIRST, and use it for every `ade plugin` command:

```bash
echo "${ADE_CLI_PATH:-unset}"      # your chat's own CLI, injected by the app that spawned you
echo "${ADE_HOME:-unset}"          # that app's machine home
ADE="${ADE_CLI_PATH:-$(command -v ade)}"
"$ADE" --version
"$ADE" plugin list --text
```

If `$ADE_CLI_PATH` is unset, derive it before giving up, in this order:

1. `ade doctor --text` — its `CLI` row names the binary, the version and the `ADE_HOME` that answered, so you can match it against the table above (and it warns outright when the binary belongs to a different app than your chat).
2. `ls -d /Applications/ADE*.app` and take the CLI from the bundle whose `ADE_HOME` matches `$ADE_HOME`.
3. Ask the user which app their window is, and name both candidates from the table.

**Never end a turn on "the `ade` on PATH has no `plugin` command".** That sentence has already been wrong in a real run: the agent reported it as "you are not on Alpha, plugins cannot be installed" while the user was looking at the Alpha window with a working Alpha CLI on disk, and the user had to contradict it. `Unknown command 'plugin'` and `Domain 'plugin' is unavailable in this runtime` are facts about ONE BINARY, never about ADE, this machine, or the request.

Report both results in one line before going further:

> This checkout has the plugin host (`sockets.ts`, 16 socket kinds). My chat's CLI is `$ADE_CLI_PATH` (ADE Alpha, `ADE_HOME=~/.ade-alpha`) and `plugin list` answers there. Building against that.

If **check 1** fails, that sentence is the entire reply — there is no platform to describe. If check 2 fails, keep going down the list above; a missing `plugin` command is a binary to find, not a task to refuse.

**One more thing to know before you debug a `webview` surface.** The guest host reads the **list payload**, not the manifest on disk. If your overlay or tab shows the panel where you expected your page, compare the two halves of one answer before you touch the plugin:

```bash
"$ADE" actions run plugin.get --input-json '{"pluginId":"<id>"}' \
  | jq '{summary: .surfaces, manifest: .manifest.surfaces}'
```

`manifest.surfaces[]` carrying `entryHtml` while `surfaces[]` does not is a HOST fault, not yours — the running app is older than the fix that copies the field. `ade plugin doctor <id> --text` makes the same comparison and fails its **Custom page** rung when it finds it. Note that `plugin.reload` cannot change what the already-running app serves; that needs a newer app and a restart.

## Phase 1 — Place it before you build it

Nobody asks for a `composer-action`. They ask for "a button next to where I type". Translate every part of the request into a named socket, in writing, and confirm it **before** building. A control that works perfectly in the wrong place does not read as a placement difference to the person who asked — it reads as the plugin not working.

### The placement map

| The user says | Socket or surface | Where it actually draws |
|---|---|---|
| "a button in the chat header" | `chat-header-action`, surface `work` | The header every chat surface shares, so an **existing** chat carries it. Desktop and web draw a button; iOS draws it as a row in the chat's overflow menu |
| "on the phone's three-dot menu" | `chat-header-action`, surface `work` | The same declaration. The phone puts it in the chat's existing overflow menu, grouped per plugin — a nav bar holds a title and about two controls |
| "a button with a little arrow / a dropdown on it" | `menu[]` on the button's payload — a split button | Works on `toolbar-action`, `composer-action` and `chat-header-action`. Max 6 entries, each with its own `icon` |
| "a button next to where I type" / "in the composer" | `composer-action`, surface `work` | Composer accessory row. Desktop, web and iOS; the TUI draws none |
| "let me type a slash command" | `slash-command`, surface `work` | The composer's command menu. Desktop and web only |
| "in ⌘K" / "the command palette" | `command-palette-action`, surface `app` | ⌘K. Desktop and web only |
| "a button at the top of the Lanes / PRs / Files list" | `toolbar-action` | That surface's toolbar. All four clients |
| "a button in the window's top bar, not tied to a tab" | `toolbar-action` on surface `app` | The top bar's trailing cluster, beside feedback/help/zoom. Its context is the window (`{surface: "app"}`), not whatever tab is open |
| "a little tag on each row" | `row-badge` | On the row a value was PUBLISHED for. 2 visible, rest behind a "+N". On `lanes` it also rides the per-lane header strip in the multi-lane column view, so splitting Lanes into columns no longer loses it |
| "an option when I right-click a row" | `row-menu-item` | That row's context menu |
| "a way to filter the list by my thing" | `filter-chip` + `filterKey` on the rows | The filter row. Publish the tags first or it filters everything out |
| "extra help when the list is empty" | `empty-state` | Below the surface's own empty state |
| "more detail when I open one" | `detail-section` | A panel, as a section in the detail view |
| "a card in the conversation" | `chat-card`, surface `work` | Your panel, inline in the transcript. **Two halves** — the socket is the permission, and you place each card with `chat.emitAdeCard`. See *A card in the transcript* |
| "a panel beside Terminal / Git / Files" | `work-rail-pane`, surface `work` | The Work tools rail. Desktop and web only |
| "a tab beside Sources / Agents / Proof" | `drawer-tab`, surface `work` | The chat actions drawer. Desktop and web only |
| "a section in Settings" | `settings-section`, surface `settings` | Desktop and web only |
| "something in the Create lane / Create PR dialog" | `dialog-section`, surfaces `lanes` / `prs` | Inside that dialog, and it can fill the dialog's fields |
| "show it in the activity feed" | `activity-entry`, surface `app` | A row in the activity pane |
| "open my file type with my own viewer" | `file-viewer`, surface `files` | Files tab, for the extensions you declare |
| "a whole new tab" | a `tab` surface | The tab rail, all four clients |
| "an `ade` command for it" | a `cli` word | `ade <pluginId> <word>` |
| "change the colours / a dark theme" | `theme` tokens | Token-backed surfaces. iOS applies the accent only |
| "make MY button my colour" | `color` on the button's payload | One control only, and refused unless it reads in both themes — see *Tinting one button*. Do not reach for a `theme` to colour one button |
| "make the agent behave differently" | `skills[]` + your own state | Loads at the start of the **next** turn — see *Timing* |
| "something I can pan, zoom or drag" | a `webview` surface | Desktop only; three clients get the panel instead |

Rule of thumb for anything not in the table: **if it is rows of things with buttons on them, it is a panel; if it is a drawing surface, it is a page.**

### Say what has no socket — before you build, not after

**This is a mandate.** Every part of the request that no socket can satisfy is stated as impossible, with the nearest available alternative, in the message *before* you start building. Discovering it afterwards, or letting the user find it on screen, is the failure this phase exists to prevent.

| The ask | Status | Nearest available |
|---|---|---|
| "fill the chat background as the state changes" | No socket. Nothing styles the transcript | A `theme` (whole app, not per chat), or a `chat-card` that shows the state |
| "shake the screen / animate ADE" | No socket. A plugin cannot animate ADE's chrome | A `row-badge` or `activity-entry` that reads as urgent |
| "make the agent I'm talking to change right now" | Not possible. Plugin state reaches the **next** turn | Say what changed and that it applies from the next message |
| "the same control, pixel-identical on phone and desktop" | Not promised by any socket. A support row promises the **contribution and its context**, not the chrome — `chat-header-action` is a header button on desktop and an overflow-menu row on iOS | Say what each client draws. The action and the context it receives are identical; the shape is the host's |
| "the same control in the same place on every client" | Depends entirely on the kind — read `PLUGIN_SOCKET_CLIENT_SUPPORT` | Pick a kind all the clients you care about draw, and say which ones they are |
| "read what the agent said" | No. Hook payloads are metadata only | `ade.actions.invoke("chat", "readTranscript", …)`, which has its own gate |
| "stop the agent from running that tool" | No. Runtime hooks are observe-only | Record it and surface it; a veto is a permission question, not an API one |
| "reorder ADE's own rows" / "put mine first" | No. Placement is host-controlled, always after core content | `order` sorts your rows against each other and nothing else |

### Per-client honesty, stated up front

Say which clients will draw the thing, in the same message as the placement. Two facts do most of the damage when they are left out:

- **A kind absent on a client is absent, not degraded.** `slash-command`, `command-palette-action`, `settings-section`, `work-rail-pane`, `drawer-tab` and `dialog-section` do not draw on iOS at all. The TUI draws exactly three kinds: `row-badge`, `row-menu-item` and `toolbar-action`. Composer actions draw on desktop, web and iOS — iOS's compact layout draws them labeled — and the TUI draws none. Never read this list from memory: `PLUGIN_SOCKET_CLIENT_SUPPORT` is one boolean per client per kind and it moves as parity lands, so read it at the moment you write the claim.
- **`icon` is a token, and the token list is the whole namespace.** Both clients resolve it against the same 69 tokens (64 generic plus 5 brand marks) — desktop to a Phosphor glyph or a vendor mark, iOS to an SF Symbol or a bundled logo asset — and anything not on the list draws the puzzle piece on **both**. So an icon that renders anywhere renders everywhere, and an unrecognised string is unrecognised identically. There is no per-client escape hatch: naming a raw SF Symbol does not work on the phone, and never portably did. The generic tokens:

  `beer` `bell` `bookmark` `brain` `bug` `calendar` `chart` `chart-bar` `chat` `clock` `clock-counter-clockwise` `cloud` `code` `compass` `cube` `currency` `database` `desktop` `device-mobile` `envelope` `eye` `file` `flag` `folder` `gear` `git-branch` `git-commit` `git-pull-request` `globe` `graph` `heart` `image` `kanban` `key` `lightning` `link` `list` `list-checks` `lock` `magic` `microphone` `music` `note` `package` `palette` `play` `plug` `puzzle` `robot` `rocket` `rows` `shield` `sparkle` `star` `storefront` `table` `tag` `terminal` `timer` `toolbox` `trend` `users` `video` `wrench`

  And five **brand tokens**, for a plugin whose whole subject is one vendor's product:

  `brand:claude` `brand:codex` `brand:cursor` `brand:github` `brand:openai`

  A brand token draws that vendor's real mark — the same one ADE already draws for the provider elsewhere — instead of a generic glyph. The set is closed and small on purpose: a vendor is only in it when every client already ships artwork for it, so there is no `brand:linear`, and there will be no new one without a logo on desktop AND iOS. `brand:anything-else` is not a special case; it is an unknown token and draws the puzzle piece like any other.

  **Three slots do not honour a brand token, on every client alike.** A `badge` node, a list item's `badge`, and an `emptyState` node all degrade it — the badge chips to their text-only form, the empty state to the puzzle piece. A badge glyph draws at 8pt and an empty-state mark at hero size, and a vendor logo reads as a smudge at one and as branding-the-wrong-thing at the other. Name a generic token for those three and a brand token anywhere else.

  Read the live list from `PLUGIN_ICON_NAMES` in `apps/desktop/src/renderer/components/plugins/pluginIcons.tsx` — it is exported for this skill, and `PLUGIN_BRAND_ICON_NAMES` next to it is the brand half on its own. **Name a token and the picture cannot differ between clients**; name anything else and you get the puzzle piece, which is what a plugin looks like when it looks unfinished.

## Phase 2 — Build, install, verify

Build with the reference half of this skill. Then install and verify — and verification is per surface you intend to claim, not once at the end.

### Install

```bash
ade plugin create my-thing --dir ~/plugins    # scaffolds the four starter files
ade plugin install ~/plugins/my-thing         # registers it on THIS machine
ade plugin dev my-thing                       # watch + reload on every save
```

**An agent installs by asking, and iterates by reloading.** There are no special agent-only verbs — the same three actions do the work, and what differs is who answers for them:

| Action | Agent calling it | What happens |
|---|---|---|
| `plugin.install` | **Yes — the user is asked** | Raises an approval card in your own chat and blocks until answered. The install then runs on the host's authority, and you get the normal install result |
| `plugin.reload` | **Yes, ungated** | Re-copies a `local` source over the installed copy, re-reads `plugin.json`, restarts the child, reconciles panels and contributions. Your authoring loop |
| `plugin.uninstall`, `enable`, `disable` | **Yes — the user is asked** | The same mechanism as `install`, symmetrically: a card in your own chat ("Remove Tipsy 0.2.0?", "Turn off Tipsy?", "Turn on Tipsy?") listing what stops being there, and the verb runs on the host's authority only if they say yes. **Never remembered** — an approved install does not pre-approve a removal, so every one of these asks again |
| `plugin.list`, `get`, `getPanel`, `getManifest`, `listContributions`, `openLogs`, `presence`, `usageSummary` | **Yes** | Every read-back in the verify section below |
| `plugin.invoke` | **Yes** | Call an installed plugin's own handlers |

So the loop is: **ask once, then reload.**

```bash
ade actions run plugin.install --input-json '{"source":"~/plugins/my-thing"}'   # asks the user, once
ade actions run plugin.reload  --input-json '{"pluginId":"my-thing"}'           # you, after every edit
```

`install` takes `{source, ref?, enable?}` — a directory holding a `plugin.json`, a bundled plugin id, or a git URL. `reload` takes a **plugin id, never a path**, and is synchronous: it completes or it throws.

**A reload of a `local` plugin re-copies the folder it was installed from, first.** So editing your source and reloading runs the edit — that is the whole loop, and it needs no second `install`. Two consequences worth holding on to: the source folder is the truth, so an edit made directly in `~/.ade/plugins/<id>` is overwritten by the next reload; and a resync ADE had to refuse (the folder moved away, its `plugin.json` stopped parsing, it renamed itself to another plugin id) comes back as a **warning on the reload result**, with the previous copy left running. Read `warnings` on what `reload` returns — a reload that kept the old bytes says so there, and nowhere else. A `git` or bundled install re-reads the installed copy exactly as before; nothing fetches on a reload.

Four things to know before you call `install`:

- **It blocks, for up to ten minutes.** The card is a real question in the chat, and your turn waits on the person. That is the cost of not handing them a paragraph of shell ceremony to install the thing you just wrote.
- **A refusal is an answer, not an error to retry.** `plugin_install_denied` and `plugin_install_cancelled` mean the person said no — ask what they would rather do instead. `plugin_install_approval_timed_out` means nobody answered in ten minutes. `plugin_install_source_unreadable` is the one that is your fault: ADE could not read what you pointed at.
- **The same plugin from the same directory does not re-ask** for the life of the ADE process, so a build-test-fix loop runs uninterrupted after the first approval. The memo is keyed on what the *host* resolved, not on what you passed — a different directory, a different plugin id at that directory, or any git URL asks again.
- **`ade plugin dev` is the user's watcher, not yours.** It blocks until interrupted, so an agent cannot run it inside a turn. Edit files, then call `plugin.reload`.

**`plugin.reload` reloads the PLUGIN. It cannot change ADE.** The reload loop above re-copies your source, re-reads your manifest and restarts your child — and that is its whole reach. Everything on the other side of the socket is the running app's own code: where a `{navigate}` opens, what a rail draws, which kinds a client renders, whether a manifest field is copied onto the summary a surface reads. A fix to any of those is a **renderer-side host fix, and it needs an app rebuild**. So a packaged ADE that predates a host fix keeps behaving the old way no matter how many times your plugin reloads — and it cannot detect that about itself, because the code that would notice is the code that is missing. `ade plugin doctor <id> --text` catches the shape of this it can see (its **Custom page** rung compares the manifest ADE parsed against the summary ADE serves); for the rest, the tell is a plugin whose manifest is plainly correct and whose behaviour does not match this document. Check the app's version before you debug your own JSON.

**You can clean up after yourself.** A diagnostic run that installs a plugin can take it off again in the same conversation, and a plugin that has stopped working can be turned back on from the chat that noticed:

```bash
ade actions run plugin.uninstall --input-json '{"pluginId":"my-thing"}'            # asks: Remove my-thing?
ade actions run plugin.disable   --input-json '{"pluginId":"my-thing"}'            # asks: Turn off my-thing?
ade actions run plugin.enable    --input-json '{"pluginId":"my-thing"}'            # asks: Turn on my-thing?
```

`ade plugin remove <id>`, `ade plugin disable <id>` and `ade plugin enable <id>` raise the same card and wait on the same answer. Four things they do NOT share with `install`:

- **Nothing is remembered.** Every removal, disable and enable asks, every time. Approving an install is not approving its deletion.
- **The refusals are named for the verb:** `plugin_uninstall_denied` / `_cancelled` / `_approval_timed_out`, and the same three for `plugin_enable_*` and `plugin_disable_*`. All are answers, not errors to retry.
- **Removing deletes the plugin's stored data**, and its synced copies on the user's other devices. The card says so. Disabling deletes nothing.
- **Never unset `ADE_CHAT_SESSION_ID`** to get around any of this. It is the thing that makes the card reachable at all; without it your call is an unattributed operator command, and the skill's rule against unsetting it has not changed.

Two trapdoors worth knowing before you run any of it:

- **Lifecycle commands need the brain.** `install`, `remove`, `enable`, `disable`, `reload`, `logs` and `dev` all go through it. `list` and `create` do not.
- **A terminal ADE launched is not the user's own terminal.** It inherits `ADE_CHAT_SESSION_ID`, `ADE_RUN_ID` and friends, and the role code treats a chat-session binding as an authority boundary — so a shell that would otherwise be `cto` is clamped to `agent`, and passing `--role cto` does not lift it. For the four lifecycle verbs that clamp is what routes you to a card rather than to a refusal, so it is working for you, not against you. A caller that is neither `cto` **nor** attached to a chat — an external client, a runtime with no chat service — has nobody to ask, and gets the flat `policyDenied` refusal instead:

  > Action 'plugin.uninstall' is limited to the machine operator. Run it from ADE, `ade code`, or your own terminal.

  carrying `{kind: "plugin_role_denied", requiredRole: "cto"}`. If you ever see that with `sessionBound: true`, the ADE you are talking to predates the removal card — read the **CLI** row of `ade doctor --text` before you conclude anything about this machine.

  **Detect the branch from `kind`, not from the sentence.** `data.kind` is the programmatic discriminator; matching on the prose breaks the moment the wording is improved again, which it already has been twice.

  **Read it as an authority boundary, not an obstacle.** Never clear `ADE_CHAT_SESSION_ID` and its friends to reach an operator action: that is laundering a permission decision the user never made, and on a current ADE it also throws away the card that would have asked them properly. Hand the user the command for their own terminal instead.

### Verify — every surface you plan to claim

**Start here, always:**

```bash
ade plugin doctor <pluginId> --text
```

One command walks the whole ladder with live checks — a rung each for **Source**, **Installed here**, **Running**, **Places**, **Last run**, **Panels**, **Panel reach**, **In this project** and **Agent skills** — then closes with a `Renders on:` line **derived from `PLUGIN_SOCKET_CLIENT_SUPPORT` itself**, so the per-client answer cannot drift from the table that decides it. Trust that line over any prose, including this skill's.

```
Tipsy (ade-tipsy) 0.3.0

  ✓ Source           https://github.com/arul/ade-tipsy
  ✓ Installed here   version 0.3.0, turned on
  ✓ Running          the plugin's own process is up
  ✓ Places           composer-action in work, slash-command in work; 1 row published right now
  ✓ Last run         drink ran 2 minutes ago; 1 action never run
  ✓ Panels           1 published of 1 panel in the manifest
  – Panel reach      no chat header button here, so nothing depends on where a navigate lands
  ✓ In this project  1 place, 1 panel, 4 stored rows
  ✓ Agent skills     1 skill · Affects agents from their next turn — running turns keep their current behavior.

  Renders on: desktop ✓ (composer-action, slash-command) · web ✓ (composer-action, slash-command) · iPhone ✓ composer-action / ✗ slash-command (not drawn on phones) · terminal ✗
```

Read that `Renders on:` line closely — it is the layer-6 answer per client and per kind, and the iPhone clause above is exactly the shape of the retrospective's failure: one kind drawn, one absent, on a plugin whose manifest declared both. **Agent skills** carries the timing sentence verbatim, which is the layer-7 answer.

**Places is the contributions read-back.** It counts your declared sockets by kind and surface (`2× row-badge in lanes` when a kind is declared twice), then adds the live published count. Three variants to expect: `; 2 switched off here` when the user has disabled sockets — and if *all* of them are off the rung flips to `✗`, because the reader is here asking why they cannot see it; `; published rows unknown (ADE is not answering)` when the host is down; and `– Places  this plugin asks for no place in ADE's own screens` for a plugin that declares none, which is *not applicable*, never a failure.

**Last run is the one rung about your own code.** Everything above it says the platform did its part; this one says whether a handler of yours was ever reached, and how the most recent attempt ended. It answers the question Places cannot: a button that is drawn and published still reads `✓ Places` when the action behind it never fires, so *"I pressed it and nothing happened"* used to need a reproduction before anyone could tell a wiring problem from a code problem. Read it as: `no action has run since ADE started` — nothing reached your code, so look at the declaration and the press path; `drink failed 4 minutes ago (invalid_args)` — your handler ran and threw, so look at the handler; `drink ran 4 minutes ago` — your handler ran and returned, so if the screen did not change, the bug is in what it did, not in whether it was called. Every route counts: a press, an `ade <id> <word>`, an agent tool, an automation step, a schedule. A refused invoke is an attempt too, and carries its code. It is **in memory**, so it says "since ADE started" and a restart empties it — and on a host too old to keep it, the rung reads `– Last run  this copy of ADE does not keep track of plugin action runs` rather than claiming nothing ever ran.

**Panel reach is the rung every other rung hides.** It answers one question, about one shape: you declared a `chat-header-action`, and you declared panels, and a chat header button *invokes an action and draws nothing in place* — so where does its `{navigate}` land? If the manifest declares no `tab` surface and no `work-rail-pane`, the answer is nowhere, and the rung fails with both fixes named. Every rung above it passes in that state: the plugin parses, installs, runs, draws its button, fires its handler and publishes its panel. That is the whole Hacker News dogfood failure, and it is the reason this rung is read from the manifest rather than from anything live — the doctor cannot run your handler to see whether it navigates, but it can see a panel with nowhere to go. It is deliberately silent about a `composer-action`, whose canonical uses are about the draft: a rung that guesses is worse than no rung on a ladder scanned for the first `✗`.

**Source names a gone folder.** For a `local` install, `✗ Source  the folder /path — gone, so a reload keeps running the installed copy` is the state to catch early: reload has nothing to re-copy from, so every edit you make elsewhere is invisible no matter how many times you reload.

A failing rung tells you the fix rather than the symptom:

```
✗ Installed here   version 0.3.0 is here but switched off — run: ade plugin enable ade-tipsy
```

It is written to be run when things are **already wrong**, so it degrades honestly: a host that answers four of five questions still prints four answers and marks the fifth `–` with *"could not ask ADE — is it running on this computer?"* rather than guessing. The install-registry rungs answer with ADE closed. "ADE is not answering" is a real rung state, not a crash.

**Its exit code is always 0.** It is a report, not a gate, so a runbook step can read it without guarding against a non-zero exit — and a `✗` rung is information rather than a failed command.

**Assert on it rather than grepping it.** JSON is the default output, and `--json` gives `{pluginId, displayName, version, layers[{key, label, state, detail}], clients[{client, label, drawn[], absent[], renders}], renders, actions[{action, declaredBy[], lastInvoke}]}`, where `state` is `"ok" | "no" | "na" | "unknown"` and `key` is the stable one of `source`, `installed`, `running`, `places`, `lastRun`, `panels`, `synced`, `skills`. `actions` is the per-action form of the Last run rung — one row for every action your manifest declares, with `lastInvoke` as `{action, at, ok, errorCode?}` or `null` for one that has never run. So the contributions check is one assertion:

```js
report.layers.find((layer) => layer.key === "places").state === "ok"
```

**Branch on the state, never on truthiness.** `na` and `unknown` both print `–`, and they mean opposite things: `na` is "this plugin declares no sockets", `unknown` is "ADE never answered". A truthy check reads those as the same thing, which is the exact conflation this command exists to break. Only `ok` is a pass, only `no` is a failure, and the two `–` states are questions you have not answered yet.

The eight `key` values and the state union are a **stable contract**: a rung is never renamed, so `find(l => l.key === "places")` keeps working. A NEW rung takes its place in the ladder where it belongs rather than at the end — `lastRun` arrived between `places` and `panels` — so read a rung by key and never by index.

**Press your own buttons before you ask a person to.** `plugin.invoke` takes a synthetic context, so every action you declared is reachable from a shell — no click, no round trip through someone else's attention:

```bash
ade actions run plugin.invoke --input-json '{"pluginId":"ade-tipsy","action":"drink","args":{"context":{"kind":"session","id":"e755df3f-5d72-4af7-87ba-c842ca8bd37c","title":"Chat","provider":"claude","status":"idle"}}}'
ade actions run plugin.invoke --input-json '{"pluginId":"ade-tipsy","action":"status","argv":["status","--json"]}'
```

The handler is named by **`action`**, and **`actionId` is accepted as an alias for it** — the spelling a `sockets[]` entry uses for the same field, so reading your own manifest and typing what you see there works.

Do this **first**, ahead of asking anyone to test in the UI. In the recorded round-2 run, an action that silently read the wrong field of its context cost a whole user round trip — *"I clicked it, nothing happened"* — that a ten-second invoke would have caught, and the author only reached for this partway through. A press by hand proves the chrome; an invoke proves the code, and the code is what you just wrote. Follow it with `ade plugin doctor <id> --text` and read the **Last run** rung: it says whether your handler ran and how it ended.

Then confirm the specific claims you intend to make:

| Check | How | What proves it |
|---|---|---|
| Installed and enabled here | `ade plugin doctor <id> --text`, or `plugin.list` | Your id, `enabled` |
| Your handler actually runs | `plugin.invoke` with a synthetic context, then the **Last run** rung | The value it returned, and a rung reading `<action> ran just now` |
| The child came up | The **Running** rung; `plugin.get {pluginId}` for manifest, effective config and recent log lines | An activation line and the action count; no `crashed` |
| Contributions materialized | The **Places** rung's published-row count; `plugin.listContributions` for the rows | A row exists for the entity you published against |
| The panel says what you think | `plugin.getPanel {pluginId, panelId}` | The **materialized** schema — what the plugin actually published, not what its manifest names. This is the real "did it work" |
| Your own state | `ade <pluginId> <word> --text` (a `cli` word you declared) | The value the UI should be showing |
| The agent-facing half is live | Check your own tool list for `plugin__<pluginId>__<tool>` | Manifest `tools[]` follow install state with no cache — disabled plugin, gone from the next listing. Not every runtime surfaces them, so confirm rather than assume |
| The client actually draws it | **Look at that client.** Desktop: open the surface. iOS: build, install and launch the simulator from **this** checkout, then open the screen. TUI: `/plugin-actions`, `/plugin-view` | You saw it |

Every read-back here is agent-callable — none is operator-gated — so there is no excuse for shipping an unverified claim about layers 1 through 6. Only layer 7 needs a new turn, and only the client check needs eyes.

**Never claim a surface you did not verify.** "The manifest declares it and the kind is supported" is a prediction, not a verification — and it is exactly the claim the recorded run got wrong on the phone. If a client could not be checked, that goes in the delivery statement under *Unverified*, in those words.

When verifying on iOS in particular, confirm the app you launched was built from this checkout. Launching the App Store build, or the other channel's build, makes every subsequent screenshot meaningless.

### Leave tests behind

The doctor and a round of `plugin.invoke` prove the plugin works *now*, on *this* machine, against *today's* data. Neither survives the next edit, and the failures that hurt most in a plugin are quiet ones — a colour silently dropped, a `list` silently truncated, a socket naming an action nobody exported. Ship a suite with the plugin.

Write it in `test/` beside the entry module, under **`node --test`** in **CommonJS**, so it loads the plugin exactly as the child bootstrap does — a missing export or a syntax error fails in the test rather than at install. `plugins/ade-cursor-cloud/test/` is the worked example. Run it with `node --test plugins/<id>/test/*.test.js`.

What earns its place:

- **Every ceiling you are near.** Stub the host the way the host behaves — a `collections.list` that clamps to 1,000, a `put` that can throw `plugin_budget_exceeded` — not the way it behaves when the store is empty. A stub with no limits proves nothing about the machine your plugin will actually run on.
- **The cross-file agreements the manifest parser cannot check.** That every `actionId` in a socket, every `refreshAction`, and every id in a binding's `allowActions` is really in `exports.actions`; that every collection the code touches is declared; that the host you `fetch` is the host you declared. Each of these parses clean and contributes nothing at runtime.
- **The shape of what you return.** One assertion per action on its `{message}` / `{navigate}` / `{openUrl}` / `{resetState}`, and on the value you write to a collection — that value IS the rendered row, so a typo in `subtitle` is a blank line on four clients.
- **Anything you got wrong once.** Write the test that fails on the old code before you fix it, and check that it does.

## Phase 3 — Say what you actually delivered

### The seven layers between "written" and "the agent behaves differently"

These look like one thing to the person using the product. They are seven, and a plugin can be stuck at any of them while every earlier one is green.

```
1  source          plugin.json on disk                     doctor: Source
2  published       public repo + `ade-plugin` topic         only for Marketplace; skip for a local install
3  installed       registry row on THIS machine             doctor: Installed here
4  activated       child spawned and sent `ready`           doctor: Running
5  materialized    a contribution row for that entity       doctor: Places / Panels / In this project
6  client renders  that client draws that socket kind       doctor: Renders on: — then look at the screen
7  agent reads     the NEXT turn loads the skill and state  doctor: Agent skills — then start a new turn
```

`ade plugin doctor <pluginId> --text` prints all seven in one pass, which is why it is the first thing to run when something is not visible.

These seven are about ADE reaching your plugin. They stop where your own code begins, and there is one more question worth asking on the same screen: **did a handler of yours ever actually run?** Doctor's **Last run** rung answers it, and it is the one that separates "the platform never called me" from "I was called and did nothing visible".

Layer 3 says nothing about layer 5. Layer 5 says nothing about layer 6. Layer 6 says nothing about layer 7. "Installed and enabled at level seven" and "the phone shows nothing" are both true at the same time, routinely, and neither is a bug.

### The delivery statement

Every line gets an answer. A line with genuinely nothing to say is dropped rather than left blank — but dropping *Unverified* or *Not built* because it would be awkward is the exact failure this template exists to stop.

```
Built:        <what you built, in the user's own words>
Installed:    <plugin id> on <machine>, via <which app/channel>, enabled
Verified:     <surface> on <client> — <how you checked it>
              <surface> on <client> — <how you checked it>
Unverified:   <surface/client you did not look at> — <why>
Not built:    <the ask> — <why no socket does this> — nearest: <alternative>
Takes effect: <now> / <from your next message — a running turn is not affected>
```

Worked example:

```
Built:        a "Take a drink" button with a sober-up item behind its arrow.
Installed:    ade-tipsy on this Mac, via ADE Alpha, enabled.
Verified:     chat header on desktop — pressed it, count went 0 → 1.
              chat header on iPhone — simulator build from this lane, tapped it.
Unverified:   the web client — not opened this session.
Not built:    the chat background filling with beer — no socket styles the
              transcript; nearest is a theme, which colours the whole app.
Takes effect: the button works now. The agent's drunk behaviour starts from
              your next message; this turn already has its context.
```

# Timing: what reaches the agent, and when

State this to the user whenever you ship a plugin that changes how an agent behaves. It is the single most common surprise, and it is not a defect.

- **A plugin's skill and state are read at the start of a turn.** A turn that is already running keeps the context it started with.
- **Nothing is retroactive.** Installing a plugin, changing its state, enabling it, or uninstalling it does not reach back into a turn in flight, and does not rewrite the transcript.
- **The same holds for removal.** After an uninstall, an already-running agent may still talk about the plugin from conversation context alone. That is memory, not an installed skill.
- **So the true sentence is** "this takes effect from your next message", never "the agent is now X". Say it in the delivery statement.

UI is different from behaviour: a contribution that has materialized draws as soon as the client re-reads it. It is the **agent's** view that is turn-bounded.

# Reference

Everything below is the contract: what a plugin may do, what will refuse it, and how each piece is shaped. Consult it inside Phase 2.

## The model, in seven lines

1. A plugin is a folder with a `plugin.json` at its root. It installs to `~/.ade/plugins/<id>/`.
2. Its code runs **only on the machine that owns it**, in a supervised Node child process. There is no remote execution.
3. Its UI is **data, never code**: a versioned JSON *panel schema* naming components from a fixed set.
4. Desktop, web, iOS, and the TUI each interpret that same JSON with their own native widgets — write it once, and it draws wherever that client supports the kind. Which is not everywhere: *Per-surface support* and *Per-surface socket support* are the two tables that say where.
5. Everything a plugin stores goes in one shared table, and the **writer** enforces every budget before a row lands.
6. Any surface that cannot render a panel renders the panel's required `fallback` instead. A panel is never blank.
7. One exception to line 3: a `webview` surface draws the plugin's own HTML page, on the desktop and nowhere else. It still names a panel the other surfaces show in its place — see *Custom UI*.

Corollary you will feel immediately: **anything you want computed, compute in your code and store as data.** The schema has no expressions, no conditionals, no formatting strings, and no callbacks.

## What you can build — and what you can't

### The engine has no fence around it

Your `entry` module is a real Node process on the machine that owns the plugin. ADE spawns it from its own Node binary, with the plugin directory as the working directory, the user's environment minus a denylist of ADE's internal socket paths and credentials, and `require` anchored at the plugin root — so vendored `node_modules` and every Node builtin load normally. Read and write any file the user can, open any socket, shell out with `child_process`, run your own database, poll an API on a timer. There is no API allowlist, no declared-capability list, and nothing reviews a plugin before it installs.

Say the consequence out loud when you ship one: **installing a plugin is trusting its author with the machine.** The SDK is a convenience layer over what that process could already do, not a boundary around it. Almost every limit below guards something *shared* — the sync layer, the relay, four clients that must render the same JSON. None of them guards the plugin's own machine, and there is nothing there to guard it with.

### What you can put in front of the user

- **Whole surfaces** — a `tab` rendering a panel schema, and on the desktop a `webview` drawing your own HTML page. (A `pane` surface is reserved for official plugins gating a compiled ADE pane; yours belongs in the Work rail as a `work-rail-pane` socket.)
- **Declarative panels**, which desktop, web, iOS and the `ade code` TUI each render with their own native widgets from one JSON document.
- **Sockets on eight surfaces** — the six tabs `work`, `lanes`, `files`, `prs`, `automations`, `cto`, plus `app` (top bar, ⌘K palette, activity pane) and `settings` — in seventeen shapes: `toolbar-action`, `row-badge`, `row-menu-item`, `detail-section`, `empty-state`, `filter-chip`, `file-viewer`, `composer-action`, `chat-header-action`, `chat-card`, `slash-command`, `command-palette-action`, `settings-section`, `work-rail-pane`, `drawer-tab`, `activity-entry`, `dialog-section`. Dynamic ones attach to a `lane`, `pr`, `session`, `file`, `automation` or `surface`.
- **Themes** (token sets, no code at all), **`ade` CLI subcommands**, **agent skills** that load only where the plugin is installed, **deeplinks** into your own panels, **cross-surface navigation** — an action returns `{navigate: {…}}` and the client moves the user to another of your panels — and **draft edits**, where an action returns `{composer: {…}}` and writes into the chat prompt the user is typing.
- **Engine registrations**, which are not placements at all — **agent tools** the coding agent can call, **automation triggers and steps** the rule builder offers, **search providers** ⌘K queries live, and **keyboard shortcuts**. Each says "when X happens, ask me" rather than "draw me here"; see *Engine registrations*.

Three shapes that fit the platform well:

- **A Jira mirror.** The Mac engine polls Jira with the user's token and writes ~50 issues into a synced collection; the phone renders them in a panel, offline, holding no token.
- **A CI dashboard.** One row per branch, green or amber (there is no red), recomputed by the machine that owns the repo and identical on every device.
- **A live agent task tracker.** An agent updates rows through your CLI word or your action handler while every open client watches them move.

### The lines you cannot cross

**The rule that explains the rest of them: limits follow the data, not the UI target.** A plugin that draws a `webview` page, sets `mobile: false`, and keeps its state in its own files or its own SQLite meets effectively none of the ceilings below — no vocabulary ceiling, because the panel its webview surface must still name can be a single fallback card; no collection budget, because it stores nothing in the shared table; no relay concern, because it puts nothing on the wire. The caps engage the moment a plugin writes into synced collections, and from then on they apply wherever the UI happens to render: ADE is multi-machine, so those rows replicate to every machine and device on the account even when only the desktop ever draws them. "Desktop-only" is not a permission tier and there is no flag that opts a plugin out of the guardrails — keeping the data local is what opts it out.

**Synced collections are small, and they are not your database.** 2 MiB per plugin per machine, 4,000 rows, 64 KiB per value — the full table is in *Budgets*. Every byte replicates to every device the user owns, and a phone has to hold all of it. Full is not broken: a `put` past a ceiling throws `plugin_budget_exceeded` and changes nothing else, reads and deletes keep working, and the accounting is delta-based — replacing a 60 KiB value with a 1 KiB one is allowed *at* the ceiling, so a plugin can always shrink itself. Treat collections as synced state; bulk data belongs in your own storage on disk, where nothing is counting. Writing a plugin that survives its own store filling up is a requirement, not a nicety — the rules are in *Never stall*.

**Churning synced values spends the user's relay allowance.** Per-machine daily relay ceilings exist and a machine past one loses relay transport until midnight UTC — numbers and the rule in *Budgets*. Direct and LAN sync are never counted. Read it as etiquette rather than a limit you will hit: publish when something changed, not on a loop.

**The vocabulary is sixteen components with hard ceilings** — 200 nodes, depth 8, 64 KiB per schema, plus the per-component caps in *Vocabulary limits*. No expressions, conditionals, formatting strings or callbacks. A component this build has never heard of renders a marker naming it, and a panel over any ceiling renders its required `fallback` instead — which is why `fallback` is mandatory rather than nice to have. **`panels.update` refuses a schema past `maxNodes` or `maxDepth` at the write**, with `plugin_budget_exceeded` naming the ceiling and your actual count, exactly as a collection value over 64 KiB is refused. That is deliberate: an over-ceiling schema is fatal to the panel on *every* client, so storing it would buy you a blank fallback card on desktop, iOS, web and the TUI at once with nothing anywhere saying why. Note this is the ceiling check only — an unknown component and a malformed known one are still accepted at the write and still become markers at render. What draws where differs per surface: *Per-surface support* is the authority, and worth reading before you design a panel around a `chart`.

**A `webview` page is desktop-only and sandboxed.** Its own origin, `script-src 'self'`, no Node, no `require`, no raw IPC, and no `window.ade` — the `window.adePlugin` bridge is the entire capability, and even `collections.put` through it is refused on the desktop app (write through `invoke` instead). iOS, the web client and the TUI render the surface's `panelId` panel in its place. **There is no custom native UI on iOS or the TUI at all**; declarative panels are the only cross-device UI that exists.

**Nothing you write executes anywhere but the owning machine.** The other clients render data — they never run a plugin's code, which is why a value has to be materialized in render shape before anyone can see it. The `mobile` flag only ever takes a surface away from the phone (see *Mobile*); it cannot put code there.

**The six built-in surface bindings belong to ADE's own plugins.** `graph`, `review`, `history`, `linear`, `ios` and `app-control` are gated by `ade-graph`, `ade-review`, `ade-history`, `ade-linear`, `ade-ios-sim` and `ade-app-control`. A manifest that does not set `official: true` has its `builtin` dropped with a warning; a manifest that does set it still only gates the surface whose registered owner is its own plugin id, because the owner table is compiled into every client. Naming someone else's surface parses clean and changes nothing.

**You cannot declare yourself Official.** The directory decides: an entry is official only when ADE's curated `official.json` lists it *and* both its repo and its install source sit in ADE's own GitHub organizations — otherwise it lists as community with a warning. Official entries carry a per-version sha256 the installer checks against the fetched tree; community plugins are not checksummed by the directory and install as unverified. Being listed in the Marketplace is not an endorsement.

**Sockets and action domains are closed sets.** You fill the seventeen slots above on those eight surfaces; there is no way to inject UI anywhere else, and placement is host-controlled and always after core content, so a contribution never reorders or interleaves with the product's own rows. `ade.actions.invoke` reaches ADE's existing action domains at **agent** role — CTO-only actions are refused — and a plugin cannot define a domain of its own.

**A borrowed action runs against ONE project, and you do not pick which.** The host resolves a project for you at call time — the project your call arrived through, or, when nothing pins one, an arbitrary attached project. Two consequences, both of which have cost an author a day:

- **A project-scoped read can answer `[]` truthfully and uselessly.** `ade.actions.invoke("lane", "list")` takes no `projectId` and cannot be given one; it lists the lanes of whichever project the host resolved. An empty array means "that project has no lanes", which is not the same as "you asked the wrong project", and nothing in the answer tells the two apart. If you have a `laneId` already, prefer `lane.getSummary({laneId})` — it takes the id you hold instead of depending on the resolution.
- **Nothing hands you a `projectId` at `activate`.** There is no project namespace on the SDK and no activate context that carries one. The first place a real `projectId` reaches you is a **change event** — `lane.changed`, `pr.changed`, `session.changed` and `install.changed` all carry `{event, ids[], projectId, overflow?}`. So a plugin that needs to know its project waits for one, rather than assuming the one it read at startup.

If a project-scoped call comes back empty at `activate` and you expected rows, this is the first thing to suspect — not your query.

**Treat `activate` as a fresh host, and clear your own caches there.** `plugin.reload` restarts the child, but module-level state is not guaranteed to be gone with it: a cache you populated at import time can survive into the next `activate` and keep answering with data the reload was supposed to invalidate. A renamed lane that stayed renamed only in ADE, and a settings change that "did not take", are both this. Initialize every module-level map, memo and cached lookup inside `activate` rather than at import, so a reload really is a clean start.

**Plugins cannot see each other.** The SDK server is constructed per plugin and answers every call against that plugin's id; the child never puts an id on the wire. Collections must be declared in your own manifest (an undeclared name is refused, not created), secrets are namespaced `plugin:<id>:<NAME>`, and `config.get()` returns your own settings. There is no cross-plugin read of any kind.

One limit that is not about sharing, because it will bite you anyway: the *process* may work for as long as it likes, but the *host round-trip* is supervised. The child has 20s to send `ready` after it is spawned, one `invoke` is capped at 60s and then fails with `plugin_timeout`, and after 5 crashes in a row inside the first minute of life the host stops reviving it until someone reloads. Long work belongs in `activate` or an event handler, with the result stored — never inside the action the user is waiting on. The exceptions are `composer-action`, `slash-command` and `chat-header-action`, which get 15 minutes because the user watches them work the whole time (*Long-running actions*).

**`activate` runs BEFORE `ready`, so start long work there — do not await it.** The bootstrap sends the `ready` frame only once your `activate` resolves, which puts everything you await inside it on the 20s clock above. A first fetch that is quick on your machine is not quick on a hotel network, and a plugin that times out its own startup is restarted, times out again, and is dead after five tries — for a reason no log line names as slowness. So:

```js
exports.activate = async (ade) => {
  sdk = ade;
  const prefs = await ade.collections.get("prefs", "feed"); // fast, local: fine to await
  void refreshEverything()                                  // slow, remote: started, not awaited
    .catch((error) => ade.log("warn", `first load failed: ${error.message}`));
};
```

Until that work lands, every client renders the schema your manifest already declares, so give `schemaFile` a real loading or empty state rather than a blank card — it is the first thing anyone sees. Nothing is lost by returning early: `panels.update` and `collections.put` work exactly the same from a promise the host is not waiting on.

## Scaffold and run one

```bash
ade plugin create my-thing --dir ~/plugins   # writes the four starter files
ade plugin install ~/plugins/my-thing        # registers it on this machine
ade plugin dev my-thing                      # watch + reload on every save
```

`create` writes exactly:

| File | What it is |
|---|---|
| `plugin.json` | Manifest — identity, surfaces, panels, sockets, settings, CLI words |
| `index.js` | Entry module (CommonJS, dependency-free). Exports `activate`, `deactivate`, `actions` |
| `panels/main.json` | The panel schema the tab renders |
| `README.md` | Shown on the plugin's Marketplace detail page |

`ade plugin list` and `ade plugin create` work with ADE closed — they read the machine install registry directly. Everything else (`install`, `remove`, `enable`, `disable`, `reload`, `logs`, `dev`) goes through the ADE brain and fails with a clear message if it is not running.

| Command | Does |
|---|---|
| `ade plugin list [--text]` | Installed plugins on this machine, from `~/.ade/plugins/state.json` |
| `ade plugin create <name> [--dir <path>]` | Scaffold a new plugin directory |
| `ade plugin install <source> [--ref <r>] [--no-enable]` | Install from a local path or git URL |
| `ade plugin remove <id>` | Uninstall |
| `ade plugin enable <id>` / `disable <id>` | Turn a plugin on or off |
| `ade plugin reload <id>` | Re-copy a `local` source, re-read the manifest, restart the child |
| `ade plugin logs <id> [--limit <n>]` | Recent log lines from the plugin's ring buffer |
| `ade plugin doctor <id>` | Check every layer between installed and visible — see *Verify* |
| `ade plugin dev [<id>\|<path>]` | Watch the source folder; reload on every save. Given an id, it watches the folder a `local` install came from, not the installed copy |

JSON is the default output; pass `--text` for human-readable. `ade plugin dev` survives ADE being closed: it says so once, keeps watching, and reloads when the brain returns.

Once installed and enabled, a plugin that declares `cli` words is reachable as `ade <pluginId> <word> [args]` — the CLI routes it to the plugin's own action.

## `plugin.json` reference

Parsing is **strict on keys it knows, tolerant of keys it does not**: an unknown field is dropped so a manifest written for a newer ADE still loads on an older one, but a known field with the wrong shape is an error. A single bad `sockets` entry is dropped with a warning; the plugin still installs.

```json
{
  "name": "graph",
  "version": "1.2.0",
  "displayName": "Graph",
  "description": "Workspace graph as an ADE tab.",
  "icon": "graph",
  "accent": "#7C6FF0",
  "minAdeVersion": "1.3.0",
  "vocabVersion": 1,
  "entry": "index.js",
  "surfaces": [{ "kind": "tab", "id": "graph", "title": "Graph", "panelId": "main" }],
  "panels":   [{ "id": "main", "schemaFile": "panels/main.json", "title": "Graph" }],
  "sockets":  [{ "socket": "file-viewer", "surface": "files", "id": "video",
                 "extensions": [".mp4", ".mov"], "panelId": "player" }],
  "collections": { "issues": { "sync": true } },
  "settings": [{ "key": "defaultLane", "kind": "select", "label": "Default lane",
                 "optionsAction": "listLanes" }],
  "cli": ["issues", "open"],
  "skills": ["skills/using-graph"],
  "theme": { "tokens": { "dark": { "--color-accent": "#7C6FF0" }, "light": {} } },
  "network": { "hosts": ["api.cursor.com"] },
  "providerKeys": ["cursor"],
  "projectSecrets": ["STRIPE_API_KEY"],
  "webhookIngress": [{ "id": "default", "label": "Build events" }],
  "official": false
}
```

| Field | Required | Rules |
|---|---|---|
| `name` | yes | The plugin id. `^[a-z][a-z0-9-]{0,63}$`. It is a directory name, a secret namespace, a sync primary key, and a CLI word — uppercase is refused, not folded |
| `version` | yes | `major.minor.patch`, optional `-pre`/`+build` tail |
| `displayName` | no | Defaults to `name` |
| `description` | no | Defaults to `""` |
| `icon` / `accent` | no | `accent` is a 3- or 6-digit hex color. `icon` is a **token from one shared 64-name list**, drawn as a Phosphor glyph on desktop and an SF Symbol on iOS; anything else puzzle-pieces on every client. The names are in *Per-client honesty* |
| `minAdeVersion` | no | Floor. An ADE below it will not load the plugin; an unknown host version never locks the user out |
| `vocabVersion` | no | Panel-schema vocabulary version. Positive integer, defaults to `1` |
| `entry` | no | Relative path to the entry module. **Omit for UI-only plugins** (themes, static panels) — they run no code at all |
| `surfaces[]` | no | `{kind: "tab"\|"pane"\|"webview", id, title, panelId, icon?, order?, mobile?, builtin?}`. `panelId` is required on all three kinds. A `webview` also needs `entryHtml` — see *Custom UI*. `mobile` — see *Mobile*. `builtin` names a compiled-in ADE tab this plugin gates instead of rendering, and is reserved — see *What you can build*. **`pane` is reserved too**: no client draws a plugin-provided pane, so the parser drops a `pane` that carries no honoured `builtin` and tells you to declare a `work-rail-pane` socket instead |
| `panels[]` | no | `{id, schemaFile?, title?, icon?, refreshAction?}`. `schemaFile` is the default schema; `sdk.panels.update()` replaces it at runtime. `refreshAction` names one of your actions and turns on a refresh gesture — see *A panel that fetches* |
| `sockets[]` | no | See *Sockets* below |
| `collections` | no | `{"<name>": {"sync": true\|false}}`. Every declared collection must be named here before you may read or write it. `sync: true` is a **disclosure**, not a switch: it is what the install sheet tells the user rides to their other devices, and what uninstall scopes its deletion to. The rows themselves are one CRR table either way, so `sync: false` does not keep a collection on this machine — if data must not leave, keep it in your own files on disk instead |
| `settings[]` | no | `{key, kind, label, description?, options?, optionsAction?, default?}`; `kind` ∈ `text`, `secret`, `select`, `toggle`, `number` |
| `cli[]` | no | Subcommand words, `^[a-z][a-z0-9-]{0,31}$`, reachable as `ade <id> <word>` |
| `skills[]` | no | Relative paths to agent-skill directories this plugin contributes; they join `ADE_AGENT_SKILLS_DIRS` |
| `tools[]` | no | `{name, description, input, action?}`. Tools the coding agent may call, as `plugin__<id>__<name>`. Max **24** — see *Engine registrations* |
| `automationTriggers[]` / `automationSteps[]` | no | `{id, label, description?}` / `+ action`. Max **8** / **12** — see *Engine registrations* |
| `searchProviders[]` | no | `{id, label, action?}`. Max **2** — see *Engine registrations* |
| `keybindings[]` | no | `{binding, label, action}`. Max **6** — see *Engine registrations* |
| `theme` | no | Token sets — see *Themes* |
| `network` | no | `{"hosts": ["api.cursor.com"]}`. Hosts your plugin's process may contact. Max **8**, lowercase, no scheme, no port, no IP. One leading `*.` wildcard is allowed and matches any subdomain depth. **Omit it and your plugin reaches nothing** — see *Outbound network* |
| `providerKeys` | no | `["cursor"]`. Providers whose ADE-stored API key you read through `ade.secrets.getProviderKey`. Max **4**, from the api-key store's own ids — see *Provider keys* |
| `authSessions[]` | no | `{id, provider, authorizeUrl, callbacks, loopback?}`. Sign-in flows the host runs for you. Max **2**. `authorizeUrl` is `https:` with no query or fragment; `callbacks` names `"loopback"` and/or `"app"`; `loopback` is required when `"loopback"` is one of them and its `port` is **1024–65535** — see *Signing the user in* |
| `credentialHandoff` | no | `["linear"]`. Built-in surfaces whose ADE-held credential you ask to inherit. Max **2**, official-only, and the host additionally refuses a built-in this plugin does not own — see *Inheriting a connection ADE already has* |
| `projectSecrets` | no | `["STRIPE_API_KEY"]`. Names of **this project's** ADE secrets you read through `ade.actions.invoke("project_secret", "get", { name })`. Max **6**. **Omit it and you read none** — see *Project secrets* |
| `webhookIngress[]` | no | `{id, label, description?, verify?}`. Webhook channels ADE receives for you at its relay. Max **4**; `id` is a URL path segment, so `^[a-z][a-z0-9-]{0,31}$` — see *Webhooks* |
| `official` | no | **Not a trust claim.** The Official badge and the checksum rule come from the registry's curated file, never from the manifest. Locally the field does exactly one thing: a surface may carry `builtin` only on a manifest that sets it — see *What you can build* |

Every path in a manifest (`entry`, `schemaFile`, `skills[]`) must be relative, inside the plugin directory, and free of `..` — absolute paths and traversal are refused at parse time.

Manifest-level rules the parser enforces (a violation drops that entry, not the plugin):

- `detail-section` and `file-viewer` sockets require `panelId`.
- `toolbar-action`, `row-menu-item`, `composer-action`, `chat-header-action`, `command-palette-action` and `slash-command` sockets require `actionId`. `PLUGIN_SOCKET_REQUIREMENTS` in `sockets.ts` is the per-kind authority, and it states the manifest and payload requirements separately because they differ — `activity-entry` takes `label` in the manifest and `title` in the payload.
- `file-viewer` requires at least one `".ext"` extension.
- A `webview` surface requires `entryHtml`, and it must name an `.html` (or `.htm`) file inside the plugin. A `webview` with no page is dropped, not warned about. `entryHtml` on any other kind is ignored.

### Outbound network

Your plugin's process reaches **no host on the internet** unless the manifest says which ones:

```json
"network": { "hosts": ["api.cursor.com", "*.hf.co"] }
```

- `api.cursor.com` matches that host and nothing else.
- `*.hf.co` matches any subdomain at any depth (`us.aws.cdn.hf.co`), and **not** the apex `hf.co`. Declare both when you need both — a redirect to a CDN is the usual reason.
- `localhost` is the one single-label name allowed. IP literals, ports, schemes and paths are refused at parse time.

Declared hosts are printed on the install card as "Talks to api.cursor.com", before the person agrees. Widening the list in a later version asks them again.

Enforcement is inside your child process: `fetch`, `WebSocket`, `http`/`https` and the `net`/`tls` sockets under them refuse an undeclared host with a `network_host_not_declared` error and write one `warn` line to your plugin log. `ade plugin doctor <id>` shows the declared hosts and counts refusals.

**It is a guard-rail, not a sandbox.** Your child is an ordinary Node process, so `child_process` walks around all of it. The declaration exists so the person installing you knows where their data goes; do not describe it to them as containment.

### Provider keys

ADE stores the user's API keys for the model providers it talks to. A plugin may read one — and only one it declared:

```json
"providerKeys": ["cursor"]
```

```js
const key = await ade.secrets.getProviderKey("cursor");
if (!key) return { text: "Add a Cursor API key in Settings to use this." };
```

- `getProviderKey` resolves `null` when the provider is declared and the user has connected no key. That is a normal state — say so, do not throw.
- `hasProviderKey(provider)` answers the same question without reading the key, for a panel that only needs to draw the empty state.
- An undeclared provider rejects with `not_permitted`; one ADE stores no key for rejects with `invalid_args`.
- The install card says "Uses your Cursor API key". Adding a provider in a later version asks the person again.

This is the user's credential, given to ADE and lent to you. Hold it for the call that needs it. Do not copy it into `ade.secrets`, a collection, a panel schema or a log — the user rotates it in Settings, and a second copy is a copy that goes stale and a credential in a place they cannot see.

### Signing the user in

You cannot run OAuth by yourself, and you do not have to. The division of labour is the thing to get right. **The host** builds the authorize URL, mints and checks `state`, owns the loopback listener or the relay bounce, and hands you the callback parameters as data. **You** declare the provider before install, supply the query parameters, run PKCE if you want it — only you can hold the verifier, because only you perform the exchange — exchange the code over a host you declared in `network`, and store the token in your own `ade.secrets`. **ADE never holds the token: it brokers the authorization, not the credential.**

```json
"authSessions": [{
  "id": "linear",
  "provider": "Linear",
  "authorizeUrl": "https://linear.app/oauth/authorize",
  "callbacks": ["loopback", "app"],
  "loopback": { "port": 19836, "path": "/oauth/callback" }
}]
```

Two transports, and most real integrations declare both. `loopback` is a browser on this machine: the host binds `127.0.0.1:<port>`, catches the GET itself, and nothing leaves the machine. `app` goes to ADE's relay, which is stateless and does one thing — 302 the query string to `ade://plugin-auth`, which the phone's in-app auth session catches and posts back to the machine that began the flow. **A flow that declares only `loopback` is desktop-only**, and the phone says so — "Connect … on the machine — this sign-in can only finish there" — rather than opening a browser it can never get back from.

**Register both redirect URIs with your provider.** For the flow above they are:

- `http://127.0.0.1:19836/oauth/callback` — built from the port and path you declared.
- `https://ade-github-webhook-relay.arulsharma1028.workers.dev/plugin/auth/callback` — ADE's relay. One route for every plugin and every flow; it names no integration and needs no deploy for yours.

```js
let verifier = null;                                  // only you can hold this

// Subscribe BEFORE you call beginSession. The completion is delivered once, to
// the child that began the flow, and it is the only copy of the code there is.
ade.events.on("auth.completed", async (event) => {
  if (!event.ok) {
    // "canceled" | "expired" | "denied" | "state_mismatch"
    if (event.reason === "denied") return draw(`Linear declined: ${event.message}`);
    return draw(event.reason === "expired" ? "That took too long — try again." : null);
  }
  const token = await exchangeCode(event.params.code, verifier);   // your fetch, your declared host
  await ade.secrets.set("LINEAR_ACCESS_TOKEN", token);
});

// The action behind your Connect button.
async function connect() {
  verifier = newVerifier();
  await ade.auth.beginSession({
    sessionId: "linear",
    params: {
      client_id: CLIENT_ID, response_type: "code", scope: "read,write",
      code_challenge: challengeFor(verifier), code_challenge_method: "S256",
    },
  });
  return { authSession: { sessionId: "linear" } };
}
```

- **`beginSession` does not return the URL**, and that is deliberate: a live authorize URL, `state` and all, would then be inside the one process this design keeps it out of. You get `{sessionId, attempt, transport, redirectUri, expiresAt}`, and the host stamps the URL on the way to the client.
- **The result is `authSession`, never `openUrl`.** A URL opened in the system browser has no way back on a phone — that is the whole gap this closes. The result kind is how the client knows to use an in-app auth session and watch for the callback scheme.
- **`redirect_uri` and `state` are refused by name, not overwritten.** Sending either is `invalid_args`, and the refusal says which one — a silent overwrite would leave you debugging a redirect you never sent. Max **12** parameters, **512** characters each.
- **`auth_session_busy`** — one live flow per declared id. The previous attempt is a browser window the user is looking at right now, so it is not retired under them. The same code comes back when the declared loopback port is already in use on the machine, with the port number in the message.
- **`auth_unavailable`** — nothing on this machine can show a sign-in: a headless brain with no desktop attached and no phone paired. A flow that started and could never finish is worse than one that refused to start.
- **A `sessionId` your manifest does not declare is `not_permitted`**, and the refusal names the `authSessions` field. A `transport` your flow does not declare is `invalid_args` rather than a quiet redirect to the other one.
- **Ten minutes**, then the host retires the flow and you get `{ok: false, reason: "expired"}`. `cancelSession(sessionId)` is idempotent and safe in a `finally`.
- `params` come back minus `state` — the host minted it and the host compared it. What is left is the provider's own vocabulary, passed through as data.
- The install card says "Signs you in to Linear, and listens on port 19836 while you do". Repointing that flow at a different provider, or moving it to a different port, asks the person again.

Declare one flow; two is the ceiling and the second slot is for a product's self-hosted twin, not for a second product. Declare both callbacks unless you genuinely cannot register the relay URI, because the callback list is what decides whether your Connect button works on the phone at all. And treat `auth.completed` as the only moment a token exists: persist the refresh token in `ade.secrets` and renew from it, because a plugin that re-runs the whole dance on every start is a plugin that asks the user to sign in twice a day.

### Inheriting a connection ADE already has

One field, for one situation: an official plugin that replaces a compiled ADE integration, on the day it ships, so that existing users do not all reconnect. **This is not for ordinary plugins.** If you are not superseding something ADE already ships, declare a sign-in above and let the user connect.

```json
"credentialHandoff": ["linear"]
```

Official-only at parse time, and the manifest is not the last word: the host also checks that the plugin **owns** the built-in it names — `ade-linear` owns `linear` — so no package can ask for a credential that is not the one it is replacing. A built-in you do not own, or one that is not a built-in surface id at all, is `not_permitted`.

```js
const { status, secretNames } = await ade.auth.requestHandoff("linear");
if (status === "accepted") {
  const token = await ade.secrets.get("LINEAR_ACCESS_TOKEN");
}
```

Three statuses, and each one is a different thing to draw. `requestHandoff` waits for the person's answer, and a second call while a card is open joins that same wait rather than stacking another card — so there is no "ask me later" state to poll for:

- **`accepted`** — the user agreed and the secrets are in your store now. Draw connected.
- **`declined`** — the user said no. Draw your own sign-in; nothing was copied.
- **`empty`** — ADE holds no credential for that surface. Indistinguishable from "the user was never connected", and it should be: draw your ordinary sign-in.

On `linear`, accepting COPIES whichever of these ADE actually holds into your own secret namespace — ADE keeps its own, and the card names each one in plain words rather than by key:

- `LINEAR_ACCESS_TOKEN` — the access token.
- `LINEAR_REFRESH_TOKEN` — the refresh token that keeps it working.
- `LINEAR_TOKEN_EXPIRES_AT` — when the access token expires.
- `LINEAR_AUTH_MODE` — whether the user signed in with Linear or pasted an API key.
- `LINEAR_OAUTH_CLIENT_ID` — the public OAuth client id the token was issued to.

**The OAuth client secret is not on that list, and it is not gated — it is absent.** It is ADE's identity to Linear rather than the user's credential: a plugin holding it could present itself to Linear *as ADE*, on every machine the plugin is installed on. The client id is handed over because a refresh token is only ever redeemable by the client it was issued to, and ADE's bundled client is a public PKCE client that ships no secret at all. If the user configured their own confidential client you get that client's id and no secret, the refresh fails the way any client missing its secret fails, and you fall back to the sign-in above — which is the correct outcome.

- **It COPIES. It never moves.** ADE keeps its own connection exactly as it was, and the card says so. ADE's compiled Linear integration keeps running until a later wave deletes it, so both need the credential during the transition: ADE's copy dies with the compiled code, yours dies with your uninstall through the secret store's own sweep.
- **Asked once per install.** After an answer, the same call returns that answer without raising a second card. A card that re-prompted on every start would be a nag, and a nag is answered yes to make it stop.
- **The one re-prompt: your copy is gone.** An accept is honoured only while the access token it gave you is still in your store. If you deleted it — a disconnect button, a reset, a bug — the next `requestHandoff` raises the card again, because a record saying "already answered" over an empty store is a dead end the user cannot get out of. A **decline** never re-asks whatever your store holds: nothing was copied, so there is no copy whose absence could mean anything.
- **A decline is not an error.** It never throws; it comes back as `declined` and is remembered. Fall back to the ordinary sign-in, and do not report it as a failure.
- **Uninstall forgets the answer**, so a reinstall asks again rather than inheriting a decision given to a package that is no longer on the machine.
- `auth_unavailable` when there is something to hand over and nothing on this machine that can ask a person about it.
- `secretNames` is keys, never values — it is your documentation of what to read, and it is safe to log. The values go into your secret store and nowhere else.
- The install card says "Asks to use the Linear connection you already set up in ADE". *Asks*, because the install is not the consent — a separate card is, and this line is only the warning that it is coming.

Call it once, at first run, and only when your own store is empty; everything after that reads `ade.secrets` like any other token you obtained yourself. Handle all three statuses where you draw your Connect button — `declined` and `empty` are not failures to report, they are the unconnected state you were already drawing.

### Project secrets

The project's own secrets — the ones the user imported from a `.env` and manages in ADE — are read **by name, and only a name you declared**:

```json
"projectSecrets": ["STRIPE_API_KEY"]
```

```js
const secret = await ade.actions.invoke("project_secret", "get", { name: "STRIPE_API_KEY" });
```

- **Undeclared is `not_permitted`**, and the refusal names the secret and the `projectSecrets` field to add it to. Declaring nothing means you read nothing; that is the default and it is the right one for almost every plugin.
- **`get` is the only verb you get.** `list`, `set`, `delete`, `previewEnvImport` and `importEnv` are refused to every plugin, declared or not. `list` is refused because it reads back the names of the secrets you did *not* declare; the writers are refused because the project's `.env` is the user's, not yours.
- **Your own secrets go in `ade.secrets`**, which is a per-plugin encrypted namespace nothing else can read. Use it for the tokens your plugin obtains itself.
- The install card says "Reads this project's secrets (.env): STRIPE_API_KEY". Adding a name in a later version asks the person again.
- `ade plugin doctor <id>` prints a **Project secrets** rung with the declared names. It never says whether a secret is set — that is the project's business, not the report's.

Prefer a plugin `setting` of kind `secret` when the value is yours to collect. Reach for `projectSecrets` only when the value is genuinely the project's and the user already keeps it in ADE.

### Webhooks

A third party can post to your plugin. Declare the channels it posts to:

```json
"webhookIngress": [
  { "id": "default", "label": "Build events" },
  { "id": "billing", "label": "Billing",
    "verify": { "kind": "hmac-sha256", "secretRef": "STRIPE_SIGNING_SECRET" } }
]
```

ADE registers a secret with its own Cloudflare relay for you and gives you a URL per channel:

```js
const url = await ade.webhooks.url();          // the "default" channel
const billing = await ade.webhooks.url("billing");

ade.events.on("webhook.received", async (event) => {
  // { id, channel, eventType, receivedAt, headers, body, truncated?, attempt }
  if (event.channel === "default") await ade.automations.emitTrigger({ triggerId: "build_finished" });
  await ade.webhooks.ack(event.id);            // acked, or you get it again
});
```

- **The URL is the setup step.** Show it to the person, or let them copy it from your plugin's Marketplace page, which lists every declared channel. `ade plugin doctor <id>` prints the same URLs, which is what to use when the plugin is installed and not running.
- **Delivery is at-least-once, and `ack` is not optional.** A delivery you do not ack is redelivered on the next drain, and abandoned after five attempts. `event.id` is stable across redeliveries, so it is the key to dedupe on if your handler is not idempotent.
- **`body` is a string, capped at 64 KiB.** Past that it arrives with `truncated: true` rather than not at all — parse defensively.
- **`headers` is a short allowlist.** Content type, user agent and the common webhook/delivery-id headers. Authorization, cookies and anything else the sender attached never reach you.
- **`verify` checks the sender's own signature**, host-side and constant-time, over the raw body, before your code sees it. `secretRef` names one of *your* secrets (`ade.secrets.set("STRIPE_SIGNING_SECRET", …)`), never a literal — a signing secret in a manifest ships in the package. A channel whose secret is missing on the machine refuses every delivery and says so in the doctor; that is the safe reading of "the manifest says check this and I cannot".
- **Without `verify`**, the relay's own registration secret is the only check, so the URL is the credential: treat it as one and do not print it in a log or a panel anybody screenshots.
- `ADE_WEBHOOK_RELAY_SECRET` is reserved. It is ADE's registration secret in your namespace, and `ade.secrets` refuses to read, write or delete it.
- **Renaming a channel id breaks a live integration** — the id is in the URL somebody already pasted somewhere. Add a channel instead.

### Mobile

Every surface says whether it belongs on the phone. Set `"mobile": false` on a surface that only makes sense on a big screen, and ADE's iOS app leaves it out of the plugin menu and will not open it.

- **Default: `true`** for a `tab` (and for the reserved `pane`). Say nothing and your panel shows up on the phone, which is the point of writing a panel schema instead of a page.
- **`false` is a good answer** when the panel needs a wide table, a long form, or a keyboard to be worth opening. Hiding it there is kinder than shipping a cramped version of it.
- **A `webview` is desktop-only either way.** Its page never draws on the phone; the panel named by its `panelId` does. Setting `mobile` on a webview surface changes nothing (ADE warns and ignores it), so put your effort into making that panel say something useful.
- **`mobile` only ever takes a surface away.** It cannot add one. A value that is not `true` or `false` is ignored with a warning, and the default applies.

Set it per surface, not per plugin: a plugin with a summary tab and a settings tab can keep the first and drop the second.

### Owning a conversation

The biggest thing your plugin can be is the agent on the other end of a chat.
Declare a `chatRuntimes` entry, and ADE sessions can be bound to you: the user's
turns arrive as `chat.turn`, and your answers stream back into the transcript.

```jsonc
"chatRuntimes": [{
  "id": "cloud",
  "displayName": "Cursor Cloud",
  "icon": "Cloud",
  "capabilities": { "followUp": true, "interrupt": true, "hydrate": true, "artifacts": true }
}]
```

Two per plugin, and **all four capability flags are required** — a missing one
drops the runtime, because both defaults lie. Then:

```js
const { sessionId } = await ade.chat.createSession({
  runtimeId: "cloud", externalId: agentId, laneId,
});

ade.events.on("chat.turn", async ({ sessionId, message, turnId }) => {
  const run = await startRun(message);              // return as soon as you have DISPATCHED
  for await (const chunk of run) {
    await ade.chat.appendAssistant(sessionId, { text: chunk, turnId });
  }
  await ade.chat.emitStatus(sessionId, { state: "idle" });
});

// Poll fast while somebody is reading, and not at all when nobody is.
ade.events.on("chat.opened", ({ sessionId }) => startLadder(sessionId));
ade.events.on("chat.closed", ({ sessionId }) => stopLadder(sessionId));
```

Four things to get right:

- **Return from `chat.turn` when the turn is dispatched, not when it is
  answered.** The reply comes back through `appendAssistant`. Holding the
  listener open for a twenty-minute run blocks the host's dispatch budget.
- **Always call `emitStatus`.** A plugin that never reports leaves a chat
  spinning forever. `idle` and `finished` settle it; settling is what feeds the
  attention ladder and the "waiting on you" treatment. `failed` marks the turn
  failed with your sentence in `detail`.
- **Use `chat.opened` / `chat.closed`, not `ade.schedules`,** for a poll ladder.
  Schedules are floored at 60 seconds and know nothing about who is looking.
- **You can only write to sessions you own.** The host reads your plugin id off
  your own connection and compares it to the session's; every `ade.chat.*` verb
  but `createSession` is refused otherwise. There is no way to name your way
  into somebody else's transcript, so do not try to handle that error.

`appendUser` backfills a single turn ADE did not originate. `setArtifacts` draws
lane-relative files as a proof card, and `attachBranch` fetches a branch into the
lane so the ordinary branch and PR affordances light up.

**Backfilling a long history: page it.** `hydrate` takes at most **500 entries
per call**, and a real cloud conversation can be longer. Send pages oldest
first — the first with no options, every later one with `{append: true}` — and
each page appends after the last. ADE does not re-sort: only you know the true
order of a conversation you read from somebody else's API.

```js
let first = true;
for (const page of pagesOldestFirst) {          // 500 entries or fewer each
  const { accepted, skipped } = await ade.chat.hydrate(sessionId, page, { append: !first });
  first = false;
  if (!accepted) break;                          // ADE already had this far back
}
```

The result is worth reading. `accepted === 0 && skipped > 0` means ADE already
holds that page — the normal answer on a re-read after a reconnect — so stop
paging rather than walking the whole history again. Entries dedupe on
`fingerprint` suffix-tolerantly, so a page that lands twice costs nothing.

One whole sweep is capped at **10,000 entries** across all its pages. `append`
is what carries the running total forward; a call without it starts a fresh
sweep. A backfill that reaches the ceiling is a loop, not a history, and gets a
`plugin_budget_exceeded` refusal that says so.

**Never name an action `ade:anything`.** The whole `ade:` prefix belongs to ADE:
the host delivers `chat.turn` and `chat.interrupt` over the same channel your
own actions use, and the name is what tells them apart. A handler, socket
`actionId`, CLI word or tool that claims the prefix is dropped from your
manifest with a warning, and `ade.actions.invoke` refuses it outright.

### Engine registrations

Seven manifest families that are **not placements**. A socket says "draw me here"; five of them say "when X happens, ask me" — a tool the agent may call, an automation trigger a rule can fire on, a step a rule can run, a provider universal search may query, a chord that invokes an action. The last two say "run this for me": a sign-in the host performs on your behalf, and a credential ADE already holds.

All seven are declared in the **manifest** rather than registered by the running child, for one reason worth understanding: the rule builder, the shortcut listing, the search palette and the agent's tool list all have to describe a plugin that is installed but **not currently running**, and a list the child publishes at boot is empty exactly when the user is looking. Tool sets in particular are built synchronously at session start, so a list published after boot could never reach Claude without restarting the chat. Declaring in the manifest also makes uninstall a non-event — the declaration leaves with the install record.

Four of them share one shape, `{id, label, action?}`, deliberately, so an author does not learn four spellings of the same promise:

| Family | Cap | Shape | Notes |
|---|---|---|---|
| `tools[]` | 24 | `{name, description, input, action?}` | The agent sees `plugin__<pluginId>__<name>`. `action` defaults to `name` |
| `automationTriggers[]` | 8 | `{id, label, description?}` | The manifest supplies the *vocabulary*; the plugin fires it with `ade.automations.emitTrigger`. `id` is stored by rules, so renaming one orphans every rule using it |
| `automationSteps[]` | 12 | `{id, label, description?, action}` | A step a rule may run. `action` defaults to `id` |
| `searchProviders[]` | 2 | `{id, label, action}` | Invoked live with `{query}`. `action` defaults to `id` |
| `keybindings[]` | 6 | `{binding, label, action}` | One chord, e.g. `"Mod+Shift+P"` |
| `authSessions[]` | 2 | `{id, provider, authorizeUrl, callbacks, loopback?}` | The host runs the flow; `id` is what `ade.auth.beginSession` names. The install card reads the `provider` and the loopback port off it before any code runs — see *Signing the user in* |
| `credentialHandoff` | 2 | `["linear"]` | Official-only, and only for the built-in this plugin owns — see *Inheriting a connection ADE already has* |

**Over-cap and duplicate entries are warnings, not errors** — the offending entry drops and the plugin still installs. A manifest typo must not turn into a dead Marketplace listing.

#### Search providers: live, and on a budget

A provider is queried **live on a debounced keystroke**, not indexed. That is deliberate — a plugin's results are whatever its store says right now, and an FTS row written at install time would be stale in a way users read as a bug. The cost is a latency budget, and the palette spends it rather than waiting:

- **300 ms.** A provider slower than that is **dropped for that keystroke**, not awaited. A throw, a rejection, a timeout, or a shape this build does not recognize all degrade to no rows — never to a broken palette. The palette is what a user reaches for when they are already lost, so it must never be the thing that breaks.
- **8 rows per plugin**, not per provider — so splitting results across both allowed providers to claim double the room does not work. Roughly one screenful beside ADE's own sections.
- **Two providers maximum**, because every one is a live invoke sharing that budget. A plugin that needs to search several things searches them inside one provider, where it — not the palette — pays for the fan-out.
- A row's `id` is echoed back as `resultId` when opened, so it is **rejected over 256 chars rather than truncated**: two long ids differing past the cut would silently open the wrong result. Titles and subtitles are cut, not refused.

#### Keybindings: a scarce shared resource

There is exactly one keyboard, every plugin wants the memorable half of it, and the user cannot see who took what until they press it. Three rules, in order:

1. **A modifier is required.** Core binds bare keys — `/`, `j`, `[`, `Enter` — because core knows when the user is typing and when they are navigating. A plugin does not, so a bare-key binding is refused. This is the load-bearing rule.
2. **Core always wins** — not "usually". A plugin cannot take a chord ADE ships, nor one the *user* rebound, because a user override counts as core's. A plugin that silently changed what ⌘K does would be indistinguishable from malware and unattributable when it went wrong.
3. **First installed wins between plugins.** Arbitrary but stable: the plugin that was there yesterday keeps working when the user installs something new today.

Some chords are refused outright whatever the manifest says:

- **`Ctrl/Mod + c`, `d`, `m`** — these end a process, and `ctrl+M` is Enter on a terminal.
- **Bare `Esc`, `Enter`, `Tab`, `Backspace`, `Delete`** — the keys a user presses to get *out* of something. A plugin that can swallow Escape can trap a user inside a panel it drew.
- **The window and OS set:** `Mod+N`, `W`, `Q`, `M`, `S`, `P`, `Shift+F`, and the zoom triple `0` / `-` / `=`+`+`, plus `Mod+,`. These are answered by the application menu and the OS *before the page sees them*, so a plugin does not win one — it **double-fires** with it. ⌘W closes the tab out from under the action; ⌘Q quits mid-invoke. The user sees a plugin firing at random and a window behaving strangely, with nothing connecting the two.

`mod` is Cmd on macOS and Ctrl elsewhere, so a plugin's `"Ctrl+K"` and core's `"Mod+K"` are the same keystroke on Windows — collisions are resolved against both spellings on every platform, so an author sees the refusal on whichever machine they own.

**A refused binding is not a failed install.** The action stays reachable from the command palette, and the refusal carries a written sentence naming who holds the chord (`core-conflict`, `plugin-conflict`, `invalid`, or `duplicate-action` when one plugin declares two chords for the same action — only the first binds).

## Panel schemas — the UI vocabulary

A panel is a JSON document. `v` is the vocabulary version, `fallback` is **required**, `body` is the tree.

```json
{
  "v": 1,
  "title": "Recent issues",
  "fallback": { "title": "Recent issues", "text": "Open ADE to see this panel.",
                "deeplink": "ade://lane/…" },
  "body": [
    { "component": "stack", "direction": "vertical", "gap": "md", "children": [
      { "component": "text", "text": "Open issues", "variant": "title" },
      { "component": "list", "bind": { "collection": "issues", "keyPrefix": "open:", "limit": 20 },
        "emptyText": "Nothing open." },
      { "component": "button", "label": "Refresh", "kind": "primary",
        "onPress": { "action": "refresh" } }
    ]}
  ]
}
```

### Components

| Component | Shape (required fields in bold) |
|---|---|
| `stack` | **`children[]`**, `direction` (`vertical`\|`horizontal`), `gap` (`none`\|`sm`\|`md`\|`lg`), `align`, `wrap` |
| `group` | **`title`**, **`children[]`**, `groupKey`, `badge`, `defaultOpen` (default true). A section the reader can collapse — see *Seven groups, no state keys* |
| `text` | **`text`**, `variant` (`title`\|`subtitle`\|`body`\|`caption`\|`code`), `tone`. `code` is the only monospace affordance |
| `markdown` | **`text`** — formatted prose. One field: no `maxHeight`, no variant, no tone. See *Prose with structure* below for the subset, which is the same on all four clients |
| `badge` | **`text`**, `tone`, `icon` |
| `button` | **`label`**, **`onPress`** (a `VocabAction`), `kind` (`primary`\|`default`\|`quiet`), `icon`, `disabled` |
| `list` | **`items[]` or `bind`**, `emptyText`, `selectable` `{stateKey, actions[] (≤4), max?}`. Item: **`title`**, `key`, `subtitle`, `meta`, `tone`, `icon`, `onPress`, `badge` `{text, tone?, icon?}`, `mono`, `actions[]` (≤3), `overflow[]` (≤6) |
| `table` | **`columns[]`** and **`rows[]` or `bind`**, `emptyText`. Column: **`key`**, **`label`**, `align` |
| `form` | **`fields[]`**, and **`submit` `{label, onPress}` or `applyOnChange` (a `VocabAction`)** — at least one, both allowed. Field kinds: `text`, `secret`, `select`, `toggle`, `number`. See *A form with no Apply button* |
| `chart` | **`kind`** (`line`\|`bar`), **`series[]`** of `{id, label?, tone?, points:[{x,y}]}`, `title`, `emptyText` |
| `video` | **`src`**, `poster`, `title`. A source over `maxSrcChars` is refused, never shortened — a truncated `data:` URI still passes the scheme check and then decodes to nothing |
| `image` | **`src`**, **`alt`**, `maxHeight`. Same `src` rule as `video` |
| `divider` | `label` |
| `keyValue` | **`rows[]` or `bind`**, `emptyText`. Row: **`key`**, `value`, `tone` |
| `emptyState` | **`title`**, `description`, `icon`, `action` `{label, onPress}` |
| `segmented` | **`stateKey`**, **`options[]`** (2–8) of `{value, label?, badge?}`, `optionsFrom` `{collection, valueField, labelField?, keyPrefix?}`, `label`, `default`, `style` (`segmented`\|`toggle`), `onChange`. The one control that holds state — see *A filter with no round trip*. With `optionsFrom` the literal `options` may be as few as one, and the control draws as a menu past eight |

Tones are `neutral`, `accent`, `success`, `warning`. **There is no red.** Any red-ish value you write (`danger`, `error`, `fail`) folds to `warning` — the house rule cannot be bypassed by a payload.

`bind` reads your own `plugin_collections` rows: `{collection, keyPrefix?, limit?, allowActions?, where?}`. The rows must **already be in render shape** for the component that binds them — a `list` binding reads `{title, subtitle?, …}` values, a `table` binding reads column-keyed records. The renderer does no reshaping.

`onPress` is `{action, args?, confirm?}`. `args` is flat scalars only (nested objects are dropped — that is where "data, never code" would start to leak). `confirm` makes the client ask before dispatching, on **every** client — a list row asks exactly as a button does.

**Put a row's whole story on the row.** A `list` item carries a status chip (`badge`), a monospace line for a value meant to be compared (`mono` — an id, a branch, a short sha), up to three trailing buttons (`actions`) and up to six more behind an overflow control (`overflow`). Each action is `{action, args?, confirm?, label, kind?, icon?}` — an `onPress` plus a required `label`, since a button on a row has no other way to say what it does.

```json
{ "component": "list", "items": [{
  "title": "bc-1", "subtitle": "Fix the login redirect",
  "mono": "origin/fix-login-redirect",
  "badge": { "text": "Running", "tone": "accent" },
  "onPress": { "action": "open-agent", "args": { "id": "bc-1" } },
  "actions": [{ "action": "stop", "label": "Stop", "confirm": "Stop this agent?" }],
  "overflow": [{ "action": "archive", "label": "Archive" }] }] }
```

Build the row this way rather than hand-assembling one out of `stack`, `badge`, `text` and `button` nodes. A hand-built row costs about seven nodes, and `maxNodes` is 200 — so the panel caps out near 27 rows. **A list is one node however rich its rows are**, which makes `maxListItems` (100) the real ceiling. The cap on `actions` counts what survived parsing, so a malformed entry does not spend a slot.

Per-client: desktop, the web client and iOS draw all of it, with `overflow` behind a menu. The TUI draws the badge bracketed after the title (`bc-1 [Running]`), the mono line under the subtitle, and `actions` **and** `overflow` together as one numbered key list — a terminal has no menu, and showing what a row can do beats hiding half of it.

**A bound row acts only through `allowActions`.** A collection row carries no action by default, because stored data that could mint one would put a button in front of the reader that the panel never declared. Name the action ids in the binding and a row may choose among them:

```json
{ "component": "list",
  "bind": { "collection": "fleet", "allowActions": ["open-agent", "stop-agent"] } }
```

A row naming anything outside that list still renders; it is simply not pressable. Max **16** ids, deduplicated. An empty `allowActions` means the same as none.

### Prose with structure

`text` renders literally on every client: a `#` is a hash and `**bold**` is four
asterisks and two words. An issue body, a comment or a release note needs the
other thing, and **`markdown`** is it.

```json
{ "component": "markdown", "text": "## Fix the redirect\n\nDrops `next` when the session is **stale**." }
```

**The subset is closed, and it is identical on desktop, web, iPhone and the
terminal.** It is defined once, as data, in
`apps/desktop/src/shared/plugins/vocabularyMarkdown.ts`; the phone mirrors it in
`PluginVocabularyMarkdown.swift`. Anything outside it is not markup — it is the
characters you typed.

| In the subset | Written as | Notes |
|---|---|---|
| Headings | `# a` … `###### f` | Six levels. A seventh hash is a paragraph |
| Bold / italic / strike | `**a**` `_a_` `~~a~~` | Nested emphasis becomes both, not a tree. `snake_case` is a word |
| Inline code | `` `a` `` | Swallows everything inside it: `` `**a**` `` is four literal characters |
| Fenced code | ```` ```ts ```` … ```` ``` ```` | The info string's first word is the language. An unclosed fence still renders |
| Links | `[text](https://…)`, `<https://…>` | **`https:` only** — see below |
| Lists | `- a`, `1. a` | Ordered lists keep their start number. Nesting is allowed |
| Task list | `- [x] a`, `- [ ] a` | **Drawn inert.** A picture of the source document, never a control |
| Blockquote | `> a` | Its content is parsed as blocks |
| Thematic break | `---` | |

| NOT in the subset | What you get | Use instead |
|---|---|---|
| Raw HTML | The characters, escaped | Nothing. This is the security line and there is no way through it |
| Images | The alt text | The `image` node, which has a source ceiling and a scheme gate |
| Tables | The pipes, as text | The `table` node, which has columns a client can lay out |
| Bare URLs | Text, not a link | `[text](url)`. Three clients disagree about where a bare URL ends |
| Setext headings, indented code | A paragraph | `#` and a fence, which nobody types by accident |

**Links pass the same gate as `{openUrl}`, and open through the same path.**
`https:` with a host, and nothing else: a `javascript:`, `data:`, `file:`,
`ade:` or plain `http:` destination loses its link and keeps its words. A tap
goes out through the client's plugin-link opener — the one that logs your plugin
id — never straight to a browser.

**Length.** `maxMarkdownChars` is 4,000, the same ceiling as `text`, and a panel
is capped at 65,536 bytes either way. Past the node ceiling the document is cut
and drawn **as its source, in monospace, with a line saying so** — because a cut
lands wherever it lands, regularly inside a fence or a link, and half-parsed
prose says less about what happened than the text does. Past
`maxMarkdownBlocks` (100) the rest is dropped and the panel says that too. Send
less prose rather than relying on either.

Per-client: desktop, the web client and iPhone draw it as formatted prose. The
terminal draws it as lines that keep the structure — a heading is bold, a bullet
is a bullet, a fenced block is its own lines, a checkbox is `[x]`, and a link is
its words followed by its URL, because a terminal cannot hide a destination
behind a word. It is **not** a placeholder like `image` and `chart`: prose is
the one thing a terminal draws as well as anything else.

**Worked example — an issue and its comments.** This is the shape the node was
built for. The issue's own fields are a `keyValue`, the body is one `markdown`,
and each comment is a `divider` naming the author plus a `markdown` of their
words. Every node here is data your plugin already fetched and materialized: the
renderer reshapes nothing.

```json
{ "component": "stack", "gap": "md", "children": [
  { "component": "text", "text": "ADE-122 · Fix the login redirect", "variant": "title" },
  { "component": "keyValue", "rows": [
    { "key": "State", "value": "In Progress", "tone": "accent" },
    { "key": "Assignee", "value": "arul" }
  ]},
  { "component": "markdown", "text": "The redirect drops the `next` param when the session is **stale**.\n\n- [x] Reproduce on `main`\n- [ ] Add a regression test\n\nSee [the trace](https://linear.app/ade/issue/ADE-122)." },
  { "component": "divider", "label": "kai · 2 days ago" },
  { "component": "markdown", "text": "Confirmed. The fix is in `sessionRedirect.ts`:\n\n```ts\nconst next = url.searchParams.get(\"next\");\n```" },
  { "component": "divider", "label": "arul · yesterday" },
  { "component": "markdown", "text": "> the fix is in `sessionRedirect.ts`\n\nAgreed — ~~blocked~~ ready for review." }
]}
```

Two things to size for. A comment thread is many `markdown` nodes, and each one
costs a node against `maxNodes` (200) and its characters against the panel's
65,536-byte budget — so publish the last N comments, not all of them, and let
the reader open the full thread on the web. And the body you fetched is somebody
else's text: it may contain HTML, a `javascript:` link or 40 KB of prose, and
you do not need to clean any of it. The subset already refuses all three,
identically, on every client.

### A form with no Apply button

A settings section should take effect as it is edited. `submit` used to be required, so every form-shaped settings panel grew a button the reader had to press — and the way around it was to rebuild the section out of `segmented` controls, which works and costs you the field labels, the help text and the validation a form gives for free, and turns a boolean into the strings `"on"` and `"off"`.

**`applyOnChange`** is that shape. It is an action, like `submit.onPress`, and it fires on every committed edit with the same full values map a submit sends — so your handler reads one payload however the values arrived. A form that declares it needs no `submit` at all, and draws no button when it has none.

```json
{
  "component": "form",
  "applyOnChange": { "action": "applySettings" },
  "fields": [
    { "kind": "toggle", "id": "digestEnabled", "label": "Weekly digest",
      "help": "A notification each week summarizing what you logged.", "value": true },
    { "kind": "select", "id": "digestDay", "label": "Send it on",
      "options": [{ "value": "1", "label": "Monday" }], "value": "1" }
  ]
}
```

Three things to hold onto:

- **A field's values arrive as top-level args, keyed by field id** — `args.digestEnabled` is a real boolean, not `"on"`. `args.state` is still the reader's `segmented` selections, and is a different thing.
- **"Committed" is not "changed".** A `toggle` and a `select` commit the moment they move. A `text`, `secret` or `number` field commits when the reader finishes with it — blur or Enter on desktop, blur or Return on iOS, Enter in the TUI — so your plugin is not invoked once per letter.
- **Declaring both is legal** and means what it reads as: edits apply as they are made, and the button re-runs the action. Declaring neither is refused at parse, and the node degrades to a marker.

### A filter with no round trip

A fleet list needs a status filter. Built out of what the vocabulary had, that was a `form`, a submit button, a `panels.update()` from your plugin and a refetch — three taps and a round trip for every change, and the selection did not survive the re-render unless you baked it back into `field.value`.

One control and one clause replace all of it. A **`segmented`** node owns a named piece of client state, and a binding's **`where`** keeps the rows that match it. Changing the control re-renders from rows already in memory: no IPC, no fetch, no call into your plugin.

```json
{
  "component": "stack", "direction": "horizontal", "gap": "md", "wrap": true,
  "children": [
    { "component": "segmented", "stateKey": "statusFilter", "label": "Status", "default": "",
      "options": [
        { "value": "", "label": "All", "badge": 12 },
        { "value": "active", "label": "Active", "badge": 4 },
        { "value": "failed", "label": "Failed", "badge": 1 }
      ] }
  ]
}
```

```json
{ "component": "list",
  "bind": {
    "collection": "fleet",
    "allowActions": ["open-agent"],
    "where": [{ "field": "statusGroup", "equals": { "$state": "statusFilter" } }]
  },
  "emptyText": "No agents match this filter." }
```

Write `statusGroup` onto every row when you publish it. **The client only compares strings** — it never computes one, which is what keeps this inside "data, never code".

**An empty `value` means unset, and that is how you write "All".** A comparison whose state key is unset — or names a key no control declares — is *inactive*, not false: it drops out of its `and`/`or`, a `not` of it is inactive too, and a `where` with nothing active keeps every row. That one rule is why the option list needs no second concept for "turn this filter off".

**The grammar.** Clauses are ANDed at the top level. A comparison is `{field, equals|notEquals|in|notIn}` where the operand is a literal, a list of literals, or `{"$state": "key"}` — exactly one operator per clause, and `since` / `before` (below) are two more of them. Compose with `{"and":[…]}`, `{"or":[…]}` and `{"not":{…}}`. `field` is a top-level field of the row: no paths, no field-to-field comparison, no expressions, no regular expressions.

```json
{ "or": [
  { "field": "statusGroup", "in": ["failed"] },
  { "and": [
    { "field": "statusGroup", "equals": "active" },
    { "field": "archived", "notEquals": "true" } ] } ] }
```

A field compares as its JSON words: `archived: false` matches `"false"`, not `"No"`. An object or an array compares as empty, so it matches nothing.

### "Today" and "this week", without rewriting your rows at midnight

`since` and `before` are the two operators that do not compare text. They read the row's field as a *time* and compare it to an instant:

```json
{ "component": "list",
  "bind": {
    "collection": "notes",
    "where": [{ "field": "ts", "since": { "$rel": "-24h" } }]
  },
  "emptyText": "Nothing in the last day." }
```

The operand is one of four things:

- an **ISO-8601 string** — `"2026-08-01T00:00:00.000Z"`, or a bare `"2026-08-01"` which reads as UTC midnight;
- **epoch milliseconds** — `1756000000000`;
- **`{"$rel": "-24h"}`** — an offset from *now*, resolved on the reader's own clock. The sign is required and may be `+`: `{"before": {"$rel": "+1h"}}` is a legitimate "due in the next hour". Units are lower-case `m`, `h`, `d`;
- **`{"$state": "range"}`** — the reader's selection, read as either of the first three. A `segmented` with option values `""` / `"-24h"` / `"-7d"` is "All / Today / This week" with no fields for you to maintain.

**A date-time must carry its zone.** `"2026-08-28T12:00:00Z"` and `"2026-08-28T12:00:00+02:00"` are read; `"2026-08-28T12:00:00"` is not, and drops with a warning. Four clients evaluate this and "local time" is a different instant on each of them. `new Date().toISOString()` — what you actually write — is always accepted.

**`since` is at-or-after; `before` is strictly earlier.** They partition the timeline at the same instant, so a pair of them never double-counts a row and never loses one.

**A row whose field is missing, or is not a time, does not match.** That is the same thing a row with no `statusGroup` already does against an `equals` — the row could not answer, so it is not in the answer. (The *inactive* rule is about the operand: an unset `$state` still turns the whole clause off and keeps every row.)

**It re-evaluates when the panel re-renders, and a panel re-renders on data change — not on a timer.** Leave a panel open across midnight and it still shows yesterday's answer until something changes. That is deliberate: a timer would wake every open panel on every surface forever to catch a boundary almost nobody is watching. Give a panel that shows a `$rel` filter a `refreshAction` (below) so the reader has a gesture that forces the re-read.

`since` and `before` cost the same as any other comparison — one clause of the same budget, the same one-operator-per-clause rule, the same node-local drop with a warning when the operand is unreadable.


**A broken filter shows too much, never too little.** A clause the parser cannot read disappears with a warning and the binding keeps the rest; a `where` where nothing survived is an unfiltered binding. You can see that a filter did nothing — you cannot see rows a filter silently removed.

**`limit` caps what a node draws, not what it fetches.** Filtering happens before the cap, and the host drops the fetch limit for a filtered collection. A fleet of 300 fetched at `limit: 100` and then filtered would report "4 failed" when there are eleven.

**Read the selection back with `$state`.** The second reserved collection after `$context`, and the only way a schema can name the reader's choice — rule 3 has no interpolation. A row's key is the control's `label` and its value is the *selected option's label*, so a `keyValue` bound to it says "Status: Active" rather than "Status: active".

```json
{ "component": "keyValue", "bind": { "collection": "$state" } }
```

**Your plugin is told, when it needs to be.** Every action invoked from the panel carries the current selections under `state` beside `context`, so a "Refresh" can fetch the filtered set instead of everything. Declare `onChange` on the control to be told on the change itself — it fires *after* the local write and never instead of it, so the filter works whether or not your handler answers. Answer an action with `{resetState: true}` (or `{resetState: ["statusFilter"]}`) to put the reader back on the defaults — worth doing after you archive everything the current filter was showing, since an empty list is a puzzle and "All" is an answer.

**Lifecycle.** State is per-panel, per-viewer and session-only. It never reaches sqlite and never syncs. It survives a re-publish of the same controls — your panel refreshing its rows every few seconds must not reset the filter — and reconciles when the controls themselves change: a key the new schema drops goes away, and a value the control no longer offers falls back to that control's default.

**Ceilings.** 8 state keys per panel, 2–8 literal options per control (50 once `optionsFrom` has resolved), 4 top-level `where` clauses, depth 3, 24 clauses in total, 20 literals per list — a `since` or `before` spends from the same budget as any other clause. A `style: "toggle"` with anything other than two options draws as a segmented control, because drawing three options as a switch would hide one.

### A filter over thirty projects

Eight options is right for "All / Active / Failed" and useless for "project": a real workspace has thirty of them, and you do not know their names when you write the schema. You are already writing them into a collection for the list beside the control, so point the control at that collection:

```json
{ "component": "segmented", "stateKey": "project", "label": "Project",
  "options": [{ "value": "", "label": "All projects" }],
  "optionsFrom": { "collection": "projects", "valueField": "id", "labelField": "name" } }
```

- **The literal `options` still draw, first.** That is where the empty-value "All" goes, and it is why a bound control needs no second concept for "no filter" — the sentinel is a literal like any other. A bound control is also exempt from the two-option floor: its second option is a row that has not arrived yet, not a mistake.
- **`valueField` is what a `where` compares against**, so write the same value onto the rows you filter. `labelField` is what the reader sees, and falls back to the value. Both are top-level fields of the row: no paths, same rule as everywhere else.
- **The host fetches it for you.** `optionsFrom` is a binding, so the collection behind it is fetched with the panel's others. No `limit`, no `where`, no `allowActions` — an option presses nothing, and a filter over a filter's own options is a puzzle. You decide which rows are options by which rows you write.
- **Past eight options the control draws as a menu**, on every surface: a dropdown on desktop and the web, a `Menu` on iOS, one line with `←→` in the TUI. You cannot ask for that and you cannot refuse it — the count is the reader's workspace, not your schema.
- **A control bound to a collection signs its BINDING, not its options.** A project created in another window, or a second page of rows landing, does not reset the reader's filter. Pointing the control at a different collection does. If the selected value stops being an option, it falls back to the unset "All" — the same fine reconciliation a literal control gets.
- **50 is the ceiling** on resolved options. Past that, filter the collection you write rather than the one you read.

### A batch, not eleven presses

A reader who wants eleven lanes should not press eleven rows. Declare `selectable` on the list and it grows a tick on every keyed row, plus a bar that appears once anything is ticked:

```json
{ "component": "list",
  "bind": { "collection": "issues", "allowActions": ["open-issue"] },
  "selectable": {
    "stateKey": "issueBatch",
    "actions": [
      { "action": "launch-lanes", "label": "Create lanes", "kind": "primary",
        "confirm": "Create a lane for each selected issue?" },
      { "action": "archive-issues", "label": "Archive" }
    ]
  },
  "emptyText": "No issues match this filter." }
```

Your handler is invoked once, with the ticked rows:

```js
sdk.actions.register("launch-lanes", async ({ selection, state, context }) => {
  for (const issueId of selection ?? []) { /* one lane per issue */ }
  return { message: `Created ${selection.length} lanes.`, resetState: true };
});
```

- **`args.selection` is an array of row keys**, injected by the host and injected last, so a schema naming `selection` cannot replace what the reader ticked. It is the one array in an args object that is otherwise flat scalars, and it is not a hole in rule 3: nothing computed it, and every key in it is one you wrote.
- **A row needs a `key` to be tickable.** A declared row writes one; a bound row inherits its collection row's own primary key, so a list you already publish becomes selectable for free. A row without one still renders and simply has no tick — a title is not an identity, and two issues can share one.
- **The batch is what the reader can SEE.** Tick four rows, move a filter that hides two, press the button: the two on screen are the batch. The other two keep their ticks and come back when the filter does. Acting on a row nobody can see is the one outcome a selection must never produce.
- **`confirm` works on a bulk verb exactly as on a row**, and matters more — a mistake here costs eleven lanes.
- **Answer with `{resetState: true}`** when you have acted on the whole batch. The same verb that puts the reader back on "All" empties the ticks, because leaving them offers to do it again to rows that have moved on.
- **Ceilings.** 100 rows ticked at once (raise nothing; that is `maxListItems`), 4 bulk actions, and 2 selectable lists in one panel. At the cap a further tick is refused rather than quietly evicting an earlier one. A `selectable` naming no usable action is dropped whole — a tick the reader cannot spend is a checkbox over an empty bar.

Per-client: desktop and the web draw a checkbox, with **shift-click extending from the last row you ticked**. iOS and the TUI have no shift, so both toggle one row at a time — the gesture degrades, the batch does not.

### Seven groups, no state keys

An issue browser has seven state groups in a fixed order, each one collapsible. Built out of `segmented` controls that was seven booleans against a ceiling of eight, and a filter strip nobody would want to look at. **`group`** is a titled section with a disclosure:

```json
{ "component": "group", "title": "In Progress", "groupKey": "started", "badge": 4,
  "children": [{ "component": "list", "bind": { "collection": "issues", "keyPrefix": "started:" } }] }
```

- **Open/closed is client-local and is not panel state.** It never signs, never reaches a `where`, never rides on an action, and never reaches your plugin. Collapsing a section says something about the reader's screen, not about which rows the panel is showing — which is exactly what makes a group free: declare as many as your node budget allows without spending a state key on any of them.
- **`groupKey` is its identity across a re-publish**, falling back to the title. A section the reader closed stays closed when you republish with one more group above it.
- **A folded section is still declared.** Its `segmented` controls still own their keys, and its bindings are still fetched — the panel is read off the schema, not off what a client chose to draw. Only the drawing is skipped, and it is skipped properly: a closed section's images do not load and its rows do not lay out.
- **Children count against `maxNodes` and `maxDepth`** like any other nodes. A group is cheap to draw, never cheap to declare.

### A panel that fetches

A panel bound to your own `plugin_collections` is already live: you write rows, the host publishes a change, and every client refetches. A panel whose rows come from somewhere else — an API you poll — has no such signal, and a reader looking at stale rows has no way to ask for new ones.

Declare `refreshAction` on the panel and each client grows the refresh gesture it actually has:

```json
{ "panels": [{ "id": "fleet", "schemaFile": "panels/fleet.json", "refreshAction": "refresh-fleet" }] }
```

- **Desktop and web** — a Refresh button above the panel.
- **iOS** — pull-to-refresh on the pane.
- **TUI** — `r` dispatches it before it refetches, instead of only refetching.

The action runs first, then the client refetches, so the gesture means "go and get new data". A refresh that fails still refetches and says why. Declare nothing and nothing changes anywhere — no button, no pull, and `r` stays the plain refetch it always was. The action id must be one your manifest declares; a value the host does not recognise costs the gesture, not the panel, and a schema you republish cannot mint one.

A refresh handler is invoked like any other panel action — one args object, carrying the panel's current selections under `state` and its render context under `context`. Read the state rather than a variable you kept from the last press: the reader may have moved a `segmented` since, and refreshing the feed they are no longer looking at is the bug this sentence exists to prevent.

### Per-surface support

| Component | Desktop / web | iOS | `ade code` TUI |
|---|---|---|---|
| `stack`, `text`, `badge`, `button`, `list`, `table`, `keyValue`, `divider`, `emptyState` | full | full | full |
| `segmented` | full | full | full (numbered options; ←→ cycles) |
| `segmented` with `optionsFrom` past 8 options | dropdown | `Menu` | one line naming the choice; ←→ cycles |
| `group` | full | full | full (`▾`/`▸` header; Enter folds) |
| `list` with `selectable` | checkbox per row; **shift-click extends** | tap target per row; no range | `[x]`/`[ ]` per row; no range |
| `markdown` | full (headings, emphasis, code, links, lists, quotes) | native attributed text, same subset | styled text; links shown as text + url |
| `form` | full | full | full (via the composer prompt line) |
| `video`, `image` | full | full | named placeholder; `Ctrl+Y` copies a link to the panel |
| `chart` | full | named marker | named placeholder |
| anything a later vocabulary version adds | inline "not supported here" marker | marker | placeholder |

Two consequences worth designing around: **put a `deeplink` in every `fallback`** so a surface that cannot draw the body still gets the user somewhere, and **do not make a chart the only content of a panel** — half your surfaces will show a marker where the point of the panel was.

### Degradation ladder

- **Panel-fatal** — bad JSON, unsupported `v`, missing `fallback`, over a size/node/depth ceiling → the client renders the fallback card.
- **Node-local** — a malformed known component or binding → that node becomes an inline error marker, the rest of the panel renders.
- **Unknown component** — a name this build never heard of → a marker naming it. This is the forward-compat path, and a warning rather than an error.

### Vocabulary limits

`maxNodes` 200 · `maxDepth` 8 · `maxSchemaBytes` 65,536 · `maxSelectOptions` 40 · `maxTableRows` 100 · `maxTableColumns` 8 · `maxListItems` 100 · `maxKeyValueRows` 60 · `maxChartSeries` 3 · `maxChartPoints` 200 · `maxFormFields` 24 · `maxTextChars` 4,000 · `maxLabelChars` 200 · `maxValueChars` 1,000 · `maxSrcChars` 8,192 · `maxBindingAllowActions` 16 · `maxStateKeys` 8 · `maxStateOptions` 8 · `maxBoundStateOptions` 50 · `maxSelectionKeys` 2 · `maxSelectedRows` 100 · `maxBulkActions` 4 · `maxWhereClauses` 4 · `maxWhereDepth` 3 · `maxWhereNodes` 24 · `maxWhereValues` 20 · `maxMarkdownChars` 4,000 · `maxMarkdownBlocks` 100 · `maxMarkdownDepth` 3 · `maxMarkdownSpans` 200.

These are part of the contract, not a client's private defence — a schema over any of them is invalid everywhere, identically.

### Context, navigation, and links to a panel

A panel can arrive carrying a small object — the *context*. It gets there two ways: a `plugin` deeplink's `?ctx=`, or an action that asked the client to go there. Two things then read it:

- **The schema**, through the reserved binding `{"collection": "$context"}` — one row per top-level key, in declaration order. A real collection can never be called `$context`, so nothing shadows it. This is the only way to put a value the panel was opened with into the panel's own text, and it is a binding rather than an expression on purpose.
- **Every action that panel dispatches**, which carries the same object along.

An action asks for navigation by returning it:

```js
exports.actions = {
  async file(args) {
    const id = await createIssue(args);
    return { navigate: { panelId: "detail", context: { issue: id } } };
  },
};
```

`panelId` must be a panel of the same plugin — anything else is ignored, and a return value with no `navigate` key behaves exactly as before. The context is capped at **2 KiB**; over the cap the navigation still happens and the context is dropped, so keep it a pointer ("the issue is ISS-14") and read the rest from your own collections.

### What else an action may answer with

Beside `{navigate}`, `{composer}`, `{dialog}` and `{openWebview}`, an action's return value may carry:

| Key | What it does |
|---|---|
| `openUrl` | Sends the reader to the open web. `{openUrl: "https://…"}` or `{openUrl: {url: "https://…"}}`. **`https:` only**, max 2,048 chars: `http:`, `file:`, `data:`, `javascript:` and `ade:` are all refused, and `ade:` because in-app destinations are what `navigate` and `fallback.deeplink` are for. Opens in the system browser on desktop, a new tab on the web, Safari on iOS; the TUI opens it through the same path a PR link uses and prints it when it has no opener. |
| `message` | One sentence about how it went, max 400 chars. Every client shows it: a banner under the panel on desktop, web and iOS, a notice in the TUI. Write it once and all four say it. `ok: false` beside it colours the banner as a failure. |
| `prompt` | Asks the reader one line of text and calls your action AGAIN with the answer. See *Asking for a line of text* below. |

All three are read tolerantly: a result carrying none of them behaves exactly as before, and a refused `openUrl` is logged rather than passed on silently.

### Asking for a line of text

A button that needs one short answer — "what are you working on?", "name this bookmark" — answers with `{prompt}` instead of finishing:

```js
exports.actions = {
  async logIt(args) {
    // First press: no answer yet, so ask.
    if (!args.prompt) {
      return { prompt: {
        id: "note",
        title: "What are you working on?",
        placeholder: "One line",
        submitLabel: "Log",
        // Optional pointer, handed straight back to you on the second pass.
        context: { sessionId: args.context?.id ?? null },
      } };
    }
    // Second press: the client re-invoked ME with what the reader typed.
    const text = args.prompt.text.trim();
    if (!text) return { message: "Nothing to log." };
    await ade.collections.put("notes", `note:${Date.now()}`, {
      title: text,
      at: new Date().toISOString(),
      lane: args.prompt.context?.sessionId ?? null,
    });
    return { message: "Logged." };
  },
};
```

The rules, and they are the same on all four clients:

- **The same action is invoked again**, with the same arguments plus `args.prompt = {id, text}` — plus `context` verbatim when the prompt carried one. Branch on `args.prompt` being present; that is the whole protocol.
- **`id` is required** and is shaped like every other plugin identifier. It rides back in the answer, so one handler can ask two different questions and tell them apart without keeping state between the two invocations.
- **Cancel invokes nothing at all.** Not a second call with an empty answer — nothing. An empty *submitted* answer is a real answer and does reach you as `text: ""`, so decide what an empty line means.
- **One hop.** A prompt returned by the re-invocation is dropped by every client. This is not a wizard: a plugin that needs a second field has a panel `form`, and one that could re-ask forever would trap the reader.
- **The answer is capped at 4 KiB** and is REFUSED past it, never truncated. Half a note saved is worse than one the reader was asked to shorten.
- `title` falls back to the word on the control that was pressed, `submitLabel` to the client's own default, and copy over its ceiling (120 / 120 / 24 characters) is dropped while the question is still asked.

Where it draws: a popover at the control on desktop and web, an alert with a text field on iOS, an inline field in the terminal. So it is `{navigate}`-to-a-form that you no longer need for a one-line capture, which is what the whole "quick capture" plugin category is made of.

The same destination has a link:

```bash
ade link plugin graph detail --ctx '{"issue":"ISS-14"}' --ade
# ade://plugin/graph/detail?ctx=…   (drop --ade for the https://ade-app.dev/open form)
```

The link opens the panel on a machine where the plugin is installed and enabled, and says so plainly on one where it is not — plugins are per-machine, so a link one person mints is routinely a link another cannot open. A malformed or oversized `ctx` on the way in is dropped and the panel still opens; `--ctx` on the way out refuses rather than minting a link quietly missing what you asked for. In the TUI, `Ctrl+Y` copies a link to the panel you have open.

## Custom UI (webview)

A `webview` surface renders the plugin's **own HTML page** instead of a panel schema. It is the one place a plugin ships UI code, and the price is fixed: the page draws on the desktop and nowhere else. iOS, the web client, and the TUI render the surface's `panelId` panel in its place — which is why `panelId` is required on a webview surface rather than optional.

### When to choose it — and when not to

The vocabulary's ceiling is the sixteen components above, arranged in stacks. Rows, tables, key/value pairs, forms, a line or bar chart, an image, a video. No expressions, no conditionals, no custom layout, no pointer events of your own, no canvas, no drag.

Choose a webview when what you need to draw is genuinely past that line — a graph someone pans, a diagram editor, a timeline with blocks people drag. Do not choose it to skip learning the vocabulary: everything you build in a page is invisible on three of ADE's four clients, and you will have written the panel anyway.

A rule of thumb that decides most cases: **if it is rows of things with buttons on them, it is a panel; if it is a drawing surface, it is a page.**

### Scaffold

`ade plugin create` scaffolds a tab, so add the surface by hand:

```json
{
  "surfaces": [{ "kind": "webview", "id": "board", "title": "Board",
                 "entryHtml": "web/index.html", "panelId": "board" }],
  "panels":   [{ "id": "board", "schemaFile": "panels/board.json", "title": "Board" }]
}
```

`entryHtml` is a relative path inside the plugin, free of `..`, ending in `.html` (or `.htm`). The page and everything it loads are served from `ade-plugin://<pluginId>/…`, which maps to the install directory and nothing above it. A request ending in `/` resolves to `index.html`; a directory itself is a 404, never a listing.

`web/index.html` — note there is no inline `<script>`, because there cannot be one:

```html
<!doctype html>
<meta charset="utf-8" />
<title>Board</title>
<link rel="stylesheet" href="./board.css" />
<div id="root">Loading…</div>
<script src="./board.js"></script>
```

`web/board.js`:

```js
const root = document.getElementById("root");

async function render() {
  const rows = await window.adePlugin.collections.list("cards", { limit: 100 });
  root.textContent = `${rows.length} cards`;
}

window.adePlugin.events.on("changed", () => void render());
void render();
```

Ship plain `.js` and `.css`. Content types come from a closed map — `.js`, `.mjs`, `.css`, `.json`, `.svg`, the usual images and fonts, `.mp4`, `.webm`, `.txt` — and anything else is served as `application/octet-stream` with `nosniff`, so a `.ts` or `.jsx` file will not execute.

### The bridge

`window.adePlugin` is the whole API. Every method is async and rejects with an ordinary `Error` carrying the host's own message; there is no error class to catch, so the code rides in the text.

| Call | Contract |
|---|---|
| `adePlugin.version` | Bridge version of the host that attached the page. **1** today. Additive like the SDK — check it before calling anything newer |
| `adePlugin.pluginId` | The page's own plugin id, from the host. Informational; nothing on the wire carries it |
| `adePlugin.context` | The subject the host attached this page to, or `null`. `{subject, pointer?}` — see *Where a page can appear* |
| `collections.get(collection, key)` | One value, or `null` |
| `collections.put(collection, key, value)` | Write one value — see the note below before relying on it |
| `collections.list(collection, {keyPrefix?, limit?})` | `{key, value}` rows, at most 500 |
| `invoke(action, args?)` | Call one of the plugin's own action handlers. Needs an `entry` — a page-only plugin has nothing to invoke |
| `config.get()` | Current values for `manifest.settings`, defaults applied |
| `config.set(key, value)` / `set({key: value, …})` | Write your own settings from the page — a settings page that could only read was the reason this exists. Same rules as the child's `ade.config.set`: undeclared key, wrong kind and an off-list `select` value are refused, a `secret` setting is refused and belongs in `ade.secrets` (which a page cannot reach at all), and `null` resets to the manifest default. Resolves the new effective config; does not restart the plugin |
| `events.on("changed", cb)` | Fires when this plugin's data moves. Returns an unsubscribe function; payload is `{kind, panelId?, collection?}`. Refetch on a `kind` you do not recognize |
| `openDeeplink(url)` | An `ade://` link opens in ADE; an `https:` link goes to the user's real browser. Nothing else is accepted |

The plugin id is never sent by the page: the host derives it from the guest's own origin and answers every call against that. Collections still have to be declared in `plugin.json` — an undeclared name is refused, not created.

Deliberately missing, and not stubbed:

| Absent | Why |
|---|---|
| `secrets` | A page is the last place a plugin's credentials should be readable, and the first place an injected script would look. Read secrets in your child process and hand the page the *result* |
| `contributions.publish`, `panels.update` | A page draws itself. Publishing into ADE's other surfaces stays the child process's job |
| `collections.delete` | Destructive, and not needed to build a UI |
| Raw IPC, `require`, `window.ade` | There is no such object in the page |

**Writing from a page is conditional.** `collections.put` needs the plugin host in the same process, and on the desktop app the host lives in the daemon — so a page's write is refused with `plugins_unavailable` ("This page can't save data on this computer.") while reads and `invoke` route through to the project's runtime and work normally. Write through your own handler instead: `await adePlugin.invoke("save", {…})`, and let the child call `ade.collections.put`.

### The sandbox, plainly

- The page gets **its own origin**, `ade-plugin://<pluginId>`, one per plugin, so the browser's same-origin rules do the isolating.
- **Only files inside the plugin's install directory are served.** A path that escapes it — `..`, an absolute path, a symlink pointing out — is refused. An uninstalled or disabled plugin has no origin at all, so disabling a plugin closes its pages.
- **No Node, no `require`, no `window.ade`, no raw IPC.**
- **Scripts and styles must ship with the plugin** (`script-src 'self'`). No CDN, no inline `<script>`, no `onclick=` attributes, no `eval`. A library you want, you vendor. Inline `style=` and `<style>` are fine.
- **Images and media may come from `https:`**, and the page may call `https:` services. Plain `http:` cannot be fetched.
- **The session is per-plugin and throwaway.** Cookies, `localStorage`, and caches die with the window. Put state in collections, where it is budgeted and the user can see it in the usage meter.
- **The page cannot leave its own origin.** A link to a site opens in the user's real browser; a new window is denied; forms cannot post anywhere; the page cannot be framed.

### The dev loop

```bash
ade plugin install ~/plugins/board   # once
ade plugin dev board                 # watch + reload on every save
```

`ade plugin dev` reloads the plugin on every save — it re-copies a `local` source over the installed copy, re-reads the manifest and restarts the child. Page files are read off disk when the guest asks for them, so re-opening the surface picks up your edits. `ade plugin logs board --text` is still where the child's log lines are; `ade.log` from the child, not `console.log` from the page, is what lands there.

### How it sits next to panels

- Write the surface's panel as the honest small version of the page, and give its `fallback` a `deeplink` — that panel is what three of four clients show.
- `$context` and `{navigate:{…}}` belong to panels; a page navigates itself. To send the user to one of your panels from a page, call `adePlugin.openDeeplink("ade://plugin/<pluginId>/<panelId>?ctx=…")`.

### Where a page can appear

A `webview` surface is not only a whole tab or pane. The same page — the same `entryHtml`, served the same way, in the same sandbox — can also mount in two tighter places on the desktop. Each is single-instance, fills its container, and loads nothing until it is shown. **All three are desktop-only, and every other client renders the surface's `panelId` panel in its place**, exactly as a webview tab does.

1. **A drawer tab.** Declare a `drawer-tab` socket whose `panelId` matches a `webview` surface's `panelId`, and the chat actions drawer draws your page as that tab's body instead of the panel. No new field — the match on `panelId` is the link, and the panel the surface already names is the phone's fallback.

   ```json
   {
     "surfaces": [{ "kind": "webview", "id": "mixer", "title": "Mixer",
                    "entryHtml": "web/mixer.html", "panelId": "mixer" }],
     "sockets":  [{ "socket": "drawer-tab", "surface": "work", "id": "mixer-tab",
                    "label": "Mixer", "panelId": "mixer" }]
   }
   ```

   The drawer's page reads `adePlugin.context.subject` — a `{kind:"session", …}` for the chat the drawer sits on. (A `work-rail-pane` socket linked to a `webview` surface the same way draws the page in the Work tools rail — same mechanism, same fallback.)

2. **A focused overlay from any button.** Return `{openWebview: {surfaceId, context?}}` from any button action — `toolbar-action`, `composer-action`, `chat-header-action`, `row-menu-item` — and ADE opens that `webview` surface (named by its `surfaces[].id`) as a dismissible full-screen overlay. `context` is an optional small pointer of your own.

   ```js
   // in your plugin's action handler
   actions: {
     openMixer: () => ({ openWebview: { surfaceId: "mixer", context: { drink: 4 } } }),
   }
   ```

**The host owns `subject`; you own `pointer`.** `adePlugin.context.subject` is the chat/lane/PR the drawer sat on or the button was pressed on — set by ADE from what it already knows, captured before your page runs, and **not something the page can forge** (rewriting your own URL does not change it). `adePlugin.context.pointer` is the optional object your `openWebview` verb passed — a hint, authored by you. Read the subject to know *what you are attached to*; never trust a page's claim about its own subject, because that is not what `subject` is.

## Sockets — appearing on core surfaces

Eight surfaces: the six list-shaped tabs — `work`, `lanes`, `files`, `prs`, `automations`, `cto` — plus `app` (the window chrome: the top bar's trailing cluster, the ⌘K palette and the activity pane) and `settings` (settings pages). Seventeen socket kinds. Both sets are closed — a plugin fills a slot, it never invents one. Placement is **host-controlled and always after core content** — a contribution never reorders, replaces, or interleaves with the product's own rows. `order` sorts plugins against each other and nothing more.

| Socket kind | Surface | Payload | What it draws |
|---|---|---|---|
| `toolbar-action` | any | `{label, actionId, icon?, disabled?, menu?, color?}` | A button in a surface's toolbar |
| `row-badge` | any | `{text, tone, icon?, tooltip?}` | A badge on the row you published it for. The manifest declaration reserves the slot and draws nothing — see *A declared badge marks no rows* |
| `row-menu-item` | any | `{label, actionId, icon?, danger?}` | An entry in a row's context menu |
| `detail-section` | any | `{panelId, title?}` | A panel rendered as a section in a detail view |
| `empty-state` | any | `{title, body?, actionId?, actionLabel?}` | Extra content on a surface's empty state |
| `filter-chip` | any | `{label, filterKey, count?}` | A chip in a surface's filter row |
| `file-viewer` | `files` | `{panelId, extensions[]}` | A viewer for matching files in the Files tab |
| `composer-action` | `work` | `{label, actionId, icon?, disabled?, menu?, color?}` | A button in the chat composer's accessory row. May run for minutes — see *Long-running actions* |
| `chat-header-action` | `work` | `{label, actionId, icon?, disabled?, menu?, color?}` | A button in the chat's header. Receives the **session**, not the surface — see below |
| `chat-card` | `work` | `{panelId, title?, icon?}` | **Permission** to draw that panel in a transcript. It draws NOTHING on its own — the card is placed by `chat.emitAdeCard`. See *A card in the transcript* |
| `slash-command` | `work` | `{command, actionId, description?, argumentHint?, icon?}` | A command the user types into the composer. Same long budget as `composer-action` |
| `command-palette-action` | `app` | `{label, actionId, icon?, disabled?}` | An entry in the ⌘K palette. Its action also receives `args.subject` — what the reader was looking at |
| `settings-section` | `settings` | `{panelId, title?, section?}` | Your panel as a section on a settings page. `section` names the page and is optional |
| `work-rail-pane` | `work` | `{label, panelId, icon?}` | A pane in the Work tools rail, beside Terminal / Git / Files |
| `drawer-tab` | `work` | `{label, panelId, icon?}` | A tab in the chat actions drawer, beside Sources / Agents / Proof |
| `activity-entry` | `app` | `{title, tone, body?, actionId?, actionLabel?}` | A row in the activity pane |
| `dialog-section` | `lanes`, `prs` | `{dialog, panelId, title?}` | Your panel as a section inside Create lane / Manage lane / Create PR — see *Writing into a dialog* |

### The three button kinds, and the split button

`toolbar-action`, `composer-action` and `chat-header-action` are **one contribution wearing three chromes** — a labelled button that invokes an action — and they share a payload type. What separates them is the CONTEXT their handler receives, which is the whole reason they are three kinds rather than a field:

| Kind | Sits | Receives |
|---|---|---|
| `toolbar-action` | A surface's toolbar — or, on the `app` surface, the window's top bar | `surface` — the tab (or `{surface: "app"}` for the top bar), no per-entity subject |
| `composer-action` | The composer's accessory row | `composer` — session, project, lane, the live `draft`, the caret |
| `chat-header-action` | The chat's header | `session` — the conversation it sits above |

A plugin that wants to act on *this conversation* cannot do it from `toolbar-action` without the host guessing which chat was meant.

#### What a click does

Read this before you build a chat button around a panel. The commonest wrong model — and the one the Hacker News dogfood run shipped — is that declaring a button next to a chat is how you put a panel next to a chat. It is not.

| You declare | What the click does | What appears where the button is |
|---|---|---|
| `chat-header-action` | Invokes `actionId` with the `session` context | **Nothing.** The button shows a busy tint while the handler runs, and that is all it draws |
| `composer-action` | Invokes `actionId` with the `composer` context | **Nothing.** Same busy tint |
| `work-rail-pane` | Nothing — it is not a button | Your panel, as a pane in the Work tools rail, when the reader selects it |
| `tab` surface | Nothing — it is not a button | Your panel, as a full page in the rail |

So a button that is *meant* to show something has to say where it went:

- Return **`{navigate: {panelId}}`** and the client opens that panel. Where it opens is the client's decision, and on desktop it depends on what else you declared: a press from a chat opens your **Work tools pane** if you have declared a `work-rail-pane` for that panel — the reader keeps the conversation — and otherwise opens your **tab**, which takes them off it. iOS presents the plugin pane sheet; `ade code` loads its plugin pane. **Declare the pane if the panel belongs beside the chat.** Without it there is no beside-the-chat to open into, and the same one-line handler behaves differently.
- Return nothing and say it in **`{message}`** if the answer is one sentence. A banner under the panel, a notice in the TUI — every client shows it, and it costs no panel at all.

`{navigate}` takes an optional **`target`**: `"tools-pane"` or `"tab"`. Send neither. The default is the client's, and a client that has no tools rail — every client except the desktop — ignores whichever you name. Reach for it only when the panel is genuinely too large for a rail (`"tab"`) or must never take the window (`"tools-pane"`).

A navigation that cannot land now **says so** rather than doing nothing: an unknown `panelId`, an uninstalled plugin or one the reader switched off raises a toast naming the panel. If your button appears to do nothing and no toast appears, the handler returned no `navigate` at all.

Declare it on `work`. One declaration mounts on the header **every work surface shares** — an existing conversation, a fresh pane once it has a chat, a CLI session terminal, and every Work grid tile, since a tile renders those same surfaces inside a floating pane. That is deliberate: the retrospective's plugin appeared only in a fresh pane and not in the chat the user was already having, which read as the contribution being absent entirely.

**It is filed per session, not per surface: published per chat, declared once.** A published row is addressed at one conversation (`entityKind: "session"`); a manifest declaration is a wildcard that applies to every chat. Exactly like `composer-action`. A row published against the Work *surface* never appears in any chat header at all.

The call site reads misleadingly — `useSurfaceContributions("work", "chat-header-action", { context: session })` — because `surface` only selects which contribution *set* to load, and the selector then narrows it by the context's entity. Two people have now misread that as surface-scoping, so the behaviour is pinned by a test on both desktop and iOS rather than left to a careful reading.

**Any of the three may be a split button**, by carrying `menu`:

```json
{ "socket": "chat-header-action", "surface": "work", "id": "tipsy",
  "label": "Take a drink", "icon": "chat", "actionId": "drink",
  "menu": [{ "label": "Sober up", "actionId": "soberUp" }] }
```

- Each entry is `{label, actionId, icon?, danger?}` — `label` capped at 40, `actionId` at 64, both required or that entry is skipped.
- **Six entries maximum.** Over-cap entries are **truncated, not dropped**, so a plugin that grew a seventh still renders its first six and its primary press. A plugin needing more than six related verbs wants a panel, where it owns the layout.
- `icon` is a token from the same 64-name list the button's own `icon` takes, and degrades the same way: an unknown token draws the puzzle piece on both clients. Absent means the puzzle piece too, so a two-entry menu that names no icons shows the same generic mark twice — name them.
- `danger` spends the product's destructive styling, and is honoured only alongside the plugin attribution the same menu draws.
- **The primary press is unchanged.** It still invokes `actionId`. Absent `menu` renders byte-identically to a button written before the field existed, so adding a dropdown to an existing plugin is additive and removing one is safe.
- **Degradation is per entry, and never costs you the button.** A malformed entry drops alone; a `menu` that is not an array, or one whose every entry is malformed, degrades to a plain button. The contribution itself is never dropped — which is why `menu` is an ordinary optional manifest field rather than a `manifestExtra`: a split button with a broken menu is still a perfectly good button.
- `command-palette-action` shares the same payload type and therefore *parses* `menu`, but the palette **ignores it** — a submenu inside a flat searchable list would hide entries from the search that is the palette's whole point. That is deliberate, not a bug to report.
- Declared menus **ride the sync wire**, so the web client and the phone receive a declared split button whole rather than half-rendering it.

One parser — the exported `parsePluginActionButtonMenu` — backs the manifest, the published payload and the renderer alike, so the six-entry cap and the label ceiling cannot drift between layers.

Two behaviours to design around, because neither is what an author would guess:

- **The two halves are one control, and they share a busy state.** The busy key is the *contribution*, not the individual action, so pressing "Sober up" from the dropdown lights the "Drink" button — and while it runs neither half will start a second invocation. A plugin author reading "menu items are separate actions" would reasonably expect separate busy states; they do not exist. Drive any start/stop pairing from your own state, exactly as with a plain long-running button.
- **In the "+N" overflow, the chevron goes away and the menu flattens.** A button that folded into the overflow cannot also open a dropdown, so its entries are drawn as **indented rows beneath their primary** inside the popover instead of vanishing at that width. Every action a plugin declared stays reachable at every window width. Same on all three button kinds — so do not design a menu whose entries only make sense next to a visible chevron.
- **On iOS a split button is a submenu, and its first row is your primary action.** Inside a menu there is no press-versus-chevron to split, so the button's own `actionId` has to be listed or it would be unreachable. Write a `label` that reads correctly both as a button and as the top row of its own menu — "Take a drink" works, "More…" does not.

On desktop the chevron and the button are drawn as **one joined control** — a shared outline, one hairline seam, no gap — because that is what they are: one contribution, one busy key, one primary press. Both halves light up together while an action runs.

### Tinting one button

`toolbar-action`, `composer-action` and `chat-header-action` take an optional `color`: a 3- or 6-digit hex that tints **that one button** — its label, its icon and a hairline border, over a faint fill of the same colour.

```json
{ "socket": "chat-header-action", "surface": "work", "id": "tipsy",
  "label": "Take a drink", "icon": "beer", "actionId": "drink",
  "color": "#7C6FF0" }
```

This is the narrow answer to "I want my button to look like mine". The wide one — a `theme` — recolours the whole application, and a plugin that only wanted its own button coloured should not have to repaint ADE to get it. `accent` in the manifest does not reach a socket at all; panel `tone` is a four-value enum and buttons never had one.

**The colour has to be legible in both themes, or it is refused.** The rule, and why it is a rule:

- The payload carries **one** colour and the **user** picks the theme. There is no per-theme form of this field, so the host cannot re-tint the way a theme plugin can — a colour that only works on dark is a button that is invisible for every user on light.
- So `color` must clear a **3:1 contrast ratio** (WCAG 2.1 SC 1.4.11, the non-text minimum) against **both** ADE backgrounds, dark and light. In practice that is a mid-tone band: near-white, near-black and the fully saturated primaries at the ends of it do not pass. `#7C6FF0` — ADE's own accent — does, and is the calibration to aim near.
- A refused colour is **dropped, never nudged**. The host does not darken your brand colour into range: it would paint something you never chose and never tell you, and your next hex would change nothing you could see. Instead the field goes missing and the button wears the platform's own tone — visibly not your colour, which is the signal that sends you back to this rule.
- **Expect a real brand colour to fail, and check yours before you ship it.** Nothing logs the refusal, `ade plugin doctor` does not report it, and the manifest still parses clean — the button simply is not your colour. A vivid brand orange like `#FF6600` fails on the light background; `#E65C00`, the same hue darkened, passes on both. The gate is `sanitizePluginActionColor`, and it is pure, so the cheapest check is to call it: pass your hex to it in a scratch test and assert it comes back non-null. Then pin the value with an assertion, or the next person to "restore the real brand colour" will land the failing hex without seeing anything go wrong.
- **A refused colour never costs you the button.** Same bargain as `menu`: the label and the primary press are what the user asked for. `sanitizePluginActionColor` in `sockets.ts` is the single gate, so a declared colour and a published one are judged identically, and a colour arriving over the sync wire is re-judged on arrival rather than trusted.
- Anything that is not plainly a hex colour is refused before contrast is even considered — no named colours, no `rgb()`, no `var(--…)`. A token value is text that ends up in a stylesheet, and this is the same lesson theme tokens already learned.
- **While an action runs, the platform takes the button back.** The busy state's own colour outranks yours for the duration, because "this is working" is a signal the user must be able to read on any plugin's button.

`command-palette-action` parses `color` — one arm, one ceiling — and the palette ignores it, exactly as it ignores `menu`.

**Every payload above may also carry three cross-kind fields**, whatever its own shape: `filterKey` tags the entity for a filter chip, `id` says which of your declarations the row fills, and `order` sorts the row among your own. All three are optional and none is listed per-kind in the table, because none belongs to a kind — they describe the ROW. `filterKey` and `id` are capped at 64 characters; `order` is any finite number. See *How a filter chip actually filters* and the `id` and `order` notes below.

**The panel kinds carry a panel id and nothing else.** `chat-card`, `settings-section`, `work-rail-pane`, `drawer-tab` and `dialog-section` all render the vocabulary, which is what makes them portable: a card built from a panel draws wherever panels draw, and one built from markup would have been desktop-only forever. Buttons inside them are the vocabulary's own `button` node dispatching your actions, so none of these kinds needs an action payload.

Two sources, deliberately different:

- **Static** contributions come from `manifest.sockets` — "this plugin has a toolbar button here".
- **Dynamic, per-entity** values come from `sdk.contributions.publish(...)` — "PR #1234 gets this badge, right now". The machine that owns the data computes them; other devices read the row.

A payload that fails validation renders nothing at all rather than a half-built row, so a missing `label` or `actionId` shows up as an absence, not as a blank button.

Entity kinds for `publish`: `lane`, `pr`, `session`, `file`, `automation`, `surface`. The three kinds that sit on the tab rather than on a row — `toolbar-action`, `empty-state`, `filter-chip` — plus `file-viewer` publish against `surface` with the surface's own name as the entity id.

**How a filter chip actually filters.** The chip itself is surface-scoped, but what it matches is the ENTITIES: put `filterKey` on any contribution you publish for an entity — a badge, a menu item, anything — and selecting your chip keeps the rows whose contributions carry that key. A chip whose key no published row carries filters everything out, which reads as a broken list, so publish the tags before you ship the chip.

**Put an `id` in the payload if you declare two sockets of the same kind on one surface.** A published row names your plugin, its entity and its socket KIND, and has no field for which of your declarations it fills — `id` is the only thing that says so. Without it the platform will not guess: the row resolves only when that kind was declared once, and otherwise **does not render at all**. An `id` naming a socket you no longer declare is stale, and that row drops too. One declaration of a kind needs nothing.

**When you do set `id`, it must name one of your declared socket ids.** It is routing input, not a label: an arbitrary value resolves to nothing, and on an older host that cannot resolve the join it can leave your unfilled declaration drawn as a neutral placeholder *beside* the row that was meant to fill it. If you want a per-row label, use the payload's own text fields.

**`order` sorts your own rows and works the same way** — put it on any contribution you publish, alongside `filterKey` and `id`. All three are cross-kind: they describe the ROW, not the socket kind, so every payload may carry them and none is listed per-kind in the table above. A row without `order` sorts after every row that has one.

Publish against an entity on the surface you declared the socket for. A row for an entity belonging to another surface is dropped on desktop and on the web, where the host joins per surface.

**One published value per kind, per entity.** A contribution row is keyed by `(entity kind, entity id, plugin, socket kind)`, so publishing a second row for the same entity and the same kind REPLACES the first. If you declare two same-kind sockets on one surface, only one of them can carry a per-entity value — `id` decides which — and the other shows its manifest declaration and nothing more. Declare two of a kind only when the second needs no published value; otherwise use one socket and vary its payload. A composer and a chat header both belong to their chat, so publish a `composer-action` or `chat-header-action` row against `session` to change what your button says for one conversation. Row badges cap at **2 visible** per row with the rest behind a "+N", and composer buttons do the same in the accessory row; a single plugin may place at most **8** contributions in one socket slot.

Your action receives a typed, read-only context object — a projection, not a handle.

**Read this before the table.** The table below lists the fields that sit **directly on the context object**. The row named `session` is the context's own `kind`, not a key holding the fields — there is no `.session`, no `.lane`, no `.pr` inside it. Here is the literal `args` object a `chat-header-action` handler is called with:

```js
// exports.actions.drink = async (args) => { ... }
{
  context: {
    kind: "session",                                // which row of the table below
    id: "e755df3f-5d72-4af7-87ba-c842ca8bd37c",
    title: "Fix the flaky lane test",
    provider: "claude",
    status: "idle"
  }
}
```

So it is `args.context.id`. `args.context.session.id` is `undefined`, and a handler that reads it fails **silently** — it returns without writing anything, no toast, no log line, nothing on screen. That exact misreading of this table cost the round-2 alpha author most of a session. Every kind follows the same shape: a `lane` context is `{kind: "lane", id, name, branch, machineKey, dirty}` on `args.context`, and so on down the table.

| Context | Fields, directly on `args.context` |
|---|---|
| `pr` | `number`, `title`, `branch`, `state` (`open`\|`closed`\|`merged`\|`draft`\|`unknown`), `ciStatus` (`passing`\|`failing`\|`pending`\|`none`\|`unknown`) |
| `lane` | `id`, `name`, `branch`, `machineKey`, `dirty` |
| `session` | `id`, `title`, `provider`, `status` (for `chat-header-action`, and for row-shaped kinds on a chat) |
| `file` | `path`, `size`, `extension`, `workspaceId` |
| `automation` | `id`, `name`, `enabled` |
| `composer` | `sessionId`, `projectKey`, `projectRoot`, `laneId`, `draft`, `cursor` (for `composer-action` and `slash-command`) |
| `dialog` | `dialog` (`create-lane`\|`manage-lane`\|`create-pr`), `laneId`, `laneName`, `branch`, `projectKey`. `laneId` is null on create-lane, where nothing exists yet |
| `activity` | `entryId` — the row of yours that was pressed — plus `projectKey`, `laneId` |
| `surface` | `surface` (for toolbar actions, empty states, chips, palette entries, settings sections — no per-entity subject) |

You cannot reach the lane's worktree, the PR's token, or the session's transcript from a context. Widening one is a platform change, not something a plugin arranges.

**The `composer` context is the exception, and deliberately so.** `draft` is the user's full unsent prompt, verbatim, and `cursor` is where their caret sits in it — a button that rewrites, translates, or expands a prompt cannot do its job from a session id, and one that asked the user to paste their draft somewhere else would not be a composer button. Installing a plugin grants it, the same grant that already lets the plugin's child process read any file the user can. `sessionId` is null on a composer that has not started a chat yet (the hero composer, a fresh Work pane), and `cursor` is null when the composer holds no live caret — append, in that case. The draft is read when the button is PRESSED, not when it rendered, so what you receive is the text on screen at that moment.

### A card in the transcript

**A `chat-card` socket is a permission, not a card.** Declaring it and publishing the contribution draws nothing at all, forever, with no error anywhere: the manifest parses, `ade plugin doctor` reports `✓ Places … chat-card in work`, and the contribution row is really in the database. That combination — green at every checkable layer, invisible to the user — is exactly the failure this document exists to prevent, so read the two halves carefully:

- **The socket supplies permission.** A transcript is ADE's own conversation, and a plugin may only draw a panel there that it DECLARED as a `chat-card` naming that `panelId`.
- **The emit supplies chronology.** A transcript row has a position in a conversation; a contribution row does not. So you PLACE each card by emitting an `ade_card`:

```js
await ade.actions.invoke("chat", "emitAdeCard", {
  sessionId,                       // the chat the card belongs in
  card: {
    cardId: `standup-${today}`,    // identity: re-emitting merges into that row
    variant: "journal_standup",    // your own word; see below
    state: "terminal",             // "live" while the work is still running
    title: "Standup",
    fallbackText: "Standup — 4 notes today",   // REQUIRED; what a client that
                                               // does not know the variant draws
    panel: { panelId: "standup" },             // must match your declared socket
  },
});
```

- `cardId` is identity, not content: emit it again with the same id and the row you already placed updates in place, rather than a second card stacking under the first. Mint one per thing (`standup-2026-08-30`), never one per press.
- `variant` is an open string, and no client knows yours. Name it after the thing (`journal_standup`), and expect every client to take the unknown-variant path.
- **The panel is what buys you a card. Without one you get `fallbackText` and nothing else.** This is the rule to plan around, because it is not obvious: a variant no client knows degrades to one line of `fallbackText`, and the exemption that restores the full frame — `title`, `subtitle`, `rows`, `metrics`, the byline — is a DECLARED panel. So the natural first implementation, title plus subtitle plus `rows` with no panel, renders as one grey line on every client. Add the panel, or put the answer in `fallbackText`.
- With a panel, `rows` and the panel's `$context` both draw. They did not always: a card whose payload carried both rendered neither, so `title`, `subtitle` and `fallbackText` were the only per-card content a plugin could show. If you are reading a card that behaves that way, you are on a build from before ADE 1.2.66.
- `fallbackText` is required and is what a client draws when it cannot draw the panel. Write it as a whole sentence, never a label.
- `panel.panelId` must name a panel your manifest declares AND a `chat-card` socket must name it. Miss either and the card still draws — as an ordinary card with its title and fallback text — but your panel does not.
- `authoredBy` is stamped by the host from the invoking plugin. You cannot set it, and you cannot emit a card attributed to anyone else. The byline draws your manifest `icon`, so name one: an unknown token, or none, is what the puzzle piece means.
- **A card is a snapshot, not a live view.** The card's own `title`, `subtitle`, `rows` and `metrics` are the words you emitted, and they stay those words: fix a bug that put a wrong lane name in a subtitle and the row already in the transcript still says the wrong name, because a chronological row records what was true when it was written. Only the PANEL follows your data — it re-reads its collections whenever they change, with no new emit. Put anything that must stay current in the panel, and re-emit the same `cardId` when you want the card's own text to change.

### A declared badge marks no rows

`row-badge` is the one socket kind whose manifest declaration draws nothing. A badge is a per-entity VALUE — "this lane has 3 notes" — and a declaration has no entity, so drawing its manifest `label` put the same chip on every row of the surface, forever, until something replaced it. Authors were choosing a label that read acceptably as an empty state (one shipped `"0"`, which is a `0` chip on every lane in the app) because there was no way to say "draw nothing yet".

So: **declare the badge, then publish a row for each entity that deserves one.** The declaration still does real work — it is what the install sheet describes, what `id` matches a published row against when you declare the kind twice, and what carries your `order` — it just reserves the slot instead of filling it. Every other kind is unchanged: a declared `row-menu-item` is still on every row, because a menu item is a verb rather than a value.

```js
await ade.contributions.publish("lane", lane.id, "row-badge", {
  text: `${count}`,
  tone: count > 0 ? "accent" : "neutral",
  id: "notes",   // WHICH declaration this fills, when you declare the kind twice
});
```

To take a badge back off a row, publish `null` for it. Do that rather than leaving a stale count on screen — a badge nobody updated is a wrong badge, and a reader cannot tell the difference.

### What a palette entry is looking at

A `command-palette-action` fires from ⌘K, which belongs to the window rather than to a row, so its `context` is `{kind: "surface", surface: "app"}` and always will be — that context is what selects which entries the palette shows.

What the handler also receives is **`args.subject`**: what the reader was looking at when they chose the row.

| `args.subject.kind` | Fields | When |
|---|---|---|
| `"session"` | `id`, `title`, `provider`, `status` | A chat is open and focused |
| `"lane"` | `id`, `name`, `branch`, `machineKey`, `dirty` | No chat focused, but a lane is selected |
| `"none"` | — | Neither. The palette over the Files tab, or over no project |

They are the same projections every other socket hands out, so a palette entry reads a session exactly as a chat header action does. **`"none"` is a real answer and the honest one** — say "open a chat first" rather than acting on a guess. Read the subject, never the last `turn.start` you happened to see.

### Per-surface socket support

| Socket | Desktop | Web | iOS | TUI |
|---|---|---|---|---|
| `toolbar-action` | yes | yes | yes | yes |
| `row-badge`, `row-menu-item` | yes | yes | yes | yes |
| `detail-section`, `empty-state`, `filter-chip`, `file-viewer`, `composer-action` | yes | yes | yes | no |
| `chat-card`, `activity-entry` | yes | yes | yes | no |
| `chat-header-action` | yes | yes | yes — as a row in the chat's overflow menu, not a header button | no |
| `slash-command`, `command-palette-action`, `settings-section`, `work-rail-pane`, `drawer-tab`, `dialog-section` | yes | yes | no — dropped where the row decodes, so it is simply absent | no |

**A `yes` in this table promises the contribution and its context, never the pixels.** `chat-header-action` is the clearest case: desktop and web draw a button in the chat header, and the phone draws the same contribution as rows in the chat's existing three-dot overflow menu, because a nav bar holds a title and about two controls. Same declaration, same `session` context, same actions reachable — different chrome. Tell a user which shape they will see on which client rather than implying one control in one place.

On the phone those rows are **grouped into a section per plugin, titled with the plugin's display name**. That is the only attribution a menu row can carry — there is no room for a subtitle, and an unattributed "Sober up" sitting under "Rename" and "Delete chat" would read as one of ADE's own verbs. Your entries are drawn after the product's own and never above the destructive ones, which stay fenced behind a divider so a mis-tap cannot land on them.

The live answer is `PLUGIN_SOCKET_CLIENT_SUPPORT` in `shared/plugins/sockets.ts`, one line per kind; this table is its prose. A client that has not grown an arm for a kind drops it where it decodes, so an unsupported kind is **absent** there, never half-drawn — which is what lets a kind ship on desktop first.

**iOS reads what you declared and what you published, the same as desktop does.** Both sources reach the phone: `plugins.list` carries your manifest's socket declarations, and your published `plugin_contributions` rows replicate. So a contribution you only declared renders on iOS exactly as on desktop, and nothing needs publishing to be visible there.

One consequence of that worth designing around: a declared `row-badge` draws as a neutral placeholder on **every** row of its surface until a published row fills it in, and a declared `composer-action` or `chat-header-action` appears in every chat. That is deliberate — it keeps a plugin that never publishes honest rather than invisible — but it is conspicuous on a phone. Publish, or do not declare.

**The hosted web client draws sockets too**, as of the round that gave it both reads it was missing. One gap remains and it is per surface rather than per kind: the web build does not mount `automations`, so a contribution declared on that surface draws nowhere there.

Which still points the same way: **design a socket as an enhancement on top of a panel that stands on its own.** The panel renders on all four clients; the socket is what makes it reachable from a row.

**A panel with no `surfaces[]` entry is not reachable everywhere, and nothing warns you.** `panels[]` says a panel *exists*; `surfaces[]` is what gives it a front door. Declaring only the first is legal, parses clean, and leaves a real gap:

| Route in | Needs a surface? |
|---|---|
| `{navigate: {panelId}}` from an action, and an `ade://plugin/<id>/<panel>` deeplink | No — desktop and web open `/plugin/<id>?panel=…` and iOS presents the plugin pane sheet, whatever the manifest declares |
| The rail on desktop and web, and the phone's plugin menu | Yes — a `tab`. For a slot in the Work tools rail use a `work-rail-pane` SOCKET, not a surface: a `{"kind": "pane"}` surface is refused by the manifest parser unless it gates a compiled ADE pane |
| The TUI's `/plugin-view <id>` | Yes. With no surface it falls back to the panel id `"main"`, so a panel named anything else opens nothing at all |

So a plugin reached only through a socket the TUI does not draw (the matrix above) is a plugin `ade code` cannot open. If the panel is meant to be a place rather than a pop-up, declare a `tab` surface for it; if it is genuinely an accessory to a chat, say so and accept that the TUI has no door to it.

The TUI draws your badges on the drawer's lane cards and chat rows, and lists your menu items and toolbar actions through **`/plugin-actions`** — menu items for the focused lane or chat, toolbar actions for the surface itself, on `lanes` and `work` only. `/plugin-view [plugin]` opens a panel in the right pane. Design so a badge is an enhancement, never the only way to learn something — and prefer the panel-shaped kinds (`chat-card`, `drawer-tab`, `settings-section`, `dialog-section`, `work-rail-pane`) for anything that matters on a phone, since they are the kinds a client can draw with the renderer it already has.

### Writing into the draft

An action can return `{composer: {…}}` the way it can return `{navigate: {…}}`, and the client applies it to the chat composer:

| Verb | Effect |
|---|---|
| `{composer: {insertText: "…"}}` | Insert at the caret, leaving the rest of the draft alone. An empty string does nothing |
| `{composer: {replaceText: "…"}}` | Replace the whole draft. An empty string clears it |

Four things worth knowing before you rely on it:

- **The verb belongs to the response, not to the socket kind.** Any action invoked from a composer- or chat-scoped socket can carry one — a `row-menu-item` on a chat row that returns `{composer: {insertText}}` writes into that chat's composer. Invoked from somewhere with no composer at all (a Lanes toolbar, a PR row), the edit is dropped with a console warning rather than queued: a draft that surfaced under an unrelated chat minutes later would be worse than nothing happening.
- **`replaceText` wins if you send both.** "Replace, then insert into the replacement" is not what either verb means.
- **32 KiB is the ceiling**, in UTF-8 bytes. Over it the edit is dropped, never truncated — a prompt cut off mid-sentence and then sent is worse than one that never arrived.
- **You cannot send the message.** Composing and sending stay the user's; the verbs write text and stop there.
- **iOS applies both verbs too**, and `insertText` appends there — the phone's composer publishes no caret, which is the same `cursor: null` case desktop treats as "append".

### Long-running actions

Every other socket's handler is capped at **60s**, and the guidance everywhere else in this skill stands: do slow work in `activate` or an event handler and store the result. Three kinds are the deliberate exception, capped at **15 minutes**:

- **`composer-action`** — canonical uses are open-ended by nature: record until I stop, transcribe this, draft that.
- **`slash-command`** — the same act by a different gesture. The user typed `/transcribe` instead of pressing the button beside it, and splitting the budget by gesture would mean `/summarize` timing out where its button succeeds.
- **`chat-header-action`** — the open-ended things a chat's own header attracts: summarize this conversation, hand it off, file it. A 60s cap would report those as plugin faults.

**The budget follows the FEEDBACK, not the position.** All three draw the same persistent busy state, refuse re-entry the same way, and sit under something the user is watching — and the header button is promoted out of its overflow menu while it runs. That shared busy state is the whole justification:

- **It stays visibly active for the entire run** — accent-tinted, label intact, still focusable. It is *not* greyed out, because a control that looks disabled for three minutes reads as broken.
- **A second press while it runs is a no-op.** You will never be re-entered for a click the user made while your handler was still working, so a "start/stop" button must be driven by your own state, not by two invocations.
- **The user keeps typing the whole time.** Which is the next rule, and the one that actually bites.

**Insert against the draft as it reads when you RESPOND, not when you were called.** ADE splices `insertText` at the caret's *current* position in the *current* draft, so an insert is always correct on ADE's side. What is on you is your own arithmetic: if your handler captured `context.draft` at the start of a three-minute recording and returns `{composer: {replaceText: draft + transcript}}`, you have just deleted everything the user typed while you were listening. Prefer `insertText` for anything that took real time, and reserve `replaceText` for actions that answer immediately or genuinely own the whole prompt.

Worked example — a prompt-template button. Declare the socket:

```json
{ "socket": "composer-action", "surface": "work", "id": "bug",
  "label": "Bug report", "icon": "Bug", "actionId": "bugTemplate" }
```

Then answer with the edit:

```js
exports.actions = {
  async bugTemplate(args) {
    const { draft } = args.context;                 // the live prompt, verbatim
    const template = "Steps to reproduce:\n1. \n\nExpected:\n\nActual:\n";
    // Nothing typed yet: lay the template down. Otherwise slot it in at the
    // caret so the sentence they were writing survives.
    return draft.trim().length === 0
      ? { composer: { replaceText: template } }
      : { composer: { insertText: `\n\n${template}` } };
  },
};
```

### Commands the user types

A `slash-command` is the same act as a composer button by a different gesture, so it gets the same `composer` context — session, project, lane, the live `draft`, the caret — the same `{composer: {…}}` verbs back, and the same 15-minute budget. What differs is the declaration: the word lives in `command`, not `label`.

`command` is `^[a-z][a-z0-9-]{1,30}$` — lowercase, hyphenated, two characters at least. Write it with or without the slash; ADE strips one and draws its own, the way it draws the `@` on a mention. `description` is the single line the command menu shows, and `argumentHint` (`<issue-id>`, `[branch]`) is drawn beside the command in that row. Both are optional — a command with neither still works.

**Selecting your command invokes it immediately.** This is the one place a plugin command differs from a runtime's own, and it decides how to word the hint. An SDK command scaffolds `/fix ` into the draft and waits for the user to finish typing; yours does not — there is no keystroke between the user picking your row and your handler running. The command word is consumed and **whatever else was in the composer arrives as `context.draft`**, so `tidy the imports /fix` invokes with `draft: "tidy the imports "`.

So `argumentHint` describes what your handler reads out of the draft, not a prompt the user will be given. `<issue-id>` promises a field that never appears; something like `reads the issue id from your prompt` says the true thing. Handle an empty draft — a user who types `/fix` and nothing else is the common case, not the edge one.

Your command joins the runtime's own commands in one list, on **every** runtime — unlike a skill-derived command, which only Claude and Codex surface.

```json
{ "socket": "slash-command", "surface": "work", "id": "conventional",
  "command": "/conventional", "description": "Rewrite the draft as a conventional commit",
  "actionId": "conventional" }
```

```js
exports.actions = {
  async conventional(args) {
    const { draft } = args.context;               // the live prompt, verbatim
    if (draft.trim().length === 0) return {};     // nothing to rewrite; say nothing
    const subject = draft.trim().split("\n")[0].toLowerCase();
    return { composer: { replaceText: `feat: ${subject}` } };
  },
};
```

### Writing into a dialog

A `dialog-section` renders your panel inside Create lane, Manage lane, or Create PR, and its actions may answer with a third verb:

| Verb | Effect |
|---|---|
| `{dialog: {setField: {field, value}}}` | Write one field of the dialog the section is in |

This is what makes "pick an issue, fill in the lane name and the base branch" something a third-party plugin can do rather than something only a built-in integration can do. Four rules bound it:

- **The field must be on the allowlist for that dialog**, and the lists are short: `create-lane` takes `name`, `baseBranch`, `parentLaneId`, `templateId`, `color`, `machineId`; `manage-lane` takes `name`, `baseBranch`, `parentLaneId`; `create-pr` takes `title`, `body`, `baseBranch`. A field from another dialog is dropped, not translated.
- **Nothing outside those lists is reachable.** The delete confirmation, the discard-dirty checkbox and the reclaim phrase are not fields, and no verb can arm them.
- **You cannot submit.** Creating the lane, or the PR, stays the user's — the same line the composer verbs draw.
- **16 KiB per value**, dropped rather than truncated. A half-written branch name that then gets created is worse than a field that stayed empty.

## The SDK your code gets

The entry module is CommonJS and dependency-free — the child bootstrap `require`s it and a plugin may not assume a bundler ran.

```js
exports.activate = async (ade) => { /* ade is the SDK */ };
exports.deactivate = async () => {};
exports.actions = {
  async refresh(args) { return { ok: true }; },
};
```

`ade` is also available as a global inside the child. Everything on it is async and host-mediated: there is no direct database, no ambient filesystem authority, no synchronous escape hatch.

| Call | Contract |
|---|---|
| `ade.actions.invoke(domain, action, args?)` | Invoke an ADE action at **agent** role. CTO-only actions are refused; project-scoped domains need `projectId` in `args`; `project_secret` needs a manifest declaration — see *Project secrets* |
| `ade.collections.get(collection, key)` | Read one value |
| `ade.collections.put(collection, key, value, options?)` | Write one value. Budget-checked inside the writer transaction. `{ifFull: "evictOldest"}` drops the oldest entries in that same collection to make room instead of refusing — see *Never stall* |
| `ade.collections.delete(collection, key)` | Delete one value |
| `ade.collections.list(collection, {keyPrefix?, limit?})` | Rows as `{collection, key, value, updatedAt}`, ordered by key. **`limit` is clamped to 1,000 and defaults to 200** — a collection may hold 4,000 rows, so a list can never return all of them, and it is silent about the ones it left out. When you need to know about a specific set of keys, `get` them by key; a `list` is for a window, not for the whole store |
| `ade.secrets.get/set/delete(name)` | Machine credential store, namespaced `plugin:<id>:<NAME>`. Never readable by another plugin |
| `ade.contributions.publish(entityKind, entityId, socket, payload)` | Publish or clear (`payload: null`) a dynamic contribution |
| `ade.events.on(event, cb)` | Two families — **change events** `lane.changed`, `pr.changed`, `session.changed`, `install.changed` (debounced; payload `{event, ids[], projectId, overflow?}`, where `overflow: true` means `ids` was truncated at the delivery cap and you should treat it as a bare refetch signal rather than trusting the partial list) and **runtime hooks** `turn.start`, `turn.end`, `tool.before` (told as they happen — see *Runtime hooks* below). Returns an unsubscribe function; call it, because a hook kind nobody subscribed to is never delivered at all |
| `ade.panels.update(panelId, schema)` | Replace a panel's schema. Refused for a panel the manifest never declared |
| `ade.config.get()` | Current values for `manifest.settings`, defaults applied. `secret` kinds are redacted |
| `ade.config.set(key, value)` / `set({key: value, …})` | Write your own settings, so a `settings-section` form can save what it renders. Resolves the new effective config. Does **not** restart you, so it is safe inside an action handler, and the next `config.get()` sees it. Refused with `invalid_args` when: the key is not in `manifest.settings`; the value is the wrong kind for it (`toggle` wants a boolean, `number` a number, everything else text); a `select` value is not one of its declared `options`; or the setting's `kind` is `secret` — those go to `ade.secrets.set`, never into the plain config store. **`null` resets**: the stored override is dropped and the manifest `default` comes back |
| `ade.memory.get/set/delete(key)` / `list({keyPrefix?, limit?})` | Your own durable memory: a reserved slice of your collections, no manifest declaration needed. Shares the collection budget and is dropped on uninstall. **Not** ADE's CTO memory — nothing you write here reaches any agent's prompt. `ade.memory` is refused as a `collections` name in both directions, so this slice has exactly one door |
| `ade.notifications.post({title, body?, target?, deeplink?})` | Tell the user outside ADE's window. `target` is `"desktop"`, `"mobile"` or `"both"` (default). Your **display name is stamped on by the host** and cannot be set, spoofed or omitted. `deeplink` decides where a tap lands and must be `ade://plugin/<your-own-id>/<panel-id>[?ctx=…]`, max 1,024 chars — anything else costs the destination, not the notification, and the tap opens your plugin as before. It reaches the phone; the desktop notification has no destination field. Resolves `{delivered: [...]}` with what actually landed; rejects `notification_unavailable` only when nothing was reached. Rate-limited — see *Budgets* |
| `ade.schedules.create({action, cron\|runAt\|delaySeconds, args?, note?})` | Ask ADE to call one of **your own** actions later. `cron` is five-field local time and recurs; `runAt`/`delaySeconds` fire once and are then dropped. Rejects `plugin_budget_exceeded` past the quota |
| `ade.schedules.list()` / `delete(scheduleId)` | Your schedules, never another plugin's. `delete` is idempotent. **Mind the two spellings:** the parameter is `scheduleId`, but a row from `list()` names the field **`id`** — so it is `delete(row.id)`, not `delete(row.scheduleId)`. Both spellings are accepted, and passing neither refuses with a message naming the row's field. Get this wrong and you delete `undefined`: the old schedule survives every settings save and walks into the live-schedule ceiling one change at a time |
| `ade.lanes.list()` / `get(laneId)` | The lanes of the project you are bound to, non-archived, as a **fixed allowlist** of fields — no `worktreePath`, no `attachedRootPath`, no `devicesOpen`. Each carries `primaryIssue` and `issueLinks`. A host with no project bound answers `unsupported_method`, not an empty list: there are no lanes here, and retrying will not grow one |
| `ade.lanes.linkIssue({laneId\|sessionId, issue, role?, includeInPr?, closeOnMerge?})` | Link an issue from **any** tracker to a lane or a chat/CLI session. Exactly one of `laneId` and `sessionId` — both, or neither, is `invalid_args`. `role` defaults to `"referenced"` (`primary` \| `worked` \| `referenced` \| `inferred`). `issue` is an `IssueRef` **without** `pluginId`: there is no field for it, because the host stamps your id from the connection that asked — see *Linking an issue* |
| `ade.lanes.unlinkIssue({laneId\|sessionId, provider, issueId})` | Remove a link **you** created. `false` when there was none, which is not an error; `not_permitted` when it belongs to another plugin or to ADE itself, with a sentence naming the owner |
| `ade.clipboard.read()` / `write(text)` | Machine clipboard, text only. A read returns whatever the user last copied — often a password they were moving between apps — so read it in response to something the user just did, never on a timer |
| `ade.dialogs.pickFile({title?, defaultPath?, directory?, filters?})` | Native picker; resolves the chosen path. Rejects `dialog_cancelled` when the user dismisses it — a dismissal is an answer, not a fault |
| `ade.log(level, message, fields?)` | `debug`/`info`/`warn`/`error` into the ring buffer `ade plugin logs` reads |
| `ade.pluginId` / `ade.sdkVersion` / `ade.manifest` | Identity, read-only |

The last four need a host that can perform them. `notifications`, `clipboard` and `dialogs` are the desktop's — a plugin running against a headless daemon gets `notification_unavailable` or `desktop_unavailable`, which are refusals worth retrying later rather than reasons to give up. Check the code, don't check the platform.

**Three things you may no longer borrow through `ade.actions.invoke`, because these verbs replace them:** `session.requestSessionAttention` (its push arrived unlabelled and unlimited, and it lied about a chat session waiting on the user), `chat.createScheduledWork` (its cron carried no owner, so nothing listed it as yours and uninstalling you left it firing forever), and `lane.linkLinearIssues` / `lane.unlinkLinearIssues` (they write the lane's issue rows with no record of who asked, so your link is indistinguishable from the user's, uninstalling you leaves it behind, and any plugin can unlink any other plugin's — or ADE's own). All are refused for plugins and name their replacement in the refusal. The user keeps every one of them through the UI, the CLI and the TUI; the refusal is about attribution, not about the act.

**And one thing you may only borrow by name:** the `project_secret` domain. `get` needs the name in your manifest's `projectSecrets`; every other verb in the domain is refused outright — see *Project secrets*.

`PLUGIN_SDK_VERSION` is **0** and the handshake is additive: methods get added, never removed or re-shaped. Anything that would break a shipped plugin gets a new method name.

Every rejection is a structural error carrying a `code` you can branch on: `plugin_not_found`, `plugin_disabled`, `plugin_no_entry`, `plugin_crashed`, `plugin_timeout`, `invalid_args`, `plugin_budget_exceeded`, `not_permitted`, `unsupported_method`, `internal_error`, plus `notification_unavailable`, `desktop_unavailable` and `dialog_cancelled` from the host capabilities above. A budget refusal additionally carries `detail: {budget, limit, actual}` — enough to tell the user exactly which ceiling they hit.

Naming rules the SDK enforces: collection names `^[A-Za-z][A-Za-z0-9._-]{0,63}$`, keys `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`, secret names `^[A-Za-z][A-Za-z0-9_.-]{0,127}$`.

### Linking an issue

If your plugin is a tracker — Jira, Shortcut, Asana, your company's internal one — this is the seam that makes it a first-class one rather than a panel beside the real thing. A link you make is on the lane itself: it rides `lane.issueLinks` everywhere ADE reads a lane, syncs to the user's other devices, survives your plugin being reloaded, and is addressable as `ade://issue/<provider>/<key>`. A lane-to-issue map kept in one of your collections is none of those things.

```js
const [lane] = await ade.lanes.list();
await ade.lanes.linkIssue({
  laneId: lane.id,
  issue: {
    provider: "jira",                                   // your tracker's vocabulary
    issueId: "10042",                                   // its stable id
    key: "OPS-42",                                      // the human key
    title: "Rotate the certificates",
    url: "https://example.atlassian.net/browse/OPS-42",
    state: { id: "3", name: "In Review", category: "started" },
    container: { id: "10000", key: "OPS", name: "Operations" },
  },
  role: "worked",
  includeInPr: true,
});
```

**`role: "primary"` does not make it the lane's primary issue.** The role is
recorded on the link, but `lane.primaryIssue` is derived from the lane's own
`lane_linear_issues` row, which only ADE's create-a-lane-from-an-issue path
writes. Your link lands in `lane.issueLinks` either way. Say what is true —
`primary` when your plugin opened the lane from that issue, `inferred` when you
guessed from a branch name — because the lane's issue list is what reads those
words back.

**Four required fields**, and a ref missing any of them is refused whole rather than repaired: `provider`, `issueId`, `key`, `title`. Everything else is optional. `state.category` is a closed set — `triage | backlog | unstarted | started | completed | canceled` — and `container` is whatever your tracker calls the group (a project, a repo, a team). `extra` is a free object ADE stores and never reads, which is where tracker-specific residue goes.

**You never state your own id.** `issue` has no `pluginId` field. The host stamps the id of the child connection that asked, and that stamp is exactly what `unlinkIssue` checks — a ref whose owner you could set would be a check against a value you supplied. `source` is host-set to `plugin_link` for the same reason: a link you made must not be able to claim the user made it.

**You can remove only your own links.** Another plugin's link, or one ADE made itself, refuses with `not_permitted` and a sentence naming the owner. A link that is not there answers `false` — no owner to check, so it is a no-op, not a fault. The user can unlink anything from the lane UI, the CLI or the TUI; the restriction is on plugins undoing each other.

**Where it lands, so you know what an older device sees.** Your ref goes inside the lane's existing issue row, under a reserved key, beside a legacy Linear-shaped projection of itself. Nothing about the database shape changes. The consequence for you: a phone or a desktop on an older build shows your Jira issue with the right key, title, URL and state name **under a Linear badge**. That is a mislabel, not a break, and it is the price of never altering a replicated table. It corrects itself when that device updates.

**Two things ADE does not do for you yet.** The PR body renders Linear references only, so an `includeInPr` link on your tracker is recorded and shows in the lane's issue list but does not currently put a line in the PR description. And a magic word only closes where something performs the close: `Fixes` for Linear, `Closes` for GitHub, `Refs` for everything else regardless of `closeOnMerge` — because `Fixes OPS-42` in a GitHub PR body is inert text, and writing it would promise a transition nobody makes. Close your own issues in your merge handler.

### Runtime hooks

Three events tell you what the coding agent is doing, as it does it.

```js
const off = ade.events.on("tool.before", ({ sessionId, runtime, toolName }) => {
  void ade.collections.put("toolstats", `${runtime}:${toolName}`, { at: Date.now() }, { ifFull: "evictOldest" });
});
```

| Event | Payload |
|---|---|
| `turn.start` | `{sessionId, projectId, runtime, model?}` |
| `turn.end` | `{sessionId, projectId, runtime, outcome, durationMs?}` — `outcome` is `"completed"`, `"error"` or `"cancelled"` (the user stopped the agent, which is not a failure to report). `durationMs` is absent when the host never saw the matching start |
| `tool.before` | `{sessionId, projectId, runtime, toolName}` |

`projectId` is the same identifier the change events carry, and is null for a turn in a project this machine has no binding for.

**Observe-only, and that is the design rather than a first iteration.** Delivery is one fire-and-forget line on your stdin. Nothing you do in a handler can veto a turn, change a tool call, delay the agent, or alter what it sees — and there is no return value the host reads. A plugin that stops reading its input has its hook deliveries **dropped**, counted in ADE's log, because the alternative is an installed plugin able to stall the user's agent. Vetoing a tool call is a permission question rather than an API one: the user's yes/no over what an agent may do stays core, and if a veto tier ever ships it will be a separate, explicitly-granted capability.

**Payloads are metadata, never content.** No message text, no prompts, no tool arguments, no tool results, no file paths. You can build a cost guard, a turn timer, a tool-usage dashboard or a lint trigger from this; you cannot read the user's conversation from it. If you need the transcript, ask for it through its own gate: `ade.actions.invoke("chat", "readTranscript", …)`.

**Subscribe narrowly.** `tool.before` fires dozens of times in a single turn, and a kind nobody subscribed to is never written to your process at all. Unsubscribe when you stop caring, rather than registering a listener that ignores most of what it gets.

**Per-runtime coverage.** ADE normalizes every runtime's stream into one transcript vocabulary and the hooks are derived from that funnel, so all six are covered on the same code path — there is no per-runtime hook wiring to fall behind.

| Runtime | `turn.start` | `turn.end` | `tool.before` |
|---|---|---|---|
| Claude | yes | yes | yes |
| Codex | yes | yes | yes |
| Cursor | yes | yes | yes |
| Droid | yes | yes | yes |
| Pi | yes | yes | yes |
| OpenCode | yes | yes | yes |

Two honest caveats. **`tool.before` reports what the runtime told ADE**, so a runtime that batches or omits a tool announcement omits a hook — the hook stream is as complete as the transcript is, and no more. **Codex announces a turn twice** (once when ADE dispatches, once when the runtime names it); ADE collapses that to one `turn.start`, and likewise reports one `turn.end` per turn however many times it settles, so counting turns is safe.

## Budgets

Writer-enforced, inside the transaction. These are not advice — a write past a ceiling is refused with `plugin_budget_exceeded`, never silently truncated.

| Budget | Limit |
|---|---|
| Collection bytes per plugin per machine | 2 MiB |
| Collection rows per plugin | 4,000 |
| One collection value | 64 KiB |
| Contribution rows per plugin | 2,000 |
| One contribution payload | 4 KiB |
| Panels per plugin | 32 |
| One panel schema | 64 KiB |
| Log ring | 500 lines, 2,000 bytes each |
| Notifications per plugin | 60 a UTC day, 5 a rolling minute |
| Notification title / body | 80 / 240 characters |
| Live schedules per plugin | 8 |
| Shortest schedule interval | 60 seconds |
| One schedule's `args` | 4 KiB |
| Clipboard text | 64 KiB |

The notification ceilings are the only ones here that bound a rate rather than a size, because a notification is an interrupt on a device the user carries. Sixty a day is past every honest notifier — one per failed CI run, per review comment, per incident lands in the tens on a bad day — and the rolling-minute cap is what stops a bug: a plugin looping on an event tick is cut off inside the first second, while a plugin reacting to four PRs that merged together still gets all four through. They are counted per plugin per machine and they **survive a restart**, so crashing the child does not refill the allowance. Over either one you get `plugin_budget_exceeded` with `detail.budget` naming which.

Schedule quota counts *live* rows: a one-shot stops counting once it has fired, so what is bounded is how many standing claims on the clock you hold at once. Eight is enough for hourly, daily and weekly plus a handful of user-requested reminders; a plugin that wants more wants one schedule and its own dispatch table inside it.

Contributions are glances, not pages: 4 KiB is room for a badge and a tooltip, and that is the intent.

### Relay fairness

Those budgets bound what a plugin *stores*. A separate ceiling bounds what a machine *relays*: sync frames that travel through ADE's relay are counted per machine per UTC day — **500,000 frames** and **250 MiB** — and a machine past either has its tunnels closed and new ones refused until midnight UTC. Direct and LAN sync are never counted; only the relay hop is.

Both ceilings sit roughly 100× above honest use, so nothing written normally approaches them. They are worth knowing anyway, because a plugin is the one thing on the machine that can write to the sync layer in a loop. Publish a value when it changed rather than on a timer, and clear a contribution with `null` rather than rewriting the same badge every tick.

### Never stall

A full store is a normal state, not an incident. A plugin **must** be written so that reaching a ceiling costs it one skipped item and nothing else — not a dead child, not a blank panel, not a plugin the user has to reinstall. These are requirements, not tuning advice.

1. **Catch every `put`.** `ade.collections.put` can refuse, and an uncaught refusal inside `activate` is fatal to the child, while one inside an action handler fails that action. The rejection carries `code: "plugin_budget_exceeded"` and `detail: {budget, limit, actual}` — branch on `error.code` directly. ADE's own `isPluginBudgetExceeded` helper is not reachable from a plugin: the child has no ADE package to import and the `ade` global does not carry it. Treat a refusal as **prune, retry once, then skip the item and carry on.** Never treat it as fatal, and never retry in a loop — the ceiling will not move because you asked twice. This holds even with the self-healing write below: it makes room, it does not make the impossible fit.
2. **Design the store as a bounded cache from day one, and let the platform hold the bound.** When a collection is a cache — newest N wins, nothing in it is precious — say so on the write and stop hand-rolling retention:

   ```js
   await ade.collections.put("issues", `open:${row.id}`, value, { ifFull: "evictOldest" });
   ```

   A write that would cross the byte or row budget then deletes the oldest entries **in that collection** until the value fits, atomically, and writes. It never reaches into another collection, so a cache cannot evict something precious you happened to store beside it — which is the argument for giving anything you cannot afford to lose a collection of its own. This is the recommended default for cache-shaped data. It does not rescue a value that can never fit — larger than the whole budget, or over the 64 KiB per-value cap — and that still throws, per rule 1. Omit the option and the behaviour is exactly as before: the write throws and you handle it.

   **Custom retention stays manual.** `evictOldest` keeps the newest; a plugin that has to keep the most *relevant*, or age rows out on its own clock, prunes for itself. Then the old discipline applies: delete before you insert once you are at your own soft ceiling — around 80% of the platform cap, which leaves room for a value that grew — and prefer overwriting one key to accumulating keys, since a fixed `summary` key you rewrite can never grow the row count at all.
3. **History-shaped data must be windowed or aggregated.** Logs, time series, message archives and event streams append forever by nature, and forever does not fit in 4,000 rows. Keep the latest snapshot or the last N entries and roll the rest off — when the window is simply "newest wins", rule 2's `ifFull` does the rolling for you. Bulk and media data do not belong in synced storage at any size — the 64 KiB per-value cap is the platform saying so, and your own files on disk are the answer.
4. **Recovery is always available, so a stuck plugin is a written bug.** Deletes are never budget-checked and the byte accounting is delta-based, so shrinking a value succeeds at the ceiling exactly as it does on an empty store. A plugin that fills its budget can always dig itself out, unattended, with no user action and no reinstall.
5. **Never block rendering on a write.** Panels render from what is already stored, so a refused `put` should cost the user the newest row and nothing more. Update the panel when a write lands; when it does not, leave the last good data on screen rather than replacing it with an error.

The same discipline is what keeps you clear of the relay ceilings above: rewriting the same value in a tight loop spends the user's daily allowance on data nobody read. Write when the state actually changed, not on every tick of your own timer.

## Recipes

### A dashboard tab backed by an API

Manifest: one `tab` surface, one panel, one collection, one `secret` setting for the token.

```js
exports.activate = async (ade) => {
  const KEEP = 50;                                     // bounded cache, decided up front
  const refresh = async () => {
    const token = await ade.secrets.get("API_TOKEN");
    const rows = (await fetchIssues(token)).slice(0, KEEP);   // your own code
    // Correctness, not budget: drop issues that have left the window entirely.
    const keep = new Set(rows.map((row) => `open:${row.id}`));
    for (const stored of await ade.collections.list("issues", { keyPrefix: "open:" })) {
      if (!keep.has(stored.key)) await ade.collections.delete("issues", stored.key);
    }
    for (const row of rows) {
      try {
        // Materialize in RENDER shape — a `list` binding reads exactly these keys.
        // `ifFull` handles budget pressure; the catch handles a value that can never fit.
        await ade.collections.put("issues", `open:${row.id}`, {
          title: row.title, subtitle: row.repo, meta: row.age, tone: row.stale ? "warning" : "neutral",
        }, { ifFull: "evictOldest" });
      } catch (error) {
        if (error?.code !== "plugin_budget_exceeded") throw error;
        ade.log("warn", `Skipped ${row.id}: store full.`);    // skip the item, keep the plugin
      }
    }
  };
  await refresh();
  ade.events.on("pr.changed", () => void refresh());
};
exports.actions = { refresh: async () => ({ ok: true }) };
```

The window, the delete-before-insert pass and the `catch` are not decoration — see *Never stall*.

Panel: a `list` with `{"bind": {"collection": "issues", "keyPrefix": "open:"}}` and a `button` whose `onPress.action` is `refresh`.

### Row badges from CI

Declare `{"socket": "row-badge", "surface": "prs", "id": "ci", "label": "CI"}` — the `label` is required, and it names the slot on the install sheet rather than drawing on any row — then publish per PR from the machine that owns the data:

```js
ade.events.on("pr.changed", async ({ ids }) => {
  for (const number of ids) {
    const status = await checkCi(number);
    await ade.contributions.publish("pr", number, "row-badge",
      status ? { text: status, tone: status === "green" ? "success" : "warning" } : null);
  }
});
```

Publishing `null` clears the badge — do that rather than leaving a stale one, and remember badges cap at 2 visible per row. Until the first publish lands, the PR rows carry no badge at all: a declaration reserves the slot and draws nothing.

### A file viewer

```json
{ "socket": "file-viewer", "surface": "files", "id": "video",
  "extensions": [".mp4", ".mov"], "panelId": "player" }
```

The `player` panel uses `video` with a `src` your code fills in via `sdk.panels.update` when a file is opened. Extensions are lowercase and include the dot.

### A theme

Themes are UI-only — **omit `entry` entirely** and ship no code.

```json
{ "theme": { "tokens": {
  "dark":  { "--color-accent": "#7C6FF0", "--shell-bg": "#0B0B0F" },
  "light": { "--color-accent": "#5B4FD6" } } } }
```

Only these token namespaces are accepted; anything else is dropped with a warning: `--color-*`, `--shell-*`, `--chat-*`, `--work-*`, `--pane-*`, `--pr-*`, `--gradient-*`. The user previews a theme and presses Esc to revert, or applies it to persist. Coverage is token-backed surfaces; iOS applies the accent only.

### A CLI command

Add the word to `cli`, add a handler of the same name to `exports.actions`, and it is reachable as `ade <pluginId> <word>`. ADE parses none of it — the words are passed through untouched, so the plugin owns its own flags and its own usage text.

**Return plain data from a CLI handler.** The CLI prints your return value as JSON and interprets none of it: `message`, `navigate`, `openUrl` and `resetState` are UI verbs that reach a client, and on this path they are printed as data rather than acted on. Answer with the fields a reader or a script wants, and keep the verbs for the handlers a surface invokes.

**`argv` is a property of the one args object, not the parameter itself.** The handler signature is the same as every other action's — one object — and the words arrive on `args.argv`:

```js
// $ ade my-thing status ISS-14 --json
exports.actions.status = async (args) => {
  const argv = args.argv || [];           // ["status", "ISS-14", "--json"]
  const words = argv.filter((w) => !w.startsWith("-"));
  const id = words[1];                    // "ISS-14"
};
```

Two things that shape is easy to get wrong, and both were got wrong on the first plugin written against this page. Writing `async status(argv)` treats the object as the array, and every index then reads `undefined`. And **`argv` still contains the command word itself** — `words[0]` is `"status"` — so taking the first non-flag token hands you the word you already knew instead of the argument you wanted. The word is not always at index 0 either (`ade my-thing --json status` puts it second), which is why the example filters the flags out and then skips one, rather than slicing.

### Contributing an agent skill

Put a `SKILL.md` under `skills/<name>/` with `name` + `description` frontmatter and list the CONTAINING directory in `manifest.skills` — `"skills": ["skills"]` resolves to `<plugin>/skills/<name>/SKILL.md`. Installed plugin skill roots are appended to `ADE_AGENT_SKILLS_DIRS`, passed to Codex as `skills/extraRoots`, handed to Claude as a plugin root (ship a `.claude-plugin/plugin.json` marker in the containing directory — Claude reads plugin roots, never the env var), and listed by `ade skill list`. A skill inside a plugin loads only where that plugin is installed and enabled, which is why ADE's own `ade-linear`, `ade-ios-simulator` and `ade-app-control` skills live in their packages rather than in the shared bundled root.

## What a plugin gates

A plugin is a whole vertical: its surfaces, its agent tooling and its skills arrive and leave together.

- **Surfaces** vanish from the rail, the palette, deeplinks and restored routes. Hidden is the default, not a fallback — a surface appears only on three positive facts (this host publishes plugins, the registry has resolved, the owner is installed and enabled).
- **Action domains** the plugin owns are refused at dispatch with `policyDenied` and `data.kind = "plugin_not_installed"`, never `methodNotFound`. The message names the fix and its wording comes from the plugin catalog, so a plugin ADE cannot name produces a plain error and no advice.
- **Skills** stop loading, on every runtime, because the root itself is gone.
- **Connections** the plugin held are deleted on uninstall. Removing `ade-linear` clears the stored Linear token; the confirm dialog says so first.

This gates ADE's premium layer for a capability, not the capability. An agent on a machine with no plugins still has `xcrun simctl`, the Linear REST API, AppleScript and CDP. What it loses is the typed action surface, the proof capture, and the lane and chat context ADE wraps around them — so when a domain refuses, say what is missing and reach for the raw tool rather than reporting the task impossible.

## Hard rules

1. **Data, never code.** No expressions, no conditionals, no formatting strings, no callbacks in a schema. Compute on your machine, store the result. A `webview` is the one exception, and it buys unlimited UI by giving up three of the four clients.
2. **Every panel declares `fallback` with a `title` and `text`.** A panel without one is fatal on every client. Add a `deeplink` too.
3. **Secrets go through `ade.secrets`, never through the environment.** The child's env is denylisted, and a secret in a collection value is a secret in the sync layer.
4. **Never assume a socket renders.** Desktop and the web client draw all seventeen kinds; iOS draws eleven and the TUI draws three. A contribution is an enhancement; the panel and the fallback are the floor.
5. **The `plugin_*` SQL shapes are frozen.** A plugin never gets its own table or its own column on an ADE entity — collections and contributions are the two storage shapes there are.
6. **Budgets are refusals, not warnings.** Catch `plugin_budget_exceeded` on every `put`, prune, and carry on — a full store must never stall a plugin (*Never stall*). Budgets bound what leaves the machine, never what the plugin's own process may do (*What you can build*).
7. **`"official": true` in your manifest buys no trust.** Official is a statement the registry makes about a plugin, never one the plugin makes about itself. The one thing the field does locally is unlock the reserved `builtin` binding, which still gates nothing unless the compiled owner table already names your plugin id.
8. **Bump `version` on every published change.** The install registry, the checksum table, and the update path all key off it.
9. **Never claim a surface you did not look at.** A declared socket on a supported kind is a prediction. Installed is not materialized, materialized is not drawn, and drawn on desktop is not drawn on the phone (*the seven layers*). What you could not check goes in the delivery statement under *Unverified*, in that word.
10. **Say the timing.** A plugin's skill and state are read at the start of a turn, so a behaviour change lands from the user's next message and never inside the turn that installed it. "The agent is now X" is the wrong sentence; "from your next message" is the right one.

## Troubleshooting

**Run `ade plugin doctor <id> --text` first.** It walks all eight rungs, names the failing one, and prints the command that fixes it — most of the rows below are what it tells you, and it tells you which one applies. Reach for a specific row when doctor points at a layer and you want the detail behind it.

| Symptom | Cause and fix |
|---|---|
| Plugin shows as `crashed` | The child exited. `ade plugin logs <id> --text` — the crash line carries the exit status and the tail of stderr. It restarts automatically with backoff `min(30s, 1s × 2ⁿ)`; a child that stays up 60s resets the counter. After 5 fast failures in a row the host stops reviving it and the status stays `crashed` — `ade plugin reload <id>` (or the Restart button) clears the counter and tries again |
| Status stuck at `starting` | The child never sent `ready` within 20s. Usually a top-level throw in the entry module or a `require` of something not installed — check the logs |
| An action hangs then fails | `plugin_timeout`: one `invoke` round-trip is capped at 60s — 15 minutes for a `composer-action`. Do slow work in `activate` or an event handler and store the result |
| The plugin restarts over and over, and the logs stop after `activate` | `activate` is awaited before the child may send `ready`, and the deadline for that is 20s. Something you await there — almost always a first network fetch — is slower than it looks on a good connection. Start it without awaiting; see *Budgets and timeouts* |
| A long composer action's insert wipes what the user typed | Your handler splices against the `context.draft` it captured at the start. Return `insertText` and let ADE place it at the live caret, rather than rebuilding the whole prompt with `replaceText` — see *Long-running actions* |
| A write fails with `plugin_budget_exceeded` | Working as designed. Read `detail.budget`, `detail.limit`, `detail.actual`, prune with `ade.collections.delete`, retry once, then skip the item. Deletes always succeed, so recovery never needs the user — if the plugin stalled here, fix it against *Never stall* |
| Panel renders as a fallback card | Panel-fatal: bad JSON, `v` mismatch, missing `fallback`, or over 200 nodes / depth 8 / 64 KiB. Compare against the limits above |
| One component shows a marker, rest renders fine | Node-local. Either the component is malformed, or that surface does not draw it (see the support matrix) |
| Panel renders on desktop, marker on iOS or the TUI | Expected for `chart`, and for `video`/`image` in the TUI. Not a bug — give the panel something else to say |
| A webview page loads but stays blank | Almost always the CSP: `script-src 'self'` blocks inline `<script>`, `onclick=` attributes, `eval`, and anything from a CDN. Move the code into a `.js` file next to the page and load it with `src` |
| A file in the page 404s or does not run | The path escaped the plugin directory, the file is not there, or its extension is outside the served content-type map (a `.ts` or `.jsx` arrives as `application/octet-stream` and will not execute). A directory URL resolves to `index.html`; a directory itself is a 404 |
| Panel shows on desktop but not on the phone at all | The surface says `"mobile": false`, or it is a `webview` (never on the phone) — see *Mobile*. The flag is resolved by the machine that publishes the panel, so edit the manifest and `ade plugin reload <id>` on that machine |
| The webview surface shows a panel instead of the page | You are not on the desktop. iOS, the web client, and the TUI render the surface's `panelId` — that is the design, so make that panel say something useful |
| `adePlugin.collections.put` fails with `plugins_unavailable` | A page can only write where the plugin host runs in the same process. Call your own action with `adePlugin.invoke(...)` and write from the child instead |
| Contribution never appears | Check `manifest.sockets` declares the kind on that surface, the payload validates for that kind, and you published from the machine that owns the entity |
| The button is there, the press does nothing, no error anywhere | Read doctor's **Last run** rung. `no action has run` means nothing reached your handler — check `actionId` against the name in `exports.actions`. `<action> ran` means it did, so the bug is inside it: the usual one is reading the context through a key that is not there (`args.context.session.id` — there is no `.session`; see *Your action receives a typed, read-only context object*), which returns without writing and without throwing. Reproduce it in one call with `plugin.invoke` and a synthetic context rather than asking anyone to click again |
| An edit to the plugin does not take effect after a reload | Reload re-copies a `local` source, so check its `warnings` and doctor's **Source** rung — a source folder that moved away leaves reload running the installed copy. For a `git` or bundled install there is no source to re-copy: install again from the source you changed |
| Composer button is there but nothing lands in the draft | Look for `[plugin composer]` in the renderer console. "no composer on screen" means the action was invoked from a surface with no composer; "malformed" means the verb was not a string, was an empty `insertText`, or was over the 32 KiB ceiling |
| Composer button never appears in the TUI | Expected — see the support table. It DOES appear on the phone and on the web, declared or published. Give the same action a panel button if it has to be reachable everywhere |
| The icon draws as a puzzle piece | The name is not one of the 64 tokens. Both clients resolve `icon` against the same list and puzzle-piece anything else, so this reproduces everywhere rather than on one client — pick a token from *Per-client honesty*. A raw SF Symbol name is not a token and does not work on the phone |
| `ade plugin <cmd>` says `Unknown command 'plugin'`, or `Domain 'plugin' is unavailable in this runtime` | Both are facts about ONE BINARY. `PATH` resolved `ade` to a build without the plugin platform — usually the stable app's CLI while your chat is in the alpha's. Run `$ADE_CLI_PATH` instead, or `ade doctor --text` and read its **CLI** row. Never report this as "this machine has no plugins"; re-run Phase 0 |
| The tab or the overlay shows your PANEL where you expected your `webview` page | The guest host reads the LIST payload, not the manifest on disk. Compare `plugin.get`'s `.surfaces` against its `.manifest.surfaces` for `entryHtml`: present in the manifest and absent from the summary is a HOST fault (an app older than the fix), and `ade plugin doctor <id> --text` fails its **Custom page** rung on it. `plugin.reload` cannot change what the running app serves |
| `plugin.install` refuses with `plugin_install_denied` or `plugin_install_cancelled` | The person said no. **Do not retry** — it is an answer, not a transient failure. Ask what they would rather do |
| `plugin.install` refuses with `plugin_install_approval_timed_out` | Nobody answered the card within ten minutes. Say the install is still pending their decision rather than calling it a failure |
| `plugin.install` refuses with `plugin_install_source_unreadable` | This one is yours, not theirs. `source` must be a directory containing a `plugin.json`, a bundled plugin id, or a git URL |
| `plugin.install` is refused with `plugin_approval_unavailable`, or (on an older build) dies with `args.chat.requestChatInput is not a function` (JSON-RPC `-32011`) | The `ade` you ran is not connected to the app that owns your chat. The card has to be raised in **your own** chat, and when that app's brain is out of reach the CLI does not stop — it falls back to an in-process runtime whose chat service is a read-only stub — it lists sessions and reads transcripts, and has no composer to put a card in — so there is nothing to raise the card with. ADE now names that outright and refuses with `plugin_approval_unavailable`; builds before this fix died on the missing method instead. The usual reason is a home mismatch: an ADE Alpha CLI with `ADE_HOME` unset reads `~/.ade`, so it looks for the stable app's brain and never finds the alpha's. Run `ade doctor --text` and read the **CLI** row — it names the binary, its version and the `ADE_HOME` that answered, and warns outright when your chat belongs to a different app than the binary you ran. Then either set `ADE_HOME` to that app's home for the command (`ADE_HOME=~/.ade-alpha "$ADE_CLI_PATH" …`), or install from the app instead: **Marketplace → Install plugin → Choose folder…**, which takes a local plugin folder. The same mismatch reaches `chat.respondToInput` as `pending_input_unverifiable`, and shows up as the *limited to the machine operator* refusal below when the fallback runtime has no chat service at all — same cause, same fix. None of this applies from **your own terminal**: with no `ADE_CHAT_SESSION_ID` the CLI connects as the machine operator and needs no card |
| `plugin.uninstall` / `enable` / `disable` refuses with `plugin_uninstall_denied`, `plugin_enable_cancelled`, `plugin_disable_approval_timed_out`, … | Same reading as the install refusals, verb by verb: `_denied` and `_cancelled` are the person's answer, `_approval_timed_out` means nobody was at the keyboard. **Do not retry.** None of these is ever pre-approved by an earlier install |
| A plugin action refuses with *limited to the machine operator* | The shell carries an ADE chat-session binding (`ADE_CHAT_SESSION_ID` and friends), and a session-bound caller is clamped to `agent` no matter what `--role` says. This is an authority boundary, not a flag to work around: hand the user the command for their own terminal |
| `ade plugin <cmd>` says it needs the brain | `install`/`remove`/`enable`/`disable`/`reload`/`logs`/`dev` are daemon-backed. Start ADE or run `ade brain start`. `list` and `create` never need it |
| `ade <pluginId> <word>` says unknown command | The plugin must be installed, **enabled**, and declare that exact word in `cli` — otherwise the CLI treats it as a typo, which is what you want |
| A directory in `~/.ade/plugins/` is ignored | `state.json` is the only source of truth for "installed". A stray clone is a leftover, not a plugin. Install it properly |
| Plugin missing on another device | Installs are per-machine. Missing plugins hide silently rather than showing broken rows; install it there or use the Marketplace's machine coverage matrix |
| An action domain answers "This machine doesn't have X" | Its plugin is not installed or is disabled here. Install it from the Marketplace, or do the job with the underlying tool — the refusal is ADE's layer being absent, not the capability |

## Publishing

1. Push a public repository with a valid `plugin.json` at its root.
2. Add the `ade-plugin` GitHub topic.

That is the whole process — no submission, no review queue, no account. A crawler picks up the topic and the plugin appears in the Marketplace. Being listed is not an endorsement: community entries show their author, carry no Official mark, and are not checksummed by the directory, so they install as unverified. Official is not something publishing can earn — see *What you can build*.

Users can also install straight from a git URL or a local path, from the Marketplace's install dialog or with `ade plugin install`.
