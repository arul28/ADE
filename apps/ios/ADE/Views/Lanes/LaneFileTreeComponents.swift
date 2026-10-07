import SwiftUI

// MARK: - Bulk action model

struct LaneFileTreeBulkAction: Identifiable {
  let id = UUID()
  let title: String
  let symbol: String
  let tint: Color
  let isDestructive: Bool
  let action: () -> Void
}

// MARK: - File tree section

struct LaneFileTreeSection: View {
  let title: String
  let subtitle: String?
  let changes: [FileChange]
  let allowsLiveActions: Bool
  let allowsDiffInspection: Bool
  let bulkActionTitle: String?
  let bulkActionSymbol: String
  let bulkActionTint: Color
  let primaryActionTitle: String
  let primaryActionSymbol: String
  let primaryActionTint: Color
  let secondaryActionTitle: String
  let secondaryActionSymbol: String
  let secondaryActionTint: Color
  var extraBulkActions: [LaneFileTreeBulkAction] = []
  let onBulkAction: (() -> Void)?
  let onDiff: (FileChange) -> Void
  let onPrimaryAction: (FileChange) -> Void
  let onSecondaryAction: (FileChange) -> Void
  let onOpenFiles: ((FileChange) -> Void)?

  @State private var collapsedPaths: Set<String>?

  var body: some View {
    // A sub-section of the Files card: title, count, bulk actions, then the tree.
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        Text(title)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        if let subtitle {
          Text(subtitle)
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textMuted)
        }
        Spacer(minLength: 0)
      }
      LazyVStack(alignment: .leading, spacing: 10) {
        HStack(spacing: 8) {
          if let bulkActionTitle, let onBulkAction, changes.count > 1 {
            ADEKitActionButton(title: bulkActionTitle, symbol: bulkActionSymbol, tint: bulkActionTint) {
              onBulkAction()
            }
            .disabled(!allowsLiveActions)
          }
          ForEach(extraBulkActions) { extra in
            if extra.isDestructive {
              ADEKitHoldButton(title: extra.title, symbol: extra.symbol, tint: extra.tint) {
                extra.action()
              }
              .disabled(!allowsLiveActions)
            } else {
              ADEKitActionButton(title: extra.title, symbol: extra.symbol, tint: extra.tint) {
                extra.action()
              }
              .disabled(!allowsLiveActions)
            }
          }
        }

        if changes.isEmpty {
          Text("No files.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        } else {
          let root = laneFileTreeRoot(from: changes)
          let resolvedCollapsed = Binding<Set<String>>(
            get: { collapsedPaths ?? allFolderPaths(in: root) },
            set: { collapsedPaths = $0 }
          )
          LaneFileTreeNodeView(
            node: root,
            collapsedPaths: resolvedCollapsed,
            onDiff: onDiff,
            onPrimaryAction: onPrimaryAction,
            onSecondaryAction: onSecondaryAction,
            onOpenFiles: onOpenFiles,
            allowsLiveActions: allowsLiveActions,
            allowsDiffInspection: allowsDiffInspection,
            primaryActionTitle: primaryActionTitle,
            primaryActionSymbol: primaryActionSymbol,
            primaryActionTint: primaryActionTint,
            secondaryActionTitle: secondaryActionTitle,
            secondaryActionSymbol: secondaryActionSymbol,
            secondaryActionTint: secondaryActionTint
          )
        }
      }
    }
  }
}

private func allFolderPaths(in node: LaneFileTreeNode) -> Set<String> {
  var paths = Set<String>()
  for child in node.children {
    paths.insert(child.id)
    paths.formUnion(allFolderPaths(in: child))
  }
  return paths
}

private struct LaneFileTreeNode: Identifiable {
  let path: String
  let name: String
  var files: [FileChange]
  var children: [LaneFileTreeNode]

  var id: String { path.isEmpty ? "__root__" : path }

  var totalFileCount: Int {
    files.count + children.reduce(0) { $0 + $1.totalFileCount }
  }
}

private func laneFileTreeRoot(from changes: [FileChange]) -> LaneFileTreeNode {
  let sortedChanges = changes.sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
  var root = LaneFileTreeNode(path: "", name: "Root", files: [], children: [])

  for change in sortedChanges {
    let components = change.path.split(separator: "/").map(String.init)
    guard components.count > 1 else {
      root.files.append(change)
      continue
    }
    insert(change, components: Array(components.dropLast()), into: &root)
  }

  root.children = root.children.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  return root
}

private func insert(_ change: FileChange, components: [String], into node: inout LaneFileTreeNode) {
  guard let first = components.first else {
    node.files.append(change)
    node.files.sort { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    return
  }

  if let index = node.children.firstIndex(where: { $0.name == first }) {
    var child = node.children[index]
    if components.count == 1 {
      child.files.append(change)
      child.files.sort { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
    } else {
      insert(change, components: Array(components.dropFirst()), into: &child)
    }
    child.children = child.children.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    node.children[index] = child
  } else {
    let childPath = node.path.isEmpty ? first : "\(node.path)/\(first)"
    var child = LaneFileTreeNode(path: childPath, name: first, files: [], children: [])
    if components.count == 1 {
      child.files.append(change)
    } else {
      insert(change, components: Array(components.dropFirst()), into: &child)
    }
    node.children.append(child)
    node.children = node.children.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
  }
}

private struct LaneFileTreeNodeView: View {
  let node: LaneFileTreeNode
  var isRoot: Bool = true
  @Binding var collapsedPaths: Set<String>
  let onDiff: (FileChange) -> Void
  let onPrimaryAction: (FileChange) -> Void
  let onSecondaryAction: (FileChange) -> Void
  let onOpenFiles: ((FileChange) -> Void)?
  let allowsLiveActions: Bool
  let allowsDiffInspection: Bool
  let primaryActionTitle: String
  let primaryActionSymbol: String
  let primaryActionTint: Color
  let secondaryActionTitle: String
  let secondaryActionSymbol: String
  let secondaryActionTint: Color

  var body: some View {
    let content = LazyVStack(alignment: .leading, spacing: 2) {
      if !node.files.isEmpty {
        ForEach(node.files) { file in
          let openFilesAction: (() -> Void)? = onOpenFiles.map { handler in
            { handler(file) }
          }
          LaneFileRow(
            file: file,
            onDiff: { onDiff(file) },
            onPrimaryAction: { onPrimaryAction(file) },
            onSecondaryAction: { onSecondaryAction(file) },
            onOpenFiles: openFilesAction,
            allowsLiveActions: allowsLiveActions,
            allowsDiffInspection: allowsDiffInspection,
            primaryActionTitle: primaryActionTitle,
            primaryActionSymbol: primaryActionSymbol,
            primaryActionTint: primaryActionTint,
            secondaryActionTitle: secondaryActionTitle,
            secondaryActionSymbol: secondaryActionSymbol,
            secondaryActionTint: secondaryActionTint
          )
        }
      }

      ForEach(node.children) { child in
        DisclosureGroup(isExpanded: binding(for: child.id)) {
          LaneFileTreeNodeView(
            node: child,
            isRoot: false,
            collapsedPaths: $collapsedPaths,
            onDiff: onDiff,
            onPrimaryAction: onPrimaryAction,
            onSecondaryAction: onSecondaryAction,
            onOpenFiles: onOpenFiles,
            allowsLiveActions: allowsLiveActions,
            allowsDiffInspection: allowsDiffInspection,
            primaryActionTitle: primaryActionTitle,
            primaryActionSymbol: primaryActionSymbol,
            primaryActionTint: primaryActionTint,
            secondaryActionTitle: secondaryActionTitle,
            secondaryActionSymbol: secondaryActionSymbol,
            secondaryActionTint: secondaryActionTint
          )
          .padding(.top, 2)
          .padding(.leading, 14)
        } label: {
          HStack(spacing: 8) {
            Image(systemName: "folder")
              .font(.system(size: 12, weight: .medium))
              .foregroundStyle(ADEColor.textSecondary)
            Text(child.name)
              .font(.adeMono(12.5, weight: .medium))
              .foregroundStyle(ADEColor.textPrimary)
            Text("\(child.totalFileCount)")
              .font(.adeMono(11))
              .foregroundStyle(ADEColor.textMuted)
            Spacer()
          }
          .contentShape(Rectangle())
        }
        .tint(ADEColor.textMuted)
      }
    }
    content
  }

  private func binding(for path: String) -> Binding<Bool> {
    Binding(
      get: { !collapsedPaths.contains(path) },
      set: { isExpanded in
        if isExpanded {
          collapsedPaths.remove(path)
        } else {
          collapsedPaths.insert(path)
        }
      }
    )
  }
}

private struct LaneFileRow: View {
  let file: FileChange
  let onDiff: () -> Void
  let onPrimaryAction: () -> Void
  let onSecondaryAction: () -> Void
  let onOpenFiles: (() -> Void)?
  let allowsLiveActions: Bool
  let allowsDiffInspection: Bool
  let primaryActionTitle: String
  let primaryActionSymbol: String
  let primaryActionTint: Color
  let secondaryActionTitle: String
  let secondaryActionSymbol: String
  let secondaryActionTint: Color

  /// One changed file: tap opens the diff, the trailing button runs the
  /// primary action, everything else is in a plain system menu.
  var body: some View {
    HStack(spacing: 10) {
      Button {
        onDiff()
      } label: {
        HStack(spacing: 9) {
          ADEKitDot(color: fileKindTint(file.kind))
          Text((file.path as NSString).lastPathComponent)
            .font(.adeMono(12.5))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer(minLength: 4)
        }
        .frame(minHeight: 34)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!allowsDiffInspection)
      .accessibilityLabel("\((file.path as NSString).lastPathComponent), \(file.kind)")
      .accessibilityHint("Opens the diff")

      Button {
        onPrimaryAction()
      } label: {
        Image(systemName: primaryActionSymbol)
          .font(.system(size: 15, weight: .regular))
          .foregroundStyle(primaryActionTint)
          .frame(width: 32, height: 32)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!allowsLiveActions)
      .opacity(allowsLiveActions ? 1 : 0.45)
      .accessibilityLabel(primaryActionTitle)

      Menu {
        Button { onDiff() } label: { Label("Diff", systemImage: "doc.text.magnifyingglass") }
          .disabled(!allowsDiffInspection)
        if let onOpenFiles {
          Button { onOpenFiles() } label: { Label("Open in Files", systemImage: "folder") }
        }
        Button { onPrimaryAction() } label: { Label(primaryActionTitle, systemImage: primaryActionSymbol) }
          .disabled(!allowsLiveActions)
        Button(role: .destructive) { onSecondaryAction() } label: {
          Label(secondaryActionTitle, systemImage: secondaryActionSymbol)
        }
        .disabled(!allowsLiveActions)
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 30, height: 32)
          .contentShape(Rectangle())
      }
      .accessibilityLabel("File actions")
    }
  }

  private func fileKindTint(_ kind: String) -> Color {
    switch kind.lowercased() {
    case "added", "created":
      return ADEColor.success
    case "deleted", "removed":
      return ADEColor.danger
    case "renamed", "moved":
      return ADEColor.info
    default:
      return ADEColor.warning
    }
  }
}
