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

        Text(isLive ? "Live" : "Cached")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(isLive ? ADEColor.success : ADEColor.textMuted)
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
        VStack(alignment: .leading, spacing: 3) {
          Text("Proof")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("Recent screenshot and video artifacts linked to this lane.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        Button(action: onRefresh) {
          Image(systemName: "arrow.clockwise")
            .font(.system(size: 14, weight: .semibold))
        }
        .buttonStyle(.glass)
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
        Text("No proof artifacts are cached for this lane yet.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(12)
          .adeInsetField(cornerRadius: 12, padding: 0)
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
    .adeGlassCard(cornerRadius: 18)
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
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: icon)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
        .frame(width: 32, height: 32)
        .background(ADEColor.accent.opacity(0.14), in: Circle())
        .glassEffect()

      VStack(alignment: .leading, spacing: 4) {
        Text(artifact.title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
        Text(artifact.artifactKind.replacingOccurrences(of: "_", with: " ").capitalized)
          .font(.caption2.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
        if let description = artifact.description, !description.isEmpty {
          Text(description)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(2)
        }
      }

      Spacer(minLength: 8)

      HStack(spacing: 6) {
        Button(action: onOpen) {
          Image(systemName: "eye")
            .font(.system(size: 15, weight: .semibold))
            .frame(width: 32, height: 32)
        }
        .buttonStyle(.glass)
        .accessibilityLabel("Open proof \(artifact.title)")

        Button(action: onCopyReference) {
          Image(systemName: "doc.on.doc")
            .font(.system(size: 15, weight: .semibold))
            .frame(width: 32, height: 32)
        }
        .buttonStyle(.glass)
        .accessibilityLabel("Copy reference for \(artifact.title)")
      }
    }
    .padding(12)
    .adeInsetField(cornerRadius: 14, padding: 0)
  }
}

struct FilesTreeNodeRow: View {
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
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(node.type == "directory" ? ADEColor.accent : fileTint(for: node.name))
          .frame(width: 18)
          .adeMatchedGeometry(id: canTransition ? "files-icon-\(node.path)" : nil, in: transitionNamespace)

        Text(node.name)
          .font(.subheadline.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .adeMatchedGeometry(id: canTransition ? "files-title-\(node.path)" : nil, in: transitionNamespace)

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
          Image(systemName: "chevron.right")
            .font(.caption2.weight(.bold))
            .foregroundStyle(ADEColor.textMuted.opacity(0.7))
        }
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 9)
      .background(ADEColor.surfaceBackground.opacity(0.35), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .contextMenu {
      Button("Copy Path", action: onCopyPath)
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
    .adeMatchedTransitionSource(id: canTransition ? "files-container-\(node.path)" : nil, in: transitionNamespace)
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
  let path: String
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: fileIcon(for: path))
        .foregroundStyle(fileTint(for: path))
        .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-icon-\(path)" : nil, in: transitionNamespace)
      VStack(alignment: .leading, spacing: 3) {
        Text(lastPathComponent(path))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.tail)
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-title-\(path)" : nil, in: transitionNamespace)
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
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "files-container-\(path)" : nil, in: transitionNamespace)
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
