import SwiftUI
import UIKit
import AVKit

struct WorkInlineMarkdownText: View {
  let text: String

  var body: some View {
    Text(markdownAttributedString(text))
      .foregroundStyle(ADEColor.textPrimary)
      .tint(ADEColor.accent)
      .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct WorkMarkdownRenderer: View {
  let markdown: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach(parseMarkdownBlocks(markdown)) { block in
        switch block.kind {
        case .paragraph(let text):
          WorkInlineMarkdownText(text: text)
        case .heading(let level, let text):
          WorkInlineMarkdownText(text: text)
            .font(headingFont(level: level))
        case .unorderedList(let items):
          VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
              HStack(alignment: .top, spacing: 8) {
                Text("•")
                  .foregroundStyle(ADEColor.accent)
                WorkInlineMarkdownText(text: item)
              }
            }
          }
        case .orderedList(let items):
          VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
              HStack(alignment: .top, spacing: 8) {
                Text("\(index + 1).")
                  .foregroundStyle(ADEColor.accent)
                WorkInlineMarkdownText(text: item)
              }
            }
          }
        case .blockquote(let lines):
          HStack(alignment: .top, spacing: 10) {
            Rectangle()
              .fill(ADEColor.accent.opacity(0.55))
              .frame(width: 3)
            VStack(alignment: .leading, spacing: 4) {
              ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                WorkInlineMarkdownText(text: line)
              }
            }
          }
          .padding(10)
          .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        case .table(let headers, let rows):
          WorkMarkdownTable(headers: headers, rows: rows)
        case .code(let language, let code):
          WorkCodeBlockView(language: language, code: code)
        case .rule:
          Divider()
        }
      }
    }
  }

  func headingFont(level: Int) -> Font {
    switch level {
    case 1: return .title3.weight(.bold)
    case 2: return .headline.weight(.bold)
    default: return .subheadline.weight(.bold)
    }
  }
}

struct WorkMarkdownTable: View {
  let headers: [String]
  let rows: [[String]]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      VStack(spacing: 0) {
        HStack(spacing: 0) {
          ForEach(headers.indices, id: \.self) { index in
            WorkInlineMarkdownText(text: headers[index])
              .font(.caption.weight(.semibold))
              .padding(10)
              .frame(minWidth: 120, alignment: .leading)
              .background(ADEColor.surfaceBackground.opacity(0.7))
          }
        }
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          Divider()
          HStack(spacing: 0) {
            ForEach(headers.indices, id: \.self) { index in
              WorkInlineMarkdownText(text: index < row.count ? row[index] : "")
                .font(.caption)
                .padding(10)
                .frame(minWidth: 120, alignment: .leading)
            }
          }
        }
      }
      .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }
}

struct WorkCodeBlockView: View {
  let language: String?
  let code: String

  var detectedLanguage: FilesLanguage {
    FilesLanguage.detect(languageId: language, filePath: "snippet.\(language ?? "txt")")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text((language?.isEmpty == false ? language : detectedLanguage.displayName).map { $0.uppercased() } ?? detectedLanguage.displayName.uppercased())
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
        Spacer()
        Button("Copy") {
          UIPasteboard.general.string = code
        }
        .font(.caption2.weight(.semibold))
      }
      ScrollView(.horizontal, showsIndicators: false) {
        Text(SyntaxHighlighter.highlightedAttributedString(code, as: detectedLanguage))
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .padding(12)
      .background(ADEColor.recessedBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .padding(12)
    .background(ADEColor.surfaceBackground.opacity(0.65), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}
