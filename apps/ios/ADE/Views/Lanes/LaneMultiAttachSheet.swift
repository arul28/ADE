import SwiftUI

struct LaneMultiAttachSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let onComplete: @MainActor (String) async -> Void
  var wrapsInNavigationStack: Bool = true

  @State private var loading = true
  @State private var fetchError: String?
  @State private var worktrees: [UnregisteredLaneCandidate] = []
  @State private var selected: Set<String> = []
  @State private var moveToAde = false
  @State private var attaching = false
  @State private var progressCurrent = 0
  @State private var progressTotal = 0
  @State private var attachErrors: [String] = []
  @State private var lastAttachedLaneId: String?

  var body: some View {
    Group {
      if wrapsInNavigationStack {
        NavigationStack { content }
      } else {
        content
      }
    }
  }

  @ViewBuilder
  private var content: some View {
    ScrollView {
      VStack(spacing: 18) {
        if loading {
          VStack(spacing: 12) {
            ProgressView()
            Text("Discovering worktrees…")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }
          .frame(maxWidth: .infinity)
          .padding(.vertical, 48)
        } else if let fetchError {
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
              .foregroundStyle(ADEColor.danger)
            Text(fetchError)
              .font(.caption)
              .foregroundStyle(ADEColor.danger)
            Spacer(minLength: 0)
          }
          .adeGlassCard(cornerRadius: 12, padding: 12)
        } else if worktrees.isEmpty {
          ADEEmptyStateView(
            symbol: "tray",
            title: "No unregistered worktrees",
            message: "All worktrees in this repository are already attached."
          )
        } else {
          headerCard
          selectAllRow
          worktreesList
          adoptToggleCard

          if attaching {
            HStack(spacing: 8) {
              ProgressView()
                .controlSize(.small)
              Text("Attaching \(progressCurrent) of \(progressTotal)\(moveToAde ? " (+ moving)" : "")…")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }

          if !attachErrors.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
              Text("Errors")
                .font(.caption.weight(.semibold))
                .foregroundStyle(ADEColor.danger)
              ForEach(Array(attachErrors.enumerated()), id: \.offset) { _, err in
                HStack(alignment: .top, spacing: 8) {
                  Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(ADEColor.danger)
                    .font(.caption)
                  Text(err)
                    .font(.caption)
                    .foregroundStyle(ADEColor.danger)
                  Spacer(minLength: 0)
                }
              }
            }
            .adeGlassCard(cornerRadius: 12, padding: 12)
          }

          Button {
            Task { await attachSelected() }
          } label: {
            HStack(spacing: 6) {
              Image(systemName: "link.badge.plus")
              Text(attaching
                ? "Attaching \(progressCurrent)/\(progressTotal)…"
                : "Attach selected (\(selected.count))")
                .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
          }
          .buttonStyle(.glassProminent)
          .controlSize(.large)
          .disabled(selected.isEmpty || attaching)
        }
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle("Attach worktrees")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .cancellationAction) {
        Button("Done") { dismiss() }
          .disabled(attaching)
      }
    }
    .task { await loadWorktrees() }
  }

  private var headerCard: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: "square.stack.3d.down.right")
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(ADEColor.tintLanes)
        .frame(width: 36, height: 36)
      VStack(alignment: .leading, spacing: 4) {
        Text("Bulk attach existing worktrees")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("Discovers git worktrees in this repository that aren't yet tracked as ADE lanes, so you can attach several at once.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .adeGlassCard(cornerRadius: 14, padding: 14)
  }

  private var selectAllRow: some View {
    HStack(spacing: 12) {
      Button {
        toggleSelectAll()
      } label: {
        HStack(spacing: 10) {
          Image(systemName: allSelected ? "checkmark.square.fill" : (selected.isEmpty ? "square" : "minus.square.fill"))
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(allSelected || !selected.isEmpty ? ADEColor.accent : ADEColor.textMuted)
          Text(allSelected ? "Deselect all" : "Select all")
            .font(.subheadline.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
          Spacer(minLength: 0)
          Text("\(worktrees.count) found")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .buttonStyle(.plain)
      .disabled(attaching)
    }
    .adeGlassCard(cornerRadius: 12, padding: 12)
  }

  private var worktreesList: some View {
    VStack(spacing: 8) {
      ForEach(worktrees) { wt in
        Button {
          toggleOne(wt.path)
        } label: {
          HStack(alignment: .top, spacing: 12) {
            Image(systemName: selected.contains(wt.path) ? "checkmark.circle.fill" : "circle")
              .font(.system(size: 20, weight: .semibold))
              .foregroundStyle(selected.contains(wt.path) ? ADEColor.accent : ADEColor.textMuted)
            VStack(alignment: .leading, spacing: 4) {
              Text(wt.branch.isEmpty ? "(detached HEAD)" : wt.branch)
                .font(.headline)
                .foregroundStyle(ADEColor.textPrimary)
              Text(wt.path)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
            }
            Spacer(minLength: 0)
          }
        }
        .buttonStyle(.plain)
        .disabled(attaching)
        .adeGlassCard(cornerRadius: 12, padding: 12)
      }
    }
  }

  private var adoptToggleCard: some View {
    Toggle(isOn: $moveToAde) {
      VStack(alignment: .leading, spacing: 4) {
        Text("Move into .ade/worktrees on attach")
          .font(.subheadline.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
        Text("Physically relocates each worktree into the project's .ade/worktrees folder for full ADE lifecycle management.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .tint(ADEColor.accent)
    .disabled(attaching)
    .adeGlassCard(cornerRadius: 12, padding: 12)
  }

  private var allSelected: Bool {
    !worktrees.isEmpty && selected.count == worktrees.count
  }

  private func toggleSelectAll() {
    if allSelected {
      selected.removeAll()
    } else {
      selected = Set(worktrees.map(\.path))
    }
  }

  private func toggleOne(_ path: String) {
    if selected.contains(path) {
      selected.remove(path)
    } else {
      selected.insert(path)
    }
  }

  @MainActor
  private func loadWorktrees() async {
    loading = true
    fetchError = nil
    do {
      let result = try await syncService.listUnregisteredWorktrees()
      worktrees = result
      selected.removeAll()
    } catch {
      fetchError = error.localizedDescription
    }
    loading = false
  }

  @MainActor
  private func attachSelected() async {
    let toAttach = worktrees.filter { selected.contains($0.path) }
    guard !toAttach.isEmpty else { return }

    attaching = true
    attachErrors = []
    progressTotal = toAttach.count
    progressCurrent = 0

    var collectedErrors: [String] = []
    var failedPaths: Set<String> = []

    for (index, wt) in toAttach.enumerated() {
      progressCurrent = index + 1
      let fallbackName = wt.path.split(separator: "/").last.map(String.init) ?? "worktree"
      let name = wt.branch.isEmpty ? fallbackName : wt.branch
      do {
        let lane = try await syncService.attachLane(name: name, attachedPath: wt.path, description: "")
        if moveToAde {
          do {
            _ = try await syncService.adoptAttachedLane(lane.id)
          } catch {
            collectedErrors.append("\(name): adopt failed — \(error.localizedDescription)")
            failedPaths.insert(wt.path)
            continue
          }
        }
        lastAttachedLaneId = lane.id
      } catch {
        collectedErrors.append("\(name): \(error.localizedDescription)")
        failedPaths.insert(wt.path)
      }
    }

    attachErrors = collectedErrors
    attaching = false

    if let lastAttachedLaneId {
      await onComplete(lastAttachedLaneId)
    }

    if collectedErrors.isEmpty {
      ADEHaptics.success()
      dismiss()
    } else {
      ADEHaptics.error()
      do {
        let refreshed = try await syncService.listUnregisteredWorktrees()
        worktrees = refreshed
        selected = Set(refreshed.filter { failedPaths.contains($0.path) }.map(\.path))
      } catch {
      }
    }
  }
}
