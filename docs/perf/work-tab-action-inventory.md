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
| work.chat.message.jira-context-refresh | Refresh Jira context chip after a turn-end snapshot update | not measured | `AgentChatPane.tsx`, `UserMessageIssueContext.tsx` |
| work.chat.message.markdown-brief | Render a user markdown brief formatted in the bubble | not measured | `AgentChatMessageList.tsx` |
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

Each `measured` row was covered by a real Work UI run, a UI-derived probe or a focused fixture test. The run logs (`work-*-2026*` run ids, fixture evidence) live in the git history of this file, up to commit `b748986c3`. Add the evidence for a new run to the PR body, not to this file.
