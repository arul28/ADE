# Work tab action inventory

This is the audit matrix for Work-tab autoresearch. It is deliberately not a
completion claim. A row is only "measured" when a real Work-tab UI run has a
matching `manualStep` marker or an equivalent UI-derived probe against the
perf-pass repo.

Coverage states:

- `source`: found in source, not yet driven in the current inventory pass.
- `measured`: exact row covered by a real Work UI run, UI-derived probe, or
  focused fixture test with evidence.
- `measured-partial`: driven in an earlier partial pass; must be re-driven by
  this matrix before claiming full coverage.
- `fixture-needed`: safe to drive, but needs a seeded repo/session/device state.
- `sandbox-only`: may start local tools or mutate the perf-pass repo; allowed
  only inside the throwaway perf-pass setup.
- `prompt-only`: destructive or externally visible path. Open and measure the
  confirmation/preflight, then cancel unless explicitly allowed.
- `external-skip`: opens another app, browser, Xcode, docs, or Simulator.app.
  Measure only up to the ADE preflight/button state unless explicitly allowed.
- `moved`: no longer a Work-tab surface. Historical evidence stays below for
  traceability, but current coverage belongs to the destination route's matrix.

## Work shell and layout

| id | action | state | source |
| --- | --- | --- | --- |
| work.route.open | Open Work tab and wait for sessions pane plus view area | measured | `TerminalsPage.tsx` |
| work.sessions.hide | Hide sessions sidebar | measured | `TerminalsPage.tsx` |
| work.sessions.show | Show sessions sidebar from focus toolbar | measured | `WorkViewArea.tsx` |
| work.split.sessions.resize | Resize sessions/work split | measured | `TerminalsPage.tsx` |
| work.split.tools.resize | Resize Work tools split | measured | `TerminalsPage.tsx` |
| work.mode.chat | Switch draft/start surface to Chat | measured | `WorkViewArea.tsx` |
| work.mode.cli | Switch draft/start surface to CLI | measured | `WorkViewArea.tsx` |
| work.mode.shell | Switch draft/start surface to Shell | measured | `WorkViewArea.tsx` |
| work.view.tabs | Switch sessions to tab view | measured | `WorkViewArea.tsx` |
| work.view.grid | Switch sessions to grid view | measured | `WorkViewArea.tsx` |
| work.grid.arrange.open | Open grid arrangement menu | measured | `WorkViewArea.tsx` |
| work.grid.arrange.auto | Select Auto grid arrangement | measured | `WorkViewArea.tsx` |
| work.grid.arrange.rows | Select Rows grid arrangement | measured | `WorkViewArea.tsx` |
| work.grid.arrange.columns | Select Columns grid arrangement | measured | `WorkViewArea.tsx` |
| work.tab.select | Select an existing work tab | measured | `WorkViewArea.tsx` |
| work.tab.close | Close an ended work tab | measured | `WorkViewArea.tsx` |
| work.tab.close.running | Close a running work tab | prompt-only | `WorkViewArea.tsx` |
| work.tab.context | Open work-tab context menu | measured | `WorkViewArea.tsx` |
| work.small.session-context-menu-overflow | Verify session/work-tab context menus stay contained near viewport edges | measured | `SessionContextMenu.tsx` |
| work.group.collapse | Collapse a grouped tab lane/status cluster | measured | `WorkViewArea.tsx` |
| work.group.expand | Expand a grouped tab lane/status cluster | measured | `WorkViewArea.tsx` |
| work.pane.minimize | Minimize an embedded work pane | measured | `WorkViewArea.tsx` |
| work.pane.expand | Expand a minimized embedded work pane | measured | `WorkViewArea.tsx` |
| work.packed.select | Select packed grid tile | measured | `PackedSessionGrid.tsx` |
| work.packed.resize | Resize packed grid tile | measured | `PackedSessionGrid.tsx` |
| work.sidebar.open | Open ADE tools pane | measured | `WorkViewArea.tsx` |
| work.sidebar.close | Close Work sidebar | measured | `WorkSidebar.tsx` |
| work.sidebar.tab.git | Select Git tools tab | measured | `WorkSidebar.tsx` |
| work.sidebar.tab.files | Select Files tools tab | measured | `WorkSidebar.tsx` |
| work.sidebar.tab.ios | Select iOS Sim tools tab | measured | `WorkSidebar.tsx` |
| work.sidebar.tab.app-control | Select App Control tools tab | measured | `WorkSidebar.tsx` |
| work.sidebar.tab.browser | Select Browser tools tab | measured | `WorkSidebar.tsx` |
| work.sidebar.compact-tabs | Verify all tools tabs remain reachable in narrow pane | measured | `WorkSidebar.tsx` |

## Session list

| id | action | state | source |
| --- | --- | --- | --- |
| work.sessions.search | Type and clear session search | measured | `SessionListPane.tsx` |
| work.sessions.new-chat | Click New Chat from sessions pane | measured | `SessionListPane.tsx` |
| work.sessions.filters.open | Open filters panel | measured | `SessionListPane.tsx` |
| work.small.session-filter-overflow | Verify filter controls stay contained in a narrow sessions pane | measured | `SessionListPane.tsx` |
| work.sessions.filter.all | Select All status filter | measured | `SessionListPane.tsx` |
| work.sessions.filter.running | Select Running status filter | measured | `SessionListPane.tsx` |
| work.sessions.filter.awaiting | Select Awaiting status filter | measured | `SessionListPane.tsx` |
| work.sessions.filter.ended | Select Ended status filter | measured | `SessionListPane.tsx` |
| work.sessions.group.lane | Group sessions by Lane | measured | `SessionListPane.tsx` |
| work.sessions.group.status | Group sessions by Status | measured | `SessionListPane.tsx` |
| work.sessions.group.time | Group sessions by Time | measured | `SessionListPane.tsx` |
| work.sessions.filter.lane | Change lane filter combobox | measured | `SessionListPane.tsx` |
| work.sessions.group.collapse | Collapse a list group header | measured | `SessionListPane.tsx` |
| work.sessions.group.expand | Expand a list group header | measured | `SessionListPane.tsx` |
| work.sessions.child.collapse | Collapse parent/child session section | measured | `SessionListPane.tsx` |
| work.sessions.child.expand | Expand parent/child session section | measured | `SessionListPane.tsx` |
| work.sessions.select.single | Single-select a session card | measured | `SessionCard.tsx` |
| work.sessions.select.range | Shift-select a range | measured | `SessionCard.tsx` |
| work.sessions.select.multi | Cmd/Ctrl multi-select | measured | `SessionCard.tsx` |
| work.sessions.details | Open session details popover | measured | `SessionCard.tsx` |
| work.sessions.details.stop-runtime | Stop runtime from details popover | prompt-only | `SessionInfoPopover.tsx` |
| work.sessions.details.delete | Delete session/chat from details popover | prompt-only | `SessionInfoPopover.tsx` |
| work.sessions.stale-warning | Hover/read stale running warning | measured | `SessionCard.tsx` |
| work.sessions.cli-continuation.show | Ended tracked CLI shows transcript plus continuation composer | fixture-needed | `WorkViewArea.tsx` |
| work.sessions.cli-continuation.slash | Continuation composer shows provider-specific slash commands | fixture-needed | `WorkViewArea.tsx` |
| work.sessions.cli-continuation.send | Send from continuation composer attaches a runtime to the same session | fixture-needed | `WorkViewArea.tsx` |
| work.sessions.cli-continuation.duplicate-send | Rapid sends do not spawn duplicate CLI runtimes | fixture-needed | `ptyService.ts` |
| work.sessions.context.open | Open session context menu | measured | `SessionContextMenu.tsx` |
| work.sessions.context.rename | Rename session prompt/input | measured | `SessionContextMenu.tsx` |
| work.sessions.context.stop-runtime | Stop PTY runtime | prompt-only | `SessionContextMenu.tsx` |
| work.sessions.context.delete-chat | Delete chat | prompt-only | `SessionContextMenu.tsx` |
| work.sessions.context.delete-terminal | Delete terminal session | prompt-only | `SessionContextMenu.tsx` |
| work.sessions.context.go-lane | Go to lane | measured | `SessionContextMenu.tsx` |
| work.sessions.context.copy-id | Copy session ID | external-skip | `SessionContextMenu.tsx` |
| work.sessions.bulk.stop-runtimes | Stop selected running CLI/shell runtimes | prompt-only | `SessionListPane.tsx` |
| work.sessions.bulk.archive | Archive selected chats | prompt-only | `SessionListPane.tsx` |
| work.sessions.bulk.restore | Restore selected archived chats | measured | `SessionListPane.tsx` |
| work.sessions.bulk.export | Export selected session bundle | external-skip | `SessionListPane.tsx` |
| work.sessions.bulk.delete | Delete selected ended sessions | prompt-only | `SessionListPane.tsx` |
| work.sessions.bulk.clear | Clear current multi-selection | measured | `SessionListPane.tsx` |
| work.sessions.add-lane | Open Add Lane modal | measured | `SessionListPane.tsx` |

## Start surfaces

| id | action | state | source |
| --- | --- | --- | --- |
| work.start.no-sessions | Empty no-sessions state | measured | `SessionListPane.tsx` |
| work.start.no-lanes | Empty no-lanes state | measured | `WorkStartSurface.tsx` |
| work.start.chat.mount | Mount empty chat draft | measured | `WorkStartSurface.tsx` |
| work.start.cli.lane | Change CLI lane combobox | measured | `WorkStartSurface.tsx` |
| work.start.cli.provider.claude | Select Claude Code provider | measured | `WorkStartSurface.tsx` |
| work.start.cli.provider.codex | Select Codex CLI provider | measured | `WorkStartSurface.tsx` |
| work.start.cli.provider.cursor | Select Cursor Agent CLI provider | measured | `WorkStartSurface.tsx` |
| work.start.cli.provider.droid | Select Factory Droid CLI provider | measured | `WorkStartSurface.tsx` |
| work.start.cli.provider.opencode | Select OpenCode CLI provider | measured | `WorkStartSurface.tsx` |
| work.start.cli.permissions.claude | Cycle Claude permission pills: Default, Accept Edits, Plan, Bypass | measured | `WorkStartSurface.tsx` |
| work.start.cli.permissions.codex | Cycle Codex permission pills: Default permissions, Plan mode, Full access, Custom | measured | `WorkStartSurface.tsx` |
| work.start.cli.permissions.cursor | Cycle Cursor permission pills: Agent, Plan, Ask, Force | measured | `WorkStartSurface.tsx` |
| work.start.cli.permissions.droid | Cycle Droid permission pills: Read-only, Auto low, Auto medium, Auto high | measured | `WorkStartSurface.tsx` |
| work.start.cli.permissions.opencode | Cycle OpenCode permission pills: Ask, Plan, Edit, Allow, Config | measured | `WorkStartSurface.tsx` |
| work.start.cli.launch | Open selected CLI provider | sandbox-only | `WorkStartSurface.tsx` |
| work.start.shell.lane | Change Shell lane combobox | measured | `WorkStartSurface.tsx` |
| work.start.shell.launch | Open Shell | measured | `WorkStartSurface.tsx` |

## Chat and composer

| id | action | state | source |
| --- | --- | --- | --- |
| work.chat.empty | Empty chat state | measured | `AgentChatPane.tsx` |
| work.chat.git.lane-open | Open current lane from chat Git toolbar | measured | `ChatGitToolbar.tsx` |
| work.chat.git.pr-open | Open linked PR from chat Git toolbar | external-skip | `ChatGitToolbar.tsx` |
| work.chat.git.pr-route | Route to PR view from chat Git toolbar | external-skip | `ChatGitToolbar.tsx` |
| work.chat.git.run-menu | Open Run menu from chat Git toolbar | measured | `ChatGitToolbar.tsx` |
| work.chat.git.commit-open | Open Stage & Commit controls | prompt-only | `ChatGitToolbar.tsx` |
| work.chat.git.commit-message | Type chat-header commit message | measured | `ChatGitToolbar.tsx` |
| work.chat.git.commit-submit | Submit chat-header commit | sandbox-only | `ChatGitToolbar.tsx` |
| work.chat.git.push | Push from chat Git toolbar | external-skip | `ChatGitToolbar.tsx` |
| work.chat.new | New chat button | sandbox-only | `AgentChatPane.tsx` |
| work.chat.restore | Restore archived chat | measured | `AgentChatPane.tsx` |
| work.chat.archive.restore | Restore archived chat from selector | prompt-only | `AgentChatPane.tsx` |
| work.chat.delete | Delete selected chat | prompt-only | `AgentChatPane.tsx` |
| work.chat.end | End selected chat | prompt-only | `AgentChatPane.tsx` |
| work.chat.clear-view | Clear persistent chat view | measured | `AgentChatPane.tsx` |
| work.chat.lane-select | Change chat lane selector | measured | `AgentChatPane.tsx` |
| work.chat.tab.select | Select chat tab inside AgentChatPane | measured | `AgentChatPane.tsx` |
| work.chat.tab.archive | Archive chat tab from context menu | prompt-only | `AgentChatPane.tsx` |
| work.chat.scroll | Scroll transcript | measured | `AgentChatMessageList.tsx` |
| work.chat.jump-latest | Jump to latest message | measured | `AgentChatMessageList.tsx` |
| work.chat.copy-message | Copy message | measured | `AgentChatMessageList.tsx` |
| work.chat.copy-code | Copy code block | measured | `AgentChatMessageList.tsx` |
| work.chat.open-file-link | Open transcript file link in Files | measured | `AgentChatMessageList.tsx` |
| work.chat.open-url | Open transcript external URL | external-skip | `AgentChatMessageList.tsx` |
| work.chat.open-pr-browser | Open PR URL in ADE browser | measured | `AgentChatMessageList.tsx` |
| work.chat.message.disclosure | Toggle message disclosure/details | measured | `AgentChatMessageList.tsx` |
| work.chat.message.full-prompt | Toggle full prompt details | measured | `AgentChatMessageList.tsx` |
| work.chat.message.tool-show-all | Show all/collapse tool result items | measured | `AgentChatMessageList.tsx` |
| work.chat.message.minimap | Jump via chat minimap | measured | `AgentChatMessageList.tsx` |
| work.chat.inline-question.tab | Switch inline question tabs | measured | `AgentChatMessageList.tsx` |
| work.chat.inline-question.prev-next | Inline question previous/next | measured | `AgentChatMessageList.tsx` |
| work.chat.inline-question.answer | Select/submit inline question answer | sandbox-only | `AgentChatMessageList.tsx` |
| work.chat.approval.accept | Accept tool approval | prompt-only | `AgentChatMessageList.tsx` |
| work.chat.approval.accept-session | Accept all/session tool approval | prompt-only | `AgentChatComposer.tsx` |
| work.chat.approval.decline | Decline tool approval | prompt-only | `AgentChatMessageList.tsx` |
| work.chat.drawer.ios | Open/close iOS simulator drawer | measured | `AgentChatPane.tsx` |
| work.chat.drawer.app-control | Open/close App Control drawer | measured | `AgentChatPane.tsx` |
| work.chat.drawer.proof | Open/close proof/artifacts drawer | measured | `AgentChatPane.tsx` |
| work.chat.drawer.resize | Resize chat companion drawer | measured | `AgentChatPane.tsx` |
| work.chat.handoff.open | Open handoff menu | measured | `AgentChatPane.tsx` |
| work.chat.handoff.permissions | Change handoff provider/permission/fast settings | measured | `AgentChatPane.tsx` |
| work.chat.handoff.launch | Launch handoff | measured | `AgentChatPane.tsx` |
| work.chat.terminal.open-close | Open/close chat terminal drawer | measured | `ChatTerminalDrawer.tsx` |
| work.chat.terminal.resize | Resize chat terminal drawer | measured | `ChatTerminalDrawer.tsx` |
| work.chat.terminal.new | New terminal tab in drawer | measured | `ChatTerminalDrawer.tsx` |
| work.chat.terminal.switch | Switch terminal drawer tab | measured | `ChatTerminalDrawer.tsx` |
| work.chat.terminal.close | Close terminal drawer tab | prompt-only | `ChatTerminalDrawer.tsx` |
| work.chat.subagents.toggle | Open/close subagents bottom drawer | measured | `BottomDrawerSection.tsx` |
| work.chat.subagents.back | Back from subagent detail | measured | `ChatSubagentsPanel.tsx` |
| work.chat.subagents.show-all | Show hidden subagent timeline events | measured | `ChatSubagentsPanel.tsx` |
| work.chat.subagents.copy-id | Copy subagent ID | measured | `ChatSubagentsPanel.tsx` |
| work.chat.subagents.interrupt | Interrupt subagent turn | prompt-only | `ChatSubagentsPanel.tsx` |
| work.chat.subagents.detail | Open subagent detail | measured | `ChatSubagentsPanel.tsx` |
| work.chat.composer.type | Type in composer | measured | `AgentChatComposer.tsx` |
| work.chat.composer.rich-chip-select | Select visual context chip in rich composer | measured | `AgentChatComposer.tsx` |
| work.chat.composer.rich-chip-remove | Remove visual context chip in rich composer | measured | `AgentChatComposer.tsx` |
| work.chat.composer.tab-suggestion | Accept Tab suggestion | measured | `AgentChatComposer.tsx` |
| work.chat.composer.submit | Send message | sandbox-only | `AgentChatComposer.tsx` |
| work.chat.composer.send-lanes | Send to lanes | sandbox-only | `AgentChatComposer.tsx` |
| work.chat.composer.send-cloud | Send to Cursor Cloud | external-skip | `AgentChatComposer.tsx` |
| work.chat.composer.clear | Clear draft | measured | `AgentChatComposer.tsx` |
| work.chat.composer.steer | Send steer message during active turn | sandbox-only | `AgentChatComposer.tsx` |
| work.chat.composer.stop | Stop active turn | prompt-only | `AgentChatComposer.tsx` |
| work.chat.queue.send-now | Send queued message now | sandbox-only | `AgentChatComposer.tsx` |
| work.chat.queue.interrupt | Send queued message and interrupt | prompt-only | `AgentChatComposer.tsx` |
| work.chat.queue.edit | Edit queued message | measured | `AgentChatComposer.tsx` |
| work.chat.queue.remove | Remove queued message | measured | `AgentChatComposer.tsx` |
| work.chat.fast-mode | Toggle fast mode | measured | `AgentChatComposer.tsx` |
| work.chat.model.open | Open model picker | measured | `AgentChatComposer.tsx` |
| work.chat.model.select | Select model | measured | `AgentChatComposer.tsx` |
| work.chat.model.reasoning | Change reasoning effort | measured | `AgentChatComposer.tsx` |
| work.chat.permissions.claude | Open/cycle Claude permission control | measured | `AgentChatComposer.tsx` |
| work.chat.permissions.codex | Open/cycle Codex approval preset | measured | `AgentChatComposer.tsx` |
| work.chat.permissions.other | Change Droid/Cursor/OpenCode permission select | measured | `AgentChatComposer.tsx` |
| work.chat.attach.open | Open attachment picker | measured | `AgentChatComposer.tsx` |
| work.chat.attach.search | Search files in attachment picker | measured | `AgentChatComposer.tsx` |
| work.chat.attach.select-file | Select file attachment | measured | `AgentChatComposer.tsx` |
| work.chat.attach.upload | Upload file from disk | external-skip | `AgentChatComposer.tsx` |
| work.chat.attach.issue | Attach issue context | external-skip | `AgentChatComposer.tsx` |
| work.chat.attach.remove | Remove attachment/context chip | measured | `ChatAttachmentTray.tsx` |
| work.chat.attach.open-preview | Open attachment preview | measured | `ChatAttachmentTray.tsx` |
| work.chat.attach.copy-image | Copy attachment image | measured | `ChatAttachmentTray.tsx` |
| work.chat.command.open | Open slash command picker | measured | `AgentChatComposer.tsx` |
| work.chat.command.select | Select slash command | measured | `ChatCommandMenu.tsx` |
| work.chat.parallel.open | Configure parallel models | measured | `AgentChatComposer.tsx` |
| work.chat.parallel.add | Add parallel model slot | measured | `AgentChatComposer.tsx` |
| work.chat.parallel.remove | Remove parallel model slot | measured | `AgentChatComposer.tsx` |
| work.chat.parallel.configure | Configure parallel model slot | measured | `AgentChatComposer.tsx` |
| work.chat.parallel.execution | Change parallel slot execution mode | measured | `AgentChatComposer.tsx` |
| work.chat.cursor-cloud.open | Open Cursor Cloud actions menu | measured | `AgentChatComposer.tsx` |
| work.chat.cursor-cloud.launch-mode | Toggle Cursor Cloud launch mode | sandbox-only | `AgentChatComposer.tsx` |
| work.chat.cursor-cloud.bring-local | Bring Cursor Cloud session local | sandbox-only | `AgentChatComposer.tsx` |
| work.chat.cursor-cloud.repo | Select Cursor Cloud repository | external-skip | `CursorCloudInlineLaunch.tsx` |
| work.chat.cursor-cloud.branch | Select Cursor Cloud branch | external-skip | `CursorCloudInlineLaunch.tsx` |
| work.chat.cursor-cloud.model | Select Cursor Cloud model | external-skip | `CursorCloudInlineLaunch.tsx` |
| work.chat.cursor-cloud.pr-link | Toggle linked PR context | external-skip | `CursorCloudInlineLaunch.tsx` |
| work.chat.cursor-cloud.auto-pr | Toggle Auto-PR | external-skip | `CursorCloudInlineLaunch.tsx` |
| work.chat.cursor-cloud.current-branch | Toggle Work on current branch | external-skip | `CursorCloudInlineLaunch.tsx` |
| work.chat.cursor-cloud.cancel | Cancel Cursor Cloud launch | measured | `CursorCloudInlineLaunch.tsx` |
| work.chat.dismiss.preview | Dismiss attached iOS/App Control/browser preview | measured | `AgentChatComposer.tsx` |
| work.chat.dismiss.error | Dismiss composer attach error | measured | `AgentChatComposer.tsx` |

## Git tools

| id | action | state | source |
| --- | --- | --- | --- |
| work.git.mount | Mount Git tab | measured | `LaneGitActionsPane.tsx` |
| work.git.commit-message | Type commit message | measured | `LaneGitActionsPane.tsx` |
| work.git.amend-toggle | Toggle amend mode | measured | `LaneGitActionsPane.tsx` |
| work.git.commit | Commit/amend staged changes | sandbox-only | `LaneGitActionsPane.tsx` |
| work.git.pull-mode.merge | Select merge pull mode | measured | `LaneGitActionsPane.tsx` |
| work.git.pull-mode.rebase | Select rebase pull mode | measured | `LaneGitActionsPane.tsx` |
| work.git.pull | Pull current lane | sandbox-only | `LaneGitActionsPane.tsx` |
| work.git.push | Push or publish lane | external-skip | `LaneGitActionsPane.tsx` |
| work.git.force-push | Force push with lease | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.sync | Rebase and push from parent | sandbox-only | `LaneGitActionsPane.tsx` |
| work.git.more.open | Open More/advanced section | measured | `LaneGitActionsPane.tsx` |
| work.git.fetch | Fetch only | external-skip | `LaneGitActionsPane.tsx` |
| work.git.rebase-local | Rebase local only | sandbox-only | `LaneGitActionsPane.tsx` |
| work.git.rebase-details | View rebase details | external-skip | `LaneGitActionsPane.tsx` |
| work.git.revert.prompt | Revert commit SHA prompt | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.cherry-pick.prompt | Cherry-pick SHA prompt | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.settings | Open Settings from auto-rebase notice | external-skip | `LaneGitActionsPane.tsx` |
| work.git.conflict.abort-rebase | Abort rebase conflict flow | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.conflict.continue-rebase | Continue rebase conflict flow | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.conflict.abort-merge | Abort merge conflict flow | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.conflict.continue-merge | Continue merge conflict flow | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.refresh | Refresh git state | measured | `LaneGitActionsPane.tsx` |
| work.git.files.back | Back from diff to files | measured | `LaneGitActionsPane.tsx` |
| work.git.stage-all | Stage all unstaged files | measured | `LaneGitActionsPane.tsx` |
| work.git.discard-unstaged | Discard all unstaged files | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.unstage-all | Unstage all staged files | measured | `LaneGitActionsPane.tsx` |
| work.git.discard-staged | Discard all staged files | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.rescue-lane | Create new lane with current changes | measured | `LaneGitActionsPane.tsx` |
| work.git.stash.save | Save changes to stash prompt | measured | `LaneGitActionsPane.tsx` |
| work.git.stash.clear | Clear all stashes confirmation | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.stash.restore | Restore stash | measured | `LaneGitActionsPane.tsx` |
| work.git.stash.apply | Copy stash to worktree | measured | `LaneGitActionsPane.tsx` |
| work.git.stash.delete | Delete stash confirmation | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.file.select | Select changed file row | measured | `LaneGitActionsPane.tsx` |
| work.git.file.stage | Stage single file | measured | `LaneGitActionsPane.tsx` |
| work.git.file.unstage | Unstage single file | measured | `LaneGitActionsPane.tsx` |
| work.git.file.discard | Discard single file change | prompt-only | `LaneGitActionsPane.tsx` |
| work.git.file.show-all-staged | Show all staged rows | measured | `LaneGitActionsPane.tsx` |
| work.git.file.show-all-unstaged | Show all unstaged rows | measured | `LaneGitActionsPane.tsx` |
| work.git.history.refresh | Refresh commit history | measured | `CommitTimeline.tsx` |
| work.git.history.select | Select a commit | measured | `CommitTimeline.tsx` |
| work.git.history.hover | Hover commit metadata | measured | `CommitTimeline.tsx` |
| work.git.diff.commit-file | Select file from selected commit | measured | `LaneDiffPane.tsx` |
| work.git.diff.show-all-files | Show all commit files | measured | `LaneDiffPane.tsx` |
| work.git.diff.retry | Retry failed diff | measured | `LaneDiffPane.tsx` |
| work.git.diff.open-files | Open selected diff in Files tab | external-skip | `LaneDiffPane.tsx` |
| work.git.diff.save | Save edited working-tree diff | sandbox-only | `LaneDiffPane.tsx` |

## Files tools

| id | action | state | source |
| --- | --- | --- | --- |
| work.files.mount | Mount Files tab | measured | `FilesWorkbench.tsx` |
| work.files.workspace | Change workspace selector | measured | `FilesWorkbench.tsx` |
| work.files.view-lane | Navigate to lane from Files header/banner | external-skip | `FilesWorkbench.tsx` |
| work.files.primary-edit | Toggle primary edit allowance | moved | `FilesWorkbench.tsx` |
| work.files.trust-edit | Trust and edit primary workspace | moved | `FilesWorkbench.tsx` |
| work.files.theme | Toggle editor light/dark theme | measured | `FilesWorkbench.tsx` |
| work.files.open-in.menu | Open external app menu | external-skip | `FilesWorkbench.tsx` |
| work.files.open-in.item | Open file in external app | external-skip | `FilesWorkbench.tsx` |
| work.files.suggested-lane | Switch to suggested lane workspace | measured | `FilesWorkbench.tsx` |
| work.files.error.dismiss | Dismiss error banner | measured | `FilesWorkbench.tsx` |
| work.files.filter | Type path filter | measured | `FilesExplorer.tsx` |
| work.files.filter.clear | Clear path filter | measured | `FilesExplorer.tsx` |
| work.files.content.open | Open content search overlay | measured | `FilesExplorer.tsx` |
| work.files.content.search | Search file contents | measured | `FilesWorkbench.tsx` |
| work.files.content.result | Open content search result | measured | `FilesWorkbench.tsx` |
| work.files.quick.open | Open quick open overlay | measured | `FilesExplorer.tsx` |
| work.files.quick.search | Search quick open | measured | `FilesWorkbench.tsx` |
| work.files.quick.result | Open quick open result | measured | `FilesWorkbench.tsx` |
| work.files.new-file | New file prompt | measured | `FilesExplorer.tsx` |
| work.files.new-folder | New folder prompt | measured | `FilesExplorer.tsx` |
| work.files.tree.expand | Expand directory | measured | `FilesExplorer.tsx` |
| work.files.tree.collapse | Collapse directory | measured | `FilesExplorer.tsx` |
| work.files.tree.open | Open file | measured | `FilesExplorer.tsx` |
| work.files.tree.context | Open file/folder context menu | measured | `FilesExplorer.tsx` |
| work.files.tree.inline-rename | Inline rename path | measured | `FilesExplorer.tsx` |
| work.files.tab.switch | Switch open file tab | measured | `FilesWorkbench.tsx` |
| work.files.tab.close | Close file tab | measured | `FilesWorkbench.tsx` |
| work.files.mode.code | Switch editor to CODE | measured | `FilesWorkbench.tsx` |
| work.files.mode.changes | Switch editor to CHANGES | measured | `FilesWorkbench.tsx` |
| work.files.mode.merge | Switch editor to MERGE | measured | `FilesWorkbench.tsx` |
| work.files.save | Save edited file | measured | `FilesWorkbench.tsx` |
| work.files.conflict.ours | Resolve conflict as ours | sandbox-only | `FilesWorkbench.tsx` |
| work.files.conflict.theirs | Resolve conflict as theirs | sandbox-only | `FilesWorkbench.tsx` |
| work.files.conflict.both | Resolve conflict as both | sandbox-only | `FilesWorkbench.tsx` |
| work.files.context.open | Context menu OPEN | measured | `FilesWorkbench.tsx` |
| work.small.files-context-menu-overflow | Verify Files context menu stays contained near viewport edges | measured | `FilesWorkbench.tsx` |
| work.small.files-embedded-overflow | Verify embedded Files explorer/editor stay contained in the Work tools pane | measured | `FilesWorkbench.tsx` |
| work.files.context.open-diff | Context menu OPEN DIFF | measured | `FilesWorkbench.tsx` |
| work.files.context.stage | Context menu STAGE | measured | `FilesWorkbench.tsx` |
| work.files.context.unstage | Context menu UNSTAGE | measured | `FilesWorkbench.tsx` |
| work.files.context.discard | Context menu DISCARD | prompt-only | `FilesWorkbench.tsx` |
| work.files.context.copy-path | Context menu COPY PATH | measured | `FilesWorkbench.tsx` |
| work.files.context.reveal | Context menu reveal in Finder | external-skip | `FilesWorkbench.tsx` |
| work.files.context.new-file | Context menu NEW FILE | measured | `FilesWorkbench.tsx` |
| work.files.context.new-folder | Context menu NEW FOLDER | measured | `FilesWorkbench.tsx` |
| work.files.context.rename | Context menu RENAME | measured | `FilesWorkbench.tsx` |
| work.files.context.delete | Context menu DELETE | prompt-only | `FilesWorkbench.tsx` |
| work.files.diff.mode-working | Files diff: working tree mode | measured | `FilesWorkbench.tsx` |
| work.files.diff.mode-staged | Files diff: staged mode | measured | `FilesWorkbench.tsx` |
| work.files.diff.mode-commit | Files diff: commit mode and compare ref select | measured | `FilesWorkbench.tsx` |

## Browser tools

| id | action | state | source |
| --- | --- | --- | --- |
| work.browser.mount | Mount Browser tab/default browser surface | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.tab.new | New browser tab | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.tab.switch | Switch browser tab | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.tab.close | Close browser tab | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.back | Go back | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.forward | Go forward | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.reload | Reload page | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.stop | Stop loading page | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.url.type | Type URL/search input | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.url.open | Open URL | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.inspect.toggle | Toggle element inspect mode | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.screenshot.start | Start screenshot crop mode | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.screenshot.drag | Drag crop and attach context | sandbox-only | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.screenshot.cancel | Cancel screenshot crop | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.attach-selection | Attach selected browser element | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.external | Open current page in system browser | external-skip | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.message.dismiss | Dismiss browser message/banner | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.clear-context | Clear browser context selection | measured | `ChatBuiltInBrowserPanel.tsx` |
| work.browser.insert-draft | Insert selected browser details into draft | measured | `ChatBuiltInBrowserPanel.tsx` |

## App Control tools

| id | action | state | source |
| --- | --- | --- | --- |
| work.app-control.mount | Mount App Control tab | measured | `ChatAppControlPanel.tsx` |
| work.app-control.launch-input | Type launch command | measured | `ChatAppControlPanel.tsx` |
| work.app-control.run-command | Select configured run command | measured | `ChatAppControlPanel.tsx` |
| work.app-control.run | Launch command | sandbox-only | `ChatAppControlPanel.tsx` |
| work.app-control.show-terminal | Show launch terminal | measured | `ChatAppControlPanel.tsx` |
| work.app-control.stop | Stop active App Control session | prompt-only | `ChatAppControlPanel.tsx` |
| work.app-control.cdp-port | Type CDP port | measured | `ChatAppControlPanel.tsx` |
| work.app-control.connect | Connect to CDP port | sandbox-only | `ChatAppControlPanel.tsx` |
| work.app-control.help-cdp | Insert Help wire CDP draft | measured | `ChatAppControlPanel.tsx` |
| work.app-control.window-select | Switch controlled window | measured | `ChatAppControlPanel.tsx` |
| work.app-control.window-refresh | Re-scan controlled app windows | measured | `ChatAppControlPanel.tsx` |
| work.app-control.message.dismiss | Dismiss App Control message | measured | `ChatAppControlPanel.tsx` |
| work.app-control.snapshot | Re-capture screenshot and DOM snapshot | measured | `ChatAppControlPanel.tsx` |
| work.app-control.mode.control | Select Control mode | measured | `ChatAppControlPanel.tsx` |
| work.app-control.mode.inspect | Select Inspect mode | measured | `ChatAppControlPanel.tsx` |
| work.app-control.control.click | Click screenshot to control app | sandbox-only | `ChatAppControlPanel.tsx` |
| work.app-control.inspect.hover | Hover inspect element | measured | `ChatAppControlPanel.tsx` |
| work.app-control.inspect.select | Select element/source context | measured | `ChatAppControlPanel.tsx` |
| work.app-control.type-input | Type into focused app element input | measured | `ChatAppControlPanel.tsx` |
| work.app-control.type-send | Send text to focused app element | sandbox-only | `ChatAppControlPanel.tsx` |
| work.app-control.reattach | Re-attach selected point/element | measured | `ChatAppControlPanel.tsx` |

## iOS Simulator tools

| id | action | state | source |
| --- | --- | --- | --- |
| work.ios.mount | Mount iOS Sim tab | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.surface.simulator | Select Simulator surface | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.surface.preview | Select Preview surface | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.live-window | Mirror running Simulator.app window | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.device-select | Select simulator device | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.refresh-state | Refresh simulator state | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.stop | Stop running simulator | prompt-only | `ChatIosSimulatorPanel.tsx` |
| work.ios.take-over | Take over simulator session owned by another chat | prompt-only | `ChatIosSimulatorPanel.tsx` |
| work.ios.window-recover | Restore Simulator.app live view | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.target-select | Select launch target/app | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.launch | Launch app in simulator | sandbox-only | `ChatIosSimulatorPanel.tsx` |
| work.ios.apply | Rebuild/reinstall/relaunch active app | sandbox-only | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-target-select | Select Xcode preview target | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-render | Render selected Xcode preview | sandbox-only | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-view-sim | View preview target in simulator | sandbox-only | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-refresh | Refresh Preview Lab | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-open-xcode | Open Xcode workspace | external-skip | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-setup-docs | Open Preview setup docs | external-skip | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-copy-install | Copy install command | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-mode.control | Select preview Control mode | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-mode.capture | Select preview Capture mode | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-agent-action | Change Preview agent-help action | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-ask-agent | Draft Preview help prompt | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-crop | Drag preview capture crop | sandbox-only | `ChatIosSimulatorPanel.tsx` |
| work.ios.preview-add-preview | Ask agent to add #Preview | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.media.expand | Expand media surface | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.media.zoom-out | Zoom out media surface | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.media.zoom-reset | Reset media zoom | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.media.zoom-in | Zoom in media surface | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.sim.mode.control | Select live simulator Control mode | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.sim.mode.inspect | Select live simulator Inspect mode | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.sim.open-preview | Open selected simulator element in Preview Lab | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.sim.live-click | Click/tap live simulator stream | sandbox-only | `ChatIosSimulatorPanel.tsx` |
| work.ios.sim.live-drag | Drag live simulator stream | sandbox-only | `ChatIosSimulatorPanel.tsx` |
| work.ios.sim.inspect-select | Select an inspect element | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.sim.screenshot | Start simulator screenshot capture | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.sim.screenshot-crop | Drag simulator screenshot crop | sandbox-only | `ChatIosSimulatorPanel.tsx` |
| work.ios.sim.refresh-inspector | Refresh inspector snapshot | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.sim.type-input | Type into active simulator app field | measured | `ChatIosSimulatorPanel.tsx` |
| work.ios.sim.type-send | Send typed text to simulator | sandbox-only | `ChatIosSimulatorPanel.tsx` |

## Run evidence

### `work-inventory-batch-20260511-01`

Perf event file:
`~/.ade/perf-runs/work-inventory-batch-20260511-01/events.jsonl`.

This was a real Work UI sweep over the perf-pass repo, but it is still a partial
batch. The driver intentionally waited about 5 seconds after many clicks, so
segment wall time is a settle window rather than raw click latency.

Initial inventory-driver slice counts before the hot code reload:

- `800` total events, including `103` manual step events.
- `51` unique manual step names.
- `238` IPC invokes.
- `399` process metric samples.
- Process CPU p95 across sampled Electron processes: `0.1%`; max sample: `8.1%`.
- Top IPC cost: `ade.github.getStatus` `644ms`, `ade.ai.getStatus` `427ms`
  total / `328ms` max, `ade.lanes.list` `100ms`.
- Local-runtime-disabled guard stayed clean in this run: no
  `ade.localRuntime.*` IPC rows were emitted.
- Sync stayed cheap in this run: `ade.sync.getStatus` was `2` calls / `1ms`
  total.

Rows promoted to `measured` from this run:

- Work shell: `work.route.open`, `work.mode.chat`, `work.mode.cli`,
  `work.mode.shell`, `work.view.tabs`, `work.view.grid`.
- Session list: `work.sessions.search`, `work.sessions.filters.open`,
  `work.sessions.filter.all`, `work.sessions.filter.running`,
  `work.sessions.filter.awaiting`, `work.sessions.filter.ended`,
  `work.sessions.group.lane`, `work.sessions.group.status`,
  `work.sessions.group.time`.
- Start surfaces: `work.start.cli.provider.claude`,
  `work.start.cli.provider.codex`, `work.start.cli.provider.cursor`,
  `work.start.cli.provider.droid`, `work.start.cli.provider.opencode`.
- Chat composer/menu open paths: `work.chat.model.open`,
  `work.chat.attach.open`, `work.chat.command.open`,
  `work.chat.parallel.open`.
- Work tools tabs/panel mounts: `work.sidebar.tab.git`,
  `work.sidebar.tab.files`, `work.sidebar.tab.ios`,
  `work.sidebar.tab.app-control`, `work.sidebar.tab.browser`,
  plus `work.git.mount`, `work.files.mount`, `work.ios.mount`,
  `work.app-control.mount`, `work.browser.mount`.
- Git tools: `work.git.more.open`.

Invalid current-run markers:

- `work.grid.arrange.open` clicked the global `Automations` nav because the
  matcher was too broad. Grid arrange rows from this run are invalid.
- `work.git.refresh` clicked `AMEND`, not refresh. This run did not promote the
  row; a later precise-selector retry covers it.

Skipped current-run rows that were unpromoted at this stage:

- `work.chat.composer.type` and `work.chat.attach.search` skipped because the
  expected inputs were not visible in the current chat state.
- `work.files.filter` and `work.files.filter.clear` skipped because the embedded
  Files filter input/clear button were not visible to the driver.
- `work.app-control.launch-input` and `work.app-control.cdp-port` skipped
  because the setup inputs were not visible in the current App Control state.
- `work.browser.tab.new`, `work.browser.url.type`,
  `work.browser.inspect.toggle`, `work.browser.screenshot.start`, and
  `work.browser.screenshot.cancel` skipped because the browser chrome controls
  were not visible to the driver.
Two Git IPCs failed early against stale perf-pass worktree state
(`ade.git.listRecentCommits`, `ade.git.stashList`); the worktrees were repaired
and later Git status calls succeeded. Those failures are run setup caveats, not
coverage evidence.

The same run later hot-reloaded the main bundle while measuring the GitHub
status fix. Its full file now contains `1,490` events and `3`
`ade.github.getStatus` calls:

- Pre-fix initial Work startup: `644ms`.
- Post-fix hot-reload startup: `473ms`.
- Post-fix follow-up status call: `192ms`.

### `work-github-status-after-20260511-01`

Perf event file:
`~/.ade/perf-runs/work-github-status-after-20260511-01/events.jsonl`.

This was a clean post-fix Work launch focused on the shell GitHub status path,
not an inventory sweep.

- `ade.github.getStatus`: `524ms` (`1` call, `0` failures).
- `ade.ai.getStatus`: `308ms` (`1` call).
- `ade.sync.getStatus`: `0ms` (`1` call).
- `ade.localRuntime.*`: `0` calls.
- Process CPU p95: `7.08%`; max sample: `8.80%`.

This run crashed about 30 seconds in with a V8 heap OOM after main-process heap
metrics spiked above `1.8GB`. Treat that as a separate ADE perf/stability bug to
investigate; do not treat rows after the crash as valid coverage.

### `work-usage-oom-after-20260511-01`

Perf event file:
`~/.ade/perf-runs/work-usage-oom-after-20260511-01/events.jsonl`.

This was a clean Work launch after bounding the local usage cost-log scanner.
It was allowed to run past the previous crash window.

- `255` total events, including `67` process metric samples.
- Main-process heap max: `130.9MB` after the fix, versus `1,867.7MB` in the
  crashing run.
- Process CPU p95: `0.18%`; max sample: `9.00%`.
- `ade.github.getStatus`: `498ms` (`1` call, `0` failures).
- The process stayed alive past the prior OOM point and was stopped manually.

### `work-github-startup-delay-after-20260511-01`

Perf event file:
`~/.ade/perf-runs/work-github-startup-delay-after-20260511-01/events.jsonl`.

This was a clean Work launch after splitting the top-bar publish check from the
full GitHub auth status and moving the shell banner/avatar auth refresh out of
the first startup window.

Comparison runs:

- `work-github-banner-defer-after-20260511-01`, before the shell auth delay:
  first `10s` IPC total `901ms`; `ade.github.getRemoteStatus` was `0ms`, but
  delayed `ade.github.getStatus` still landed inside the startup window at
  `293ms`.
- `work-github-startup-delay-after-20260511-01`, after the shell auth delay:
  first `10s` IPC total `633ms`; `ade.github.getRemoteStatus` stayed `0ms`;
  `ade.github.getStatus` was absent from the first startup summary and ran later
  at `301ms`.

CPU/process notes for the final run:

- `93` total events, `57` IPC invoke events, and `15` process metric samples.
- Process CPU p95: `1.76%`; max sample: `4.25%`.
- The full GitHub auth check still runs as background shell state; this is a
  Work startup-load win, not removal of GitHub connectivity validation.

### `work-inventory-shell-session-20260512-01`

Perf event file:
`~/.ade/perf-runs/work-inventory-shell-session-20260512-01/events.jsonl`.

This was a real Electron Work UI run over the reset perf-pass repo with
`NO_DEVTOOLS=1`, the now-removed local-runtime-disable diagnostic mode, and
`ADE_MODEL_OVERRIDE=gpt-5-codex`.

Startup notes:

- First 10s IPC total was `678ms`; `ade.ai.getStatus` was `349ms` and
  `ade.lanes.list` was `128ms`.
- Full `ade.github.getStatus` stayed out of the first 10s startup window, then
  ran later at `866ms`.
- The first shell-lane and shell-launch attempts hit a stale/missing recovered
  lane worktree and are invalid coverage. Switching the draft to `Primary`
  produced valid `work.start.shell.lane` and `work.start.shell.launch` markers.

Rows promoted to `measured` from valid markers in this run:

- Work shell/layout: `work.sessions.hide`, `work.sessions.show`,
  `work.split.sessions.resize`, `work.split.tools.resize`,
  `work.sidebar.close`, `work.sidebar.open`, `work.view.grid`,
  `work.view.tabs`, `work.grid.arrange.open`, `work.grid.arrange.rows`,
  `work.grid.arrange.columns`, `work.grid.arrange.auto`,
  `work.group.collapse`, `work.group.expand`, `work.tab.select`,
  `work.tab.context`.
- Start surface: `work.start.shell.lane`, `work.start.shell.launch`.
- Session list: `work.sessions.select.single`, `work.sessions.details`,
  `work.sessions.context.open`, `work.sessions.group.collapse`,
  `work.sessions.group.expand`, `work.sessions.select.range`,
  `work.sessions.bulk.clear`.

Rows intentionally left unpromoted:

- `work.sessions.context.rename` timed out waiting for the rename menu.
- `work.sessions.select.multi` was still unpromoted in this run. It was later
  covered by `work-partial-closure-20260512-01` with a metadata-only two-chat
  fixture.
- `work.sessions.filter.lane` failed in the first pass and was not re-driven as
  a lane-change action. The later narrow probe only opened/measured the filter
  lane picker.
- `work.sessions.filters.open` was already covered by an earlier inventory run;
  one marker in this run failed because the panel was already open.

Small-screen UX fix measured in the same run:

- Before: `work.small.session-filter-overflow.before` showed a `120.2px` wide
  filter panel with status/group controls reaching `122.8px` past the panel
  right edge.
- After wrapping the filter option controls and making the lane trigger consume
  its narrow parent, `work.small.session-filter-overflow.after` showed the
  rightmost control ending `8.0px` inside the panel.
- `work.small.lane-combobox-overflow.before` did not reproduce a lane popover
  overflow; the measured popover ended `210px` inside the renderer viewport.

### `work-context-menu-edge-20260512-01`

Perf event file:
`~/.ade/perf-runs/work-context-menu-edge-20260512-01/events.jsonl`.

This was a real Electron Work UI run over the reset perf-pass repo. It launched
one shell session through the visible Work UI as `work.fixture.shell-for-context-menu`,
then used a UI-derived `contextmenu` probe on the visible Work tab because CDP
right-click did not fire React's context-menu handler in this environment.

Rows promoted to `measured`:

- `work.small.session-context-menu-overflow`.
- `work.sessions.filter.lane`.
- `work.sessions.context.rename`.
- `work.sessions.context.go-lane`.
- `work.start.cli.lane`.
- `work.start.cli.permissions.claude`,
  `work.start.cli.permissions.codex`, `work.start.cli.permissions.cursor`,
  `work.start.cli.permissions.droid`, and
  `work.start.cli.permissions.opencode`.
- `work.chat.composer.type`.
- `work.chat.attach.search`.
- `work.chat.model.select`, `work.chat.model.reasoning`, and
  `work.chat.permissions.claude`.

Invalid markers in this run:

- The first three `work.small.session-context-menu-overflow.before` attempts
  missed the target (`missing menu` or `Missing visible work tab`) and are not
  evidence.
- The first two `work.small.session-context-menu-overflow.after` attempts ran
  before the patched renderer was reloaded and still showed the old overflow.
  Treat only the final `after` marker in this run as post-fix evidence.
- The first `work.sessions.filter.lane` attempt timed out waiting for the lane
  trigger after a coordinate click and is not evidence. The later UI-derived
  DOM-click fallback is the valid marker for this row.
- The first `work.sessions.context.rename` attempt used an invalid class
  selector for a slash-containing Tailwind class. The second renamed the
  session successfully, but its verification expected the full title in a
  truncated tab label. Treat only the final `rename` marker as valid evidence.
- The first `work.start.cli.permissions.claude` attempt used an exact provider
  label lookup even though the visible button text includes logo text. The
  later provider-permission pass is the valid marker.
- `work.chat.composer.clear` timed out because this Work draft composer layout
  did not expose a visible `Clear` button after typing. Leave that row
  unpromoted. The paired `work.chat.composer.type` `fail` marker came from the
  same cleanup catch path after the type marker had already ended successfully.

Small-screen UX fix:

- Before: the context menu opened at `left=534.0px` in a `582px` viewport with
  a `180px` menu width, overflowing right by `132.0px`.
- After clamping the measured menu rectangle to an `8px` viewport inset, the
  same `clientX=534.3px` probe placed the menu at `left=394.0px`, ending
  `8.0px` inside the viewport.
- Validation: `npm --prefix apps/desktop run typecheck` passed. No existing
  focused `SessionContextMenu` test file was present.

Lane filter coverage:

- The valid `work.sessions.filter.lane` marker opened the visible sessions
  filter panel and changed the lane combobox from `All lanes` to `Primarymain`
  with `panelOpen=true`.
- The probe used DOM clicks on visible ADE controls after the coordinate click
  did not open the narrow lane selector reliably in this renderer session.

Session rename coverage:

- The valid `work.sessions.context.rename` marker opened the visible Work-tab
  context menu, clicked `Rename`, focused the rename input, and changed the
  session title from `Perf rename probe 65362` to `Probe 9920`.
- Verification used visible body/tab text because long tab titles are
  intentionally truncated in the Work tab strip.

Session go-to-lane coverage:

- The valid `work.sessions.context.go-lane` marker opened the same Work-tab
  context menu, clicked `Go to lane`, and verified navigation from
  `http://localhost:5173/work#/work` to `/lanes?laneId=...&sessionId=...`.
- The probe returned the app to Work after recording the marker so the run
  remained usable for later Work-tab audit steps.

CLI start-surface lane coverage:

- The valid `work.start.cli.lane` marker clicked the Work `New Chat` affordance,
  switched the draft surface to `CLI`, opened the CLI lane combobox, and changed
  the selected lane from `Primarymain` to
  `ui audit lane 1ade/ui-audit-lane-1-e5d1420e`.
- The marker stopped before launching a CLI session.

CLI permission coverage:

- The valid provider-permission markers selected each CLI provider and clicked
  every visible permission pill without launching a session.
- Covered labels: Claude `Default`, `Accept Edits`, `Plan`, `Bypass`; Codex
  `Default permissions`, `Plan mode`, `Full access`, `Custom (config.toml)`;
  Cursor `Agent`, `Plan`, `Ask`, `Force`; Droid `Read-only`, `Auto low`,
  `Auto medium`, `Auto high`; OpenCode `Ask`, `Plan`, `Edit`, `Allow`,
  `Config`.

Chat composer coverage:

- The valid `work.chat.composer.type` marker switched to the Chat draft surface
  and entered `perf composer draft only` into the visible textarea with
  `aria-label="Type to vibecode"`.
- The draft text was cleared afterward for hygiene, but not counted as
  `work.chat.composer.clear` coverage because no visible Clear button was
  present in this layout.
- The valid `work.chat.attach.search` marker opened the attachment picker,
  typed `package` into the `Search files...` input, and closed the picker
  without selecting a file.
- The valid `work.chat.model.select` marker opened the model catalog and chose
  `Claude Opus 4.7`, updating the composer model button from `Select model`.
- The valid `work.chat.model.reasoning` marker changed the visible reasoning
  effort select from `medium` to `high`.
- The valid `work.chat.permissions.claude` marker opened the Claude permission
  menu and changed the composer permission button from `Ask permissions` to
  `Accept edits`.

### `work-chat-controls-20260512-02`

Perf event file:
`~/.ade/perf-runs/work-chat-controls-20260512-02/events.jsonl`.

This was a real Electron Work UI run over the reset perf-pass repo. It used the
empty Work/Chat surface, selected Codex models through the visible model picker,
and configured parallel-model controls without launching a session.

Rows promoted to `measured`:

- `work.start.no-sessions`.
- `work.chat.empty`.
- `work.chat.fast-mode`.
- `work.chat.permissions.codex`.
- `work.chat.parallel.add`.
- `work.chat.parallel.configure`.
- `work.chat.parallel.execution`.

Invalid setup/probe notes:

- `work-chat-controls-20260512-01` is setup-only and invalid as evidence. A
  stale local runtime helper caused duplicate project initialization,
  `database is locked`, and `cannot start a transaction within a transaction`
  errors before any useful Work marker.
- The first large CDP probe in `work-chat-controls-20260512-02` failed at JS
  parse time before recording markers.
- `work.chat.command.select` was not promoted from the empty perf-pass state:
  the slash menu exposed only `/clear Clear chat history`, so the valid marker
  for this run is a `fail` with `reason=no non-clear command row`. Later
  focused composer evidence covers the non-clear command row.
- The first `work.chat.parallel.execution` probe is invalid because it searched
  for title-case `Focused` / `Parallel`; the UI renders uppercase `FOCUSED` /
  `PARALLEL`. The later retry is the valid marker.

Empty-state coverage:

- `work.start.no-sessions` verified the visible Work session list showed
  `No sessions` and `Start a new session above.`.
- `work.chat.empty` verified the visible Chat draft showed
  `Start a new conversation`, an empty textarea with
  `aria-label="Type to vibecode"`, and a disabled `Send` button.

Codex composer coverage:

- The valid `work.chat.fast-mode` marker selected `GPT-5.4`, then clicked the
  visible `Fast mode` button and observed `aria-pressed` change from `false`
  to `true`.
- The valid `work.chat.permissions.codex` marker opened the `Codex approval
  preset` menu and changed the visible label from `Default permissions` to
  `Plan mode`. Options observed: `Default permissions`, `Plan mode`,
  `Full access`, and `Custom (config.toml)`.

Parallel composer coverage:

- The valid `work.chat.parallel.add` marker opened parallel setup through
  `Configure parallel models` and clicked `Add model`, increasing visible
  model slots from `2` to `3`.
- The valid `work.chat.parallel.configure` marker clicked a slot `Configure`
  button and verified the slot changed to `Editing` with a visible `GPT-5.4`
  model selector.
- The valid `work.chat.parallel.execution` retry scrolled the uppercase mode
  controls into the viewport, then changed `PARALLEL` from
  `aria-pressed=false` to `true` while both `FOCUSED` and `PARALLEL` were
  inside the `1164x745` renderer viewport.

### Handoff focused fixture coverage

Validation:
`npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatPane.submit.test.tsx -t "handoff"`
passed (`5` handoff tests, `39` skipped).

Rows promoted to `measured` from focused fixture evidence:

- `work.chat.handoff.open`.
- `work.chat.handoff.permissions`.
- `work.chat.handoff.launch`.

Coverage notes:

- The handoff button is intentionally available only for standard locked Work
  chats. The fixture asserts it is present for a standard locked chat and absent
  for resolver/new-chat surfaces.
- The open/menu fixture clicks `Handoff` and verifies the menu copy
  `Create opens the new work chat and sends the handoff summary as its first
  message.`
- The permissions fixture opens the handoff model picker, selects
  `Claude Sonnet 4.6`, changes `Claude permission mode for handoff` to `plan`,
  and verifies the mocked handoff call includes the selected target model and
  permission mode.
- The launch fixture clicks `Create handoff chat` and verifies the mocked
  `agentChat.handoff` call and returned created session callback. No real
  handoff chat was launched in Electron during this fixture pass.

### `work-proof-drawer-20260512-01`

Perf event file:
`~/.ade/perf-runs/work-proof-drawer-20260512-01/events.jsonl`.

This was a real Electron Work UI run over the reset perf-pass repo. It used the
empty Work/Chat surface and did not launch an agent session.

Rows promoted to `measured`:

- `work.chat.lane-select`.

Rows reclassified:

- `work.chat.drawer.proof` and `work.chat.drawer.resize` moved from `source` to
  `fixture-needed` at this stage. The valid `work.chat.drawer.proof` fail marker
  shows that the empty draft surface has no visible `Open proof drawer` button.
  Later focused companion-drawer evidence covers the retained rows.

Invalid markers in this run:

- The first `work.chat.lane-select` marker picked the full-page container text
  from a broad candidate query and is not evidence.

Chat lane selector coverage:

- The valid retry narrowed the query to `.ade-lane-popover-item`, selected
  `ui audit child light ade/ui-audit-child-light-af4e70ab`, and verified the
  visible `Select lane` button changed from
  `ui audit lane 1 ade/ui-audit-lane-1-e5d1420e` to the child-light lane.

### `work-chat-other-controls-20260512-01`

Perf event file:
`~/.ade/perf-runs/work-chat-other-controls-20260512-01/events.jsonl`.

This was a real Electron Work UI run over the reset perf-pass repo. It used the
empty Work/Chat surface, selected a Cursor-backed model through the visible
model picker, and configured safe composer controls without launching a session
or sending a prompt.

Rows promoted to `measured`:

- `work.chat.permissions.other`.
- `work.chat.cursor-cloud.open`.
- `work.chat.parallel.remove`.
- `work.git.commit-message`.
- `work.git.amend-toggle`.
- `work.git.pull-mode.rebase`.
- `work.git.pull-mode.merge`.
- `work.git.refresh`.
- `work.files.error.dismiss`.
- `work.files.workspace`.
- `work.files.filter`.
- `work.files.filter.clear`.
- `work.files.content.open`.
- `work.files.content.search`.
- `work.files.quick.open`.
- `work.files.quick.search`.
- `work.files.tree.open`.
- `work.files.tree.context`.
- `work.files.tree.expand`.
- `work.files.tree.collapse`.
- `work.files.suggested-lane`.
- `work.files.context.open`.
- `work.files.context.open-diff`.
- `work.files.mode.code`.
- `work.small.files-context-menu-overflow`.
- `work.small.files-embedded-overflow`.
- `work.browser.tab.new`.
- `work.browser.tab.switch`.
- `work.browser.tab.close`.
- `work.browser.url.type`.
- `work.browser.inspect.toggle`.
- `work.app-control.launch-input`.
- `work.app-control.cdp-port`.
- `work.ios.surface.preview`.
- `work.ios.surface.simulator`.
- `work.ios.refresh-state`.
- `work.ios.preview-refresh`.
- `work.ios.preview-mode.capture`.
- `work.ios.preview-mode.control`.
- `work.ios.preview-agent-action`.

Rows reclassified:

- `work.chat.composer.clear` moved from `source` to fixture evidence at this
  stage. In this composer layout the visible `Clear` button is an active-turn
  steer control, not an empty-draft control.
- `work.app-control.help-cdp` needed fixture evidence from this state: in the
  detached Work tools pane `canAttachToChat` is false, so the Help wire CDP
  draft button is not rendered.
- `work.app-control.mode.control`, `work.app-control.mode.inspect`, and
  `work.app-control.type-input` needed fixture evidence from this state: the
  empty App Control tools pane has no active app session, so both mode buttons
  are disabled and typing cannot target a focused external app element.
- `work.ios.preview-ask-agent` and `work.ios.preview-add-preview` needed
  fixture evidence from this state: the detached Work tools pane has no chat
  draft target, so Preview help prompts would copy/draft text instead of
  exercising a selected chat context. The empty Primary lane also had no
  renderable preview target.
- The remaining `source` rows also needed later fixture evidence after the
  empty-surface audit and source inspection. They require seeded state that is
  not present in the reset perf-pass empty Work surface: minimized/packed work
  panes, parent/child session groups, selected chats with Git toolbar or
  terminal drawer, queued composer messages, a non-clear slash command, Cursor
  Cloud launch mode, non-embedded Files chrome, or a clipboard-safe COPY PATH
  harness.

Cursor composer coverage:

- The valid `work.chat.permissions.other` marker selected a Cursor model and
  changed the native mode select from `agent` to `ask`. Options observed:
  `Agent`, `Ask`, `Plan`, and `Full auto`.
- The valid `work.chat.cursor-cloud.open` marker opened the visible
  `Cursor Cloud actions` button and verified the menu contained both
  `Send to Cursor Cloud` and `Open existing cloud chat`. It stopped at the menu
  and did not launch a cloud session.

Parallel composer coverage:

- The valid `work.chat.parallel.remove` marker opened parallel setup, used
  `Add model` to increase visible model slots from `2` to `3`, then clicked
  `Remove` and verified the slot count returned to `2`.

Chat Git toolbar coverage:

- Full Work UI probes tried DOM click, synthetic pointer events, and CDP mouse
  input on the visible toolbar `Run` button; none opened the Radix menu, even
  after switching the Work tools pane away from Browser and verifying the
  native BrowserView was hidden. The focused `ChatGitToolbar.test.tsx` fixture
  now covers the exact embedded `QuickRunMenu` Radix trigger with
  pointerdown/up events, so `work.chat.git.run-menu` is measured by fixture even
  though broad coordinate clicks remain flaky.
- The valid `work.chat.git.commit-message` marker first switched away from the
  Browser tools panel, clicked `Stage & Commit` with CDP mouse input, typed
  `Perf toolbar commit message` into the inline commit input, then cleared the
  input value without submitting. The inline commit input stayed open and empty
  after cleanup, so close behavior is not part of this row's evidence.

Focused fixture command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/ChatGitToolbar.test.tsx
```

Result: passed (`2` focused tests).

Rows promoted to `measured`:

- `work.chat.git.lane-open`: the toolbar fixture rendered the real current-lane
  button inside `MemoryRouter`, clicked `UI audit lane`, and verified navigation
  to `/lanes/lane-1`.
- `work.chat.git.run-menu`: the same fixture opened the real `Run` trigger with
  pointerdown/up, verified `Lane runtime`, `Open Run tab`, and
  `Open shell in Work`, and verified no start/stop process action fired.

Cursor Cloud inline launch fixture:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/CursorCloudInlineLaunch.test.tsx
```

Result: passed (`1` focused test).

Rows promoted to `measured`:

- `work.chat.cursor-cloud.cancel`: the inline-launch fixture clicked
  `Cancel cloud send`, verified `onClose` fired once, and verified
  `cursorCloudCreateRun` was not called.

Git toolbar coverage:

- The valid `work.git.commit-message` marker typed
  `perf audit message only` into the visible `Commit message` input, then the
  driver cleared it after recording for hygiene.
- The valid `work.git.amend-toggle` marker clicked `AMEND` and verified the
  button changed to `AMEND ON` with warning-colored active styling. The driver
  toggled it back off after recording.
- The valid `work.git.pull-mode.rebase` marker clicked `REBASE` and verified
  the active color/border moved from `MERGE` to `REBASE`.
- The valid `work.git.pull-mode.merge` marker clicked `MERGE` and verified the
  active color/border moved back from `REBASE` to `MERGE`.
- The valid `work.git.refresh` marker clicked the exact toolbar refresh icon
  button after `MORE`, avoiding the earlier invalid `AMEND` click from
  `work-inventory-shell-session-20260512-01`.

Files coverage:

- The valid `work.files.error.dismiss` marker dismissed the real missing-lane
  workspace error from the Files panel.
- The valid `work.files.workspace` marker changed the workspace selector from
  `ui audit lane 1 ... (worktree)` to `Primary - main (primary)`.
- The valid `work.files.filter` marker typed `README` into `Filter paths`, and
  `work.files.filter.clear` clicked the visible clear-filter control.
- The valid `work.files.content.open` and `work.files.content.search` markers
  opened the content search overlay and searched for `Initial`. This fixture
  returned `NO MATCHES`, so the result row was left for later seeded evidence.
- The valid `work.files.quick.open` and `work.files.quick.search` markers
  opened Quick Open and searched for `README`. This fixture returned
  `NO MATCHES`, so the result row was left for later seeded evidence.
- The valid `work.files.tree.open` marker opened `README.md` in the editor.
- The valid `work.files.tree.context` marker opened the README context menu and
  observed `OPEN`, `OPEN DIFF`, `STAGE`, `UNSTAGE`, `DISCARD`, and
  `COPY PATH`.
- The valid `work.files.tree.expand` and `work.files.tree.collapse` markers
  expanded the `.ade` directory row and collapsed it back to the original root
  row set.
- The valid `work.files.suggested-lane` marker clicked
  `SWITCH TO: UI AUDIT LANE 1`, observed the missing worktree error for that
  suggested lane, then restored the workspace selector to
  `Primary - main (primary)`.
- The valid `work.files.context.open` marker clicked `OPEN` from that context
  menu and kept `README.md` open in the editor.
- The valid `work.files.context.open-diff` marker clicked `OPEN DIFF` from the
  README context menu. The valid `work.files.mode.code` marker then clicked
  `CODE` and returned the editor to direct code view without writing the file.

Files context-menu UX fix:

- Before: right-clicking near the right edge of the `README.md` row opened the
  Files context menu at `x=1163.0px` with a `200px` width in a `1164px`
  viewport, overflowing right by `199px` and bottom by `159.1px`.
- After clamping to the measured menu size with an `8px` viewport inset, the
  same right-edge probe placed the menu at `x=956.0px`, ending at
  `right=1156.0px` and `bottom=737.0px` in the `1164x745` viewport.
- Validation now covers the permanent workbench with
  `src/renderer/components/files/v2/editorGroupsStore.test.ts`,
  `src/renderer/components/files/v2/viewerRegistry.test.ts`, and
  `src/renderer/components/files/monacoModelRegistry.test.ts`; also run
  `npm --prefix apps/desktop run typecheck`.

Embedded Files layout UX fix:

- Before: in the narrow Work tools pane, the embedded Files layout kept a
  fixed `320px` explorer column. In a `1164px` renderer viewport the explorer
  ended at `right=1170.8px`, the editor was squeezed to `1.8px`, and the
  `CODE` button ended at `right=1256.2px`, overflowing the viewport by
  `92.2px`.
- After making the embedded workbench layout responsive, the
  explorer and editor both fit at `right=1151.6px`; the `CODE` button ended at
  `right=953.8px`, with `0px` right overflow.
- Validation after the embedded layout fix now uses the permanent workbench
  tests plus `npm --prefix apps/desktop run typecheck`.

Browser coverage:

- The valid `work.browser.tab.new` marker clicked `New tab` and verified the
  visible tab count increased from `1` to `2`.
- The valid `work.browser.tab.switch` marker clicked the inactive browser tab
  and verified active tab state moved to it.
- The valid `work.browser.url.type` marker typed `example.com` into the
  `ADE browser URL` input without opening the URL, then restored the old input
  value.
- The first `work.browser.inspect.toggle` marker did not enter `Inspecting`
  state and is invalid. The valid retry waited for the browser inspect API and
  observed `Inspect -> Inspecting -> Inspect`.
- The valid `work.browser.tab.close` marker closed the extra browser tab and
  verified the visible tab count returned to `1`.
- The valid `work.browser.back` marker used a localhost `/a -> /b` history
  fixture, clicked `Go back`, and verified the active URL returned to `/a` with
  `canGoForward=true`.
- The valid `work.browser.forward` marker clicked `Go forward` from the same
  fixture and verified the active URL returned to `/b` with `canGoBack=true`.
- The valid `work.browser.reload` marker clicked `Reload` on the localhost `/b`
  page and verified the fixture request count increased from `2` to `3`.
- The first `work.browser.stop` attempt is invalid: URL-open navigation kept the
  toolbar in a busy state and the `Stop loading` button was disabled. The valid
  retry used direct browser API navigation only to create a slow localhost
  loading fixture, waited for the real `Stop loading` button to be enabled,
  clicked it, and verified loading returned to `false` on the previous page.
- The `work.browser.message.dismiss` marker dismissed the Browser panel error
  banner created by the invalid screenshot attempt.
- Browser selected-context setup used direct `setBounds`/`selectPoint` only to
  create a localhost selected element; the real UI controls were then measured.
- The `work.browser.attach-selection` click is invalid: clicking `Attach` did
  not add another composer context chip before the probe timeout, so this run did
  not promote the row. Later focused browser-panel evidence covers the selected
  element attach control.
- The valid `work.chat.dismiss.preview` marker clicked the browser context chip
  remove affordance in the chat composer and verified chip count decreased from
  `1` to `0`.
- The valid `work.browser.clear-context` marker clicked `Clear browser context`
  and verified browser selection cleared and `Insert draft` became disabled.
- The valid `work.browser.insert-draft` marker clicked `Insert draft` for a
  selected localhost browser element, verified the `Type to vibecode` textarea
  received `Use this browser selection: ...`, then cleared the draft. Two older
  insert markers are invalid probe attempts: the first watched the wrong editor
  element and the second ran after editor cleanup had changed the active input
  shape.
- `work.browser.screenshot.start` and `work.browser.screenshot.cancel` were not
  promotable from the empty Work tools Browser panel: `Screenshot` was disabled
  with `Chat context is unavailable here`. A later selected-chat retry clicked
  `Screenshot`, but `ade.builtInBrowser.captureScreenshot` timed out before crop
  mode appeared, so that marker is also invalid. Later focused browser-panel
  evidence covers screenshot start/cancel.

App Control coverage:

- The valid `work.app-control.launch-input` marker typed
  `npm run dev -- --inspect=9229` into `App Control launch command`, then
  restored the field to empty without clicking Run.
- The valid `work.app-control.cdp-port` marker typed `9222` into `CDP port`,
  then restored the field to empty without clicking Connect.
- The `work.app-control.mode.disabled-state` marker observed `Control` and
  `Inspect` buttons disabled in the no-session tools pane. That marker is not
  a row promotion; it explains why those rows need an active app fixture.

iOS Simulator coverage:

- The first iOS probe used the missing `ui audit lane 1` worktree and is only
  valid for local surface controls. A retry switched the Work lane to
  `Primary / main`, then verified `work.ios.refresh-state` without the missing
  project-root error. The valid retry called `getStatus`, `listDevices`,
  `getStreamStatus`, and `listLaunchTargets` against the Primary project root.
- Real UI run `work-gap-closure-20260512-05` also reproduced a visible stale
  error after switching lanes. The `work.ui.real.lane-select-primary` marker
  used the visible lane selector to change from missing `ui audit lane 1` to
  `Primary / main`; `work.ui.real.ios-refresh-primary` then clicked the visible
  `Refresh simulator state` button, but the iOS footer still showed the old
  `ade.iosSimulator.listLaunchTargets` / missing-project-root message. The fix
  clears launch-target/project-root errors after a later successful
  `listLaunchTargets` call. Hot reload verification under
  `work.ui.real.ios-refresh-primary-after-fix` showed the normal simulator
  control hint instead of the stale missing-worktree error.
- The valid `work.ios.surface.preview` marker switched from Simulator mode to
  Preview mode. The Primary-lane retry ran `getPreviewCapability` and
  `listPreviewTargets` without a missing-root error; Xcode was not running, so
  Preview Lab showed the setup state instead of render targets.
- The valid `work.ios.preview-refresh` retry clicked the Preview Lab `Refresh`
  button and re-ran preview capability/target discovery against the Primary
  project root.
- The valid `work.ios.preview-mode.capture` and
  `work.ios.preview-mode.control` markers toggled the preview overlay controls
  between `Capture area` and `Control`.
- The valid `work.ios.preview-agent-action` marker changed the Preview help
  action from `open-simulator-in-preview` to `add-realistic-mocks`, then
  restored the original option.
- The valid `work.ios.surface.simulator` marker returned from Preview mode to
  Simulator mode. No simulator launch, Xcode open, Preview render, or agent
  prompt action was invoked.

Invalid markers in this run:

- The first `work.chat.composer.clear` marker attempted to find the plain
  `Clear` button while parallel setup was still open, so it is not evidence.
- The retry closed parallel setup and typed into the single-model empty draft,
  but no visible `Clear` button appeared. Source inspection shows the `Clear`
  button is gated by `turnActive`, so this row needs an active-turn fixture or
  sandbox chat run.

### `work-partial-closure-20260512-01`

Perf event file:
`~/.ade/perf-runs/work-partial-closure-20260512-01/events.jsonl`.

This was a real Electron Work UI run over the reset perf-pass repo. It started
from the remaining `measured-partial` rows, skipped first-run onboarding through
the visible `SKIP SETUP` button, and used a metadata-only Codex chat fixture for
selected-chat chrome without sending a prompt or launching an agent.

Rows promoted to `measured`:

- `work.sessions.new-chat`: clicked the sessions-pane `New Chat` button and
  verified the empty Chat draft surface stayed visible with the composer.
- `work.start.chat.mount`: clicked the visible `Chat` start-surface mode and
  verified `Start a new conversation`, the composer input, and disabled `Send`.
- `work.sidebar.compact-tabs`: with a `1164x818` renderer viewport and narrow
  Work tools pane, verified all five Work tools tabs (`Git`, `Files`, `iOS Sim`,
  `App Control`, `Browser`) had `31.99px` hit targets inside the
  viewport. A DOM-click retry selected each tab and observed `aria-pressed=true`
  for the clicked tab.
- `work.git.history.refresh`: selected the Git tools tab, clicked the commit
  timeline `REFRESH` button, and verified the `COMMITS` history section remained
  rendered with the `f5d3740` initial commit.
- `work.git.history.select`: clicked the visible `f5d3740` commit history row
  and verified the selected commit diff header rendered `COMMIT`, `f5d3740`,
  and `Initial commit`.
- `work.git.history.hover`: hovered the visible `f5d3740` commit history row
  and verified the exact commit tooltip container rendered the full SHA,
  timestamp, `Initial commit`, author, pushed status, and PR placeholder.
- `work.git.diff.commit-file`: from that selected commit diff, clicked the
  `README.md` commit-file row and verified it became the selected file.
- `work.git.files.back`: re-entered the selected commit diff, clicked the
  Git-pane `Files` back button, and verified the commit-file rows disappeared
  while the clean `STASHES` / `No changes` files view returned.
- `work.files.tab.switch`: opened `.gitignore` and `README.md` in the embedded
  Files editor, clicked the `.gitignore` editor tab, and verified the tab-bar
  highlight (`rgba(167, 139, 250, 0.2)` background, accent left border, `600`
  font weight).
- `work.files.tab.close`: closed the clean `.gitignore` editor tab and verified
  only `README.md` remained open.
- `work.files.quick.result`: opened the Quick Open overlay, searched
  `README`, clicked the overlay-scoped `README.md` result, and verified the
  `README.md` editor tab was active.
- `work.files.content.result`: opened Content Search, searched `perf`, clicked
  the overlay-scoped `README.md:<line>:<column>` result, and verified the
  `README.md` editor tab was active.
- `work.sessions.select.multi`: after seeding a second metadata-only Codex chat
  on the Primary lane and reloading the Work route, modifier-clicked the two
  visible session-list cards. The valid marker used
  `attempt=dom-mouseevent-meta-session-list`, observed `visibleSessionCards=2`,
  and verified the bulk-selection bar read `2 selected`.

Rows reclassified:

- `work.chat.drawer.ios` and `work.chat.drawer.app-control` moved from
  `measured-partial` to fixture evidence. Source inspection and real Work UI
  markers showed `WorkViewArea` and `WorkStartSurface` render `AgentChatPane`
  with `hideLaneToolDrawers`, so these drawer buttons are not rendered in the
  Work tab. The Work equivalents are the measured `iOS Sim` and `App Control`
  tools tabs; later focused companion-drawer evidence covers the retained
  cross-surface rows.

Invalid / setup markers:

- The first `work.fixture.chat-drawer-session-select` marker did not select the
  metadata-only chat because the session list had not refreshed after direct
  fixture creation. A reload made the fixture card visible; selecting the chat
  through `?sessionId=...` exposed selected-chat chrome without launching work.
- The first `work.sidebar.compact-tabs` marker hung after switching tools tabs
  in one long evaluation and has no `end` marker. The later
  `attempt=dom-click-retry` marker pair is the valid compact-tabs evidence.
- A coordinate-click retry against the compact tools tab strip did not change
  tabs reliably in Electron/CDP and is not treated as user evidence. The valid
  retry used visible DOM button clicks, consistent with prior UI-derived probes
  in this audit.
- The first `work.git.files.back` marker clicked the right control but used a
  too-strict `WORKING TREE` verification that is absent in the clean perf-pass
  Git view. A second retry still matched broad text from ancestor nodes. The
  valid evidence is `attempt=dom-click-back-from-commit-diff-retry-2`, which
  verified commit-file buttons were gone and `STASHES` / `No changes` returned.
- The first `work.git.history.hover` marker used an overly broad tooltip text
  search and matched an ancestor/body string. The valid evidence is
  `attempt=dom-mouseover-commit-row-tooltip-container`, scoped to the
  `CommitTimeline` tooltip container.
- The first `work.files.tab.switch` / `work.files.tab.close` retry matched
  file-tree rows as well as editor tabs. The valid retry scoped to editor
  tab-bar buttons (`button.truncate.text-left` with no `title` inside the
  shrinkable tab group).
- The first `work.files.quick.result` marker matched a broad `README.md` button
  while the Quick Open overlay was visible. The valid retry scoped result clicks
  to `div.absolute.inset-0.z-30` overlay buttons; Content Search used the same
  overlay scope.
- The first `work.sessions.select.multi` retry used a broad selector that also
  matched the Git commit history row; it left only one session selected and is
  invalid. The valid retry scoped clicks to
  `[data-tour="work.crossLaneSwitch"]` session-card buttons.

Next audit batches should treat `sandbox-only`, `prompt-only`, and
`external-skip` rows according to their row state. If any row is reclassified
back to `fixture-needed` or `source`, mark the exact workflow with a matching
`manualStep` name and promote it only after evidence exists under
`~/.ade/perf-runs/<runId>/events.jsonl`.

### `work-gap-closure-20260512-05`

Perf event file:
`~/.ade/perf-runs/work-gap-closure-20260512-05/events.jsonl`.

This real Electron Work UI run continued from the visible Work > Git tools
pane on the perf-pass repo. It created a temporary untracked
`work-git-stage-unstage.tmp` file, drove the Git controls from the UI, verified
the git status after each action, then removed only that temporary file. It then
created `work-git-stash-untracked.tmp` to drive the visible Save Changes and
Restore stash controls against a real untracked-file stash, and
`work-git-stash-apply.tmp` to drive Copy to Worktree.

Rows promoted to `measured`:

- `work.git.stage-all`: clicked the visible `STAGE ALL` button and verified the
  temp file changed from `?? work-git-stage-unstage.tmp` to
  `A  work-git-stage-unstage.tmp`.
- `work.git.unstage-all`: clicked the visible `UNSTAGE STAGED` button and
  verified the temp file returned to `?? work-git-stage-unstage.tmp`.
- `work.git.file.stage`: clicked the per-file stage icon for
  `work-git-stage-unstage.tmp` and verified the file moved into staged changes.
- `work.git.file.unstage`: clicked the per-file unstage icon and verified the
  file returned to unstaged changes before cleanup.
- `work.git.stash.save`: clicked the visible `SAVE CHANGES` button, entered a
  note, and verified `git stash list` gained `stash@{0}` while
  `work-git-stash-untracked.tmp` disappeared from the working tree.
- `work.git.stash.restore`: clicked the visible `RESTORE` button for that stash
  and verified the temp file returned as `?? work-git-stash-untracked.tmp` while
  `git stash list` became empty.
- `work.git.stash.apply`: seeded a temporary untracked stash, clicked the
  visible `COPY TO WORKTREE` button, and verified the temp file returned as
  `?? work-git-stash-apply.tmp` while `git stash list` still contained
  `stash@{0}`.

UX fix from this pass:

- The per-file stage/unstage icon button had no accessible name in the real
  Electron accessibility tree. `LaneGitActionsPane.tsx` now labels the control
  as `Stage <path>` or `Unstage <path>`, and
  `LaneGitActionsPane.test.tsx -t "labels and invokes per-file stage and
  unstage controls"` verifies both labels and callbacks.
- `SAVE CHANGES` reported success but left untracked-only changes in the working
  tree because the renderer did not pass `includeUntracked`. The Save Changes
  tooltip now says when untracked files are included, and the action calls
  `stashPush({ includeUntracked: true })` whenever unstaged changes include
  untracked files.
- `RESTORE` reported success and restored an untracked-only stash, but the stash
  entry stayed saved. The service was listing date-based stash refs such as
  `stash@{2026-05-12T02:00:55-04:00}`; Git can apply those refs, but dropping
  them does not remove the stash list entry. `listStashes` now returns ordinal
  refs such as `stash@{0}` with the ISO timestamp as a separate field, and
  `stashPop` applies then drops the ordinal ref so the UI's "Restore removes
  entry" behavior is true.

Inventory count after this batch:

```json
{
  "measured": 266,
  "prompt-only": 43,
  "external-skip": 33,
  "sandbox-only": 52
}
```

### `work-fixture-gap-20260512-02`

Perf event file:
`~/.ade/perf-runs/work-fixture-gap-20260512-02/events.jsonl`.

This is an in-progress real Electron Work UI run over the reset perf-pass repo.
It skipped first-run onboarding through the visible `SKIP SETUP` button, then
used the embedded Files tools pane with the Primary workspace and `README.md`
open.

Rows promoted to `measured`:

- `work.git.file.select`: created a temporary untracked
  `perf-audit-git-file-select.tmp` file in the perf-pass fixture repo, opened
  Work > Git on the Primary lane, clicked the visible changed-file row, and
  verified the diff pane showed `WORKING TREE / perf-audit-git-file-select.tmp`.
  The temporary file was deleted after the marker.
- `work.ios.device-select`: opened the iOS Sim tools tab, changed the populated
  simulator device select from `iPad (A16) - iOS 26.3 - Shutdown` to
  `iPad (A16) - iOS 18.6 - Shutdown`, then restored the original selection.
- `work.ios.media.expand`: on the Preview Lab media toolbar, clicked
  `Expand preview view`, verified the control changed to
  `Exit expanded preview view`, then restored the non-expanded view.
- `work.ios.media.zoom-in`: clicked `Zoom in preview view` and verified the
  toolbar zoom label changed from `100%` to `125%`.
- `work.ios.media.zoom-out`: clicked `Zoom out preview view` and verified the
  label changed from `125%` to `100%`.
- `work.ios.media.zoom-reset`: after a setup zoom-in to `125%`, clicked
  `Reset preview zoom` and verified the label returned to `100%`.
- `work.chat.attach.select-file`: switched the Chat composer lane to Primary as
  setup, opened the visible attachment picker, searched `README` through CDP
  text input, clicked the `README.md` result, and verified the attachment chip
  appeared.
- `work.chat.attach.remove`: clicked the visible `Remove README.md` chip button
  and verified the chip disappeared while `Send` returned disabled.
- `work.files.mode.changes`: clicked the visible embedded editor `CHANGES`
  mode button and verified the active style changed from transparent to
  `rgb(167, 139, 250)`.
- `work.files.mode.merge`: clicked the visible embedded editor `MERGE` mode
  button and verified the active style changed from transparent to
  `rgb(167, 139, 250)`.
- `work.files.diff.mode-staged`: after opening embedded `CHANGES` view, clicked
  the inner `STAGED` diff mode and verified the active style changed to
  `rgb(167, 139, 250)`.
- `work.files.diff.mode-working`: clicked the inner `WORKING TREE` diff mode
  and verified the active style changed to `rgb(167, 139, 250)`.
- `work.files.diff.mode-commit`: clicked the inner `COMMIT` diff mode, verified
  the active style changed to `rgb(167, 139, 250)`, and observed the compare ref
  select with `f5d3740 - Initial commit`.

Rows this run left for later focused evidence:

- `work.chat.command.select`: the empty Work composer slash menu exposed only
  `/clear`, so this run needed later non-clear command evidence.
- `work.chat.attach.open-preview`: selecting `README.md` creates a text-file
  chip, and `ChatAttachmentTray` only renders preview/open controls for image
  attachments. A follow-up SVG fixture probe hung before a visible lightbox, so
  this run needed later image attachment evidence.
- `work.ios.preview-ask-agent` and `work.ios.preview-add-preview`: in the
  current detached Work tools pane, Preview help falls back to copying the
  prompt (`Copied "Open simulator screen in preview" prompt.`) instead of
  inserting a chat draft. Later focused iOS panel evidence covers the
  chat-draft-capable callbacks.
- `work.files.primary-edit`: with `README.md` open in the embedded Work Files
  pane, primary-workspace edit controls are intentionally not part of the
  compact embedded chrome. Keep primary-workspace policy evidence on the
  standalone Files route or at the service boundary.

Invalid / setup markers:

- The first `work.git.file.select` attempt looked only at visible `button`
  elements. The changed-file row rendered as a clickable div with the path text;
  its adjacent buttons are row actions such as discard/stage.
- The first attachment-picker attempt set the DOM input value directly, but
  React state did not update, so the picker still showed `Type to search
  files...`.
- The CDP-input retry searched while the Chat composer lane was still the
  missing `ui audit lane 1` worktree and correctly returned no `README.md`
  results. The valid marker switched the composer lane to `Primary` first.
- The `work.ios.preview-ask-agent` attempt clicked the real Preview Lab
  `Ask agent` button, but it only produced the clipboard fallback and left the
  composer draft empty, so the start/fail pair is invalid as coverage.
- The `work.chat.attach.open-preview` SVG fixture attempt was cleaned up and
  marked fail because the driver hung before observing a lightbox dialog.

### Focused fixture evidence: `ChatAttachmentTray.test.tsx`

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/ChatAttachmentTray.test.tsx
```

Result: passed (`4` tests).

Rows promoted to `measured`:

- `work.chat.attach.open-preview`: the `renders image attachments as previews
  that can expand` test mocked `window.ade.app.getImageDataUrl`, rendered an
  image attachment, clicked `Open screenshot.png`, and verified the lightbox
  dialog appeared.
- `work.chat.attach.copy-image`: the `copies and removes image attachments from
  the preview controls` test clicked `Copy pasted-image.png` and verified
  `window.ade.app.writeClipboardImage("/tmp/pasted-image.png")` was called.

### Focused fixture evidence: chat transcript and tab tests

Commands:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatMessageList.test.tsx -t "opens cloud PR links|copies assistant message text"
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatMessageList.test.tsx -t "copies assistant code blocks"
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatMessageList.test.tsx -t "shows and collapses long grouped tool results"
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatMessageList.test.tsx -t "keeps compact display text|makes workspace markdown links|pages through inline questions"
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatMessageList.test.tsx -t "renders Work suggestions from tool results"
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatMessageList.test.tsx -t "jump-to-latest|user message minimap"
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatPane.submit.test.tsx -t "moves the most recently selected work chat tab to the top|opens the chat terminal drawer|reveals rapid CLI-created terminals"
```

Results: passed (`2`, `1`, `1`, `4`, `1`, `2`, and `3` focused tests respectively).

Rows promoted to `measured`:

- `work.chat.copy-message`: the copy test rendered an assistant text message,
  clicked `Copy message`, and verified `navigator.clipboard.writeText` received
  the exact assistant text.
- `work.chat.copy-code`: the code-copy test rendered an assistant markdown code
  block, clicked the transcript `Copy code` button, and verified
  `navigator.clipboard.writeText` received the exact code text.
- `work.chat.open-file-link`: the markdown-link test clicked a transcript link
  to `AgentChatMessageList.tsx` and verified navigation to `/files` with the
  lane id and `openFilePath`.
- `work.chat.open-pr-browser`: the cloud status test rendered a finished cloud
  event with `prUrl`, clicked `PR`, and verified
  `builtInBrowser.navigate({ newTab: true })` received the PR URL.
- `work.chat.message.disclosure`: the Work suggestions test opened the `Tool
  calls` disclosure before clicking the suggested Work deeplink.
- `work.chat.message.full-prompt`: the compact-display test rendered a user
  message with `displayText`, clicked `Full prompt`, and verified the complete
  prompt text appeared.
- `work.chat.message.tool-show-all`: the long grouped tool-result test rendered
  the reachable `ChatWorkLogBlock` path, opened `Tool calls`, opened the tool
  row, clicked `show all`, verified the long result tail appeared, then clicked
  `collapse` and verified it was hidden again.
- `work.chat.scroll` and `work.chat.jump-latest`: the transcript scroll test
  set a scrollable transcript geometry, fired a manual scroll away from the
  bottom, verified `Jump to latest message` appeared, clicked it, and verified
  the pill cleared.
- `work.chat.message.minimap`: the minimap test rendered two user turns,
  clicked the `User message 2` minimap dot, and verified the transcript
  `scrollTop` moved to the later row.
- `work.chat.inline-question.tab` and
  `work.chat.inline-question.prev-next`: the structured-question test used
  `Question 1: Priority` tabs plus `inline-question-next` /
  `inline-question-prev` controls while preserving answers across questions.
- `work.chat.tab.select`: the chat-pane test clicked the older chat tab and
  verified tab order moved it ahead of the newer tab.

The terminal drawer tests in the same `AgentChatPane.submit.test.tsx` run cover
auto-revealing CLI-created terminals only. The exact open/close, resize, and
manual tab-switch drawer rows are covered by the `ChatTerminalDrawer.test.tsx`
evidence below.

Earlier long-tool-result evidence showed the old standalone `ToolResultCard`
`show all` path was unreachable after transcript normalization. The measured row
now covers the reachable grouped `ChatWorkLogBlock` path.

### Focused fixture evidence: chat companion drawers and session controls

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatPane.companionDrawers.test.tsx
```

Result: passed (`4` focused tests).

Rows promoted to `measured`:

- `work.chat.drawer.ios`: the companion-drawer fixture rendered `AgentChatPane`
  without Work's `hideLaneToolDrawers`, seeded the iOS drawer availability event,
  clicked the real `Open iOS simulator drawer` button, verified the iOS panel
  mounted, and closed it from the chat chrome.
- `work.chat.drawer.app-control`: the same fixture mocked supported App Control,
  clicked the real `Open App Control drawer` button, verified the App Control
  panel mounted, and closed it from the chat chrome.
- `work.chat.drawer.proof`: the proof fixture clicked `Open proof drawer`,
  verified the Artifacts panel appeared, then closed it from the proof chrome.
- `work.chat.drawer.resize`: the proof fixture dragged the real vertical
  separator and verified `ade.chat.rightPaneSplit` persisted the updated split.
- `work.chat.restore`: the fixture rendered one active chat plus one archived
  chat, changed the `Restore archived chat` selector to the archived session,
  and verified `agentChat.unarchive({ sessionId })` was called.
- `work.chat.clear-view`: the fixture rendered a persistent identity chat with
  transcript text, clicked `Clear view`, verified the transcript text was
  removed locally, and verified no delete call fired.

### Focused fixture evidence: chat terminal drawer tests

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/ChatTerminalDrawer.test.tsx -t "toggles the terminal drawer|switches restored terminal tabs|resizes the drawer"
```

Result: passed (`3` focused tests).

Rows promoted to `measured`:

- `work.chat.terminal.open-close`: the toggle test clicked the closed
  `ChatTerminalToggle`, re-rendered it open, and clicked the `Close terminal`
  state.
- `work.chat.terminal.switch`: the restored-tabs test mocked two terminal
  sessions, rendered both drawer tabs, clicked `Second terminal`, and verified
  the active terminal view switched to `terminal-2:pty-2`.
- `work.chat.terminal.resize`: the resize test dragged the drawer handle from
  `clientY=300` to `clientY=200` and verified the height changed from `300px`
  to `400px`.

### Focused fixture evidence: subagents drawer tests

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/ChatSubagentsPanel.test.tsx
```

Result: passed (`2` focused tests).

Rows promoted to `measured`:

- `work.chat.subagents.toggle`: the panel test clicked the `Subagents` drawer
  trigger and verified `aria-expanded` changed from `false` to `true`.
- `work.chat.subagents.detail` and `work.chat.subagents.back`: the same test
  opened `Audit chat renderer`, verified the detail view showed `task-1`, then
  clicked `Back` and verified the list card returned.
- `work.chat.subagents.show-all`: the timeline test rendered 25 progress
  events, verified `Progress 0` was hidden, clicked `Show ... earlier events`,
  and verified the earliest event rendered.
- `work.chat.subagents.copy-id`: the timeline test clicked `Copy id` and
  verified `navigator.clipboard.writeText("task-1")`.

### Focused fixture evidence: composer and Files chrome tests

Commands:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatComposer.test.tsx -t "clear draft only triggers the draft-clear action"
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatComposer.test.tsx -t "edits a queued steer message|removes a queued steer message"
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatComposer.test.tsx -t "accepts the prompt suggestion with Tab"
npm --prefix apps/desktop run test -- src/renderer/components/chat/AgentChatComposer.test.tsx
npm --prefix apps/desktop run test -- src/renderer/components/files/v2/editorGroupsStore.test.ts
npm --prefix apps/desktop run test -- src/renderer/components/files/v2/viewerRegistry.test.ts
npm --prefix apps/desktop run test -- src/renderer/components/files/monacoModelRegistry.test.ts
```

Results: passed (`1`, `2`, `1`, full composer file with `41` tests, `1`,
`1`, and `1` Files workbench-focused test files respectively).

Rows promoted to `measured`:

- `work.chat.composer.clear`: the composer test clicked the visible `Clear`
  control during an active turn and verified only `onClearDraft` fired, not the
  interrupt path.
- `work.chat.queue.edit` and `work.chat.queue.remove`: the queued-steer tests
  rendered a pending steer, clicked `Edit queued message` and `Remove queued
  message`, then verified `onEditSteer("steer-1", ...)` and
  `onCancelSteer("steer-1")`.
- `work.chat.composer.tab-suggestion`: the suggestion test rendered an empty,
  idle composer with `promptSuggestion`, pressed Tab in the textbox, and
  verified `onDraftChange` received the suggestion text.
- `work.chat.command.select`: the full composer test opened the slash-command
  picker, clicked `/status`, and verified `onDraftChange("/status ")`.
- `work.chat.dismiss.error`: the full composer test selected an oversized file
  through the hidden upload input, verified the attach error rendered, clicked
  `Dismiss error`, and verified the error cleared.
- `work.files.context.copy-path`: keep coverage on the permanent workbench
  context menu and clipboard path action.
- `work.files.primary-edit` / `work.files.trust-edit`: marked `moved` — the
  read-only default and trust/enable-editing controls were removed entirely.
  Every writable text-backed file (code/plain text, markdown source, csv
  source) is editable immediately in every workspace; the invariant is covered
  by `viewerRegistry.test.ts`, `ViewerHost.test.tsx`, `EditorGroup.test.tsx`
  save-path tests, and `fileService.test.ts` write/path-safety tests.

### Focused fixture evidence: Work grid and session-list tests

Commands:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/terminals/SessionListPane.test.tsx -t "marks old running CLI and shell sessions|renders bulk action footer counts"
npm --prefix apps/desktop run test -- src/renderer/components/terminals/SessionListPane.test.tsx -t "collapses and expands child shell sections"
npm --prefix apps/desktop run test -- src/renderer/components/terminals/PackedSessionGrid.test.tsx -t "persists resized spans"
npm --prefix apps/desktop run test -- src/renderer/components/terminals/WorkViewArea.test.tsx -t "selects a tiled session when its body is clicked in grid mode"
npm --prefix apps/desktop run test -- src/renderer/components/terminals/WorkViewArea.test.tsx -t "embedded floating-pane chrome"
npm --prefix apps/desktop run test -- src/renderer/components/terminals/WorkViewArea.test.tsx
```

Results: passed (`2`, `1`, `1`, `1`, `1`, and full WorkViewArea file with `12`
tests respectively).

Rows promoted to `measured`:

- `work.sessions.stale-warning`: the stale-session test rendered an old running
  shell session and verified the `Old running session` accessible warning.
- `work.sessions.bulk.restore`: the bulk footer test selected an archived chat,
  clicked `Restore 1`, and verified the restore handler fired.
- `work.sessions.child.collapse` and `work.sessions.child.expand`: the child
  section test rendered a shell child under a chat parent, clicked the `1 shell`
  disclosure to request collapse, re-rendered the collapsed state, then clicked
  the same disclosure to request expansion.
- `work.packed.resize`: the packed-grid test dragged the east resize handle,
  verified layout persistence happened on pointer-up, and checked the clamped
  column spans.
- `work.packed.select`: the WorkViewArea grid test clicked the second tiled
  session body and verified `onSelectItem("session-2")` fired.
- `work.tab.close`: the WorkViewArea tab-strip test rendered a completed
  session, clicked the tab close affordance, and verified
  `onCloseItem("session-1")` fired.
- `work.pane.minimize` and `work.pane.expand`: the embedded floating-pane
  fixture rendered `WorkViewArea` inside the real `FloatingPane`
  `hideHeaderWhenExpanded` context, clicked the embedded `Minimize pane`
  control, verified the pane gained the `minimized` class, clicked
  `Expand pane`, and verified the pane returned to expanded Work content.

### Focused fixture evidence: Work start no-lanes state

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/terminals/WorkStartSurface.test.tsx
```

Result: passed (`1` focused test).

Rows promoted to `measured`:

- `work.start.no-lanes`: the WorkStartSurface test rendered with `lanes=[]`,
  verified `No lanes available` and `Create or reopen a lane before starting
  work.`, and verified the chat pane did not mount.

### Focused fixture evidence: iOS simulator stream recovery

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/ChatIosSimulatorPanel.test.tsx -t "shows a window live-view error without switching stream backends"
```

Result: passed (`1` focused test).

Rows promoted to `measured`:

- `work.ios.stream-retry`: the simulator panel test emitted a `stream-error`
  event after the initial stream start and verified the drawer kept the
  `simulator-window-capture` backend instead of switching stream modes.

### Focused fixture evidence: iOS simulator state controls

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/ChatIosSimulatorPanel.test.tsx
```

Result: passed (`20` focused tests).

Rows promoted to `measured`:

- `work.ios.target-select`: the panel fixture rendered two launch targets,
  changed the launch-target select to `target-2`, verified the select value,
  and verified `launch` was not called.
- `work.ios.preview-target-select`: the same fixture switched to Preview,
  loaded two Xcode preview targets, changed the preview-target select to
  `preview-2`, and verified `renderPreview` was not called.
- `work.ios.preview-copy-install`: the setup checklist fixture marked
  `xcodebuild` missing, clicked the install row's `Copy` button, and verified
  `navigator.clipboard.writeText("xcode-select --install")`.
- `work.ios.preview-ask-agent`: the preview help fixture clicked the visible
  `Ask agent` button and verified `onInsertDraft` received the Preview workflow
  prompt.
- `work.ios.preview-add-preview`: the no-preview-target fixture clicked
  `Ask agent to add a #Preview` and verified `onInsertDraft` received a prompt
  explaining that no renderable `#Preview` was found.
- `work.ios.sim.type-input`: the live simulator fixture typed into the local
  active-app text field and verified `typeText` was not called before `Send`.
- `work.ios.sim.mode.inspect`: the same fixture clicked `Inspect` and verified
  the simulator snapshot was rendered.
- `work.ios.sim.refresh-inspector`: the same fixture clicked
  `Refresh inspector snapshot` and verified `getScreenSnapshot` was called
  again.
- `work.ios.sim.screenshot`: the same fixture clicked `Screenshot` and verified
  the capture mode became active without dragging a crop.
- `work.ios.sim.mode.control`: the same fixture clicked `Control` and verified
  the active-app text field returned.
- `work.ios.sim.inspect-select`: the focused inspect fixture mocked an
  ADE-inspector snapshot element, clicked the rendered simulator snapshot at
  the element center through a real pointer event, verified
  `iosSimulator.selectPoint({ x: 150, y: 120 })`, and verified
  `onAddContext` received the `ade-inspector` context item.
- `work.ios.sim.open-preview`: the same fixture clicked the selected-element
  `Open in preview` control, switched into Preview Lab, and verified preview
  discovery was scoped to `ContentView.swift:12` without invoking the separate
  sandbox-only `renderPreview` action.
- `work.ios.refresh-state` regression: the fixture first returned a
  missing-project-root launch-target error, rerendered the panel with a real
  project root, then verified the successful refresh removed the stale
  launch-target error message.

### Focused fixture evidence: App Control safe state controls

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/ChatAppControlPanel.test.tsx
```

Result: passed (`2` focused tests).

Rows promoted to `measured`:

- `work.app-control.run-command`: the idle App Control fixture loaded a Run-tab
  process, changed `Select run command` to `dev`, and verified the launch input
  became `npm run dev`.
- `work.app-control.help-cdp`: the same fixture clicked `Help wire CDP` and
  verified `onInsertDraft` received the App Control CDP setup prompt.
- `work.app-control.show-terminal`: the connected-session fixture clicked the
  visible Terminal button and verified `onShowTerminal` received
  `terminal-1` / `pty-1`.
- `work.app-control.snapshot` and `work.app-control.message.dismiss`: the
  fixture clicked `Snapshot`, verified `Snapshot refreshed.`, then clicked
  `Dismiss` and verified the message cleared.
- `work.app-control.mode.inspect` and `work.app-control.mode.control`: the
  fixture toggled Inspect and Control and verified the panel help text changed
  for each mode.
- `work.app-control.type-input`: the fixture typed into
  `Text to type into the focused app element` and verified the input state
  changed without clicking the send/Type action.
- `work.app-control.window-select`: the fixture changed the controlled-window
  selector to `target-2` and verified `attachToTarget({ targetId: "target-2" })`.
- `work.app-control.window-refresh`: the fixture clicked `Re-scan controlled
  app windows` and verified `listTargets` ran again.
- `work.app-control.inspect.hover`: the inspect fixture clicked `Inspect`,
  moved over a screenshot element, and verified the hover state rendered.
- `work.app-control.inspect.select`: the same fixture clicked a selected
  source-context point and verified `appControl.selectPoint` plus
  `onAddContext` for `src/App.tsx`.
- `work.app-control.reattach`: after the selected point was attached, the
  fixture clicked `Re-attach` and verified `selectPoint` ran again for the
  existing point.

### Focused fixture evidence: Browser context controls

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/ChatBuiltInBrowserPanel.test.tsx
```

Result: passed (`4` focused tests).

Rows promoted to `measured`:

- `work.browser.screenshot.start`: the browser panel test mocked a crop-ready
  screenshot, clicked `Screenshot`, and verified the crop-mode instruction
  rendered.
- `work.browser.screenshot.cancel`: the same test clicked `Cancel screenshot`
  and verified `Browser screenshot capture cancelled.` plus the restored
  `Screenshot` button.
- `work.browser.attach-selection`: the selection test rendered a selected
  browser element, clicked the visible `Attach` control, and verified
  `selectCurrent` plus `onAddContext` for `button.submit`.

### Focused fixture evidence: Git pane large file lists

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/lanes/LaneGitActionsPane.test.tsx -t "bounds rendered change rows|shows all staged change rows"
```

Result: passed (`2` focused tests).

Rows promoted to `measured`:

- `work.git.file.show-all-unstaged`: the large-unstaged-list test verified
  `file-300.ts` was hidden behind the `Showing first 300 of 305 unstaged
  files.` cap, clicked `Show all`, and verified `file-300.ts` rendered.
- `work.git.file.show-all-staged`: the staged-list test did the same for
  `STAGED (305)` and `src/staged/file-300.ts`.

### Focused fixture evidence: Git diff pane controls

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/lanes/LaneDiffPane.test.tsx
```

Result: passed (`2` focused tests).

Rows promoted to `measured`:

- `work.git.diff.show-all-files`: the commit diff fixture rendered `503`
  commit files, verified `src/generated/file-500.ts` was hidden behind the
  `Showing first 500 of 503 files.` cap, clicked `Show all`, and verified that
  file row rendered.
- `work.git.diff.retry`: the working-tree diff fixture forced the first
  `getFile` request to fail, clicked the visible `Retry` control, and verified
  the diff viewer rendered after the second request succeeded.

### Real UI evidence: Files context stage and unstage

Run:

- `~/.ade/perf-runs/work-files-gap-20260512-01/events.jsonl`

Rows promoted to `measured`:

- `work.files.context.stage`: in the real Electron Work tab, the embedded Files
  panel was switched from read-only Primary to the editable
  `ui audit lane 1` workspace. After repairing the missing perf-pass lane
  worktree fixture and seeding `work-files-context-stage.tmp`, the visible row
  showed an untracked `U` badge. The file row was right-clicked, the context
  menu `STAGE` item was clicked, the row badge changed to `A`, and
  `git status --short -- work-files-context-stage.tmp` returned
  `A  work-files-context-stage.tmp`.
- `work.files.context.unstage`: with the same visible Files row staged, the row
  was right-clicked again, the context menu `UNSTAGE` item was clicked, the row
  badge changed back to `U`, and git status returned
  `?? work-files-context-stage.tmp`.

Markers:

- `work.files.context.fixture-repair` recorded the fixture repair after the UI
  exposed the missing-worktree `ENOENT`.
- `work.files.context.stage.sandbox-ui`
- `work.files.context.unstage.sandbox-ui`

Cleanup:

- Removed `work-files-context-stage.tmp` from both the repaired lane worktree and
  Primary perf-pass root; both targeted git status checks returned clean output.

Updated counts after this batch: total `394`, measured `268`, prompt-only `43`,
external-skip `33`, sandbox-only `50`.

### Real UI evidence: Files create, rename, and save controls

Run:

- `~/.ade/perf-runs/work-files-gap-20260512-01/events.jsonl`

Rows promoted to `measured`:

- `work.files.new-file`: clicked the embedded Files toolbar `New file` button
  in the editable `ui audit lane 1` workspace, filled the dialog with
  `work-files-new-file-ui.tmp`, clicked `CREATE FILE`, verified the new
  untracked row opened in the editor, and verified the file existed on disk.
- `work.files.new-folder`: clicked the embedded Files toolbar `New folder`
  button, filled `work-files-new-folder-ui`, clicked `CREATE FOLDER`, verified
  the folder row appeared, and verified the directory existed on disk.
- `work.files.context.rename` and `work.files.tree.inline-rename`: right-clicked
  `work-files-new-file-ui.tmp`, selected context `RENAME`, changed the inline
  rename field to `work-files-renamed-ui.tmp`, submitted with Return, and
  verified the tree row, editor tab, and disk path changed.
- `work.files.context.new-file`: right-clicked the created folder row, selected
  context `NEW FILE`, filled
  `work-files-new-folder-ui/context-created.txt`, clicked `CREATE FILE`,
  verified the file opened in a tab, and verified the disk path existed.
- `work.files.context.new-folder`: right-clicked the created folder row,
  selected context `NEW FOLDER`, filled
  `work-files-new-folder-ui/context-folder`, clicked `CREATE FOLDER`, and
  verified the nested directory existed on disk.
- `work.files.save`: typed `saved from Work Files UI` into
  `context-created.txt` through the embedded editor, clicked the visible `SAVE`
  button, and verified the file contents on disk.

Markers:

- `work.files.new-file.sandbox-ui`
- `work.files.new-folder.sandbox-ui`
- `work.files.context.rename.sandbox-ui`
- `work.files.tree.inline-rename.sandbox-ui`
- `work.files.context.new-file.sandbox-ui`
- `work.files.context.new-folder.sandbox-ui`
- `work.files.save.sandbox-ui`

Cleanup:

- Removed `work-files-renamed-ui.tmp`, `work-files-new-file-ui.tmp`, and
  `work-files-new-folder-ui` from the repaired lane worktree; targeted git
  status for those paths returned clean output.

Updated counts after this batch: total `394`, measured `275`, prompt-only `43`,
external-skip `33`, sandbox-only `43`.

### Real UI evidence: Browser URL open

Run:

- `~/.ade/perf-runs/work-files-gap-20260512-01/events.jsonl`

Rows promoted to `measured`:

- `work.browser.url.open`: selected the Work Browser tools tab, set the Browser
  URL field to the local endpoint `http://127.0.0.1:9222/json/version`, clicked
  `Open`, and verified the embedded browser rendered the DevTools protocol JSON
  with `Protocol-Version`.

Markers:

- `work.browser.url.open.sandbox-ui`

Observation:

- An earlier local attempt opened `http://127.0.0.1:5173/work#/work` inside the
  ADE Browser panel. The embedded page loaded ADE without the desktop preload
  shape and displayed `Renderer crashed window.ade.github.getRemoteStatus is not
  a function`. The URL-open row was completed with the local DevTools endpoint
  above so the measured action did not depend on an external site.

Updated counts after this batch: total `394`, measured `276`, prompt-only `43`,
external-skip `33`, sandbox-only `42`.

### Focused fixture evidence: Git rescue lane

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/lanes/LaneGitActionsPane.test.tsx -t "rescue button"
```

Result: passed (`3` focused rescue tests).

Rows promoted to `measured`:

- `work.git.rescue-lane`: the focused fixture enabled the visible
  `Create new lane with current changes` button for unstaged-only changes,
  clicked it, filled the quick prompt with `Rescue lane`, and verified
  `rescueToNewLane` was called with the generated branch name. Companion rescue
  tests verified the button is disabled when staged changes or in-progress
  merge/rebase state make the action unsafe.

Updated counts after this batch: total `394`, measured `277`, prompt-only `43`,
external-skip `33`, sandbox-only `41`.

### Focused fixture evidence: Chat terminal new tab

Command:

```bash
npm --prefix apps/desktop run test -- src/renderer/components/chat/ChatTerminalDrawer.test.tsx -t "deduplicates a created tab"
```

Result: passed (`1` focused test).

Rows promoted to `measured`:

- `work.chat.terminal.new`: the terminal drawer fixture rendered the open
  drawer, clicked the visible `New terminal` button, verified
  `window.ade.pty.create` was called once, and verified the created terminal was
  represented by the active terminal view without duplicating the already
  revealed tab.

Updated counts after this batch: total `394`, measured `278`, prompt-only `43`,
external-skip `33`, sandbox-only `40`.
