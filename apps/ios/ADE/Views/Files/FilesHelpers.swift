import Foundation
import SwiftUI

private let filesRelativeIsoFormatter = ISO8601DateFormatter()
private let filesRelativeTimeFormatter = RelativeDateTimeFormatter()

func filesSortedNodes(_ nodes: [FileTreeNode]) -> [FileTreeNode] {
  nodes.sorted { lhs, rhs in
    let lhsIsDirectory = lhs.type == "directory"
    let rhsIsDirectory = rhs.type == "directory"
    if lhsIsDirectory != rhsIsDirectory {
      return lhsIsDirectory && !rhsIsDirectory
    }
    return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
  }
}

func joinedPath(base: String, name: String) -> String {
  let cleanedBase = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  let cleanedName = name.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  guard !cleanedBase.isEmpty else { return cleanedName }
  guard !cleanedName.isEmpty else { return cleanedBase }
  return "\(cleanedBase)/\(cleanedName)"
}

func parentDirectory(of path: String) -> String {
  let components = pathComponents(path)
  guard components.count > 1 else { return "" }
  return components.dropLast().joined(separator: "/")
}

func pathComponents(_ path: String) -> [String] {
  path
    .split(separator: "/")
    .map(String.init)
}

func lastPathComponent(_ path: String) -> String {
  pathComponents(path).last ?? path
}

func fileTint(for name: String) -> Color {
  let icon = fileIcon(for: name)
  switch icon {
  case "chevron.left.forwardslash.chevron.right":
    return .blue
  case "doc.badge.gearshape":
    return .orange
  case "doc.text":
    return .yellow
  case "photo":
    return .pink
  case "doc.zipper":
    return .red
  default:
    return ADEColor.textSecondary
  }
}

func changeStatusTint(_ changeStatus: String) -> Color {
  switch changeStatus.uppercased() {
  case "A":
    return ADEColor.success
  case "D":
    return ADEColor.danger
  case "M":
    return ADEColor.warning
  default:
    return ADEColor.textSecondary
  }
}

func changeStatusDescription(_ changeStatus: String) -> String {
  switch changeStatus.uppercased() {
  case "A":
    return "Added"
  case "D":
    return "Deleted"
  case "M":
    return "Modified"
  default:
    return changeStatus.uppercased()
  }
}

func relativeDateDescription(from isoTimestamp: String?) -> String? {
  guard let isoTimestamp, let date = filesRelativeIsoFormatter.date(from: isoTimestamp) else {
    return nil
  }
  return filesRelativeTimeFormatter.localizedString(for: date, relativeTo: Date())
}

extension View {
  func filesListRow() -> some View {
    listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
  }
}
