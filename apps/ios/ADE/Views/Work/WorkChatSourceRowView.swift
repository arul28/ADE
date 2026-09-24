import SwiftUI
import UIKit

struct WorkChatSourceRowView: View {
  let source: AgentChatSourceRef
  var faviconDataURL: String? = nil

  private var faviconImage: UIImage? {
    guard let faviconDataURL,
          let comma = faviconDataURL.firstIndex(of: ","),
          let data = Data(base64Encoded: String(faviconDataURL[faviconDataURL.index(after: comma)...])) else {
      return nil
    }
    return UIImage(data: data)
  }

  private var safeURL: URL? {
    guard let raw = source.url?.trimmingCharacters(in: .whitespacesAndNewlines),
          let components = URLComponents(string: raw),
          let scheme = components.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          components.user == nil,
          components.password == nil,
          components.host?.isEmpty == false else { return nil }
    return URL(string: raw)
  }

  private var title: String {
    let value = source.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    if !value.isEmpty { return value }
    if let path = source.path, !path.isEmpty { return (path as NSString).lastPathComponent }
    if let host = safeURL?.host { return host }
    return "Source"
  }

  private var detail: String? {
    if let safeURL, let host = safeURL.host {
      return host + lineSuffix
    }
    if let path = source.path { return path + lineSuffix }
    return nil
  }

  private var lineSuffix: String {
    guard let start = source.lineStart else { return "" }
    if let end = source.lineEnd, end != start { return " · lines \(start)–\(end)" }
    return " · line \(start)"
  }

  var body: some View {
    Group {
      if let safeURL {
        Link(destination: safeURL) { rowLabel }
      } else if let path = source.path, !path.isEmpty {
        Button {
          UIPasteboard.general.string = path
        } label: {
          rowLabel
        }
        .buttonStyle(.plain)
        .accessibilityHint("Copies the source path")
      }
    }
  }

  private var rowLabel: some View {
    HStack(spacing: 9) {
      if let faviconImage {
        Image(uiImage: faviconImage)
          .resizable()
          .scaledToFit()
          .frame(width: 16, height: 16)
          .clipShape(RoundedRectangle(cornerRadius: 3))
          .frame(width: 18)
      } else {
        Image(systemName: source.kind == "file" ? "doc.text" : (source.cited == true ? "quote.opening" : "link"))
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
          .frame(width: 18)
      }
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let detail {
          Text(detail)
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
        }
      }
      Spacer(minLength: 0)
      Image(systemName: safeURL == nil ? "doc.on.doc" : "arrow.up.right")
        .font(.caption2.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .padding(.vertical, 6)
    .contentShape(Rectangle())
  }
}

