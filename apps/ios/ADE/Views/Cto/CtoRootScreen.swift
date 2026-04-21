import SwiftUI
import UIKit

struct CtoRootScreen: View {
  @EnvironmentObject private var syncService: SyncService

  @State private var roster: CtoRoster?
  @State private var isLoading = false
  @State private var errorMessage: String?
  @State private var path = NavigationPath()

  private var workers: [CtoWorkerEntry] {
    roster?.workers ?? []
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        headerSection
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 6, trailing: 0))

        if let errorMessage {
          ADENoticeCard(
            title: "Roster failed to load",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await loadRoster() } }
          )
          .listRowBackground(Color.clear)
          .listRowSeparator(.hidden)
        }

        Section {
          ctoCardRow
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
        }

        Section {
          workersSectionHeader
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 10, leading: 0, bottom: 2, trailing: 0))

          if isLoading && workers.isEmpty {
            ForEach(0..<3, id: \.self) { _ in
              ADECardSkeleton(rows: 2)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }
          } else if workers.isEmpty {
            emptyWorkersCard
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
          } else {
            ForEach(workers) { worker in
              CtoWorkerRow(entry: worker) {
                path.append(CtoSessionRoute.worker(agentId: worker.agentId, displayName: worker.name))
              }
              .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
              .listRowBackground(Color.clear)
              .listRowSeparator(.hidden)
            }
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .tint(ADEColor.ctoAccent)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("CTO")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          ADEConnectionDot()
        }
      }
      .refreshable { await loadRoster() }
      .task {
        if roster == nil { await loadRoster() }
      }
      .navigationDestination(for: CtoSessionRoute.self) { route in
        switch route {
        case .cto:
          CtoSessionDestinationView(kind: .cto)
            .environmentObject(syncService)
        case .worker(let agentId, let displayName):
          CtoSessionDestinationView(kind: .worker(agentId: agentId, displayName: displayName))
            .environmentObject(syncService)
        }
      }
    }
  }

  private var headerSection: some View {
    HStack(alignment: .center, spacing: 14) {
      Image(systemName: "brain.head.profile")
        .font(.system(size: 26, weight: .semibold))
        .symbolRenderingMode(.hierarchical)
        .foregroundStyle(ADEColor.ctoAccent)
        .frame(width: 50, height: 50)
        .background(ADEColor.ctoAccent.opacity(0.14), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .stroke(ADEColor.ctoAccent.opacity(0.28), lineWidth: 0.8)
        )

      VStack(alignment: .leading, spacing: 3) {
        Text("CTO")
          .font(.caption.monospaced().weight(.bold))
          .foregroundStyle(ADEColor.ctoAccent)
          .tracking(0.6)
        Text("Control room")
          .font(.title2.weight(.bold))
          .foregroundStyle(ADEColor.textPrimary)
      }

      Spacer(minLength: 0)

      if isLoading {
        ProgressView()
          .controlSize(.small)
      }
    }
    .padding(.vertical, 4)
  }

  private var ctoCardRow: some View {
    Button {
      path.append(CtoSessionRoute.cto)
    } label: {
      HStack(alignment: .center, spacing: 14) {
        Image(systemName: "brain.head.profile")
          .font(.system(size: 22, weight: .semibold))
          .symbolRenderingMode(.hierarchical)
          .foregroundStyle(ADEColor.ctoAccent)
          .frame(width: 46, height: 46)
          .background(ADEColor.ctoAccent.opacity(0.16), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
              .stroke(ADEColor.ctoAccent.opacity(0.3), lineWidth: 0.7)
          )

        VStack(alignment: .leading, spacing: 4) {
          Text(roster?.cto?.title ?? "CTO")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text("Always-on technical lead")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }

        Spacer(minLength: 0)

        VStack(alignment: .trailing, spacing: 6) {
          ADEStatusPill(text: "Persistent", tint: ADEColor.success)
          Image(systemName: "chevron.right")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .adeListCard()
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("CTO chat. Always-on technical lead. Persistent.")
    .accessibilityHint("Opens the persistent CTO chat.")
  }

  private var workersSectionHeader: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text("Workers")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
        .textCase(.uppercase)
        .tracking(0.4)
      Spacer(minLength: 0)
      if !workers.isEmpty {
        Text("\(workers.count)")
          .font(.caption.monospacedDigit().weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
  }

  private var emptyWorkersCard: some View {
    ADEEmptyStateView(
      symbol: "person.crop.circle.badge.questionmark",
      title: "No workers hired yet",
      message: "Hire a worker from the desktop CTO tab to see them here."
    )
  }

  @MainActor
  private func loadRoster() async {
    if isLoading { return }
    isLoading = true
    defer { isLoading = false }
    do {
      let fetched = try await syncService.fetchCtoRoster()
      roster = fetched
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

enum CtoSessionRoute: Hashable {
  case cto
  case worker(agentId: String, displayName: String)
}

struct CtoWorkerRow: View {
  let entry: CtoWorkerEntry
  let onOpen: () -> Void

  var body: some View {
    Button(action: onOpen) {
      HStack(alignment: .center, spacing: 12) {
        CtoWorkerAvatar(name: entry.name, seed: entry.avatarSeed)

        VStack(alignment: .leading, spacing: 3) {
          Text(entry.name)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if let preview = entry.sessionSummary?.lastOutputPreview, !preview.isEmpty {
            Text(preview)
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(2)
          } else {
            Text(entry.agentId)
              .font(.caption.monospaced())
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
        }

        Spacer(minLength: 8)

        ADEStatusPill(text: entry.status, tint: statusTint(entry.status))

        Image(systemName: "chevron.right")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
      }
      .adeListCard()
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(entry.name), status \(entry.status)")
    .accessibilityHint("Opens this worker's chat.")
  }
}

private struct CtoWorkerAvatar: View {
  let name: String
  let seed: String?

  private var initial: String {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let scalar = trimmed.first else { return "?" }
    return String(scalar).uppercased()
  }

  private var tint: Color {
    let basis = (seed?.isEmpty == false ? seed! : name)
    let trimmed = basis.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return ADEColor.textMuted }
    return ctoAvatarPalette[ctoAvatarPaletteIndex(for: trimmed, paletteSize: ctoAvatarPalette.count)]
  }

  var body: some View {
    ZStack {
      Circle()
        .fill(tint.opacity(0.18))
      Circle()
        .stroke(tint.opacity(0.35), lineWidth: 0.8)
      Text(initial)
        .font(.subheadline.weight(.bold))
        .foregroundStyle(tint)
    }
    .frame(width: 40, height: 40)
    .accessibilityHidden(true)
  }
}

private let ctoAvatarPalette: [Color] = [
  ADEColor.ctoAccent,
  ADEColor.tintMissions,
  ADEColor.tintLanes,
  ADEColor.tintWork,
  ADEColor.tintHistory,
  ADEColor.tintAutomations,
  ADEColor.tintGraph,
]

/// Deterministic palette index for a worker's seed/name. Uses FNV-1a over the
/// basis' unicode scalars so the same input always maps to the same color —
/// `String.hashValue` is randomized per-process and would drift between launches.
func ctoAvatarPaletteIndex(for basis: String, paletteSize: Int) -> Int {
  guard paletteSize > 0 else { return 0 }
  var hash: UInt32 = 2166136261
  for scalar in basis.unicodeScalars {
    hash ^= scalar.value
    hash = hash &* 16777619
  }
  return Int(hash % UInt32(paletteSize))
}

private func statusTint(_ status: String) -> Color {
  switch status.lowercased() {
  case "idle", "running", "active", "ready":
    return ADEColor.success
  case "paused", "waiting", "awaiting-input", "queued":
    return ADEColor.warning
  case "failed", "error":
    return ADEColor.danger
  default:
    return ADEColor.textMuted
  }
}
