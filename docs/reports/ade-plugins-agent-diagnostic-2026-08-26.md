# ADE plugins diagnostic (agent run, 2026-08-26)

Date: 2026-08-26  
Lane: `alpha-build` / branch `plugin-platform` at `668968f82`  
App under test: packaged `/Applications/ADE Alpha.app` (`ade` 1.0.0-beta.1, `ADE_HOME` `~/.ade-alpha`)  
Shell `ade` on PATH: `/Users/arul/.local/bin/ade` → `/Applications/ADE.app` (`ade` 1.2.64)  
Chat session: `bbca6866-ffc5-4d8a-9d04-8073f2e92cb6`  
Plugin under test: local `ade-tipsy` (drink counter + later webview dashboard). Source was removed from the lane after this run. **Uninstall from this chat was refused** (`plugin_role_denied`, `sessionBound: true`). The machine may still have `ade-tipsy` until an operator terminal runs `ade plugin remove ade-tipsy` against Alpha.

This is a bug/issue list for the plugins team. It is not a product pitch and not a request to keep Tipsy.

---

## 1. The agent is not talking to the ADE the user is looking at

**What happened.** The user was in ADE Alpha. Every `ade` this agent ran from PATH was stable **ADE.app 1.2.64**. `ade plugin list` → `Unknown command 'plugin'`. `ade actions run plugin.install` → `Domain 'plugin' is unavailable in this runtime.` Chat `note`/`ask` on the same PATH binary still worked for this session.

**How confirmed.** `which ade` → symlink to ADE.app. Alpha CLI at `/Applications/ADE Alpha.app/Contents/Resources/ade-cli/bin/ade` is 1.0.0-beta.1 and `plugin list` works. Installs land under `~/.ade-alpha/plugins/`, not the stable home.

**Whose fault.** Platform + skill. Two apps, two CLIs, two homes is real. The skill tells the agent to trust PATH `ade` and, if `plugin` is missing, to **stop**. That made the agent tell the user they were “not on Alpha” while they were. The user had to contradict it.

**What should change.**

- A session-bound agent should get a CLI that matches the window that launched it (or an explicit `ADE_CLI` / `--app alpha` that cannot silently hit ADE.app).
- `ade doctor --text` should say, in one line: which binary, which version, which `ADE_HOME`, whether `plugin` exists, and whether that is the same app as `ADE_CHAT_SESSION_ID`.
- The `ade-plugins` skill Phase 0 must not treat “PATH has no plugin command” as “this checkout has no platform” and must not instruct the agent to end the turn. It should say: PATH is often ADE.app even when the chat is Alpha; look up the Alpha CLI before claiming install is impossible.

---

## 2. `plugin.list` / `plugin.get` drop `entryHtml` from summary surfaces

**What happened.** Tipsy declared a `webview` surface with `entryHtml: "web/index.html"`. Chat-header **Dashboard** opened an overlay titled “Tipsy · Tipsy” that rendered the **panel** (“Drink log”), not the HTML glass. The left-rail Tipsy tab was visible.

**How confirmed.** Live `plugin.get ade-tipsy`:

- `result.surfaces[]` for `dashboard`: `kind`, `id`, `title`, `panelId`, `icon` — **no `entryHtml`**.
- `result.manifest.surfaces[]` for the same surface **includes** `entryHtml: "web/index.html"`.

Renderer overlay code (`PluginWebviewOverlayHost`) only mounts `<webview>` when `surface.kind === "webview" && surface.entryHtml`. Missing `entryHtml` is defined as “draw the panel.” The SDK comment on `PluginSummary.surfaces.entryHtml` already says absence means render the panel. The host mapper in `pluginHostService.ts` (`toSummary` / `surfaces: (manifest?.surfaces ?? []).map(...)`) never copies `entryHtml`.

**Whose fault.** Host bug. The plugin and the overlay client did what the contract said; the list payload omitted the field the contract requires for a guest.

**What should change.** Copy `entryHtml` onto summary surfaces the same way `icon` and `builtin` are copied. Add a host test that `plugin.list` round-trips a webview `entryHtml`. Until that ships in the **running** Alpha, every webview plugin will look like a boring panel and authors will debug the plugin instead of the host.

---

## 3. Sync/adapter tab list ignores `webview` surfaces

**What happened.** `pluginInstallServiceAdapter.toRecordTabs` keeps only `surface.kind === "tab"`. A plugin whose only full-page surface is `webview` has **zero** sync tabs.

**How confirmed.** Source in this checkout. Desktop preload *does* include webview in `tabs` (`pluginBridge.ts`). The adapter used for the wire/record shape does not. Phone/web clients that read `record.tabs` will not see a Tipsy-like plugin as a tab at all, or will disagree with desktop.

**Whose fault.** Host/sync bug (desktop rail can still work via preload; other clients and any code path using the adapter will not).

**What should change.** Treat `tab` and `webview` as rail surfaces on the adapter, matching the preload comment that filtering `kind === "tab"` silently drops custom-UI plugins.

---

## 4. Plugin tab click can do nothing (stale `lastPanelByPlugin`)

**What happened.** User: rail Tipsy is visible, click does nothing. Overlay Dashboard still opened (panel, see §2).

**How confirmed.** `PluginTabPage` resolves `panelId` as `?panel=` else `lastPanelByPlugin[pluginId]` else `tabs[0].panelId` else `"main"`. It then looks up `plugin.tabs.find(tab => tab.panelId === panelId)`. If the store still has `main` (default / previous plugin) and this plugin only has `panelId: "dashboard"`, `surface` is null, `entryHtml` is null, and the page hosts panel `"main"` which this plugin does not publish — empty or inert.

**Whose fault.** Host bug. A remembered panel id that the current manifest does not declare should not win over `tabs[0]`.

**What should change.** Ignore `lastPanelByPlugin` unless it matches a declared tab `panelId`. Test: remember `"main"`, plugin only declares `"dashboard"`, page still hosts the declared surface.

---

## 5. Agent cannot uninstall (or enable/disable) the plugin it just installed

**What happened.** User asked to uninstall Tipsy. `ade plugin remove ade-tipsy` (Alpha CLI, same session env) → `plugin_role_denied`, `requiredRole: "cto"`, `sessionBound: true`. Skill is explicit: do not unset `ADE_CHAT_SESSION_ID` to bypass this.

**Whose fault.** Product rule, not a crash. It is still a workflow hole: the same session can `plugin.install` (user-gated) and `plugin.reload`, but cannot clean up. The diagnostic run cannot leave the machine in the state the user asked for.

**What should change.** Either:

- an agent-callable uninstall that raises the same class of approval card as install, or
- a one-shot “remove what this session installed” that the user can accept in-chat,

and say so in the skill next to install. “Run it from a terminal you opened” is correct as a permission story and a failure as an agent-test story.

---

## 6. Doctor “Places” / “Renders on” hide webview tabs

**What happened.** After Tipsy 0.2 (header button + webview tab), `ade plugin doctor ade-tipsy --text` reported Places as `chat-header-action in work` and `Renders on: desktop ✓ (chat-header-action) · …`. The tab/webview was only visible later under Panels (`1 published of 1 panel`). An author debugging “I see a tab that does nothing” does not get “webview surface, guest needs entryHtml on the list payload.”

**Whose fault.** Doctor completeness. Panels ≠ “this is a rail tab with a guest.”

**What should change.** Doctor should name webview/tab surfaces the way it names sockets, and if `entryHtml` is in the manifest but missing on the live summary, that should be a **failing** rung, not silence.

---

## 7. Install approval still a black box (not re-proven this run, still blocking)

**What happened this run.** `plugin.install` via Alpha CLI blocked ~76s then succeeded. The agent never saw the card body. Prior attributed report (`docs/reports/ade-tipsy-plugin-alpha-handoff-2026-08-25.md` §3) still applies unless landed: host builds a real disclosure; chat composer shows title + generic Accept and drops `body` / option labels.

**What should change.** Same as that report: show the install disclosure and plugin-specific actions, or stop claiming the card is the trust UI.

---

## 8. Skill and guidance that actively misled this run

These are skill/docs defects, not “the agent should have tried harder.”

| Guidance | What it caused | What would have helped |
|---|---|---|
| Phase 0: if PATH `ade plugin` fails, **that sentence is the entire reply** | Agent told the user they were on ADE.app and could not install, while the Alpha window and Alpha CLI were fine | Phase 0: identify **this chat’s app** vs PATH; table of common binaries (`ADE.app` vs `ADE Alpha.app`) |
| “A lane changes the checkout. It does not change which app `ade` runs.” | True, and then the skill still uses PATH as the only install path | Session should inject `ADE_ALPHA_CLI` or equivalent; skill should show the exact Alpha `ade` path |
| Install via `ade actions run plugin.install` | Correct on Alpha, fatal on PATH 1.2.64 with a domain error that sounds like “plugins don’t exist” | Error text should say “this CLI is ADE 1.2.64 without plugins; Alpha is a different binary” |
| Webview overlay `{openWebview:{surfaceId}}` | Implemented exactly; UI showed panel | Skill should say: if overlay is the panel, dump `plugin.get` summary.surfaces vs manifest.surfaces for `entryHtml` before rewriting the plugin |
| “Declare webview + panel; desktop gets the page” | Author believes the tab is the page | Skill should say the **list** payload, not the manifest on disk, is what the guest host reads |
| Icon tokens include `beer`; `color` contrast rules | Those parts worked | Keep; they were the rare bits that matched the screen |
| Timing: skill loads next turn | Worked once drinks were logged; easy to forget mid-debug | Fine; keep the sentence in doctor (already there) |
| Screenshots in ADE chat | First image did not reach the Cursor turn; later re-attach did | ADE should attach image files to the agent turn the same way Cursor does, or say “agent cannot see this image” in the composer |

---

## 9. Smaller issues worth not losing

- **`plugin_disabled` vs UI.** `getDrunkLevel` failed with `plugin_disabled` after the user had used the button. Enable/disable is also operator-only for the agent, so the agent cannot recover or even re-enable.
- **Two successful CLIs in one turn.** PATH `ade chat note` (session) + Alpha `ade plugin *` (plugins). Nothing in the prompt said these are different programs. Easy to “fix” the wrong one.
- **Reload vs running binary.** `plugin.reload` updated Tipsy 0.2.0 on disk and in the child. It cannot change `toSummary` in the already-running Electron main process. Authors will reload forever waiting for `entryHtml` to appear.
- **Default panel id `"main"`.** Host and page still default to `"main"`. Plugins that never declare `main` (Tipsy used `dashboard`) collide with remembered state (§4). Either require `tabs[0]` always, or stop defaulting to `main`.

---

## 10. What this run did *not* validate

Do not treat these as passing:

- Animated glass / wobbly liquid (guest never mounted).
- iOS overflow-menu beer button.
- Web client fallback copy (“open on desktop”).
- Whether a rebuilt Alpha with §2–§4 applied actually shows the guest.

---

## Attribution summary

| ID | Issue | Attribution |
|---|---|---|
| §1 | PATH CLI ≠ Alpha window | Platform + skill Phase 0 |
| §2 | Summary omits `entryHtml` | Host bug |
| §3 | Adapter tabs skip `webview` | Host/sync bug |
| §4 | Stale last panel blanks the tab | Host bug |
| §5 | Agent cannot uninstall | Product rule / test-loop hole |
| §6 | Doctor silent on webview guest | Doctor |
| §7 | Install card content | Host/composer (prior, still likely) |
| §8 | Skill stop-on-PATH, no Alpha CLI | Skill |
