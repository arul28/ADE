import Foundation

/// A stored machine or computer name with an old default's product name read
/// as DAEX ("ADE Cloud computer 2" → "DAEX Cloud computer 2", "ADE CLI on
/// mac" → "DAEX CLI on mac"); any other name, including every name a person
/// typed, comes back unchanged. Display only: stored rows keep the old name.
/// Mirrors `displayLegacyDefaultName` in apps/desktop/src/shared/legacyDefaultNames.ts.
func displayLegacyDefaultName(_ name: String) -> String {
  let old = Brand.formerName
  guard name.hasPrefix(old) else { return name }
  let rest = String(name.dropFirst(old.count))
  let isNumber = { (text: Substring) in !text.isEmpty && text.allSatisfy(\.isASCII) && text.allSatisfy(\.isNumber) }
  if rest == " Cloud computer" { return "\(Brand.cloudName) computer" }
  if rest.hasPrefix(" Cloud computer "), isNumber(rest.dropFirst(" Cloud computer ".count)) {
    return "\(Brand.cloudName)\(rest.dropFirst(" Cloud".count))"
  }
  if rest.hasPrefix(" Cloud · "), rest.count > " Cloud · ".count { return "\(Brand.cloudName)\(rest.dropFirst(" Cloud".count))" }
  if rest == " computer" || rest == " computer copy" { return "\(Brand.name)\(rest)" }
  for kind in [" CLI on ", " agents on ", " Desktop on "] where rest.hasPrefix(kind) && rest.count > kind.count {
    return "\(Brand.name)\(rest)"
  }
  return name
}
