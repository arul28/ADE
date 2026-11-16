import SwiftUI

// MARK: - Brain

struct CtoBrainPage: View {
  @ObservedObject var store: CtoStore
  @ObservedObject var live: CtoLiveModel
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared

  private enum Picking: Identifiable {
    case main, backup
    var id: String { self == .main ? "main" : "backup" }
  }

  @State private var picking: Picking? = nil
  @State private var modelBusy = false
  @State private var refreshState: String? = nil
  @State private var refreshing = false
  @State private var showingHomeChooser = false
  @State private var accounts: [ProviderAccount] = []
  @State private var accountBusy = false

  private var accent: Color { live.look.ctoAccent }

  /// Claude or Codex: the providers with more than one login per machine.
  private var accountProvider: ProviderAccountProvider? { ProviderAccountProvider(rawValue: currentProvider) }
  /// The accounts that can run the CTO. The row shows only with two or more.
  private var usableAccounts: [ProviderAccount] { accounts.filter(\.canTakeChats) }
  private var currentAccountId: String? {
    store.ctoSession?.instanceId
      ?? store.identity?.modelPreferences?.instanceId
      ?? usableAccounts.first(where: \.isDefault)?.id
  }
  private var fallbacks: [CtoModelPreferences] { store.identity?.fallbackModels ?? [] }

  private var currentModelId: String {
    store.ctoSession?.modelId ?? store.ctoSession?.model
      ?? store.identity?.modelPreferences?.modelId ?? store.identity?.modelPreferences?.model ?? ""
  }

  private var currentProvider: String {
    store.ctoSession?.provider ?? store.identity?.modelPreferences?.provider ?? "claude"
  }

  var body: some View {
    List {
      Section {
        Button { if !store.isFixture { picking = .main } } label: {
          modelRow(provider: currentProvider, modelId: currentModelId, placeholder: "Pick a model", trailing: modelBusy ? AnyView(ProgressView().controlSize(.small)) : AnyView(chevron))
        }
        .buttonStyle(.plain)
        .disabled(modelBusy)
        .accessibilityLabel("Main model, \(currentModelId.isEmpty ? "none" : prettyWorkChatModelName(currentModelId))")
        if usableAccounts.count >= 2 {
          accountRow
        }
      } header: {
        Text("Main model")
      } footer: {
        Text("Claude, Codex, Cursor, OpenCode or Copilot")
          .lineLimit(1)
      }

      Section {
        ForEach(Array(fallbacks.enumerated()), id: \.offset) { index, entry in
          modelRow(
            provider: entry.provider,
            modelId: entry.modelId ?? entry.model,
            placeholder: entry.model,
            trailing: AnyView(backupMenu(index: index))
          )
        }
        if fallbacks.count < ctoMaxFallbackModels {
          Button { picking = .backup } label: {
            Label(fallbacks.isEmpty ? "Add a backup" : "Add another", systemImage: "plus")
              .foregroundStyle(accent)
          }
          .disabled(store.isFixture)
        }
      } header: {
        Text("Backups")
      } footer: {
        Text("Used in order when limits hit").lineLimit(1)
      }

      if store.canRefreshContext {
        Section {
          HStack {
            VStack(alignment: .leading, spacing: 2) {
              Text("Refresh context").foregroundStyle(ADEColor.textPrimary)
              Text(refreshState ?? "Keeps notes and recent messages")
                .font(.footnote)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            }
            Spacer(minLength: 8)
            Button(refreshing ? "Refreshing…" : "Refresh") {
              Task {
                refreshing = true
                refreshState = await store.refreshContext()
                refreshing = false
              }
            }
            .buttonStyle(.bordered)
            .disabled(refreshing)
          }
        }
      }

      Section {
        homeMachineRow
      } header: {
        Text("Home machine")
      } footer: {
        if !store.isFixture, syncPublishes.service.activeProjectGitOriginUrl == nil {
          Text(ctoHomeNeedsGitOriginMessage)
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .ctoSettingsPage(title: "Brain", store: store)
    .task(id: currentProvider) { await loadAccounts() }
    .sheet(item: $picking) { which in
      WorkModelPickerSheet(
        currentModelId: which == .main ? currentModelId : "",
        currentProvider: currentProvider,
        currentReasoningEffort: which == .main ? (store.ctoSession?.reasoningEffort ?? "") : "",
        currentCodexFastMode: which == .main ? (store.ctoSession?.effectiveFastMode ?? false) : false,
        lanes: [],
        commandScope: .project,
        isBusy: modelBusy,
        modelFilter: { providerSupportsLiveRedirect($0.provider) },
        onSelect: { option, reasoning, _, fastMode in
          Task { @MainActor in
            if which == .main {
              await setMain(option, reasoning: reasoning, fastMode: fastMode)
            } else {
              await addBackup(option)
            }
          }
        }
      )
      .environmentObject(syncPublishes.service)
    }
  }

  private var chevron: some View {
    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(ADEColor.textMuted)
  }

  private func modelRow(provider: String, modelId: String, placeholder: String, trailing: AnyView) -> some View {
    HStack(spacing: 12) {
      WorkProviderLogo(provider: provider, size: 30)
      Text(modelId.isEmpty ? placeholder : prettyWorkChatModelName(modelId))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
      Spacer(minLength: 8)
      trailing
    }
    .contentShape(Rectangle())
  }

  private func backupMenu(index: Int) -> some View {
    Menu {
      if index > 0 {
        Button { moveBackup(from: index, to: index - 1) } label: { Label("Move up", systemImage: "arrow.up") }
      }
      if index < fallbacks.count - 1 {
        Button { moveBackup(from: index, to: index + 1) } label: { Label("Move down", systemImage: "arrow.down") }
      }
      Button(role: .destructive) { removeBackup(at: index) } label: { Label("Remove", systemImage: "trash") }
    } label: {
      Image(systemName: "ellipsis")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 36, height: 36)
        .contentShape(Rectangle())
    }
    .accessibilityLabel("Backup \(index + 1) options")
  }

  /// Which account runs the main model. Same conversation on every account:
  /// the host moves the thread, it does not start a new one.
  private var accountRow: some View {
    let current = usableAccounts.first { $0.id == currentAccountId }
    return Menu {
      ForEach(usableAccounts) { account in
        Button {
          Task { await setAccount(account) }
        } label: {
          if account.id == currentAccountId {
            Label(account.displayName, systemImage: "checkmark")
          } else {
            Text(account.displayName)
          }
        }
      }
    } label: {
      HStack(spacing: 12) {
        Image(systemName: "person.crop.circle")
          .font(.system(size: 18))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 30)
        Text("Account").foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 8)
        if accountBusy {
          ProgressView().controlSize(.small)
        } else {
          Text(current?.displayName ?? "Default")
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .truncationMode(.middle)
          Image(systemName: "chevron.up.chevron.down")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .contentShape(Rectangle())
    }
    .disabled(accountBusy || modelBusy)
    .accessibilityLabel("Account, \(current?.displayName ?? "default")")
  }

  @MainActor
  private func loadAccounts() async {
    guard let provider = accountProvider else { accounts = []; return }
    #if DEBUG
    if store.isFixture {
      accounts = ProviderAccountsPreviewData.accounts.filter { $0.provider == provider.rawValue }
      return
    }
    #endif
    guard let sync = SyncService.shared, sync.supportsProviderAccounts else { accounts = []; return }
    accounts = (try? await ProviderAccountsClient(host: sync).list(provider)) ?? []
  }

  @MainActor
  private func setAccount(_ account: ProviderAccount) async {
    guard account.id != currentAccountId, var preferences = store.identity?.modelPreferences else { return }
    accountBusy = true
    defer { accountBusy = false }
    preferences.instanceId = account.id
    var patch = CtoIdentityPatch()
    patch.modelPreferences = preferences
    guard await store.updateIdentity(patch) else { return }
    if !store.isFixture, let sync = SyncService.shared {
      // The host moves the thread on ensure, or when the next turn starts if one is running.
      if let session = try? await sync.ensureCtoSession() { store.ctoSession = session }
      await store.reloadIdentity()
    }
    ADEHaptics.light()
  }

  private func saveBackups(_ next: [CtoModelPreferences]) {
    var patch = CtoIdentityPatch()
    patch.fallbackModels = next
    Task { await store.updateIdentity(patch) }
  }

  private func moveBackup(from: Int, to: Int) {
    var next = fallbacks
    guard next.indices.contains(from), next.indices.contains(to) else { return }
    next.swapAt(from, to)
    saveBackups(next)
  }

  private func removeBackup(at index: Int) {
    var next = fallbacks
    guard next.indices.contains(index) else { return }
    next.remove(at: index)
    saveBackups(next)
  }

  private func preferenceName(_ modelId: String) -> String {
    modelId.split(separator: "/").last.map(String.init) ?? modelId
  }

  @MainActor
  private func addBackup(_ option: WorkModelOption) async {
    guard option.id != currentModelId, !fallbacks.contains(where: { ($0.modelId ?? $0.model) == option.id }) else { return }
    var next = fallbacks
    next.append(CtoModelPreferences(provider: option.provider, model: preferenceName(option.id), reasoningEffort: nil, modelId: option.id))
    saveBackups(Array(next.prefix(3)))
  }

  @MainActor
  private func setMain(_ option: WorkModelOption, reasoning: String?, fastMode: Bool) async {
    guard let sync = store.isFixture ? nil : SyncService.shared else { return }
    modelBusy = true
    defer { modelBusy = false }
    do {
      let session: AgentChatSessionSummary
      if let existing = store.ctoSession { session = existing } else { session = try await sync.ensureCtoSession() }
      let nextReasoning = reasoning ?? ""
      _ = try await sync.updateChatSession(
        sessionId: session.sessionId,
        modelId: option.id,
        reasoningEffort: nextReasoning == (session.reasoningEffort ?? "") ? nil : nextReasoning,
        codexFastMode: fastMode == session.effectiveFastMode ? nil : fastMode
      )
      store.ctoSession = try await sync.ensureCtoSession()
      await store.reloadIdentity()
      store.savedTick += 1
      ADEHaptics.light()
    } catch {
      store.errorText = ctoShortError(error, fallback: "Couldn't switch the model")
      ADEHaptics.error()
    }
  }

  @ViewBuilder
  private var homeMachineRow: some View {
    if store.isFixture {
      HStack(spacing: 12) {
        Image(systemName: "desktopcomputer").foregroundStyle(ADEColor.textSecondary).frame(width: 30)
        Text("This Mac").foregroundStyle(ADEColor.textPrimary)
        Spacer()
      }
    } else {
      let sync = syncPublishes.service
      let canChoose = sync.supportsRemoteAction("cto.setHomeMachine")
      Button { showingHomeChooser = true } label: {
        HStack(spacing: 12) {
          Image(systemName: sync.ctoHomeIsCloudComputer ? "cloud" : "desktopcomputer")
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 30)
          VStack(alignment: .leading, spacing: 2) {
            Text(ctoHomeRowName(sync))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            if sync.ctoHomeIsCloudComputer {
              Text("ADE Cloud")
                .font(.footnote)
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
            }
          }
          Spacer(minLength: 8)
          if canChoose {
            Image(systemName: "chevron.up.chevron.down")
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!canChoose)
      .accessibilityLabel("Home machine, \(ctoHomeRowName(sync))")
      .sheet(isPresented: $showingHomeChooser) {
        CtoHomeChooserSheet(
          look: live.look,
          name: live.name,
          currentName: sync.ctoHomeNeedsChoice ? nil : ctoHomeRowName(sync),
          blockedReason: sync.activeProjectGitOriginUrl == nil ? ctoHomeNeedsGitOriginMessage : nil,
          onChoose: { option in
            let note = try await ctoChooseHome(option, sync: sync)
            await store.reloadIdentity()
            store.savedTick += 1
            return note
          }
        )
      }
    }
  }
}
