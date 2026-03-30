import SwiftUI
import UIKit

struct FilesCodeEditorView: UIViewRepresentable {
  @Binding var text: String
  @Binding var selection: NSRange
  let isEditable: Bool
  let onSelectionChange: (NSRange) -> Void

  func makeCoordinator() -> Coordinator {
    Coordinator(parent: self)
  }

  func makeUIView(context: Context) -> FilesCodeEditorContainerView {
    let container = FilesCodeEditorContainerView()
    container.textView.delegate = context.coordinator
    container.gutterTextView.delegate = context.coordinator
    container.textView.isEditable = isEditable
    container.textView.text = text
    container.gutterTextView.text = fileViewerLineNumbersText(for: text)
    container.textView.selectedRange = selection.clamped(toUTF16Length: (text as NSString).length)
    container.configureKeyboardShortcuts(target: context.coordinator)
    context.coordinator.container = container
    return container
  }

  func updateUIView(_ uiView: FilesCodeEditorContainerView, context: Context) {
    context.coordinator.parent = self
    context.coordinator.container = uiView

    uiView.textView.isEditable = isEditable
    uiView.textView.textColor = isEditable ? UIColor(ADEColor.textPrimary) : UIColor(ADEColor.textSecondary)

    if !context.coordinator.isUpdatingFromDelegate && uiView.textView.text != text {
      uiView.textView.text = text
      uiView.updateLineNumbers()
    }

    let safeSelection = selection.clamped(toUTF16Length: (text as NSString).length)
    if uiView.textView.selectedRange != safeSelection {
      uiView.textView.selectedRange = safeSelection
    }

    uiView.updateLineNumbers()
  }

  final class Coordinator: NSObject, UITextViewDelegate {
    var parent: FilesCodeEditorView
    weak var container: FilesCodeEditorContainerView?
    var isUpdatingFromDelegate = false

    init(parent: FilesCodeEditorView) {
      self.parent = parent
    }

    func textViewDidChange(_ textView: UITextView) {
      guard textView === container?.textView else { return }
      isUpdatingFromDelegate = true
      defer { isUpdatingFromDelegate = false }
      parent.text = textView.text
      container?.updateLineNumbers()
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
      guard textView === container?.textView else { return }
      let updatedSelection = textView.selectedRange
      if parent.selection != updatedSelection {
        parent.selection = updatedSelection
        parent.onSelectionChange(updatedSelection)
      }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
      guard scrollView === container?.textView else { return }
      container?.gutterTextView.contentOffset = scrollView.contentOffset
    }

    @objc func insertTab() { insert(snippet: "\t") }
    @objc func insertParentheses() { insert(snippet: "()", cursorOffset: 1) }
    @objc func insertBraces() { insert(snippet: "{}", cursorOffset: 1) }
    @objc func insertBrackets() { insert(snippet: "[]", cursorOffset: 1) }
    @objc func insertDoubleQuotes() { insert(snippet: "\"\"", cursorOffset: 1) }
    @objc func insertSingleQuotes() { insert(snippet: "''", cursorOffset: 1) }
    @objc func insertSemicolon() { insert(snippet: ";") }
    @objc func insertColon() { insert(snippet: ":") }

    private func insert(snippet: String, cursorOffset: Int? = nil) {
      guard let textView = container?.textView else { return }
      let current = textView.selectedRange
      let mutable = NSMutableString(string: textView.text)
      mutable.replaceCharacters(in: current, with: snippet)
      textView.text = mutable as String

      let offset = cursorOffset ?? (snippet as NSString).length
      let location = current.location + offset
      let updatedSelection = NSRange(location: location, length: 0).clamped(toUTF16Length: mutable.length)
      textView.selectedRange = updatedSelection
      textViewDidChange(textView)
      textViewDidChangeSelection(textView)
    }
  }
}

final class FilesCodeEditorContainerView: UIView {
  let gutterTextView = UITextView()
  let textView = UITextView()
  private let stackView = UIStackView()
  private let gutterWidth: CGFloat = 44

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear

    stackView.axis = .horizontal
    stackView.alignment = .fill
    stackView.distribution = .fill
    stackView.spacing = 0
    stackView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stackView)

    configureGutter()
    configureTextView()

    stackView.addArrangedSubview(gutterTextView)
    stackView.addArrangedSubview(textView)

    NSLayoutConstraint.activate([
      stackView.topAnchor.constraint(equalTo: topAnchor),
      stackView.bottomAnchor.constraint(equalTo: bottomAnchor),
      stackView.leadingAnchor.constraint(equalTo: leadingAnchor),
      stackView.trailingAnchor.constraint(equalTo: trailingAnchor),
      gutterTextView.widthAnchor.constraint(equalToConstant: gutterWidth),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  func updateLineNumbers() {
    gutterTextView.text = fileViewerLineNumbersText(for: textView.text)
  }

  func configureKeyboardShortcuts(target: FilesCodeEditorView.Coordinator) {
    let buttonGroups = [
      UIBarButtonItemGroup(
        barButtonItems: [
          UIBarButtonItem(title: "Tab", style: .plain, target: target, action: #selector(FilesCodeEditorView.Coordinator.insertTab)),
          UIBarButtonItem(title: "()", style: .plain, target: target, action: #selector(FilesCodeEditorView.Coordinator.insertParentheses)),
          UIBarButtonItem(title: "{}", style: .plain, target: target, action: #selector(FilesCodeEditorView.Coordinator.insertBraces)),
          UIBarButtonItem(title: "[]", style: .plain, target: target, action: #selector(FilesCodeEditorView.Coordinator.insertBrackets)),
        ],
        representativeItem: nil
      ),
      UIBarButtonItemGroup(
        barButtonItems: [
          UIBarButtonItem(title: "\"\"", style: .plain, target: target, action: #selector(FilesCodeEditorView.Coordinator.insertDoubleQuotes)),
          UIBarButtonItem(title: "''", style: .plain, target: target, action: #selector(FilesCodeEditorView.Coordinator.insertSingleQuotes)),
          UIBarButtonItem(title: ";", style: .plain, target: target, action: #selector(FilesCodeEditorView.Coordinator.insertSemicolon)),
          UIBarButtonItem(title: ":", style: .plain, target: target, action: #selector(FilesCodeEditorView.Coordinator.insertColon)),
        ],
        representativeItem: nil
      ),
    ]

    textView.inputAssistantItem.leadingBarButtonGroups = buttonGroups
    textView.inputAssistantItem.trailingBarButtonGroups = []
  }

  private func configureGutter() {
    gutterTextView.backgroundColor = .clear
    gutterTextView.textColor = UIColor(ADEColor.textMuted)
    gutterTextView.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
    gutterTextView.textAlignment = .right
    gutterTextView.isEditable = false
    gutterTextView.isSelectable = false
    gutterTextView.isScrollEnabled = true
    gutterTextView.showsVerticalScrollIndicator = false
    gutterTextView.showsHorizontalScrollIndicator = false
    gutterTextView.textContainerInset = UIEdgeInsets(top: 12, left: 6, bottom: 12, right: 8)
    gutterTextView.textContainer.lineFragmentPadding = 0
    gutterTextView.isAccessibilityElement = true
    gutterTextView.accessibilityLabel = "Line numbers"
  }

  private func configureTextView() {
    textView.backgroundColor = .clear
    textView.textColor = UIColor(ADEColor.textPrimary)
    textView.font = .monospacedSystemFont(ofSize: 15, weight: .regular)
    textView.isEditable = true
    textView.isSelectable = true
    textView.isScrollEnabled = true
    textView.showsVerticalScrollIndicator = true
    textView.showsHorizontalScrollIndicator = true
    textView.textContainerInset = UIEdgeInsets(top: 12, left: 0, bottom: 12, right: 12)
    textView.textContainer.lineFragmentPadding = 0
    textView.autocorrectionType = .no
    textView.autocapitalizationType = .none
    textView.smartQuotesType = .no
    textView.smartDashesType = .no
    textView.smartInsertDeleteType = .no
    textView.spellCheckingType = .no
    textView.returnKeyType = .default
    textView.allowsEditingTextAttributes = false
    textView.isAccessibilityElement = true
    textView.accessibilityLabel = "Code editor"
  }
}

private extension NSRange {
  func clamped(toUTF16Length length: Int) -> NSRange {
    let location = min(max(0, location), length)
    let maxLength = max(0, length - location)
    return NSRange(location: location, length: min(max(0, self.length), maxLength))
  }
}
