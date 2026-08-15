# ADE plugin alpha test: Tipsy retrospective

Date: 2026-08-14
Lane: `52188131-8867-497f-931f-fba65fe172db` (`ade/ade-plugin-context`)
Scope: the user conversation, the desktop/iOS alpha-platform test, and the resulting user experience

## Purpose and scope

This report records an end-to-end attempt to make and use a small ADE plugin from the point of view of a person trying to customize ADE through an agent. It is intentionally observational. It does not prescribe fixes, propose an implementation plan, or turn the findings into a product roadmap.

The experiment was called **Tipsy**. The concept was deliberately small and playful: an agent could take a drink, display a drink count, become increasingly drunk through ten levels, and be returned to normal with a sober-up action. The point was not the drinking theme itself. The point was to test whether a user could describe a plugin in natural language, have an agent build and publish it, see it immediately in ADE, use it on desktop and iOS, and understand what was happening at each boundary.

The test also happened against an alpha plugin platform whose implementation was not on the normal `main` branch. That distinction became part of the test. The experience therefore exposed both plugin-product behavior and the agent’s ability to identify the correct code, branch, installation, runtime, and client surface before making claims about what had been built.

The report has two parts:

1. A chronological account of the user journey and the interactions that led to the current state.
2. An analysis of what the experience communicated well, what it communicated poorly, what was technically observed, and where the plugin-development skill and surrounding workflow failed to provide a reliable mental model.

## Part I: Raw conversation, interactions, and steps

### 1. Starting with context and the plugin model

The conversation began with a request to start with the context skill and establish whether the agent understood ADE plugins and how to make them. This was not initially a request for code. It was a request for confidence that the agent knew the platform it was about to modify.

The user then described the testing goal: ADE was in an alpha build with new plugin code that was not on `main`, and the user wanted to make a simple plugin, publish it, and use it immediately. The user was explicitly testing the plugin system itself rather than asking for a polished production feature.

The first idea was a “drunk agent.” The user imagined a small drink control that would cause visible and behavioral changes over time: screen shaking, increasingly drunk language, worse usefulness, and eventually an extreme “blackout drunk” state. The initial questions covered whether this could work on desktop, whether it could work on mobile, and where the plugin could participate.

### 2. Exploring hidden state versus visible UI

The user asked whether a plugin could insert something in the background without showing it to the user. The discussion then moved to whether the plugin could affect the underlying SDK process and steer the agent without displaying the intervention in the main thread.

This distinction mattered to the user. They were not only asking for a visible novelty button; they were asking whether a plugin could change the agent’s behavior through hidden context or state while keeping the transcript clean. The later implementation clarified that the Tipsy skill reads the drink state at the start of a new agent turn. It does not poll an already-running turn, inject into a live SDK process, or retroactively alter the current agent context.

The user also asked how the agent would “see” the drink. The practical answer was that the plugin stores and exposes state, and the skill can read that state when a new turn begins. That answer was important, but it came after several rounds of uncertainty about whether a visible button, a plugin panel, a skill, and the agent runtime were the same mechanism.

### 3. The requested plugin behavior

The user authorized building the plugin for desktop and iOS and described a deliberately minimal, non-interrupting interaction:

- A button in the chat header, described as something like “Take a drink.”
- Each press increases the count: “1 drink in!”, “2 drinks in!”, and so on.
- Ten drinks means “blackout drunk.”
- At the highest level, the agent should be extremely drunk, unhelpful, and barely coherent.
- When the count is above zero, an arrow or dropdown should expose a sober-up action.
- Sober-up should return the agent to zero and normal behavior.
- The action should not interrupt ongoing agent work.
- The surrounding chat background might visually fill with beer as the count rises.

The user asked whether the custom background idea was possible before asking for the build. The response distinguished a native plugin from a separate webview or custom page. The user questioned why a separate webview would be needed and whether a native plugin could produce the desired effect directly in the existing chat.

The user ultimately chose the native-plugin direction and asked the agent to go end to end: build it, publish it, find or create a beer-related logo, make it available immediately, and set it up automatically for testing.

### 4. What the first visible result communicated

The first visible result did not match that request cleanly. The user encountered a puzzle-like default icon rather than a recognizable Tipsy logo. The control appeared in a composer area rather than in the requested chat header. There was no visible dropdown action for sober-up. The agent itself did not start behaving drunk.

The user asked, in substance, why the plugin had not done what was requested, whether the limitations were ADE limitations, and why the agent was not affected by the plugin. This was the first major trust break: the user had authorized an end-to-end test and expected a clear statement of what had actually been delivered. Instead, the UI made the result look like a partially realized plugin with a fallback icon and a control in an unexpected location.

The user then shifted from asking for more implementation to asking for an explanation of the plugin system’s boundaries. They wanted to know which parts were installed, whether uninstalling would remove everything, whether plugin state was account-wide or machine-local, and how mobile testing worked.

### 5. Understanding agent timing and plugin lifecycle

The conversation established a critical lifecycle distinction: a plugin skill is not the same thing as a live runtime interceptor. The Tipsy skill checks the stored level at the beginning of a new agent turn. If an agent turn was already running before the skill or plugin was installed, that turn would not automatically become drunk. Even if the plugin level changed while the turn was running, the current turn would continue with its existing context.

This explained why the agent in the conversation did not immediately become drunk. The user had expected the plugin to affect the agent they were currently talking to. The observed behavior was closer to “the next turn may read a new state,” not “the current agent process is now under plugin control.” That difference was not obvious from the visible button or the plugin installation status.

### 6. Moving to iOS and the simulator

The user asked whether the plugin needed to be rebuilt for mobile and whether it could be tested in a simulator. The answer evolved into a request to launch the simulator on the current computer.

The simulator portion became frustrating. The agent discussed other plugin and context concepts when the user wanted a direct simulator launch. The user repeatedly said, in increasingly direct terms, to ignore the extra explanation and launch the simulator. There was also confusion about which ADE app and which code checkout were being launched.

The eventual iOS work used the simulator and rebuilt the app from this lane. The direct computer-use backend was unavailable with an `Unknown error -1743`, so the simulator was operated through the available build/install/launch/screenshot path rather than through a completed interactive computer-use flow. This allowed launch-screen verification but did not produce a full, successful tap-through test of the mobile Tipsy chat action.

### 7. Pairing and sign-in screens

The iOS simulator exposed a separate but related set of problems. The user saw a launch screen with a prominent sign-in button and a “Pair again” action, alongside text saying that the phone had a saved pairing whose key could no longer be read. The user expected a clear choice between signing in and continuing without an account, while still being able to connect machines locally.

The user then shared screenshots of the connection UI. The visible phrases included:

- “Continue to ADE”
- “Continue”
- “Pair again”
- “Connected” or “Not connected”
- “Pair once on Wi-Fi to remotely connect later.”
- “No machines yet. Add one below.”

The user found “Continue to ADE” confusing because the person was already inside ADE. They expected wording that described the actual account action, such as signing in to ADE to reach computers from another network. They also questioned why the connection screen implied that pairing once on Wi-Fi was a universal prerequisite, when an account-backed connection and a manually paired local connection have different semantics.

The lane included iOS copy and launch-gate changes that made the unauthenticated path explicit and separated account sign-in from local pairing repair. The current screenshots and code therefore reflect an intermediate alpha-platform repair, not the original unmodified behavior.

### 8. The mobile chat result

The user showed a mobile chat screenshot with no visible Tipsy drink control. This contradicted the expectation created by the earlier request to build the plugin for desktop and iOS.

At that point, the user’s mental model was simple: if the plugin was installed and the action existed in the plugin manifest, the same action ought to be visible in the mobile chat. The actual platform model was more conditional: iOS receives materialized plugin contribution rows through sync, and a mobile host only renders socket types that it supports. A manifest declaration alone is not enough for the phone.

### 9. Reconstructing the alpha lane

The later lane inspection found that the active lane had initially been based on `origin/main`, while the alpha plugin-platform implementation was available from the separate `origin/plugin-platform` ref. The current lane therefore did not initially contain the iOS and desktop plugin host code that the user believed was being tested.

The alpha plugin platform was integrated into this lane, and the iOS connection copy and composer presentation were updated. The iOS composer action was made visibly labeled rather than icon-only. The lane was rebuilt and tested.

This reconstruction explained why the earlier conversation had felt as if the agent was talking about a plugin system that did not exist in the current checkout. The system was real, but its code provenance was not established early enough. The user was testing an alpha feature while the active lane still looked like ordinary mainline ADE.

### 10. The latest cross-surface observations

After the iOS work, the user observed another mismatch. On mobile, the Tipsy action displayed an icon that looked like tea or coffee rather than a beer stein. On desktop, the same conceptual action displayed a beer icon. The mobile screenshot also showed a shortened, truncated action label in the composer.

The user additionally observed that the desktop action appeared in a new chat pane even though the request had been for an existing chat header. On mobile, the action did not appear in the corresponding location. The user asked whether a plugin could add an item to the three-dot menu in the top-right of the mobile chat.

The current iOS socket taxonomy confirms that the phone has hosts for several contribution kinds, including toolbar actions, row menu items, composer actions, chat cards, and activity entries. It does not define a plugin socket for the chat header’s top-right menu. The phone’s composer action is session-scoped, and the iOS composer explicitly draws no plugin actions in its compact layout. This gives a code-level explanation for why “installed plugin” and “same visible control on every chat surface” did not amount to the same thing.

## Part II: Analysis and observations

### What worked

The plugin idea itself was easy to understand and small enough to exercise many platform boundaries. The user could describe a stateful interaction in ordinary language: increment a value, show the value in a button, expose a reset action, and change agent behavior at future turns. That is a useful test shape because it includes state, UI, invocation, skill behavior, and lifecycle without requiring a large feature.

The eventual Tipsy plugin had several working pieces:

- A stored drink level with a zero-to-ten range.
- A visible level label and drunk-state profile.
- A panel that could display the state.
- A composer action whose label changed as the level changed.
- A sober-up action exposed through the plugin’s actions/panel/command model.
- A skill that could read the level at the beginning of a new agent turn.
- A CLI status surface that made the installed plugin and current level observable.
- Synced plugin collections and materialized contributions that made the state available to iOS when the host and socket path were present.

The user’s testing style was also productive. They did not stop at the first button. They compared desktop and mobile, tried a fresh chat, inspected the pairing flow, tested sign-in versus local use, questioned uninstall and account scope, and asked why the current agent was not affected. Those questions exposed boundaries that a happy-path plugin demo would have hidden.

The later lane work produced concrete verification rather than only source-level assertions. The iOS simulator build passed, the focused plugin and launch-gate tests passed, desktop typechecking passed, and the desktop plugin icon tests passed. Those checks establish that the alpha platform and the local iOS changes compiled and passed their targeted automated checks. They do not establish that every requested mobile interaction was reachable in a live chat; the direct computer-use backend failure prevented that full visual interaction test.

### The central expectation mismatch: “installed” versus “immediately usable everywhere”

The user’s expectation was that publishing or installing a plugin would produce an immediately usable feature in the current chat on every requested client. The actual system has multiple states that are easy to conflate:

1. The plugin source exists in a repository.
2. A package has been published or made available to a registry.
3. A local ADE installation has the plugin enabled.
4. The plugin process has activated and written presence/state.
5. The plugin has materialized a contribution row for a particular entity.
6. The current client knows how to render that contribution kind.
7. The current agent turn has loaded the skill and state.

The conversation moved between all seven without a stable, visible status model. The CLI could report that `ade-tipsy` was enabled and at level seven, while the mobile chat could still show no action. The plugin could be active while the current agent remained sober. A source repository could exist in another checkout while the current lane lacked the platform host code. From a developer’s perspective these are distinct states; from the user’s perspective they all looked like “the plugin is installed but it does not work.”

This was the biggest source of frustration. The user wanted to test the plugin, not learn a hidden deployment topology before getting the first successful interaction.

### Branch and alpha provenance were not established early enough

The lane’s initial relationship to the alpha plugin code was a major problem. The user explicitly said that the alpha build contained code not yet on `main`, but the active lane initially looked like a mainline checkout without the plugin platform. The agent proceeded through conceptual and implementation discussion before establishing which ref contained the relevant desktop and iOS host code.

The result was a credibility problem rather than only a Git problem. When an agent talks about plugin sockets, mobile contributions, and publishing while the active checkout does not contain those surfaces, the user cannot tell whether the platform is incomplete, the agent is mistaken, or the plugin failed. Later inspection showed that the alpha implementation was available from `origin/plugin-platform`, but that fact arrived after the user had already seen incorrect or incomplete behavior.

The external Tipsy source introduced a second provenance boundary. `plugins/ade-tipsy/` is a nested repository and was intentionally not included in this ADE lane’s commit. The platform integration belongs in this branch; the plugin source belongs elsewhere. That is expected from the user’s architecture, but it makes “commit all the work” inherently selective. The user needs to distinguish platform changes, test artifacts, installed plugin state, and the external plugin repository.

### Surface parity was weaker than the plugin manifest suggested

The same `beer` icon token did not render the same image. Desktop maps it to a Phosphor beer stein. iOS maps it to the SF Symbol `cup.and.saucer.fill`, which visually reads as tea or coffee. The user experienced this as the plugin not having the real logo they had asked for, even though the plugin had an SVG icon and a beer token in its manifest.

The action’s placement also differed:

- The user asked for a chat-header control.
- Desktop showed a composer-area control, including in a new-chat pane according to the user’s observation.
- Mobile did not show it in the corresponding chat screenshot.
- iOS’s actual host is session-scoped and does not expose the chat header’s top-right menu as a plugin socket.
- iOS’s compact composer intentionally renders no plugin controls.

The user did not see these as nuanced platform contracts. They saw one plugin that looked different depending on the client and that appeared in a place they had not requested. The distinction between “composer action,” “toolbar action,” “header menu item,” and “row menu item” was not visible enough to protect the user from that expectation.

The user’s question about adding the action to the mobile three-dot menu is therefore not just a request for another UI location. It exposed a missing or undocumented socket category from the user’s point of view. The current iOS code has no explicit plugin contribution kind for that chat-header menu.

### The requested dropdown never materialized as the expected control

The user described a small arrow on the drink button that would expose “sober up” once the count was above zero. The resulting plugin had a sober-up action in its panel/command model, but the visible composer control did not acquire the requested dropdown behavior.

This was a particularly sharp mismatch because it was concrete and easy to verify. The user was not asking whether the underlying action existed. They were asking for a specific interaction attached to the visible drink button. Seeing a drink button with no arrow made the result look unfinished, even if a separate panel or slash command could eventually reach the reset action.

The plugin contract’s available menu concepts were not equivalent to the requested one. A slash command, panel button, composer overflow menu, row menu item, and chat-header dropdown each have different discoverability and context. The user experienced their absence or substitution as “the thing I asked for was not built.”

### Chat background styling was an expectation boundary

The user proposed a beer-filled chat background as the drink level increased. The discussion established that the plugin contract did not expose arbitrary styling of the surrounding chat transcript. This limitation was understandable at the platform level, but it arrived after the user had already begun thinking in terms of a native plugin that could customize ADE itself.

The user’s broader goal was customization: “I can customize ADE as I want.” A plugin that can add a panel and composer action but cannot alter the chat background or header can still be useful, but it is a narrower customization model than the user imagined. The difference between “extend ADE through declared sockets” and “customize any part of ADE’s native UI” was not clear at the beginning.

### Agent behavior was not retroactive

The most important runtime observation was that the Tipsy plugin did not directly take control of the current agent. Its skill reads state at the start of a new turn. It does not alter a turn that began before installation, does not continuously poll the drink meter, and does not invisibly steer the provider SDK process during an active response.

The user asked why the agent was not drunk and whether it was because the agent had started before the Tipsy skill arrived. That interpretation was substantially correct. The active conversation was not automatically rehydrated with the new skill behavior simply because the plugin was installed or the drink count changed.

This was confusing because the requested behavior was phrased as “the agent gets drunk,” while the actual mechanism was “future turns may receive a skill-driven behavior modifier based on stored plugin state.” The visible UI did not explain this temporal boundary. The plugin’s state, the skill’s loading time, and the provider process’s current context appeared to the user as one system.

The observation also explains why a plugin can be installed successfully while the agent in the same visible chat appears unaffected. Plugin installation is not equivalent to modifying the current transcript’s runtime context.

### Account, pairing, and machine scope were mixed into the plugin test

The user asked whether installed plugins were account-wide, whether a fresh ADE install would have no plugins, and whether uninstalling would fully remove the skill and all effects. Those questions were not answered by a clean, demonstrated lifecycle test in this conversation. The local CLI showed the plugin enabled on the development machine, but the experiment did not establish a fresh-install or second-account boundary.

The iOS pairing UI then made the scope problem more visible. Account sign-in, local Wi-Fi pairing, saved pairing keys, remote access, and simulator state all appeared in a small set of screens. The user reasonably questioned the difference between “Continue to ADE,” “Continue without an account,” “Pair again,” and “Sign in.” The words suggested transitions inside ADE rather than distinct authentication and connection modes.

The user’s complaint was not limited to copy. They were trying to determine whether a plugin installed on the desktop would be available to the phone, whether the phone was connected to the same machine, whether the account was required, and whether a broken saved pairing was the same thing as being signed out. The screens did not make those boundaries self-evident.

### Simulator and computer-use friction amplified the product confusion

The simulator was part of the user’s requested test, not an optional side task. The agent’s early responses spent too much time on plugin context and other tool concepts when the user wanted the simulator launched. The user eventually used blunt language because the operational request was simple and the agent was not acting on it quickly.

The direct computer-use backend then failed with `-1743`, so the work fell back to build/install/launch/screenshot operations. That was enough to verify that the iOS app built and launched, but not enough to prove the full plugin action path interactively. The difference between “the simulator is open,” “the app is the build from this lane,” “the app is paired,” and “the Tipsy action can be invoked in a mobile chat” remained important and only partially verified.

The user also noticed that the wrong app or wrong code context could be launched. This was especially damaging because the user had already warned that the alpha code lived on a special lane. Launching an app that does not contain the intended platform makes all subsequent visual testing ambiguous.

### What the user liked or found valuable

The user remained engaged because the experiment was inherently fun and because the failures were informative. The drink meter was a good test idea: it was visually obvious, stateful, easy to reset, and able to exercise both plugin UI and agent behavior.

The user valued the ability to ask the agent to do the whole loop rather than manually wiring a demo. They wanted the experience of a future external user: describe a customization, have the agent build it, publish it, and immediately use it. That made the rough edges meaningful rather than theoretical.

The user also accepted the idea that this run was useful as a plugin-platform test even after the implementation disappointed them. By the end, they explicitly reframed the lane as a learning exercise and asked for a detailed report for the other agent working on the plugin platform. The user’s approval was for documenting the problems honestly, not for pretending the first result met the original request.

### What the user disliked and where frustration accumulated

The frustration accumulated from repeated small mismatches rather than one isolated defect:

- The agent did not establish the correct alpha branch before discussing implementation.
- The first result looked like a fallback puzzle icon instead of a branded plugin.
- The visible action was not in the requested chat header.
- The requested dropdown/sober-up affordance was absent.
- The chat background could not be customized as imagined.
- The current agent did not become drunk.
- Desktop and mobile did not show the same action in the same place.
- The mobile icon looked like tea or coffee.
- The mobile label was truncated.
- The mobile chat screenshot had no drink action.
- The desktop action appeared in a new-chat surface the user did not want affected.
- The simulator launch involved unnecessary discussion and ambiguity about the app being tested.
- The pairing UI made sign-in, local pairing, and saved-key repair look like overlapping states.
- The scope of install, publish, uninstall, account state, and machine state remained unclear.

The user’s language moved from curiosity to direct frustration: asking “did it work?”, saying that the result genuinely did not do anything well, demanding that the simulator simply be launched, and questioning why the agent was talking about another plugin or app. The emotional trigger was not merely that alpha code had limitations. It was that the agent appeared to claim progress without giving a crisp account of which repository, branch, client, plugin installation, and runtime turn were actually involved.

### What the plugin skill conveyed poorly

The plugin skill contained useful platform concepts and a broad socket model, but the practice run showed several communication gaps.

First, the existence of a socket taxonomy did not translate into an immediate user-facing answer to “where can my button go?” The distinction between a composer action, a toolbar action, a row menu item, and a chat-header menu was technically meaningful but not present in the user’s mental model.

Second, the skill did not force an early provenance check. The user had supplied the critical fact that the alpha code was not on `main`, but the workflow did not visibly begin by proving which branch or ref contained the host implementation. That allowed the agent to reason from a platform model before confirming that the current lane had the platform code.

Third, the skill’s lifecycle information was not concise enough at the moment it mattered. The user needed to know the difference between plugin source, published package, enabled local installation, materialized contribution, client rendering, and next-turn skill behavior. Those distinctions were discovered across the conversation instead of presented as a single end-to-end state model.

Fourth, the skill did not make cross-surface parity an explicit acceptance boundary. Desktop and iOS can consume different data sources and support different socket kinds. The practice run revealed that a plugin can pass a desktop icon test and still render a different symbol on iOS, or be visible in one composer layout and absent in another.

Fifth, the skill did not prevent overclaiming. The agent treated “build and publish” as if it implied “available immediately in the current chat on desktop and iOS,” even though the actual workflow includes installation, activation, sync, session materialization, client support, and agent-turn timing.

Finally, the skill could explain the contract but did not by itself produce a reassuring testing narrative. The user was asking an agent to act as a builder and tester. The experience needed a truthful statement of what was built, what was installed, what was visible, what was not reachable, and what remained unverified. Instead, that statement emerged only after several rounds of user correction.

### The unresolved questions left by this experiment

These are recorded as unresolved observations, not recommendations:

- What exactly counts as “published” for a local ADE plugin, and how that differs from a plugin being enabled on one machine.
- Whether plugin installation is account-scoped, machine-scoped, or both, and what a fresh ADE installation inherits.
- Whether uninstall cleanup can be observed and verified across the panel, contributions, skill, schedules, stored collections, and installed package.
- Whether the desktop new-chat composer action is intentionally supported, accidentally visible, or a consequence of session/contribution timing.
- Whether the absence of the mobile action was caused by no materialized session contribution, unsupported compact layout, stale sync, or a combination of those conditions.
- Whether the iOS top-right chat menu is intentionally core-only or simply not yet represented in the mobile plugin taxonomy.
- Whether icon tokens are expected to be cross-platform semantic names or platform-specific aliases, given that `beer` rendered as beer on desktop and cup/tea on iOS.
- Whether the plugin skill’s start-of-turn behavior is sufficiently visible to an external user who expects an installed plugin to affect the current agent.
- Which pieces of plugin state are synced to a phone and which remain host-local.
- How an agent should identify that a plugin lives in a different repository from the ADE lane while still testing the lane's host code.

### Follow-up: the uninstall test and the command-line permission maze

After the main retrospective was written, the user tested removal of Tipsy. This follow-up is part of the same user-experience record because uninstall was supposed to answer a basic lifecycle question: after a plugin is removed, is it actually gone, and can an ordinary user perform that operation without learning ADE's internal runtime topology?

The first command was the natural one:

```text
ade plugin remove ade-tipsy --text
```

In the user's normal terminal, that produced `Unknown command 'plugin'`. The shell was resolving `ade` to the stable `/Applications/ADE.app` CLI, while the plugin command existed only in the alpha `/Applications/ADE Alpha.app` CLI. The fact that the prompt showed the alpha lane worktree did not change the installed CLI selected by the user's shell. The lane changed the checkout, not the user's global `PATH` or application selection.

The next attempt invoked the alpha packaged Electron runtime directly. That was already a large jump in complexity for removing one plugin: an explicit `ADE_HOME`, an alpha package channel, `ELECTRON_RUN_AS_NODE=1`, the application executable, the packaged `cli.cjs` path, and the plugin command itself. That command found the plugin, but returned:

```text
Action 'plugin.uninstall' is limited to the machine operator.
```

The response included `requiredRole: "cto"`, so the user retried with `--role cto`. It still failed with the same error. The missing detail was that the terminal had been launched from an ADE agent context and inherited session identity variables. The runtime role code treats a chat-session binding as an authority boundary: a caller carrying a chat session cannot elevate itself to CTO merely by passing `--role cto`. The requested role was clamped back to `agent` before the plugin action ran.

The successful command required clearing the inherited `ADE_CHAT_SESSION_ID`, `ADE_RUN_ID`, `ADE_STEP_ID`, `ADE_ATTEMPT_ID`, `ADE_OWNER_ID`, and `ADE_DEFAULT_ROLE` variables, then setting the alpha home/channel and passing `--role cto` to the packaged CLI. In other words, the user needed to distinguish all of the following before one local uninstall could succeed:

- the stable ADE CLI versus the alpha ADE CLI;
- the worktree path versus the installed application;
- an ordinary terminal versus an ADE-launched terminal;
- the CLI's requested role versus the role allowed by the inherited chat binding;
- plugin registry state versus plugin source code in another repository.

This was experienced as excessive ceremony and “a huge command to literally remove one plugin.” The command was technically coherent once the layers were known, but none of those layers were visible in the original `ade plugin remove` invocation. The error message said to run the action from “your own terminal,” even though an ADE-owned terminal can look exactly like a normal shell while carrying hidden agent identity. The user had to fail three times before the correct boundary became clear.

#### Post-uninstall audit

The successful removal was followed by a read-only audit of the alpha machine, the current project database, and the plugin discovery surfaces. The results were:

- A fresh alpha `plugin list --text` contained `ade-linear`, the three theme plugins, and no `ade-tipsy`.
- `/Users/arul/.ade-alpha/plugins/ade-tipsy` was absent.
- `state.json` remained as the generic plugin registry, but its plugin ids were only `ade-linear`, `ade-theme-contrast`, `ade-theme-ink`, and `ade-theme-paper`.
- A fresh alpha `skill list --text` contained no Tipsy or drink skill.
- The Tipsy skill directory was absent, and the current `ADE_AGENT_SKILLS_DIRS` value no longer contained its path.
- `plugin.get` for `ade-tipsy` returned `null`.
- The alpha presence query returned no Tipsy row. It showed remaining presence for other installed plugins on “This computer,” not for Tipsy.
- The current project database at `/Users/arul/ADE/.ade/ade.db` contained zero rows for `ade-tipsy` in `plugin_presence`, `plugin_panels`, `plugin_collections`, and `plugin_contributions`.
- No Tipsy-specific process was found after removal.
- No Tipsy-specific file was found under the alpha home outside the external source checkout.
- The alpha plugin caches and runtime logs contained no `ade-tipsy`, `Tipsy`, or `drink` strings.
- The nested `plugins/ade-tipsy/` directory in this lane still existed as the separate, untracked plugin source repository. That is source code intentionally kept outside the ADE installation and outside the pushed ADE branch; its presence does not mean the alpha plugin remains installed.

The evidence supports that uninstall truly removed the installed Tipsy instance from this alpha machine and removed its materialized project data and presence. The host implementation also explicitly runs cleanup for plugin rows, machine-scoped plugin secrets, plugin-owned schedules, notification-usage counters, and plugin-owned account connections. The encrypted secret store was not opened or dumped during this audit, so the secret-removal part is supported by the implementation path and absence of all observable Tipsy state, rather than by exposing opaque credential storage.

Uninstall is not retroactive to the existing conversation. An already-running agent may remember that Tipsy was discussed, and old transcript messages may still mention the plugin. That is conversation context, not an installed skill or active plugin process. A fresh plugin list, skill discovery pass, presence query, and project-data query all treated Tipsy as absent.

## Evidence from the lane

The following evidence was available at the end of the test:

- The alpha plugin platform and iOS connection/composer changes are in commit `135e45ae6` (`Integrate alpha plugin platform and mobile connection UX fixes`).
- The active lane is `ade/ade-plugin-context`, based on `main`, and was ahead of its remote before the retrospective commit.
- `ade plugin list --text` showed `ade-tipsy` enabled locally alongside the other installed plugins.
- `ade ade-tipsy status --text` reported level 7, maximum level 10, label `7 drinks in! 🍺`, state `Very drunk`, and effect `Frequent confusion`.
- Plugin logs reported activation at level 0 and plugin readiness with four actions.
- The Tipsy source remained in the nested, untracked `plugins/ade-tipsy/` repository. It was intentionally not staged or committed to this ADE lane.
- The iOS simulator was an iPhone 17 Pro with UDID `95F41FEE-EA2F-4E4B-AF2B-1FC974ABE0AE`.
- The iOS simulator build completed successfully with `xcodebuild`.
- Focused iOS plugin/presence and launch-gate tests passed.
- Desktop typechecking passed.
- Desktop plugin icon tests passed, including the beer icon mapping.
- The direct computer-use backend returned `Unknown error -1743`, so the full interactive mobile chat proof was not completed through that backend.

The evidence supports a narrower conclusion than “the plugin worked end to end.” It supports that the alpha host platform was integrated into this lane, the iOS build and focused tests passed, the local Tipsy plugin was enabled and had state, and several plugin surfaces existed. It does not support the claim that the original requested native chat-header control, dropdown, background effect, cross-surface logo parity, and immediate current-turn agent behavior were all delivered.

## Closing assessment

This was a valuable plugin-platform test precisely because the idea was small and the expectations were concrete. The user could tell immediately when the icon was wrong, the control was in the wrong place, the dropdown was missing, mobile did not match desktop, the simulator was ambiguous, or the agent stayed sober.

The main lesson from the user experience is that ADE’s plugin system currently exposes several distinct layers that look like one feature to the person using the product: external plugin source, alpha host code, local installation, plugin activation, synced state, client-side socket rendering, visible placement, and agent-turn context. The conversation became difficult whenever those layers were described interchangeably or verified only by source code.

The experiment also showed why repeated practice runs matter for the plugin skill. A skill can describe the available contracts and still fail to help an agent deliver a reliable end-to-end experience if it does not keep branch provenance, client parity, lifecycle state, and current-turn timing visible. The user’s request for this report is itself part of the test: it captures the experience another agent needs to understand before attempting to build a plugin for an external user who expects it to appear immediately and behave consistently.
