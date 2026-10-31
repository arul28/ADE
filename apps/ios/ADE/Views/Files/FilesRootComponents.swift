import SwiftUI

/// The tree's header row: the workspace (lane) picker as one compact control,
/// then search where the screen has no other search button, and ⋯ (Activity,
/// Settings) — Lanes' and Work's header grammar.
struct FilesTreeHeaderRow: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  let workspaces: [FilesWorkspace]
  let lanes: [LaneSummary]
  @Binding var selectedWorkspaceId: String
  let isLive: Bool
  /// False where the edge bar or the viewer's bar already carries search.
  var showsSearch: Bool
  let onSearch: () -> Void

  var body: some View {
    HStack(spacing: 8) {
      FilesWorkspacePickerDropdown(
        workspaces: workspaces,
        lanes: lanes,
        selectedWorkspaceId: $selectedWorkspaceId,
        isLive: isLive
      )
      if showsSearch {
        Button(action: onSearch) {
          Image(systemName: "magnifyingglass")
            .font(.system(size: 18, weight: .medium))
            .foregroundStyle(isLive ? ADEColor.textPrimary : ADEColor.textMuted)
            .frame(width: 32, height: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isLive)
        .accessibilityLabel("Search files")
      }
      WorkHeaderOverflowMenu(
        showsLinear: false,
        showsCursorCloud: false,
        actions: WorkRootHeaderActions(
          onOpenActivity: { syncService.attentionDrawerPresented = true },
          onOpenSettings: { syncService.settingsPresented = true }
        )
      )
    }
    .padding(.horizontal, 16)
    .padding(.bottom, 6)
    // Solid, up under the bar: rows scrolling beneath must not show through.
    .background(ADEColor.pageBackground.ignoresSafeArea(edges: .top))
  }
}

/// The lane's proof (screenshots, recordings) under the tree, as a list
/// section. Nothing at all when the lane has none.
struct FilesProofListSection: View {
  let artifacts: [ComputerUseArtifactSummary]
  let errorMessage: String?
  let onRefresh: () -> Void
  let onOpenArtifact: (ComputerUseArtifactSummary) -> Void
  let onCopyReference: (ComputerUseArtifactSummary) -> Void

  var body: some View {
    if !artifacts.isEmpty || errorMessage != nil {
      Section {
        if let errorMessage {
          FilesTreeMessageRow(
            symbol: "exclamationmark.triangle",
            text: errorMessage,
            actionTitle: "Retry",
            action: onRefresh
          )
          .adeFlatRow(insets: FilesOutlineTree<EmptyView, EmptyView>.rowInsets, separator: .hidden)
        }
        ForEach(artifacts) { artifact in
          FilesProofArtifactRow(
            artifact: artifact,
            onOpen: { onOpenArtifact(artifact) },
            onCopyReference: { onCopyReference(artifact) }
          )
          .adeFlatRow(insets: EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 8), separator: .hidden)
        }
      } header: {
        Text("PROOF")
          .font(.caption2.weight(.semibold))
          .tracking(0.6)
          .foregroundStyle(ADEColor.textMuted)
          .padding(.leading, 2)
          .padding(.top, 14)
      }
    }
  }
}

struct FilesProofArtifactRow: View {
  let artifact: ComputerUseArtifactSummary
  let onOpen: () -> Void
  let onCopyReference: () -> Void

  private var icon: String {
    artifact.artifactKind == "video_recording" ? "video" : "photo"
  }

  var body: some View {
    Button(action: onOpen) {
      HStack(spacing: 8) {
        Image(systemName: icon)
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 20)
        Text(artifact.title)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
        Text(artifact.artifactKind == "video_recording" ? "Recording" : "Screenshot")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }
      .padding(.horizontal, 10)
      .frame(minHeight: 36)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .contextMenu {
      Button("Copy Reference", systemImage: "doc.on.doc", action: onCopyReference)
    }
    .accessibilityLabel("Open proof \(artifact.title)")
    .accessibilityAction(named: Text("Copy reference"), onCopyReference)
  }
}

struct FilesResultRow: View {
  let workspaceId: String
  let path: String
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: filesGlyph(for: lastPathComponent(path)))
        .font(.system(size: 14))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 20)
        .adeMatchedGeometry(id: isSelectedTransitionSource ? filesTransitionId(kind: "icon", workspaceId: workspaceId, path: path) : nil, in: transitionNamespace)
      VStack(alignment: .leading, spacing: 3) {
        Text(lastPathComponent(path))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.tail)
          .adeMatchedGeometry(id: isSelectedTransitionSource ? filesTransitionId(kind: "title", workspaceId: workspaceId, path: path) : nil, in: transitionNamespace)
        Text(path)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      Spacer(minLength: 0)
    }
    // A flat row, the tree's: no card per result.
    .padding(.horizontal, 12)
    .frame(minHeight: 48)
    .contentShape(Rectangle())
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? filesTransitionId(kind: "container", workspaceId: workspaceId, path: path) : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(lastPathComponent(path)), file")
    .adeInspectable(
      "Files.QuickOpen.ResultRow",
      metadata: [
        "label": "\(lastPathComponent(path)), file",
        "path": path,
        "type": "file",
        "role": "row"
      ]
    )
  }
}
