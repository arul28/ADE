import SwiftUI

struct FilesWorkspaceHeader: View {
  let workspaces: [FilesWorkspace]
  @Binding var selectedWorkspaceId: String
  let selectedWorkspace: FilesWorkspace
  @Binding var showHidden: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Workspace")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
        }

        Spacer(minLength: 0)

        Picker("Workspace", selection: $selectedWorkspaceId) {
          ForEach(workspaces) { workspace in
            Text(workspace.name).tag(workspace.id)
          }
        }
        .pickerStyle(.menu)
        .labelsHidden()
      }

      Text(selectedWorkspace.rootPath)
        .font(.caption.monospaced())
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
        .truncationMode(.middle)
        .accessibilityLabel("Workspace path \(selectedWorkspace.rootPath)")
        .textSelection(.enabled)

      ScrollView(.horizontal, showsIndicators: false) {
        ADEGlassGroup(spacing: 8) {
          ADEStatusPill(text: selectedWorkspace.kind.uppercased(), tint: ADEColor.accent)
          if selectedWorkspace.laneId != nil {
            ADEStatusPill(text: "LANE ROOT", tint: ADEColor.success)
          }
          if selectedWorkspace.readOnlyOnMobile {
            ADEStatusPill(text: "READ ONLY", tint: ADEColor.warning)
          }
          Button {
            showHidden.toggle()
          } label: {
            Label(showHidden ? "Hide" : "Show", systemImage: showHidden ? "eye.slash" : "eye")
              .font(.caption.weight(.semibold))
              .lineLimit(1)
              .fixedSize(horizontal: true, vertical: false)
          }
          .buttonStyle(.glass)
          .accessibilityLabel(showHidden ? "Hide hidden files" : "Show hidden files")
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
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

      Menu {
        Button {
          onOpen()
        } label: {
          Label("Open proof", systemImage: "eye")
        }
        Button {
          onCopyReference()
        } label: {
          Label("Copy reference", systemImage: "doc.on.doc")
        }
      } label: {
        Image(systemName: "ellipsis.circle")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 32, height: 32)
      }
      .accessibilityLabel("Actions for \(artifact.title)")
    }
    .padding(12)
    .adeInsetField(cornerRadius: 14, padding: 0)
  }
}

struct FilesQueryCard: View {
  let title: String
  let prompt: String
  @Binding var query: String
  let disabled: Bool
  let emptyMessage: String
  let scopeText: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(title)
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        Spacer(minLength: 8)
        Text(disabled ? "Offline" : "Ready")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(disabled ? ADEColor.textMuted : ADEColor.success)
      }

      Label {
        Text(scopeText)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(2)
          .truncationMode(.middle)
      } icon: {
        Image(systemName: "folder")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
      }

      HStack(spacing: 8) {
        Image(systemName: "magnifyingglass")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
        TextField(prompt, text: $query)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .submitLabel(.search)
          .disabled(disabled)
        if !query.isEmpty {
          Button {
            query = ""
          } label: {
            Image(systemName: "xmark.circle.fill")
              .foregroundStyle(ADEColor.textMuted)
          }
          .accessibilityLabel("Clear \(title.lowercased())")
        }
      }
      .adeInsetField()
      Text(emptyMessage)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

struct FilesTreeNodeRow: View {
  let node: FileTreeNode
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: node.type == "directory" ? "folder.fill" : fileIcon(for: node.name))
        .font(.headline)
        .foregroundStyle(node.type == "directory" ? ADEColor.accent : fileTint(for: node.name))
        .frame(width: 22)
        .adeMatchedGeometry(id: canTransition ? "files-icon-\(node.path)" : nil, in: transitionNamespace)

      VStack(alignment: .leading, spacing: 4) {
        Text(node.name)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .adeMatchedGeometry(id: canTransition ? "files-title-\(node.path)" : nil, in: transitionNamespace)
        Text(node.path.isEmpty ? (node.type == "directory" ? "Folder" : "File") : node.path)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      if let size = node.size, node.type == "file" {
        Text(formattedFileSize(size))
          .font(.caption2.monospaced())
          .foregroundStyle(ADEColor.textMuted)
      }

      if let changeStatus = node.changeStatus {
        ADEStatusPill(text: changeStatus.uppercased(), tint: changeStatusTint(changeStatus))
      }

      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .adeListCard(cornerRadius: 16)
    .adeMatchedTransitionSource(id: canTransition ? "files-container-\(node.path)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
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
  }
}

struct FilesSearchResultRow: View {
  let result: FilesSearchTextMatch
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Image(systemName: fileIcon(for: result.path))
          .foregroundStyle(fileTint(for: result.path))
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-icon-\(result.path)" : nil, in: transitionNamespace)
        Text(lastPathComponent(result.path))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-title-\(result.path)" : nil, in: transitionNamespace)
          .lineLimit(1)
          .truncationMode(.tail)
        Spacer()
        ADEStatusPill(text: "L\(result.line)", tint: ADEColor.accent)
      }
      Text(result.path)
        .font(.caption.monospaced())
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
        .truncationMode(.middle)
      Text(result.preview)
        .font(.caption)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
    }
    .adeListCard(cornerRadius: 16)
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "files-container-\(result.path)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(lastPathComponent(result.path)), line \(result.line), \(result.path)")
  }
}

struct FilesBreadcrumbBar: View {
  let relativePath: String
  let includeCurrentFile: Bool
  let onSelectDirectory: (String) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        Button("root") {
          onSelectDirectory("")
        }
        .buttonStyle(.glass)

        ForEach(filesBreadcrumbItems(relativePath: relativePath, includeCurrentFile: includeCurrentFile), id: \.path) { breadcrumb in
          Image(systemName: "chevron.right")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)

          if breadcrumb.isDirectory {
            Button(breadcrumb.label) {
              onSelectDirectory(breadcrumb.path)
            }
            .buttonStyle(.glass)
          } else {
            Text(breadcrumb.label)
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .padding(.horizontal, 10)
              .padding(.vertical, 7)
              .background(ADEColor.surfaceBackground, in: Capsule())
              .glassEffect()
          }
        }
      }
      .padding(4)
    }
    .adeGlassCard(cornerRadius: 18, padding: 12)
  }
}
