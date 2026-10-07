import SwiftUI

struct FilesWorkspaceHeader: View {
  let workspaces: [FilesWorkspace]
  let lanes: [LaneSummary]
  @Binding var selectedWorkspaceId: String
  let selectedWorkspace: FilesWorkspace
  let isLive: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      FilesWorkspacePickerDropdown(
        workspaces: workspaces,
        lanes: lanes,
        selectedWorkspaceId: $selectedWorkspaceId
      )

      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(selectedWorkspace.rootPath)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)

        HStack(spacing: 5) {
          ADEKitDot(tone: isLive ? .ok : .neutral)
          Text(isLive ? "Live" : "Cached")
            .font(.system(size: 11.5))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Workspace path \(selectedWorkspace.rootPath), \(isLive ? "live" : "cached")")
    }
  }
}

struct FilesProofSection: View {
  let artifacts: [ComputerUseArtifactSummary]
  let errorMessage: String?
  let onRefresh: () -> Void
  let onOpenArtifact: (ComputerUseArtifactSummary) -> Void
  let onCopyReference: (ComputerUseArtifactSummary) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 10) {
        Image(systemName: "photo.on.rectangle")
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(ADEColor.textMuted)
        Text("Proof")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if !artifacts.isEmpty {
          Text("\(artifacts.count)")
            .font(.adeMono(11))
            .foregroundStyle(ADEColor.textMuted)
        }
        Spacer(minLength: 8)
        Button(action: onRefresh) {
          Image(systemName: "arrow.clockwise")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 30, height: 30)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Refresh proof artifacts")
      }

      if let errorMessage {
        FilesCompactBanner(
          symbol: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          title: errorMessage,
          actionTitle: "Retry",
          onAction: onRefresh
        )
      } else if artifacts.isEmpty {
        Text("No screenshots or recordings for this lane yet.")
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
      } else {
        VStack(spacing: 10) {
          ForEach(artifacts) { artifact in
            FilesProofArtifactRow(
              artifact: artifact,
              onOpen: { onOpenArtifact(artifact) },
              onCopyReference: { onCopyReference(artifact) }
            )
          }
        }
      }
    }
    .adeKitCard()
  }
}

struct FilesProofArtifactRow: View {
  let artifact: ComputerUseArtifactSummary
  let onOpen: () -> Void
  let onCopyReference: () -> Void

  private var icon: String {
    artifact.artifactKind == "video_recording" ? "video.fill" : "photo.fill"
  }

  var body: some View {
    HStack(spacing: 10) {
      Button(action: onOpen) {
        HStack(spacing: 10) {
          Image(systemName: icon)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 30, height: 30)
            .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
          VStack(alignment: .leading, spacing: 2) {
            Text(artifact.title)
              .font(.system(size: 14, weight: .medium))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            Text(artifact.artifactKind.replacingOccurrences(of: "_", with: " ").capitalized)
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textMuted)
          }
          Spacer(minLength: 4)
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Open proof \(artifact.title)")

      Button(action: onCopyReference) {
        Image(systemName: "doc.on.doc")
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 36, height: 36)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Copy reference for \(artifact.title)")
    }
  }
}

struct FilesTreeNodeRow: View {
  let workspaceId: String
  let node: FileTreeNode
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool
  let onOpen: () -> Void
  let onCopyPath: () -> Void
  let onCopyRelativePath: () -> Void

  var body: some View {
    Button(action: onOpen) {
      HStack(spacing: 10) {
        Image(systemName: node.type == "directory" ? "folder.fill" : fileIcon(for: node.name))
          .font(.system(size: 14, weight: .regular))
          .foregroundStyle(node.type == "directory" ? ADEColor.textSecondary : fileTint(for: node.name))
          .frame(width: 20)
          .adeMatchedGeometry(id: canTransition ? filesTransitionId(kind: "icon", workspaceId: workspaceId, path: node.path) : nil, in: transitionNamespace)

        Text(node.name)
          .font(.system(size: 15))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .adeMatchedGeometry(id: canTransition ? filesTransitionId(kind: "title", workspaceId: workspaceId, path: node.path) : nil, in: transitionNamespace)

        if let changeStatus = node.changeStatus {
          ADEStatusPill(text: changeStatus.uppercased(), tint: changeStatusTint(changeStatus))
            .fixedSize(horizontal: true, vertical: false)
        }

        Spacer(minLength: 4)

        if let size = node.size, node.type == "file" {
          Text(formattedFileSize(size))
            .font(.caption2.monospaced())
            .foregroundStyle(ADEColor.textMuted)
            .fixedSize(horizontal: true, vertical: false)
        }

        if node.type == "directory" {
          ADESettingsChevron()
        }
      }
      .padding(.horizontal, ADEKit.inset)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(ADEKitRowButtonStyle())
    .contextMenu {
      Button("Copy Full Path", action: onCopyPath)
      Button("Copy Relative Path", action: onCopyRelativePath)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityHint(node.type == "directory" ? "Opens folder" : "Opens file")
    .adeInspectable(
      "Files.Directory.NodeRow",
      metadata: [
        "label": accessibilityLabel,
        "path": node.path,
        "type": node.type,
        "role": "row"
      ]
    )
    .adeMatchedTransitionSource(id: canTransition ? filesTransitionId(kind: "container", workspaceId: workspaceId, path: node.path) : nil, in: transitionNamespace)
  }

  private var canTransition: Bool {
    node.type == "file" && isSelectedTransitionSource
  }

  private var accessibilityLabel: String {
    if let changeStatus = node.changeStatus {
      return "\(node.name), \(node.type), \(changeStatusDescription(changeStatus))"
    }
    return "\(node.name), \(node.type)"
  }
}

struct FilesResultRow: View {
  let workspaceId: String
  let path: String
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: fileIcon(for: path))
        .foregroundStyle(fileTint(for: path))
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
      Spacer()
      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .adeListCard(cornerRadius: 16)
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

struct FilesBreadcrumbBar: View {
  let relativePath: String
  let includeCurrentFile: Bool
  let onSelectDirectory: (String) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 6) {
        Button("root") {
          onSelectDirectory("")
        }
        .font(.caption2.weight(.semibold))
        .buttonStyle(.plain)
        .foregroundStyle(ADEColor.textMuted)

        ForEach(filesBreadcrumbItems(relativePath: relativePath, includeCurrentFile: includeCurrentFile), id: \.path) { breadcrumb in
          Image(systemName: "chevron.right")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(ADEColor.textMuted.opacity(0.55))

          if breadcrumb.isDirectory {
            Button(breadcrumb.label) {
              onSelectDirectory(breadcrumb.path)
            }
            .font(.caption2.weight(.semibold))
            .buttonStyle(.plain)
            .foregroundStyle(ADEColor.textSecondary)
          } else {
            Text(breadcrumb.label)
              .font(.caption2.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
          }
        }
      }
      .padding(.vertical, 2)
    }
  }
}
