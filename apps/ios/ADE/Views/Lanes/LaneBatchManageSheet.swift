import SwiftUI

// MARK: - Batch manage sheet

struct LaneBatchManageSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let snapshots: [LaneListSnapshot]
  let onComplete: @MainActor () async -> Void

  @State private var deleteMode: LaneDeleteMode = .worktree
  @State private var deleteRemoteName = "origin"
  @State private var deleteForce = false
  @State private var confirmText = ""
  @State private var errorMessage: String?
  @State private var busy = false

  private var laneIds: [String] {
    snapshots.map(\.lane.id)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 14) {
          GlassSection(title: "Selected lanes (\(laneIds.count))") {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(snapshots) { snapshot in
                HStack(alignment: .center, spacing: 10) {
                  LaneStatusIndicator(bucket: snapshot.runtime.bucket, size: 8)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(snapshot.lane.name)
                      .font(.subheadline.weight(.semibold))
                      .foregroundStyle(ADEColor.textPrimary)
                    Text(snapshot.lane.branchRef)
                      .font(.system(.caption, design: .monospaced))
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                  Spacer()
                  if snapshot.lane.status.dirty {
                    LaneTypeBadge(text: "Dirty", tint: ADEColor.warning)
                  }
                }
              }
            }
          }

          GlassSection(title: "Archive") {
            Button {
              Task { await archiveSelected() }
            } label: {
              HStack {
                Image(systemName: "archivebox.fill")
                Text("Archive selected lanes")
                  .font(.subheadline.weight(.semibold))
                Spacer()
              }
              .foregroundStyle(ADEColor.warning)
              .padding(12)
              .background(ADEColor.warning.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(busy || laneIds.isEmpty)
          }

          GlassSection(title: "Delete") {
            VStack(alignment: .leading, spacing: 12) {
              Picker("Delete mode", selection: $deleteMode) {
                ForEach(LaneDeleteMode.allCases) { mode in
                  Text(mode.title).tag(mode)
                }
              }
              .pickerStyle(.menu)

              if deleteMode == .remoteBranch {
                LaneTextField("Remote name", text: $deleteRemoteName)
                  .textInputAutocapitalization(.never)
                  .autocorrectionDisabled()
              }

              Toggle("Force delete", isOn: $deleteForce)
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)

              LaneTextField("Type delete open lanes to confirm", text: $confirmText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()

              Button(role: .destructive) {
                Task { await deleteSelected() }
              } label: {
                HStack {
                  Image(systemName: "trash.fill")
                  Text("Delete selected lanes")
                    .font(.subheadline.weight(.semibold))
                  Spacer()
                }
                .padding(12)
                .background(ADEColor.danger.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
              }
              .buttonStyle(.plain)
              .disabled(confirmText.lowercased() != "delete open lanes" || busy || laneIds.isEmpty)
            }
          }

          if let errorMessage {
            HStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(ADEColor.danger)
              Text(errorMessage)
                .font(.caption)
                .foregroundStyle(ADEColor.danger)
              Spacer()
            }
            .padding(12)
            .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }
        }
        .padding(16)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Manage lanes")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
            .disabled(busy)
        }
      }
    }
  }

  @MainActor
  private func archiveSelected() async {
    do {
      busy = true
      for laneId in laneIds {
        try await syncService.archiveLane(laneId)
      }
      await onComplete()
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }

  @MainActor
  private func deleteSelected() async {
    do {
      busy = true
      for laneId in laneIds {
        try await syncService.deleteLane(
          laneId,
          deleteBranch: deleteMode != .worktree,
          deleteRemoteBranch: deleteMode == .remoteBranch,
          remoteName: deleteRemoteName,
          force: deleteForce
        )
      }
      await onComplete()
      dismiss()
    } catch {
      errorMessage = error.localizedDescription
    }
    busy = false
  }
}
