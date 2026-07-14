import SwiftUI

/// CTO settings sheet: identity, live model selection, a
/// read-only Linear connection status, a "what the CTO remembers" memory
/// summary, and an advanced re-run-onboarding action. Presented as a sheet
/// from the CTO tab's gear button.
struct CtoSettingsScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let onSnapshotChanged: (CtoSnapshot) -> Void

  @State private var snapshot: CtoSnapshot?
  @State private var linearStatus: LinearConnectionStatus?
  @State private var memory: CtoMemory?
  @State private var memoryUnavailable = false
  @State private var isLoading = false
  @State private var isResettingOnboarding = false
  @State private var errorMessage: String?
  @State private var showingIdentityEditor = false
  @State private var showingModelPicker = false
  @State private var modelUpdateInFlight = false
  @State private var ctoSession: AgentChatSessionSummary?

  init(snapshot: CtoSnapshot? = nil, onSnapshotChanged: @escaping (CtoSnapshot) -> Void) {
    _snapshot = State(initialValue: snapshot)
    self.onSnapshotChanged = onSnapshotChanged
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if let errorMessage, !syncService.connectionState.isHostUnreachable {
            ADENoticeCard(
              title: "Settings failed to load",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload() } }
            )
          }

          if isLoading && snapshot == nil {
            VStack(spacing: 12) {
              ADECardSkeleton(rows: 3)
              ADECardSkeleton(rows: 3)
            }
          }

          if let snapshot {
            identitySection(snapshot)
            modelSection(snapshot)
          }

          integrationsSection
          memorySection
          advancedSection

          Color.clear.frame(height: 24)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
      }
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .navigationTitle("CTO settings")
      .adeAnalyticsScreen(.ctoSettings)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
        }
      }
      .tint(ADEColor.ctoAccent)
      .refreshable { await reload() }
      .task {
        guard snapshot == nil else {
          // Still refresh the side data (Linear, memory) even if identity was
          // seeded from the parent snapshot.
          await loadSideData()
          await loadCtoSession()
          return
        }
        await reload()
      }
      .sheet(isPresented: $showingIdentityEditor) {
        CtoIdentityEditor(snapshot: snapshot) { updated in
          self.snapshot = updated
          onSnapshotChanged(updated)
        }
        .environmentObject(syncService)
      }
      .sheet(isPresented: $showingModelPicker) {
        WorkModelPickerSheet(
          currentModelId: currentModelId,
          currentProvider: currentProvider,
          currentReasoningEffort: currentReasoningEffort,
          currentCodexFastMode: currentFastMode,
          lanes: [],
          commandScope: .project,
          isBusy: modelUpdateInFlight,
          onSelect: { option, reasoningEffort, _, fastMode in
            Task { @MainActor in
              await updateModel(
                modelId: option.id,
                reasoningEffort: reasoningEffort ?? "",
                fastMode: option.supportsCodexFastMode ? fastMode : false
              )
            }
          }
        )
      }
    }
  }

  // MARK: - Identity

  @ViewBuilder
  private func identitySection(_ snapshot: CtoSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionHeader(title: "Identity")
      IdentityCard(
        identity: snapshot.identity,
        onEdit: { showingIdentityEditor = true }
      )
    }
  }

  // MARK: - Model

  private func modelSection(_ snapshot: CtoSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionHeader(title: "Model")
      Button {
        showingModelPicker = true
      } label: {
        HStack(spacing: 12) {
          Image(systemName: "cpu")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(ADEColor.ctoAccent)
            .frame(width: 32, height: 32)
            .background(
              ADEColor.ctoAccent.opacity(0.12),
              in: RoundedRectangle(cornerRadius: 9, style: .continuous)
            )

          VStack(alignment: .leading, spacing: 2) {
            Text(prettyWorkChatModelName(currentModelId))
              .font(.system(size: 13.5, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Text(modelDetailText(snapshot))
              .font(.system(size: 10.5, design: .monospaced))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }

          Spacer(minLength: 8)

          if modelUpdateInFlight {
            ProgressView().controlSize(.mini)
          } else {
            Image(systemName: "chevron.right")
              .font(.system(size: 11, weight: .semibold))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(modelUpdateInFlight)
      .accessibilityLabel("Change CTO model")
      .adeListCard(padding: 0)
    }
  }

  private var currentModelId: String {
    ctoSession?.modelId
      ?? ctoSession?.model
      ?? snapshot?.identity.modelPreferences.model
      ?? ""
  }

  private var currentProvider: String {
    ctoSession?.provider
      ?? snapshot?.identity.modelPreferences.provider
      ?? "claude"
  }

  private var currentReasoningEffort: String {
    ctoSession?.reasoningEffort
      ?? snapshot?.identity.modelPreferences.reasoningEffort
      ?? ""
  }

  private var currentFastMode: Bool {
    ctoSession?.effectiveFastMode ?? false
  }

  private func modelDetailText(_ snapshot: CtoSnapshot) -> String {
    var details = [currentProvider]
    if !currentReasoningEffort.isEmpty {
      details.append(currentReasoningEffort)
    }
    if currentFastMode {
      details.append("fast")
    }
    return details.isEmpty
      ? snapshot.identity.modelPreferences.model
      : details.joined(separator: " · ")
  }

  @MainActor
  private func updateModel(modelId: String, reasoningEffort: String, fastMode: Bool) async {
    guard !modelUpdateInFlight else { return }
    modelUpdateInFlight = true
    errorMessage = nil
    defer { modelUpdateInFlight = false }

    do {
      let session = try await currentCtoSession()
      _ = try await syncService.updateChatSession(
        sessionId: session.sessionId,
        modelId: modelId,
        reasoningEffort: reasoningEffort,
        codexFastMode: fastMode
      )
      ctoSession = try await syncService.ensureCtoSession()
      let updated = try await syncService.fetchCtoState()
      snapshot = updated
      onSnapshotChanged(updated)
      ADEHaptics.light()
    } catch {
      ADEHaptics.error()
      errorMessage = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }
  }

  @MainActor
  private func currentCtoSession() async throws -> AgentChatSessionSummary {
    if let ctoSession { return ctoSession }
    let ensured = try await syncService.ensureCtoSession()
    ctoSession = ensured
    return ensured
  }

  // MARK: - Integrations (read-only)

  private var integrationsSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionHeader(title: "Integrations")
      VStack(spacing: 0) {
        IntegrationRow(
          name: "Linear",
          subtitle: linearSubtitle,
          connected: linearStatus?.connected == true
        )
      }
      .adeListCard(padding: 0)
    }
  }

  private var linearSubtitle: String {
    guard let linearStatus else { return "Manage in ADE" }
    if linearStatus.connected {
      if let name = linearStatus.viewerName, !name.isEmpty { return "Connected · \(name)" }
      return "Connected"
    }
    if let message = linearStatus.message, !message.isEmpty { return message }
    return "Not connected"
  }

  // MARK: - Memory

  private var memorySection: some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionHeader(title: "Memory")
      CtoMemoryCard(memory: memory, unavailable: memoryUnavailable)
    }
  }

  // MARK: - Advanced

  private var advancedSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionHeader(title: "Advanced")
      VStack(spacing: 0) {
        Button {
          Task { await rerunOnboarding() }
        } label: {
          HStack(spacing: 8) {
            Text("Re-run setup")
              .font(.system(size: 13.5, weight: .medium))
              .foregroundStyle(ADEColor.textPrimary)
              .frame(maxWidth: .infinity, alignment: .leading)
            if isResettingOnboarding {
              ProgressView().controlSize(.mini)
            } else {
              Image(systemName: "arrow.counterclockwise")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(ADEColor.textMuted)
            }
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 12)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isResettingOnboarding)
        .accessibilityLabel("Re-run CTO setup")
      }
      .adeListCard(padding: 0)
    }
  }

  /// Resets onboarding to incomplete so the tab flips back to the setup card.
  /// The desktop only requires the "identity" step, so an empty
  /// `completedSteps` (and no `completedAt`) reads as incomplete.
  private func rerunOnboarding() async {
    guard !isResettingOnboarding else { return }
    isResettingOnboarding = true
    defer { isResettingOnboarding = false }
    var patch = CtoIdentityPatch()
    patch.onboardingState = CtoOnboardingState(completedSteps: [], dismissedAt: nil, completedAt: nil)
    do {
      let updated = try await syncService.updateCtoIdentity(patch: patch)
      snapshot = updated
      onSnapshotChanged(updated)
      dismiss()
    } catch {
      errorMessage = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }
  }

  // MARK: - Data loading

  private func reload() async {
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }

    do {
      let updated = try await syncService.fetchCtoState()
      self.snapshot = updated
      onSnapshotChanged(updated)
    } catch {
      if self.snapshot == nil {
        self.errorMessage = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
      }
    }
    await loadSideData()
    await loadCtoSession()
  }

  /// The live CTO chat is the source of truth for model, reasoning, and fast
  /// mode. Keep identity preferences as an offline fallback, but do not let a
  /// failed session refresh make the rest of CTO settings unusable.
  private func loadCtoSession() async {
    if let session = try? await syncService.ensureCtoSession() {
      ctoSession = session
    }
  }

  /// Linear status + memory. Both tolerate failure: Linear falls back to
  /// "Manage in ADE" and memory falls back to the "not available" row.
  private func loadSideData() async {
    if let value = try? await syncService.fetchLinearConnectionStatus() {
      self.linearStatus = value
    } else {
      self.linearStatus = nil
    }

    do {
      self.memory = try await syncService.fetchCtoMemory()
      self.memoryUnavailable = false
    } catch {
      // Older hosts don't implement cto.getMemory — surface a quiet row, not
      // an error card.
      self.memory = nil
      self.memoryUnavailable = true
    }
  }
}

// MARK: - Memory card

/// Renders the CTO's durable memory and rolling thread state as scrollable
/// monospaced blocks under a "what the CTO remembers" framing. Degrades to a
/// quiet unavailable row on older hosts.
private struct CtoMemoryCard: View {
  let memory: CtoMemory?
  let unavailable: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("What the CTO remembers")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)

      if unavailable {
        Text("Memory not available on this host version.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
      } else if let memory, !memory.isEmpty {
        let trimmedMemory = memory.memory.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedThread = memory.threadState.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedMemory.isEmpty {
          memoryBlock(title: "Durable facts", body: trimmedMemory)
        }
        if !trimmedThread.isEmpty {
          memoryBlock(title: "Current thread", body: trimmedThread)
        }
        if let updatedAt = memory.updatedAt, !updatedAt.isEmpty {
          Text("Updated \(updatedAt)")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
        }
      } else {
        Text("Nothing saved yet. The CTO writes durable facts here as you work.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .adeListCard()
  }

  private func memoryBlock(title: String, body: String) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title.uppercased())
        .font(.caption2.weight(.semibold))
        .tracking(0.4)
        .foregroundStyle(ADEColor.textMuted)
      ScrollView {
        Text(body)
          .font(.system(size: 11.5, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .frame(maxHeight: 180)
      .padding(10)
      .background(ADEColor.recessedBackground.opacity(0.78), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
      )
    }
  }
}

// MARK: - Section header

private struct SectionHeader: View {
  let title: String

  var body: some View {
    Text(title.uppercased())
      .font(.caption.weight(.semibold))
      .tracking(0.4)
      .foregroundStyle(ADEColor.textMuted)
      .padding(.top, 6)
  }
}

// MARK: - Identity card

private struct IdentityCard: View {
  let identity: CtoIdentity
  let onEdit: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 12) {
        ZStack {
          RoundedRectangle(cornerRadius: 13, style: .continuous)
            .fill(
              LinearGradient(
                colors: [ADEColor.ctoAccent.opacity(0.35), ADEColor.accentDeep.opacity(0.55)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
          RoundedRectangle(cornerRadius: 13, style: .continuous)
            .stroke(ADEColor.ctoAccent.opacity(0.3), lineWidth: 0.5)
          Text(initials)
            .font(.system(size: 20, weight: .heavy))
            .foregroundStyle(ADEColor.textPrimary)
        }
        .frame(width: 44, height: 44)

        VStack(alignment: .leading, spacing: 2) {
          Text(identity.name.isEmpty ? "CTO" : identity.name)
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text(providerModelText)
            .font(.system(size: 10.5, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }

        Spacer(minLength: 8)

        Button(action: onEdit) {
          Text("Edit")
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.ctoAccent)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(ADEColor.ctoAccent.opacity(0.14), in: Capsule())
        }
        .buttonStyle(.plain)
      }

      Text(summaryText)
        .font(.system(size: 12))
        .foregroundStyle(ADEColor.textSecondary)
        .lineSpacing(2)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(ADEColor.recessedBackground.opacity(0.78), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 10, style: .continuous)
            .stroke(ADEColor.glassBorder, lineWidth: 0.5)
        )
    }
    .adeListCard()
  }

  private var initials: String {
    let name = identity.name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = name.first else { return "C" }
    return String(first).uppercased()
  }

  private var providerModelText: String {
    "\(identity.modelPreferences.provider) · \(identity.modelPreferences.model)"
  }

  private var summaryText: String {
    if let ext = identity.systemPromptExtension?.trimmingCharacters(in: .whitespacesAndNewlines), !ext.isEmpty {
      return ext
    }
    let persona = identity.persona?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !persona.isEmpty { return persona }
    return ctoPersonalityPresetOptions.first { $0.id == identity.personality }?.description
      ?? ctoPersonalityPresetOptions[0].description
  }
}

// MARK: - Integration row

private struct IntegrationRow: View {
  let name: String
  let subtitle: String
  let connected: Bool

  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(ADEColor.glassBackground)
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.5)
        Text(String(name.prefix(1)))
          .font(.system(size: 11, weight: .heavy))
          .foregroundStyle(ADEColor.textSecondary)
      }
      .frame(width: 26, height: 26)

      VStack(alignment: .leading, spacing: 1) {
        Text(name)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(subtitle)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      .frame(maxWidth: .infinity, alignment: .leading)

      ADEStatusPill(
        text: connected ? "connected" : "off",
        tint: connected ? ADEColor.success : ADEColor.textSecondary
      )
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
  }
}
