import SwiftUI

struct FilesWorkspaceHeader: View {
  let workspaces: [FilesWorkspace]
  @Binding var selectedWorkspaceId: String
  let selectedWorkspace: FilesWorkspace
  @Binding var showHidden: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Workspace")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text("Switch between cached lane roots without leaving the Files tab.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
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
        .foregroundStyle(ADEColor.textSecondary)
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
            Label(showHidden ? "Hide dotfiles" : "Show dotfiles", systemImage: showHidden ? "eye.slash" : "eye")
              .font(.caption.weight(.semibold))
          }
          .buttonStyle(.glass)
          .accessibilityLabel(showHidden ? "Hide hidden files" : "Show hidden files")
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
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
      Text(title)
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
      Text(scopeText)
        .font(.caption.monospaced())
        .foregroundStyle(ADEColor.textSecondary)
        .lineLimit(1)
      TextField(prompt, text: $query)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .disabled(disabled)
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
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-title-\(path)" : nil, in: transitionNamespace)
        Text(path)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
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
        Spacer()
        ADEStatusPill(text: "L\(result.line)", tint: ADEColor.accent)
      }
      Text(result.path)
        .font(.caption.monospaced())
        .foregroundStyle(ADEColor.textSecondary)
      Text(result.preview)
        .font(.caption)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
    }
    .adeListCard(cornerRadius: 16)
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "files-container-\(result.path)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(lastPathComponent(result.path)), line \(result.line)")
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

        ForEach(Array(filesBreadcrumbItems(relativePath: relativePath, includeCurrentFile: includeCurrentFile).enumerated()), id: \.offset) { _, breadcrumb in
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
