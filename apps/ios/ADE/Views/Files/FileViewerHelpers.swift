import Foundation

struct FilesSearchMatch: Identifiable, Equatable {
  let id: Int
  let range: NSRange
}

func fileViewerLineCount(for text: String) -> Int {
  max(1, splitPreservingEmptyLines(text).count)
}

func fileViewerLineNumbersText(for text: String) -> String {
  (1...fileViewerLineCount(for: text)).map(String.init).joined(separator: "\n")
}

func fileViewerFindMatches(in text: String, query: String) -> [NSRange] {
  let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmedQuery.isEmpty else { return [] }

  let nsText = text as NSString
  let options: NSString.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
  var matches: [NSRange] = []
  var searchRange = NSRange(location: 0, length: nsText.length)

  while searchRange.location < nsText.length {
    let found = nsText.range(of: trimmedQuery, options: options, range: searchRange)
    guard found.location != NSNotFound, found.length > 0 else { break }
    matches.append(found)

    let nextLocation = found.location + found.length
    searchRange = NSRange(location: nextLocation, length: nsText.length - nextLocation)
  }

  return matches
}

func fileViewerMatchIndex(containing selection: NSRange, in matches: [NSRange]) -> Int? {
  guard selection.location != NSNotFound else { return nil }
  return matches.firstIndex { candidate in
    NSIntersectionRange(candidate, selection).length > 0 || candidate.location == selection.location
  }
}

func fileViewerReplaceCurrentMatch(
  in text: String,
  query: String,
  replacement: String,
  matchIndex: Int
) -> (text: String, selection: NSRange)? {
  let matches = fileViewerFindMatches(in: text, query: query)
  guard matches.indices.contains(matchIndex) else { return nil }

  let mutable = NSMutableString(string: text)
  let range = matches[matchIndex]
  mutable.replaceCharacters(in: range, with: replacement)

  let replacementLength = (replacement as NSString).length
  let selection = NSRange(location: range.location, length: replacementLength)
  return (mutable as String, selection)
}

func fileViewerReplaceAllMatches(
  in text: String,
  query: String,
  replacement: String
) -> String {
  let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmedQuery.isEmpty else { return text }

  let mutable = NSMutableString(string: text)
  let options: NSString.CompareOptions = [.caseInsensitive, .diacriticInsensitive]
  var searchRange = NSRange(location: 0, length: mutable.length)

  while searchRange.location < mutable.length {
    let found = mutable.range(of: trimmedQuery, options: options, range: searchRange)
    guard found.location != NSNotFound, found.length > 0 else { break }
    mutable.replaceCharacters(in: found, with: replacement)

    let nextLocation = found.location + (replacement as NSString).length
    searchRange = NSRange(location: nextLocation, length: mutable.length - nextLocation)
  }

  return mutable as String
}

