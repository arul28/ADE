import SwiftUI

/// One row of the Files tree: indentation guides, a disclosure chevron for
/// folders, the file-type glyph, the name, and the git status at the end
/// (a letter for a file, a dot for a folder that holds changes) — desktop's
/// FilesExplorer row.
struct FilesTreeRow: View {
  let node: FileTreeNode
  let depth: Int
  let isExpanded: Bool
  let isLoading: Bool
  let isSelected: Bool
  let onTap: () -> Void

  static let indent: CGFloat = 14

  private var isDirectory: Bool { node.type == "directory" }
  private var status: FilesChangeBadge? { filesChangeBadge(node.changeStatus) }

  var body: some View {
    Button(action: onTap) {
      HStack(spacing: 6) {
        Image(systemName: "chevron.right")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
          .rotationEffect(.degrees(isExpanded ? 90 : 0))
          .frame(width: 12)
          .opacity(isDirectory ? 1 : 0)

        Image(systemName: isDirectory ? (isExpanded ? "folder" : "folder.fill") : filesGlyph(for: node.name))
          .font(.system(size: 14))
          .foregroundStyle(isDirectory ? ADEColor.textSecondary : ADEColor.textMuted)
          .frame(width: 20)

        Text(node.name)
          .font(.subheadline)
          .foregroundStyle(nameColor)
          .lineLimit(1)
          .truncationMode(.middle)
          .frame(maxWidth: .infinity, alignment: .leading)

        if isLoading {
          ProgressView().controlSize(.mini)
        } else if let status {
          if isDirectory {
            Circle()
              .fill(status.color)
              .frame(width: 6, height: 6)
          } else {
            Text(status.letter)
              .font(.caption2.monospaced().weight(.bold))
              .foregroundStyle(status.color)
              .frame(minWidth: 14)
          }
        }
      }
      .padding(.leading, 8 + CGFloat(depth) * Self.indent)
      .padding(.trailing, 10)
      .frame(minHeight: 36)
      .background(alignment: .leading) { guides }
      .background {
        if isSelected {
          RoundedRectangle(cornerRadius: 9, style: .continuous)
            .fill(ADEColor.accent.opacity(0.16))
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(FilesTreeRowButtonStyle())
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel)
    .accessibilityValue(isDirectory ? (isExpanded ? "Expanded" : "Collapsed") : (isSelected ? "Open" : ""))
    .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    .accessibilityHint(isDirectory ? "Shows or hides this folder's contents" : "Opens the file")
  }

  private var nameColor: Color {
    if isSelected { return ADEColor.textPrimary }
    if node.changeStatus?.lowercased() == "ignored" { return ADEColor.textMuted }
    return ADEColor.textPrimary
  }

  /// Desktop's indentation guides: one hairline per ancestor level.
  @ViewBuilder
  private var guides: some View {
    if depth > 0 {
      HStack(spacing: 0) {
        ForEach(0..<depth, id: \.self) { _ in
          Rectangle()
            .fill(ADEColor.glassBorder)
            .frame(width: 1)
            .frame(width: Self.indent, alignment: .center)
        }
      }
      .padding(.leading, 8 + 6 - Self.indent / 2)
    }
  }

  private var accessibilityLabel: String {
    var label = "\(node.name), \(isDirectory ? "folder" : "file")"
    if let status { label += ", \(status.title)" }
    return label
  }
}

private struct FilesTreeRowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background {
        if configuration.isPressed {
          RoundedRectangle(cornerRadius: 9, style: .continuous)
            .fill(ADEColor.textPrimary.opacity(0.08))
        }
      }
  }
}

/// A quiet line inside the tree: an empty folder, or a folder that failed to
/// list with a retry.
struct FilesTreeMessageRow: View {
  let symbol: String?
  let text: String
  let actionTitle: String?
  let action: () -> Void
  var depth = 0

  var body: some View {
    HStack(spacing: 8) {
      if let symbol {
        Image(systemName: symbol)
          .font(.footnote)
          .foregroundStyle(ADEColor.textMuted)
      }
      Text(text)
        .font(.footnote)
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(2)
        .frame(maxWidth: .infinity, alignment: .leading)
      if let actionTitle {
        Button(actionTitle, action: action)
          .font(.footnote.weight(.semibold))
          .buttonStyle(.borderless)
      }
    }
    .padding(.leading, 8 + 18 + CGFloat(depth) * FilesTreeRow.indent)
    .padding(.trailing, 10)
    .frame(minHeight: 34)
  }
}

/// A placeholder row while the root lists.
struct FilesTreeSkeletonRow: View {
  let widthFraction: CGFloat

  var body: some View {
    HStack(spacing: 8) {
      RoundedRectangle(cornerRadius: 3, style: .continuous)
        .fill(ADEColor.textMuted.opacity(0.18))
        .frame(width: 16, height: 14)
      GeometryReader { proxy in
        RoundedRectangle(cornerRadius: 3, style: .continuous)
          .fill(ADEColor.textMuted.opacity(0.14))
          .frame(width: proxy.size.width * widthFraction, height: 10)
          .frame(maxHeight: .infinity, alignment: .center)
      }
    }
    .padding(.leading, 26)
    .padding(.trailing, 10)
    .frame(height: 36)
    .accessibilityHidden(true)
  }
}

struct FilesChangeBadge: Equatable {
  let letter: String
  let color: Color
  let title: String
}

/// Desktop's git status marks (`changeStatusLabel` / `changeStatusColor`).
func filesChangeBadge(_ status: String?) -> FilesChangeBadge? {
  guard let status = status?.trimmingCharacters(in: .whitespaces), !status.isEmpty else { return nil }
  switch status.lowercased() {
  case "a", "added":
    return FilesChangeBadge(letter: "A", color: ADEColor.success, title: "Added")
  case "untracked", "u", "?":
    return FilesChangeBadge(letter: "U", color: ADEColor.success, title: "Untracked")
  case "d", "deleted":
    return FilesChangeBadge(letter: "D", color: ADEColor.danger, title: "Deleted")
  case "r", "renamed":
    return FilesChangeBadge(letter: "R", color: ADEColor.info, title: "Renamed")
  case "m", "modified":
    return FilesChangeBadge(letter: "M", color: ADEColor.warning, title: "Modified")
  case "ignored":
    return nil
  default:
    return FilesChangeBadge(letter: String(status.prefix(1)).uppercased(), color: ADEColor.textSecondary, title: status.capitalized)
  }
}

/// The file-type glyph. Shape says the kind; colour stays for git status.
func filesGlyph(for name: String) -> String {
  let lower = name.lowercased()
  let ext = (lower as NSString).pathExtension
  switch ext {
  case "swift": return "swift"
  case "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "c", "cpp", "cc", "h", "hpp", "m", "mm", "java", "kt", "kts", "cs", "php", "lua", "vue", "html", "htm", "css", "scss", "less":
    return "chevron.left.forwardslash.chevron.right"
  case "json", "jsonc", "json5": return "curlybraces"
  case "yml", "yaml", "toml", "ini", "plist", "xml", "cfg", "conf", "env", "lock": return "gearshape"
  case "md", "mdx", "markdown": return "text.document"
  case "txt", "log", "rtf": return "doc.plaintext"
  case "sh", "bash", "zsh", "fish", "ps1": return "terminal"
  case "png", "jpg", "jpeg", "gif", "svg", "webp", "heic", "bmp", "tiff", "ico", "avif": return "photo"
  case "mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus": return "waveform"
  case "mp4", "m4v", "mov", "webm", "ogv", "avi", "mkv": return "film"
  case "pdf": return "doc.richtext"
  case "csv", "tsv", "xls", "xlsx": return "tablecells"
  case "zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z": return "doc.zipper"
  case "sql", "db", "sqlite": return "cylinder"
  default:
    if lower.hasPrefix(".") || lower == "dockerfile" || lower == "makefile" { return "gearshape" }
    return "doc"
  }
}
