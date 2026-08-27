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
| "a little tag on each row" | `row-badge` | On the row. 2 visible, rest behind a "+N". On `lanes` it also rides the per-lane header strip in the multi-lane column view, so splitting Lanes into columns no longer loses it |
| "an option when I right-click a row" | `row-menu-item` | That row's context menu |
| "a way to filter the list by my thing" | `filter-chip` + `filterKey` on the rows | The filter row. Publish the tags first or it filters everything out |
| "extra help when the list is empty" | `empty-state` | Below the surface's own empty state |
| "more detail when I open one" | `detail-section` | A panel, as a section in the detail view |
| "a card in the conversation" | `chat-card`, surface `work` | Your panel, inline in the transcript |
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
- **`icon` is a token, and the token list is the whole namespace.** Both clients resolve it against the same 64 tokens — desktop to a Phosphor glyph, iOS to an SF Symbol — and anything not on the list draws the puzzle piece on **both**. So an icon that renders anywhere renders everywhere, and an unrecognised string is unrecognised identically. There is no per-client escape hatch: naming a raw SF Symbol does not work on the phone, and never portably did. The tokens:

  `beer` `bell` `bookmark` `brain` `bug` `calendar` `chart` `chart-bar` `chat` `clock` `clock-counter-clockwise` `cloud` `code` `compass` `cube` `currency` `database` `desktop` `device-mobile` `envelope` `eye` `file` `flag` `folder` `gear` `git-branch` `git-commit` `git-pull-request` `globe` `graph` `heart` `image` `kanban` `key` `lightning` `link` `list` `list-checks` `lock` `magic` `microphone` `music` `note` `package` `palette` `play` `plug` `puzzle` `robot` `rocket` `rows` `shield` `sparkle` `star` `storefront` `table` `tag` `terminal` `timer` `toolbox` `trend` `users` `video` `wrench`

  Read the live list from `PLUGIN_ICON_NAMES` in `apps/desktop/src/renderer/components/plugins/pluginIcons.tsx` — it is exported for this skill. **Name a token and the picture cannot differ between clients**; name anything else and you get the puzzle piece, which is what a plugin looks like when it looks unfinished.

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

One command walks the whole ladder with live checks — a rung each for **Source**, **Installed here**, **Running**, **Places**, **Last run**, **Panels**, **In this project** and **Agent skills** — then closes with a `Renders on:` line **derived from `PLUGIN_SOCKET_CLIENT_SUPPORT` itself**, so the per-client answer cannot drift from the table that decides it. Trust that line over any prose, including this skill's.

```
Tipsy (ade-tipsy) 0.3.0

  ✓ Source           https://github.com/arul/ade-tipsy
  ✓ Installed here   version 0.3.0, turned on
  ✓ Running          the plugin's own process is up
  ✓ Places           composer-action in work, slash-command in work; 1 row published right now
  ✓ Last run         drink ran 2 minutes ago; 1 action never run
  ✓ Panels           1 published of 1 panel in the manifest
  ✓ In this project  1 place, 1 panel, 4 stored rows
  ✓ Agent skills     1 skill · Affects agents from their next turn — running turns keep their current behavior.

  Renders on: desktop ✓ (composer-action, slash-command) · web ✓ (composer-action, slash-command) · iPhone ✓ composer-action / ✗ slash-command (not drawn on phones) · terminal ✗
```

Read that `Renders on:` line closely — it is the layer-6 answer per client and per kind, and the iPhone clause above is exactly the shape of the retrospective's failure: one kind drawn, one absent, on a plugin whose manifest declared both. **Agent skills** carries the timing sentence verbatim, which is the layer-7 answer.

**Places is the contributions read-back.** It counts your declared sockets by kind and surface (`2× row-badge in lanes` when a kind is declared twice), then adds the live published count. Three variants to expect: `; 2 switched off here` when the user has disabled sockets — and if *all* of them are off the rung flips to `✗`, because the reader is here asking why they cannot see it; `; published rows unknown (ADE is not answering)` when the host is down; and `– Places  this plugin asks for no place in ADE's own screens` for a plugin that declares none, which is *not applicable*, never a failure.

**Last run is the one rung about your own code.** Everything above it says the platform did its part; this one says whether a handler of yours was ever reached, and how the most recent attempt ended. It answers the question Places cannot: a button that is drawn and published still reads `✓ Places` when the action behind it never fires, so *"I pressed it and nothing happened"* used to need a reproduction before anyone could tell a wiring problem from a code problem. Read it as: `no action has run since ADE started` — nothing reached your code, so look at the declaration and the press path; `drink failed 4 minutes ago (invalid_args)` — your handler ran and threw, so look at the handler; `drink ran 4 minutes ago` — your handler ran and returned, so if the screen did not change, the bug is in what it did, not in whether it was called. Every route counts: a press, an `ade <id> <word>`, an agent tool, an automation step, a schedule. A refused invoke is an attempt too, and carries its code. It is **in memory**, so it says "since ADE started" and a restart empties it — and on a host too old to keep it, the rung reads `– Last run  this copy of ADE does not keep track of plugin action runs` rather than claiming nothing ever ran.

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

- **Whole surfaces** — a `tab` or a `pane` rendering a panel schema, and on the desktop a `webview` drawing your own HTML page.
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

**The vocabulary is thirteen components with hard ceilings** — 200 nodes, depth 8, 64 KiB per schema, plus the per-component caps in *Vocabulary limits*. No expressions, conditionals, formatting strings or callbacks. A component this build has never heard of renders a marker naming it, and a panel over any ceiling renders its required `fallback` instead — which is why `fallback` is mandatory rather than nice to have. What draws where differs per surface: *Per-surface support* is the authority, and worth reading before you design a panel around a `chart`.

**A `webview` page is desktop-only and sandboxed.** Its own origin, `script-src 'self'`, no Node, no `require`, no raw IPC, and no `window.ade` — the `window.adePlugin` bridge is the entire capability, and even `collections.put` through it is refused on the desktop app (write through `invoke` instead). iOS, the web client and the TUI render the surface's `panelId` panel in its place. **There is no custom native UI on iOS or the TUI at all**; declarative panels are the only cross-device UI that exists.

**Nothing you write executes anywhere but the owning machine.** The other clients render data — they never run a plugin's code, which is why a value has to be materialized in render shape before anyone can see it. The `mobile` flag only ever takes a surface away from the phone (see *Mobile*); it cannot put code there.

**The six built-in surface bindings belong to ADE's own plugins.** `graph`, `review`, `history`, `linear`, `ios` and `app-control` are gated by `ade-graph`, `ade-review`, `ade-history`, `ade-linear`, `ade-ios-sim` and `ade-app-control`. A manifest that does not set `official: true` has its `builtin` dropped with a warning; a manifest that does set it still only gates the surface whose registered owner is its own plugin id, because the owner table is compiled into every client. Naming someone else's surface parses clean and changes nothing.

**You cannot declare yourself Official.** The directory decides: an entry is official only when ADE's curated `official.json` lists it *and* both its repo and its install source sit in ADE's own GitHub organizations — otherwise it lists as community with a warning. Official entries carry a per-version sha256 the installer checks against the fetched tree; community plugins are not checksummed by the directory and install as unverified. Being listed in the Marketplace is not an endorsement.

**Sockets and action domains are closed sets.** You fill the seventeen slots above on those eight surfaces; there is no way to inject UI anywhere else, and placement is host-controlled and always after core content, so a contribution never reorders or interleaves with the product's own rows. `ade.actions.invoke` reaches ADE's existing action domains at **agent** role — CTO-only actions are refused — and a plugin cannot define a domain of its own.

**Plugins cannot see each other.** The SDK server is constructed per plugin and answers every call against that plugin's id; the child never puts an id on the wire. Collections must be declared in your own manifest (an undeclared name is refused, not created), secrets are namespaced `plugin:<id>:<NAME>`, and `config.get()` returns your own settings. There is no cross-plugin read of any kind.

One limit that is not about sharing, because it will bite you anyway: the *process* may work for as long as it likes, but the *host round-trip* is supervised. The child has 20s to send `ready` after it is spawned, one `invoke` is capped at 60s and then fails with `plugin_timeout`, and after 5 crashes in a row inside the first minute of life the host stops reviving it until someone reloads. Long work belongs in `activate` or an event handler, with the result stored — never inside the action the user is waiting on. The exceptions are `composer-action`, `slash-command` and `chat-header-action`, which get 15 minutes because the user watches them work the whole time (*Long-running actions*).

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
| `surfaces[]` | no | `{kind: "tab"\|"pane"\|"webview", id, title, panelId, icon?, order?, mobile?, builtin?}`. `panelId` is required on all three kinds. A `webview` also needs `entryHtml` — see *Custom UI*. `mobile` — see *Mobile*. `builtin` names a compiled-in ADE tab this plugin gates instead of rendering, and is reserved — see *What you can build* |
| `panels[]` | no | `{id, schemaFile?, title?, icon?, refreshAction?}`. `schemaFile` is the default schema; `sdk.panels.update()` replaces it at runtime. `refreshAction` names one of your actions and turns on a refresh gesture — see *A panel that fetches* |
| `sockets[]` | no | See *Sockets* below |
| `collections` | no | `{"<name>": {"sync": true\|false}}`. `sync: true` rides the sync layer to your other devices |
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

- **Default: `true`** for a `tab` or a `pane`. Say nothing and your panel shows up on the phone, which is the point of writing a panel schema instead of a page.
- **`false` is a good answer** when the panel needs a wide table, a long form, or a keyboard to be worth opening. Hiding it there is kinder than shipping a cramped version of it.
- **A `webview` is desktop-only either way.** Its page never draws on the phone; the panel named by its `panelId` does. Setting `mobile` on a webview surface changes nothing (ADE warns and ignores it), so put your effort into making that panel say something useful.
- **`mobile` only ever takes a surface away.** It cannot add one. A value that is not `true` or `false` is ignored with a warning, and the default applies.

Set it per surface, not per plugin: a plugin with a summary pane and a settings tab can keep the first and drop the second.

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

Five manifest families that are **not placements**. A socket says "draw me here"; each of these says "when X happens, ask me" — a tool the agent may call, an automation trigger a rule can fire on, a step a rule can run, a provider universal search may query, a chord that invokes an action.

All five are declared in the **manifest** rather than registered by the running child, for one reason worth understanding: the rule builder, the shortcut listing, the search palette and the agent's tool list all have to describe a plugin that is installed but **not currently running**, and a list the child publishes at boot is empty exactly when the user is looking. Tool sets in particular are built synchronously at session start, so a list published after boot could never reach Claude without restarting the chat. Declaring in the manifest also makes uninstall a non-event — the declaration leaves with the install record.

Four of them share one shape, `{id, label, action?}`, deliberately, so an author does not learn four spellings of the same promise:

| Family | Cap | Shape | Notes |
|---|---|---|---|
| `tools[]` | 24 | `{name, description, input, action?}` | The agent sees `plugin__<pluginId>__<name>`. `action` defaults to `name` |
| `automationTriggers[]` | 8 | `{id, label, description?}` | The manifest supplies the *vocabulary*; the plugin fires it with `ade.automations.emitTrigger`. `id` is stored by rules, so renaming one orphans every rule using it |
| `automationSteps[]` | 12 | `{id, label, description?, action}` | A step a rule may run. `action` defaults to `id` |
| `searchProviders[]` | 2 | `{id, label, action}` | Invoked live with `{query}`. `action` defaults to `id` |
| `keybindings[]` | 6 | `{binding, label, action}` | One chord, e.g. `"Mod+Shift+P"` |

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
| `text` | **`text`**, `variant` (`title`\|`subtitle`\|`body`\|`caption`\|`code`), `tone`. `code` is the only monospace affordance |
| `badge` | **`text`**, `tone`, `icon` |
| `button` | **`label`**, **`onPress`** (a `VocabAction`), `kind` (`primary`\|`default`\|`quiet`), `icon`, `disabled` |
| `list` | **`items[]` or `bind`**, `emptyText`. Item: **`title`**, `subtitle`, `meta`, `tone`, `icon`, `onPress`, `badge` `{text, tone?, icon?}`, `mono`, `actions[]` (≤3), `overflow[]` (≤6) |
| `table` | **`columns[]`** and **`rows[]` or `bind`**, `emptyText`. Column: **`key`**, **`label`**, `align` |
| `form` | **`fields[]`**, **`submit`** `{label, onPress}`. Field kinds: `text`, `secret`, `select`, `toggle`, `number` |
| `chart` | **`kind`** (`line`\|`bar`), **`series[]`** of `{id, label?, tone?, points:[{x,y}]}`, `title`, `emptyText` |
| `video` | **`src`**, `poster`, `title` |
| `image` | **`src`**, **`alt`**, `maxHeight` |
| `divider` | `label` |
| `keyValue` | **`rows[]` or `bind`**, `emptyText`. Row: **`key`**, `value`, `tone` |
| `emptyState` | **`title`**, `description`, `icon`, `action` `{label, onPress}` |

Tones are `neutral`, `accent`, `success`, `warning`. **There is no red.** Any red-ish value you write (`danger`, `error`, `fail`) folds to `warning` — the house rule cannot be bypassed by a payload.

`bind` reads your own `plugin_collections` rows: `{collection, keyPrefix?, limit?, allowActions?}`. The rows must **already be in render shape** for the component that binds them — a `list` binding reads `{title, subtitle?, …}` values, a `table` binding reads column-keyed records. The renderer does no reshaping.

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

### Per-surface support

| Component | Desktop / web | iOS | `ade code` TUI |
|---|---|---|---|
| `stack`, `text`, `badge`, `button`, `list`, `table`, `keyValue`, `divider`, `emptyState` | full | full | full |
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

`maxNodes` 200 · `maxDepth` 8 · `maxSchemaBytes` 65,536 · `maxSelectOptions` 40 · `maxTableRows` 100 · `maxTableColumns` 8 · `maxListItems` 100 · `maxKeyValueRows` 60 · `maxChartSeries` 3 · `maxChartPoints` 200 · `maxFormFields` 24 · `maxTextChars` 4,000 · `maxLabelChars` 200 · `maxValueChars` 1,000 · `maxBindingAllowActions` 16.

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

Both are read tolerantly: a result carrying neither behaves exactly as before, and a refused `openUrl` is logged rather than passed on silently.

The same destination has a link:

```bash
ade link plugin graph detail --ctx '{"issue":"ISS-14"}' --ade
# ade://plugin/graph/detail?ctx=…   (drop --ade for the https://ade-app.dev/open form)
```

The link opens the panel on a machine where the plugin is installed and enabled, and says so plainly on one where it is not — plugins are per-machine, so a link one person mints is routinely a link another cannot open. A malformed or oversized `ctx` on the way in is dropped and the panel still opens; `--ctx` on the way out refuses rather than minting a link quietly missing what you asked for. In the TUI, `Ctrl+Y` copies a link to the panel you have open.

## Custom UI (webview)

A `webview` surface renders the plugin's **own HTML page** instead of a panel schema. It is the one place a plugin ships UI code, and the price is fixed: the page draws on the desktop and nowhere else. iOS, the web client, and the TUI render the surface's `panelId` panel in its place — which is why `panelId` is required on a webview surface rather than optional.

### When to choose it — and when not to

The vocabulary's ceiling is the thirteen components above, arranged in stacks. Rows, tables, key/value pairs, forms, a line or bar chart, an image, a video. No expressions, no conditionals, no custom layout, no pointer events of your own, no canvas, no drag.

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
| `row-badge` | any | `{text, tone, icon?, tooltip?}` | A badge on a row |
| `row-menu-item` | any | `{label, actionId, icon?, danger?}` | An entry in a row's context menu |
| `detail-section` | any | `{panelId, title?}` | A panel rendered as a section in a detail view |
| `empty-state` | any | `{title, body?, actionId?, actionLabel?}` | Extra content on a surface's empty state |
| `filter-chip` | any | `{label, filterKey, count?}` | A chip in a surface's filter row |
| `file-viewer` | `files` | `{panelId, extensions[]}` | A viewer for matching files in the Files tab |
| `composer-action` | `work` | `{label, actionId, icon?, disabled?, menu?, color?}` | A button in the chat composer's accessory row. May run for minutes — see *Long-running actions* |
| `chat-header-action` | `work` | `{label, actionId, icon?, disabled?, menu?, color?}` | A button in the chat's header. Receives the **session**, not the surface — see below |
| `chat-card` | `work` | `{panelId, title?, icon?}` | Your panel, drawn as a card in the chat transcript |
| `slash-command` | `work` | `{command, actionId, description?, argumentHint?, icon?}` | A command the user types into the composer. Same long budget as `composer-action` |
| `command-palette-action` | `app` | `{label, actionId, icon?, disabled?}` | An entry in the ⌘K palette |
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
| `ade.actions.invoke(domain, action, args?)` | Invoke an ADE action at **agent** role. CTO-only actions are refused; project-scoped domains need `projectId` in `args` |
| `ade.collections.get(collection, key)` | Read one value |
| `ade.collections.put(collection, key, value, options?)` | Write one value. Budget-checked inside the writer transaction. `{ifFull: "evictOldest"}` drops the oldest entries in that same collection to make room instead of refusing — see *Never stall* |
| `ade.collections.delete(collection, key)` | Delete one value |
| `ade.collections.list(collection, {keyPrefix?, limit?})` | Rows as `{collection, key, value, updatedAt}` |
| `ade.secrets.get/set/delete(name)` | Machine credential store, namespaced `plugin:<id>:<NAME>`. Never readable by another plugin |
| `ade.contributions.publish(entityKind, entityId, socket, payload)` | Publish or clear (`payload: null`) a dynamic contribution |
| `ade.events.on(event, cb)` | Two families — **change events** `lane.changed`, `pr.changed`, `session.changed`, `install.changed` (debounced; payload `{event, ids[], projectId, overflow?}`, where `overflow: true` means `ids` was truncated at the delivery cap and you should treat it as a bare refetch signal rather than trusting the partial list) and **runtime hooks** `turn.start`, `turn.end`, `tool.before` (told as they happen — see *Runtime hooks* below). Returns an unsubscribe function; call it, because a hook kind nobody subscribed to is never delivered at all |
| `ade.panels.update(panelId, schema)` | Replace a panel's schema. Refused for a panel the manifest never declared |
| `ade.config.get()` | Current values for `manifest.settings`, defaults applied. `secret` kinds are redacted |
| `ade.memory.get/set/delete(key)` / `list({keyPrefix?, limit?})` | Your own durable memory: a reserved slice of your collections, no manifest declaration needed. Shares the collection budget and is dropped on uninstall. **Not** ADE's CTO memory — nothing you write here reaches any agent's prompt. `ade.memory` is refused as a `collections` name in both directions, so this slice has exactly one door |
| `ade.notifications.post({title, body?, target?, deeplink?})` | Tell the user outside ADE's window. `target` is `"desktop"`, `"mobile"` or `"both"` (default). Your **display name is stamped on by the host** and cannot be set, spoofed or omitted. `deeplink` decides where a tap lands and must be `ade://plugin/<your-own-id>/<panel-id>[?ctx=…]`, max 1,024 chars — anything else costs the destination, not the notification, and the tap opens your plugin as before. It reaches the phone; the desktop notification has no destination field. Resolves `{delivered: [...]}` with what actually landed; rejects `notification_unavailable` only when nothing was reached. Rate-limited — see *Budgets* |
| `ade.schedules.create({action, cron\|runAt\|delaySeconds, args?, note?})` | Ask ADE to call one of **your own** actions later. `cron` is five-field local time and recurs; `runAt`/`delaySeconds` fire once and are then dropped. Rejects `plugin_budget_exceeded` past the quota |
| `ade.schedules.list()` / `delete(scheduleId)` | Your schedules, never another plugin's. `delete` is idempotent |
| `ade.clipboard.read()` / `write(text)` | Machine clipboard, text only. A read returns whatever the user last copied — often a password they were moving between apps — so read it in response to something the user just did, never on a timer |
| `ade.dialogs.pickFile({title?, defaultPath?, directory?, filters?})` | Native picker; resolves the chosen path. Rejects `dialog_cancelled` when the user dismisses it — a dismissal is an answer, not a fault |
| `ade.log(level, message, fields?)` | `debug`/`info`/`warn`/`error` into the ring buffer `ade plugin logs` reads |
| `ade.pluginId` / `ade.sdkVersion` / `ade.manifest` | Identity, read-only |

The last four need a host that can perform them. `notifications`, `clipboard` and `dialogs` are the desktop's — a plugin running against a headless daemon gets `notification_unavailable` or `desktop_unavailable`, which are refusals worth retrying later rather than reasons to give up. Check the code, don't check the platform.

**Two things you may no longer borrow through `ade.actions.invoke`, because these verbs replace them:** `session.requestSessionAttention` (its push arrived unlabelled and unlimited, and it lied about a chat session waiting on the user) and `chat.createScheduledWork` (its cron carried no owner, so nothing listed it as yours and uninstalling you left it firing forever). Both are refused for plugins and name their replacement in the refusal.

`PLUGIN_SDK_VERSION` is **0** and the handshake is additive: methods get added, never removed or re-shaped. Anything that would break a shipped plugin gets a new method name.

Every rejection is a structural error carrying a `code` you can branch on: `plugin_not_found`, `plugin_disabled`, `plugin_no_entry`, `plugin_crashed`, `plugin_timeout`, `invalid_args`, `plugin_budget_exceeded`, `not_permitted`, `unsupported_method`, `internal_error`, plus `notification_unavailable`, `desktop_unavailable` and `dialog_cancelled` from the host capabilities above. A budget refusal additionally carries `detail: {budget, limit, actual}` — enough to tell the user exactly which ceiling they hit.

Naming rules the SDK enforces: collection names `^[A-Za-z][A-Za-z0-9._-]{0,63}$`, keys `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$`, secret names `^[A-Za-z][A-Za-z0-9_.-]{0,127}$`.

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

Declare `{"socket": "row-badge", "surface": "prs", "id": "ci"}`, then publish per PR from the machine that owns the data:

```js
ade.events.on("pr.changed", async ({ ids }) => {
  for (const number of ids) {
    const status = await checkCi(number);
    await ade.contributions.publish("pr", number, "row-badge",
      status ? { text: status, tone: status === "green" ? "success" : "warning" } : null);
  }
});
```

Publishing `null` clears the badge — do that rather than leaving a stale one, and remember badges cap at 2 visible per row.

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
