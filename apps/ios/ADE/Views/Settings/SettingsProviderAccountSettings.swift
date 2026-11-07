import SwiftUI

// MARK: - Routing

/// Where new chats go, as one account's badge (desktop `ProviderAccountsPanel`):
/// "Next chat" on smart balance's next pick, "New chats" on the default when
/// smart balance is off. Nil for every other account, and for one that cannot
/// take chats (signed out, broken, or a copy of another login).
func providerAccountRoutingBadge(_ account: ProviderAccount, smartBalance: Bool, isNext: Bool) -> String? {
  guard account.canTakeChats else { return nil }
  if smartBalance { return isNext ? "Next chat" : nil }
  return account.isDefault ? "New chats" : nil
}

/// Desktop `SMART_BALANCE_HINT`, in the two halves the phone shows.
enum ProviderAccountRoutingCopy {
  static let smartBalanceOn = "New chats go to the account with the most weekly room to use before it resets. A chat at a limit moves to one with room."
  static let autoStart = "When a window ends, one tiny request on the cheapest model starts the next. ADE logs each one with its cost."
}

/// The provider has a 5-hour window on this machine, so auto-start means
/// something (desktop `providerOffersAutoStart`).
func providerAccountOffersAutoStart(_ provider: ProviderAccountProvider, snapshot: MobileUsageQuotaSnapshot?) -> Bool {
  (snapshot?.windows ?? []).contains { $0.provider == provider.rawValue && $0.windowType == "five_hour" }
}

// MARK: - Account settings

/// One account's own settings (desktop `AccountCard` menu pages): Claude's two
/// prompt cache lifetimes and what extra usage does, and the account's own
/// compaction when the machine holds more than one account.
struct ProviderAccountSettingsSection: View {
  let account: ProviderAccount
  @ObservedObject var store: ProviderAccountsStore
  let showsCompaction: Bool

  var body: some View {
    let isClaude = account.provider == ProviderAccountProvider.claude.rawValue
    if isClaude || showsCompaction {
      ADESettingsSection("Settings", hint: "For ADE chats on this account, on this machine. New sessions use them.") {
        ADESettingsRows {
          if showsCompaction {
            ADESettingsLink(
              title: "Auto-compact",
              symbol: "arrow.down.right.and.arrow.up.left",
              value: account.compaction == nil ? "Default" : "Custom",
              tint: .violet
            ) {
              ProviderAccountCompactionPage(store: store, accountId: account.id)
            }
          }
          if isClaude {
            choiceRow(
              "Main chat cache",
              hint: "How long Claude keeps a chat ready between your messages.",
              symbol: "clock.arrow.circlepath",
              tint: .blue,
              selected: account.mainPromptCacheTtl,
              choices: [
                (nil, "Automatic", "1 hour on a subscription, 5 minutes on an API key or extra usage."),
                ("5m", "5 minutes", "Each save costs less. A pause over 5 minutes re-sends the whole chat."),
                ("1h", "1 hour", "Each save costs more. The chat stays ready through breaks up to an hour."),
              ],
              change: ProviderAccountSettingChange.mainPromptCache
            )
            choiceRow(
              "Subagent cache",
              hint: "How long Claude keeps a subagent ready between its requests.",
              symbol: "person.2",
              tint: .teal,
              selected: account.subagentPromptCacheTtl,
              choices: [
                (nil, "5 minutes", "Default. The lowest cost per save."),
                ("1h", "1 hour", "Each save costs more. Worth it only when subagents often wait over 5 minutes."),
              ],
              change: ProviderAccountSettingChange.subagentPromptCache
            )
            choiceRow(
              "Extra usage",
              hint: "When a turn passes the plan limit and Claude starts to bill extra usage.",
              symbol: "creditcard",
              tint: .amber,
              selected: account.onExtraUsage,
              choices: [
                (nil, "Continue", "Default. The turn keeps going and Claude bills the extra usage."),
                ("stop", "Stop the turn", "ADE stops the turn, as it does at a plan limit. One request can be billed before the stop."),
              ],
              change: ProviderAccountSettingChange.onExtraUsage
            )
          }
        }
      }
    }
  }

  /// A menu of a few values of one setting; each value says what it costs.
  private func choiceRow(
    _ title: String,
    hint: String,
    symbol: String,
    tint: ADESettingsTint,
    selected: String?,
    choices: [(value: String?, title: String, note: String)],
    change: @escaping (String?) -> ProviderAccountSettingChange
  ) -> some View {
    let current = choices.first { $0.value == selected }?.title ?? choices[0].title
    return ADESettingsRow(title: title, hint: hint, symbol: symbol, tint: tint) {
      Menu {
        ForEach(choices, id: \.title) { choice in
          Button {
            guard choice.value != selected else { return }
            Task { await store.setAccountSetting(id: account.id, change(choice.value)) }
          } label: {
            Text(choice.title)
            Text(choice.note)
            if choice.value == selected { Image(systemName: "checkmark") }
          }
        }
      } label: {
        ADESettingsMenuLabel(text: current)
      }
      .disabled(store.busyAccountId == account.id)
    }
  }
}

// MARK: - Compaction

/// Claude's compaction windows, in the 100k steps it accepts.
private let claudeCompactWindowSteps = (1...10).map { $0 * 100_000 }

/// One account's compaction (desktop `CompactionSettings` with `account`):
/// the provider's settings, or this account's own.
struct ProviderAccountCompactionPage: View {
  @ObservedObject var store: ProviderAccountsStore
  let accountId: String
  @State private var codexAtTokens = ""
  @FocusState private var codexFieldFocused: Bool

  var body: some View {
    ADESettingsPage(title: "Auto-compact", subtitle: "When ADE compacts chats on this account.") {
      if let account = store.account(id: accountId) {
        content(account)
      }
    }
    .settingsPageClose()
  }

  @ViewBuilder
  private func content(_ account: ProviderAccount) -> some View {
    let isClaude = account.provider == ProviderAccountProvider.claude.rawValue
    let custom = account.compaction
    if let error = store.errorMessage {
      ADESettingsNotice(message: error, tone: .crit)
    }
    ADESettingsSection("This account") {
      ADESettingsRows {
        ADESettingsRow(title: "Compaction", hint: custom == nil ? "Same as the provider default." : "This account's own settings.") {
          Menu {
            Button { save(account, nil) } label: {
              Text("Same as provider default")
              if custom == nil { Image(systemName: "checkmark") }
            }
            Button { save(account, ProviderAccount.Compaction()) } label: {
              Text("Custom")
              if custom != nil { Image(systemName: "checkmark") }
            }
          } label: {
            ADESettingsMenuLabel(text: custom == nil ? "Default" : "Custom")
          }
        }
      }
    }
    if let custom {
      ADESettingsSection("Compaction") {
        ADESettingsRows {
          if isClaude {
            windowRow(account, custom, key: \.atTokens, title: "Compact at", hint: "Applies at the next query start.", autoLabel: "Auto")
            windowRow(
              account,
              custom,
              key: \.subagentAtTokens,
              title: "Subagents compact at",
              hint: subagentHint(custom),
              autoLabel: "Same as the main chat"
            )
          } else {
            ADESettingsRow(title: "Compact at", hint: "Token count, capped at the model's window. Empty is Auto.") {
              TextField("Auto", text: $codexAtTokens)
                .keyboardType(.numberPad)
                .multilineTextAlignment(.trailing)
                .font(.adeMono(14))
                .frame(width: 110)
                .focused($codexFieldFocused)
                .onAppear { codexAtTokens = custom.atTokens.map(String.init) ?? "" }
                .onChange(of: codexFieldFocused) { _, focused in
                  if !focused { saveCodexAtTokens(account, custom) }
                }
                .toolbar {
                  ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { codexFieldFocused = false }
                  }
                }
            }
          }
          idleRow(account, custom, isClaude: isClaude)
        }
      }
    }
  }

  private func windowRow(
    _ account: ProviderAccount,
    _ custom: ProviderAccount.Compaction,
    key: WritableKeyPath<ProviderAccount.Compaction, Int?>,
    title: String,
    hint: String,
    autoLabel: String
  ) -> some View {
    let value = custom[keyPath: key]
    return ADESettingsRow(title: title, hint: hint) {
      Menu {
        Button { var next = custom; next[keyPath: key] = nil; save(account, next) } label: {
          Text(autoLabel)
          if value == nil { Image(systemName: "checkmark") }
        }
        ForEach(claudeCompactWindowSteps, id: \.self) { step in
          Button { var next = custom; next[keyPath: key] = step; save(account, next) } label: {
            Text("\(step / 1000)k")
            if value == step { Image(systemName: "checkmark") }
          }
        }
      } label: {
        ADESettingsMenuLabel(text: value.map { "\($0 / 1000)k" } ?? autoLabel)
      }
    }
  }

  private func idleRow(_ account: ProviderAccount, _ custom: ProviderAccount.Compaction, isClaude: Bool) -> some View {
    // Desktop `compactionIdleModeDefault`: Claude has always offered; others start at never.
    let mode = custom.idleMode ?? (isClaude ? "ask" : "never")
    let choices: [(value: String, title: String)] = [
      ("ask", "Ask (pill)"),
      ("always", isClaude ? "Always compact first" : "On by default"),
      ("never", "Never"),
    ]
    return ADESettingsRow(
      title: "After the cache expires",
      hint: isClaude
        ? "After an hour idle, or 5 minutes on the 5-minute cache. In Always, ADE also compacts a large chat 54 minutes in, while the cache is still warm."
        : "OpenAI's prompt cache lasts 30 minutes, so the pill offers to compact a large chat once it is idle that long. Nothing runs on its own."
    ) {
      Menu {
        ForEach(choices, id: \.value) { choice in
          Button { var next = custom; next.idleMode = choice.value; save(account, next) } label: {
            Text(choice.title)
            if choice.value == mode { Image(systemName: "checkmark") }
          }
        }
      } label: {
        ADESettingsMenuLabel(text: choices.first { $0.value == mode }?.title ?? mode)
      }
    }
  }

  /// Desktop `claudeSubagentWindowIneffective`: subagents can only compact earlier.
  private func subagentHint(_ custom: ProviderAccount.Compaction) -> String {
    if let main = custom.atTokens, let subagent = custom.subagentAtTokens, subagent >= main {
      return "No effect: subagents can only compact earlier than the main chat. Pick a lower number, or raise Compact at."
    }
    return "Subagents can only compact earlier than the main chat, never later."
  }

  private func saveCodexAtTokens(_ account: ProviderAccount, _ custom: ProviderAccount.Compaction) {
    let raw = codexAtTokens.trimmingCharacters(in: .whitespaces)
    let parsed: Int?
    if raw.isEmpty {
      parsed = nil
    } else if let number = Int(raw), number > 0 {
      parsed = number
    } else {
      // Put the saved value back rather than keep text that was never saved.
      codexAtTokens = custom.atTokens.map(String.init) ?? ""
      store.errorMessage = "Compact at: enter a whole number above 0."
      return
    }
    guard parsed != custom.atTokens else { return }
    var next = custom
    next.atTokens = parsed
    save(account, next)
  }

  private func save(_ account: ProviderAccount, _ next: ProviderAccount.Compaction?) {
    guard next != account.compaction else { return }
    Task { await store.setAccountSetting(id: account.id, .compaction(next)) }
  }
}
