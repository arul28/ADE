import SwiftUI

struct CtoSettingsScreen: View {
  @EnvironmentObject private var syncService: SyncService

  @State private var snapshot: CtoSnapshot?
  @State private var budget: AgentBudgetSnapshot?
  @State private var linearStatus: LinearConnectionStatus?
  @State private var isLoading = false
  @State private var isSyncing = false
  @State private var errorMessage: String?
  @State private var syncNotice: String?
  @State private var showingIdentityEditor = false
  @State private var showingBriefEditor = false
  @State private var showingDesktopOnlySheet = false
  @State private var desktopOnlyTitle: String = ""

  var body: some View {
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
            ADECardSkeleton(rows: 4)
            ADECardSkeleton(rows: 3)
          }
        }

        if let snapshot {
          identitySection(snapshot)
          coreMemorySection(snapshot)
        }

        heartbeatSection
        budgetSection
        integrationsSection
        advancedSection

        Color.clear.frame(height: 32)
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
    }
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .refreshable { await reload() }
    .task {
      guard snapshot == nil else { return }
      await reload()
    }
    .sheet(isPresented: $showingIdentityEditor) {
      CtoIdentityEditor(snapshot: snapshot) { updated in
        self.snapshot = updated
      }
    }
    .sheet(isPresented: $showingBriefEditor) {
      CtoBriefEditor(snapshot: snapshot) { updated in
        self.snapshot = updated
      }
    }
    .sheet(isPresented: $showingDesktopOnlySheet) {
      DesktopOnlySheet(title: desktopOnlyTitle)
        .presentationDetents([.fraction(0.3), .medium])
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

  // MARK: - Core memory

  @ViewBuilder
  private func coreMemorySection(_ snapshot: CtoSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionHeader(title: "Core memory")
      VStack(spacing: 0) {
        MemoryRow(
          label: "Project summary",
          sub: projectSummarySubtitle(snapshot.coreMemory)
        ) { showingBriefEditor = true }
        Sep()
        MemoryRow(
          label: "Conventions",
          sub: "\(snapshot.coreMemory.criticalConventions.count) convention\(snapshot.coreMemory.criticalConventions.count == 1 ? "" : "s")"
        ) { showingBriefEditor = true }
        Sep()
        MemoryRow(
          label: "Preferences",
          sub: "\(snapshot.coreMemory.userPreferences.count) preference\(snapshot.coreMemory.userPreferences.count == 1 ? "" : "s")"
        ) { showingBriefEditor = true }
        Sep()
        MemoryRow(
          label: "Focus & notes",
          sub: "\(snapshot.coreMemory.activeFocus.count + snapshot.coreMemory.notes.count) entries"
        ) { showingBriefEditor = true }
      }
      .adeListCard(padding: 0)
    }
  }

  private func projectSummarySubtitle(_ memory: CtoCoreMemory) -> String {
    memory.projectSummary.isEmpty ? "empty" : "captured"
  }

  // MARK: - Heartbeat (read-only placeholders)

  private var heartbeatSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionHeader(title: "Heartbeat")
      VStack(spacing: 0) {
        RowItem(label: "Mode", value: "Combined", disabled: true)
        Sep()
        RowItem(label: "Interval", value: "every 15 min", disabled: true)
        Sep()
        RowItem(label: "Event triggers", value: "—", disabled: true)
      }
      .adeListCard(padding: 0)
    }
  }

  // MARK: - Budget

  private var budgetSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionHeader(title: "Budget")
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline) {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(companySpentLabel)
              .font(.system(size: 22, weight: .heavy))
              .tracking(-0.3)
              .foregroundStyle(ADEColor.textPrimary)
            if let capText = companyCap {
              Text("/ \(capText)")
                .font(.system(size: 13))
                .foregroundStyle(ADEColor.textMuted)
            }
          }
          Spacer(minLength: 0)
          if let pct = companyBudgetPct {
            ADEStatusPill(
              text: pct > 80 ? "warning" : "healthy",
              tint: pct > 80 ? ADEColor.warning : ADEColor.success
            )
          }
        }

        if let pct = companyBudgetPct {
          Text("\(pct)% this month")
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
          CtoBudgetBar(percent: pct)
        }

        Divider().opacity(0.08)

        HStack {
          Text("Alert threshold")
            .font(.system(size: 12.5, weight: .medium))
            .foregroundStyle(ADEColor.textMuted)
          Spacer(minLength: 0)
          Text("80%")
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      .adeListCard()
    }
  }

  private var companySpentLabel: String {
    guard let budget else { return "$—" }
    return Self.formatUSD(cents: budget.companySpentMonthlyCents)
  }

  private var companyCap: String? {
    guard let cap = budget?.companyCapMonthlyCents else { return nil }
    return Self.formatUSD(cents: cap)
  }

  private var companyBudgetPct: Int? {
    guard let budget else { return nil }
    return ctoBudgetPercent(spentCents: budget.companySpentMonthlyCents, capCents: budget.companyCapMonthlyCents)
  }

  private static func formatUSD(cents: Int) -> String {
    let dollars = Double(cents) / 100.0
    return String(format: "$%.2f", dollars)
  }

  // MARK: - Integrations

  private var integrationsSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionHeader(title: "Integrations")
      if let syncNotice {
        Text(syncNotice)
          .font(.system(size: 11.5, design: .monospaced))
          .foregroundStyle(ADEColor.success)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 16)
      }

      VStack(spacing: 0) {
        IntegrationRow(
          name: "Linear",
          subtitle: linearSubtitle,
          connected: linearStatus?.connected == true
        )
        if linearStatus?.connected == true {
          Sep()
          Button {
            Task { await triggerLinearSync() }
          } label: {
            HStack(spacing: 8) {
              ZStack {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                  .fill(ADEColor.purpleAccent.opacity(0.12))
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                  .stroke(ADEColor.purpleAccent.opacity(0.24), lineWidth: 0.5)
                Group {
                  if isSyncing {
                    ProgressView().controlSize(.mini).tint(ADEColor.purpleAccent)
                  } else {
                    Image(systemName: "arrow.triangle.2.circlepath")
                      .font(.system(size: 12, weight: .semibold))
                      .foregroundStyle(ADEColor.purpleAccent)
                  }
                }
              }
              .frame(width: 26, height: 26)

              VStack(alignment: .leading, spacing: 1) {
                Text(isSyncing ? "Syncing…" : "Sync now")
                  .font(.system(size: 13, weight: .semibold))
                  .foregroundStyle(ADEColor.textPrimary)
                Text("Trigger intake & dispatch cycle")
                  .font(.system(size: 10, design: .monospaced))
                  .foregroundStyle(ADEColor.textMuted)
                  .lineLimit(1)
              }
              .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(isSyncing)
          .accessibilityLabel("Sync Linear now")
        }
        Sep()
        IntegrationRow(name: "OpenClaw", subtitle: "—", connected: false)
        Sep()
        IntegrationRow(name: "External MCP", subtitle: "off", connected: false)
      }
      .adeListCard(padding: 0)
    }
  }

  private func triggerLinearSync() async {
    guard !isSyncing else { return }
    isSyncing = true
    syncNotice = nil
    defer { isSyncing = false }
    do {
      _ = try await syncService.runLinearSyncNow()
      syncNotice = "Linear sync completed."
      Task {
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        await MainActor.run { syncNotice = nil }
      }
    } catch {
      syncNotice = "Sync failed: \(error.localizedDescription)"
    }
  }

  // MARK: - Advanced

  private var advancedSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      SectionHeader(title: "Advanced")
      VStack(spacing: 0) {
        RowItem(label: "Re-run onboarding", value: "") {
          desktopOnlyTitle = "Re-run onboarding"
          showingDesktopOnlySheet = true
        }
        Sep()
        RowItem(label: "Re-scan project", value: "") {
          desktopOnlyTitle = "Re-scan project"
          showingDesktopOnlySheet = true
        }
        Sep()
        RowItem(label: "Reset memory", value: "", danger: true) {
          desktopOnlyTitle = "Reset memory"
          showingDesktopOnlySheet = true
        }
      }
      .adeListCard(padding: 0)
    }
  }

  private var linearSubtitle: String {
    guard let linearStatus else { return "Manage from desktop" }
    if linearStatus.connected {
      if let name = linearStatus.viewerName, !name.isEmpty { return "Connected · \(name)" }
      return "Connected"
    }
    if let message = linearStatus.message, !message.isEmpty { return message }
    return "Not connected"
  }

  // MARK: - Data loading

  /// Fires all reads in parallel but tolerates partial failures — one endpoint
  /// returning an error shouldn't blank the entire screen (e.g. Linear status
  /// is optional and should never block the identity card from rendering).
  private func reload() async {
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }

    do {
      self.snapshot = try await syncService.fetchCtoState()
    } catch {
      if self.snapshot == nil {
        self.errorMessage = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
      }
    }

    if let value = try? await syncService.fetchCtoBudget() {
      self.budget = value
    }
    if let value = try? await syncService.fetchLinearConnectionStatus() {
      self.linearStatus = value
    }
  }
}

// MARK: - Budget bar (GeometryReader-free to avoid iOS 26 glass-layer pool churn)

private struct CtoBudgetBar: View {
  let percent: Int

  var body: some View {
    let clamped = max(0, min(100, percent))
    let fill = CGFloat(clamped) / 100.0
    ZStack(alignment: .leading) {
      RoundedRectangle(cornerRadius: 3, style: .continuous)
        .fill(ADEColor.recessedBackground.opacity(0.5))
      RoundedRectangle(cornerRadius: 3, style: .continuous)
        .fill(
          LinearGradient(
            colors: clamped > 80
              ? [ADEColor.warning, ADEColor.warning.opacity(0.7)]
              : [ADEColor.accentDeep, ADEColor.ctoAccent],
            startPoint: .leading,
            endPoint: .trailing
          )
        )
        .scaleEffect(x: fill, y: 1, anchor: .leading)
    }
    .frame(height: 5)
    .frame(maxWidth: .infinity)
  }
}

// MARK: - Section header

private struct SectionHeader: View {
  let title: String
  var rightLabel: String? = nil

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title.uppercased())
        .font(.caption.weight(.semibold))
        .tracking(0.4)
        .foregroundStyle(ADEColor.textMuted)
      Spacer(minLength: 8)
      if let rightLabel {
        Text(rightLabel)
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
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
                colors: [ADEColor.purpleAccent.opacity(0.35), ADEColor.accentDeep.opacity(0.55)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
          RoundedRectangle(cornerRadius: 13, style: .continuous)
            .stroke(ADEColor.purpleAccent.opacity(0.3), lineWidth: 0.5)
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
            .foregroundStyle(ADEColor.accent)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(ADEColor.accent.opacity(0.14), in: Capsule())
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
    return CtoPresetSummary.text(for: identity.personality)
  }
}

enum CtoPresetSummary {
  static func text(for preset: String?) -> String {
    switch preset {
    case "professional":
      return "Professional technical lead. Direct feedback, pragmatic tradeoffs, holds the mental model."
    case "strategic":
      return "Strategic thinker. Emphasizes system boundaries, migration safety, and long-term tradeoffs."
    case "hands_on":
      return "Hands-on executor. Moves fast, unblocks the team, prefers decisive action."
    case "casual":
      return "Casual collaborator. Informal tone, low-friction feedback loops."
    case "minimal":
      return "Minimal voice. Short, surgical replies with no filler."
    case "custom":
      return "Custom identity. Configure the system prompt extension from the desktop app."
    default:
      return "Pragmatic senior engineer who holds the mental model so workers don't have to."
    }
  }
}

// MARK: - Memory row

private struct MemoryRow: View {
  let label: String
  let sub: String
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(spacing: 10) {
        ZStack {
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(ADEColor.purpleAccent.opacity(0.12))
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .stroke(ADEColor.purpleAccent.opacity(0.24), lineWidth: 0.5)
          Image(systemName: "brain.head.profile")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.purpleAccent)
        }
        .frame(width: 26, height: 26)

        VStack(alignment: .leading, spacing: 1) {
          Text(label)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(sub)
            .font(.system(size: 10, design: .monospaced))
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 11)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }
}

// MARK: - Row item

private struct RowItem: View {
  let label: String
  let value: String
  var warn: Bool = false
  var danger: Bool = false
  var disabled: Bool = false
  var onTap: (() -> Void)? = nil

  var body: some View {
    let content = HStack(spacing: 8) {
      Text(label)
        .font(.system(size: 13.5, weight: .medium))
        .foregroundStyle(labelColor)
        .frame(maxWidth: .infinity, alignment: .leading)
      if !value.isEmpty {
        Text(value)
          .font(.system(size: 11, design: .monospaced))
          .foregroundStyle(valueColor)
      }
      if onTap != nil {
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .contentShape(Rectangle())
    .opacity(disabled ? 0.55 : 1.0)

    if let onTap, !disabled {
      Button(action: onTap) { content }
        .buttonStyle(.plain)
    } else {
      content
    }
  }

  private var labelColor: Color {
    if danger { return ADEColor.danger }
    return ADEColor.textPrimary
  }

  private var valueColor: Color {
    if warn { return ADEColor.warning }
    return ADEColor.textSecondary
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

// MARK: - Separator

private struct Sep: View {
  var body: some View {
    Divider()
      .background(ADEColor.glassBorder)
      .padding(.leading, 14)
  }
}

// MARK: - Desktop-only sheet

private struct DesktopOnlySheet: View {
  @Environment(\.dismiss) private var dismiss
  let title: String

  var body: some View {
    VStack(spacing: 18) {
      Image(systemName: "desktopcomputer")
        .font(.system(size: 36, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
        .padding(.top, 24)
      Text(title.isEmpty ? "Desktop only" : title)
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
      Text("Manage from desktop for now.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
      Button("Close") { dismiss() }
        .buttonStyle(.glassProminent)
        .padding(.top, 4)
      Spacer()
    }
    .frame(maxWidth: .infinity)
    .adeScreenBackground()
  }
}
