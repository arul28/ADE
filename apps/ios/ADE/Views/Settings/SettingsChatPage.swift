import SwiftUI

/// Settings › Chat: the chat settings that live on the connected machine, in
/// the desktop Chat tab's order (`ChatSection.tsx`): Speed & spend, Next
/// prompt, Smart decisions and Claude mods, then Scheduled work. Fast mode is
/// the account's; the rest is the active project's `.ade/local.yaml` on that
/// machine, read with `projectConfig.get` and written with `ai.updateConfig`
/// like the desktop, so a change here shows there. The transcript and
/// composer looks are how the desktop draws, so they stay on the desktop.
struct SettingsChatPage: View {
  let syncService: SyncService
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared

  /// The account's Fast permission, read over the sync host. Off by default,
  /// like the desktop.
  @State private var fastModeEnabled = false
  /// Orders the switch's writes and reads: an older read or a failed write must
  /// not overwrite what the person chose last.
  @State private var fastModeWriteGeneration = 0
  @State private var fastModeSaving = false

  @State private var config: SettingsProjectChatConfig?
  @State private var configError: String?
  /// The `ai.chat` keys with a save out: the `SettingsChatKey` raw values and
  /// `modelHintKey`.
  @State private var savingKeys: Set<String> = []
  /// What turning the model hint back on restores.
  @State private var lastHintMode: SettingsModelHintMode = .modelAndEffort
  /// The machine's OpenCode Zen sign-in; nil hides Smart decisions, as on the desktop.
  @State private var zen: String?
  /// The project `config` was read from, so another project's switches never
  /// show, or save, under this one.
  @State private var loadedProjectId: String?
  @State private var toast: ADEToastMessage?

  private var connected: Bool { syncService.connectionState == .connected }
  private var machine: String { syncService.machineDisplayName }
  private var projectName: String { syncService.activeProject?.displayName ?? "this project" }
  private var supportsProjectConfig: Bool {
    syncService.supportsRemoteAction("projectConfig.get") && syncService.supportsRemoteAction("ai.updateConfig")
  }

  var body: some View {
    ADESettingsPage(route: .chat) {
      if !connected {
        ADESettingsNotice(message: SettingsPageCopy.connectMachine)
      } else {
        speedSection
        projectSections
      }
    }
    .adeToast($toast)
    .task(id: "\(connected):\(syncService.activeProjectId ?? "-")") {
      guard connected else { return }
      if loadedProjectId != syncService.activeProjectId {
        config = nil
        configError = nil
        loadedProjectId = syncService.activeProjectId
      }
      await load()
    }
  }

  // MARK: - Speed & spend

  private var speedSection: some View {
    ADESettingsSection("Speed & spend", hint: "The paid faster tier. Saved to your account, so every computer follows it.", symbol: "bolt.fill", tint: .amber) {
      if syncService.supportsRemoteAction("chat.setFastModeEnabled") {
        ADESettingsRows {
          ADESettingsToggleRow(
            title: "Allow Fast mode",
            hint: "About 2× cost (Ultrafast up to 8×). Chats start at Standard; turn Fast on per chat.",
            isOn: Binding(get: { fastModeEnabled }, set: { setFastMode($0) }),
            tint: ADEColor.warning,
            disabled: fastModeSaving
          )
        }
      } else {
        ADESettingsNotice(message: SettingsPageCopy.updateADE(on: machine))
      }
    }
  }

  private func setFastMode(_ next: Bool) {
    guard !fastModeSaving else { return }
    fastModeWriteGeneration += 1
    let generation = fastModeWriteGeneration
    fastModeEnabled = next
    fastModeSaving = true
    Task {
      do {
        try await syncService.setFastModeEnabled(next)
      } catch {
        if generation == fastModeWriteGeneration {
          fastModeEnabled = !next
          toast = ADEToastMessage(text: "Couldn't change Fast mode. \(SyncUserFacingError.message(for: error))", kind: .failure)
        }
      }
      if generation == fastModeWriteGeneration {
        fastModeSaving = false
      }
    }
  }

  // MARK: - Project settings

  @ViewBuilder
  private var projectSections: some View {
    if syncService.activeProjectId == nil {
      ADESettingsSection("Agent behavior", hint: "Saved in each project.", symbol: "sparkles", tint: .violet) {
        // What lives here, dimmed, so the page says what opening a project
        // gives instead of only that it is needed.
        VStack(alignment: .leading, spacing: 0) {
          ADESettingsRows {
            ForEach(SettingsChatTopic.allCases, id: \.self) { topic in
              ADESettingsRow(topic.title, hint: topic.preview, symbol: topic.symbol, tint: topic.tint)
            }
          }
          .opacity(0.5)
          .allowsHitTesting(false)
          Label(SettingsPageCopy.openProject, systemImage: "info.circle.fill")
            .font(.system(size: 13))
            .foregroundStyle(ADEColor.textSecondary)
            .padding(.horizontal, 4)
            .padding(.top, 10)
        }
      }
    } else if !supportsProjectConfig {
      ADESettingsSection("Agent behavior", symbol: "sparkles", tint: .violet) {
        ADESettingsNotice(message: SettingsPageCopy.updateADE(on: machine))
      }
    } else if let config {
      nextPromptSection
      if zen != nil {
        smartDecisionsSection(config)
      }
      claudeModsSection
      scheduledWorkSection
    } else if let configError {
      ADESettingsSection("Agent behavior", symbol: "sparkles", tint: .violet) {
        ADESettingsNotice(
          message: "Couldn't read the chat settings on \(machine). \(configError)",
          actionTitle: "Try again",
          action: { Task { await loadProjectConfig() } }
        )
      }
    } else {
      ADESettingsSection("Agent behavior", symbol: "sparkles", tint: .violet) {
        ADESettingsRows {
          ADESettingsLoadingRow()
        }
      }
    }
  }

  private var nextPromptSection: some View {
    ADESettingsSection(
      SettingsChatTopic.nextPrompt.title,
      hint: "A guess at your next message in an empty prompt box. Saved in \(projectName) on \(machine).",
      symbol: SettingsChatTopic.nextPrompt.symbol,
      tint: SettingsChatTopic.nextPrompt.tint
    ) {
      ADESettingsRows {
        toggleRow(
          "Suggest the next prompt in Codex chats",
          hint: "One short call on Codex's small model per finished turn.",
          key: .codexPromptSuggestionsEnabled
        )
        toggleRow(
          "Suggest the next prompt for other providers",
          hint: "One short call on each provider's small model per finished turn. Claude Code suggests its own.",
          key: .promptSuggestionsEnabled
        )
      }
    }
  }

  private func smartDecisionsSection(_ config: SettingsProjectChatConfig) -> some View {
    ADESettingsSection(
      SettingsChatTopic.smartDecisions.title,
      hint: "Quick calls ADE makes about your chats and prompts.",
      symbol: SettingsChatTopic.smartDecisions.symbol,
      tint: SettingsChatTopic.smartDecisions.tint
    ) {
      ADESettingsRows {
        toggleRow(
          "Smart decisions (Jev)",
          hint: "ADE asks the small Jev model quick questions, like whether a finished turn asked you something. It's free through OpenCode. When Jev can't answer, ADE's built-in rules decide.",
          key: .smartDecisionsEnabled
        )
      }
      if config.isOn(.smartDecisionsEnabled) {
        ADESettingsRows {
          toggleRow(
            "Waiting on you",
            hint: "Whether a chat's last reply asked you something, or an agent CLI is waiting for your input.",
            key: .smartChatStatusEnabled
          )
          if config.isOn(.smartChatStatusEnabled) {
            toggleRow(
              "Also check plain terminals",
              hint: "Like an install script asking [y/N]. Their last screen is sent with secrets removed, at most 4 KB.",
              key: .smartPlainTerminalsEnabled
            )
          }
          toggleRow(
            "Settle finished chats",
            hint: "Suggests settling a chat that has sat idle for 3 hours when its last turn reads as done.",
            key: .smartSettleNudgeEnabled
          )
          modelHintRows(config)
          toggleRow(
            "⌘K suggestions",
            hint: "Puts the command that fits what you type at the top of ⌘K on the computer.",
            key: .smartPaletteEnabled
          )
          toggleRow(
            "Lane emoji",
            hint: "Picks an emoji for a new lane from its name.",
            key: .smartLaneEmojiEnabled
          )
        }
        ADESettingsRows {
          if zen == "signed_in" {
            toggleRow(
              "Use my OpenCode Zen credit",
              hint: "Once the free allowance is out, spend your own OpenCode Zen balance on Jev before ADE's bonus.",
              key: .jevZenCreditEnabled
            )
          } else {
            ADESettingsRow(
              "Use my OpenCode Zen credit",
              hint: zen == "token_expired"
                ? "Your OpenCode Zen sign-in expired. Sign in again on your computer to use your own balance."
                : "Optional. Sign in to OpenCode Zen on your computer to spend your own balance on Jev."
            )
          }
        }
      }
    }
  }

  @ViewBuilder
  private func modelHintRows(_ config: SettingsProjectChatConfig) -> some View {
    let saving = savingKeys.contains(Self.modelHintKey)
    ADESettingsToggleRow(
      title: "Model and effort hint",
      hint: "Suggests a model and effort beside the composer's pickers for a new chat, from how you picked for similar ones.",
      isOn: Binding(get: { config.modelHintMode != .off }, set: { saveModelHint($0 ? lastHintMode : .off) }),
      disabled: saving
    )
    if config.modelHintMode != .off {
      VStack(alignment: .leading, spacing: 8) {
        Text("Suggest")
          .font(.system(size: 12.5))
          .foregroundStyle(ADEColor.textSecondary)
        ADEKitSegmented(
          selection: Binding(
            get: { config.modelHintMode == .effortOnly ? SettingsModelHintMode.effortOnly : .modelAndEffort },
            set: { saveModelHint($0) }
          ),
          options: [SettingsModelHintMode.modelAndEffort, .effortOnly].map { (value: $0, title: $0.title) }
        )
        .disabled(saving)
      }
      .padding(.horizontal, ADEKit.inset)
      .padding(.vertical, 11)
    }
  }

  private var claudeModsSection: some View {
    ADESettingsSection(
      SettingsChatTopic.claudeMods.title,
      hint: "Claude Code plugins that draw in the chat.",
      symbol: SettingsChatTopic.claudeMods.symbol,
      tint: SettingsChatTopic.claudeMods.tint
    ) {
      ADESettingsRows {
        toggleRow(
          "Show what Claude mods draw",
          hint: "What your Claude Code mods draw, on top of the prompt box. Early access in Claude Code, so it can change.",
          key: .claudePluginUiEnabled
        )
      }
    }
  }

  /// On the desktop this card is under Notifications; it is the same
  /// `ai.chat` key, so it sits with the other project chat settings here.
  private var scheduledWorkSection: some View {
    ADESettingsSection(
      SettingsChatTopic.scheduledWork.title,
      hint: "Jobs agents schedule.",
      symbol: SettingsChatTopic.scheduledWork.symbol,
      tint: SettingsChatTopic.scheduledWork.tint
    ) {
      ADESettingsRows {
        toggleRow(
          "Pause all scheduled work",
          hint: "Wakeups, cron tasks, and loops stay armed. Overdue work runs once on resume.",
          key: .scheduledWorkPaused
        )
      }
    }
  }

  private func toggleRow(_ title: String, hint: String?, key: SettingsChatKey) -> some View {
    ADESettingsToggleRow(
      title: title,
      hint: hint,
      isOn: Binding(get: { config?.isOn(key) ?? key.defaultOn }, set: { save(key, $0) }),
      disabled: config == nil || savingKeys.contains(key.rawValue)
    )
  }

  // MARK: - Loading and saving

  private func load() async {
    let generation = fastModeWriteGeneration
    let enabled = await syncService.getFastModeEnabled()
    if generation == fastModeWriteGeneration {
      fastModeEnabled = enabled
    }
    await loadProjectConfig()
  }

  private func loadProjectConfig() async {
    guard let projectId = syncService.activeProjectId, supportsProjectConfig else { return }
    configError = nil
    do {
      let loaded = try await syncService.fetchProjectChatConfig()
      // The project changed while the read was out: the new load owns the page.
      guard syncService.activeProjectId == projectId else { return }
      // A switch flipped while the read was out keeps its new value.
      var merged = loaded
      if let current = config {
        for key in SettingsChatKey.allCases where savingKeys.contains(key.rawValue) {
          merged.set(key, current.isOn(key))
        }
        if savingKeys.contains(Self.modelHintKey) { merged.modelHintMode = current.modelHintMode }
      }
      config = merged
      if merged.modelHintMode != .off { lastHintMode = merged.modelHintMode }
    } catch {
      if config == nil { configError = SyncUserFacingError.message(for: error) }
    }
    zen = await syncService.fetchJevZenState()
  }

  /// Optimistic, like the desktop's `useChatConfigToggle`: a failed save puts
  /// the switch back and says so.
  private func save(_ key: SettingsChatKey, _ value: Bool) {
    guard config != nil, !savingKeys.contains(key.rawValue) else { return }
    config?.set(key, value)
    savingKeys.insert(key.rawValue)
    Task {
      defer { savingKeys.remove(key.rawValue) }
      toast = await SettingsPageCopy.commit(
        failure: "Couldn't save the setting.",
        on: machine,
        revert: { _ in config?.set(key, !value) }
      ) {
        try await syncService.updateProjectChatConfig([key.rawValue: value])
      } ?? toast
    }
  }

  /// The `ai.chat` key of Jev's model and effort hint.
  private static let modelHintKey = "modelHintMode"

  private func saveModelHint(_ next: SettingsModelHintMode) {
    guard let previous = config?.modelHintMode, previous != next, !savingKeys.contains(Self.modelHintKey) else { return }
    config?.modelHintMode = next
    if next != .off { lastHintMode = next }
    savingKeys.insert(Self.modelHintKey)
    Task {
      defer { savingKeys.remove(Self.modelHintKey) }
      toast = await SettingsPageCopy.commit(
        failure: "Couldn't save the setting.",
        on: machine,
        revert: { _ in config?.modelHintMode = previous }
      ) {
        try await syncService.updateProjectChatConfig([Self.modelHintKey: next.rawValue])
      } ?? toast
    }
  }
}

/// The project's chat settings, one per section. The page without a project
/// lists the same ones, dimmed, so the two never drift apart.
private enum SettingsChatTopic: CaseIterable {
  case nextPrompt, smartDecisions, claudeMods, scheduledWork

  var title: String {
    switch self {
    case .nextPrompt: return "Next prompt"
    case .smartDecisions: return "Smart decisions"
    case .claudeMods: return "Claude mods"
    case .scheduledWork: return "Scheduled work"
    }
  }

  var symbol: String {
    switch self {
    case .nextPrompt: return "text.cursor"
    case .smartDecisions: return "brain"
    case .claudeMods: return "puzzlepiece.extension"
    case .scheduledWork: return "clock"
    }
  }

  var tint: ADESettingsTint {
    switch self {
    case .nextPrompt, .scheduledWork: return .blue
    case .smartDecisions: return .teal
    case .claudeMods: return .orange
    }
  }

  /// The short line the dimmed list shows.
  var preview: String {
    switch self {
    case .nextPrompt: return "A guess at your next message"
    case .smartDecisions: return "Quick calls about your chats"
    case .claudeMods: return "Plugins that draw in the chat"
    case .scheduledWork: return "Jobs agents schedule"
    }
  }
}
