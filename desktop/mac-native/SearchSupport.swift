import Foundation

/// A display-ready piece of text and the ranges that matched the user's query.
/// Keeping this value type separate from SwiftUI makes search behaviour testable
/// without rendering the desktop app.
struct SearchDisplayText {
    let value: String
    let matchRanges: [Range<String.Index>]
}

/// Returns every localized, case/diacritic/width-insensitive occurrence.
/// Chinese queries remain exact because Foundation's localized matching does
/// not fold unrelated Han characters.
func searchMatchRanges(in value: String, query: String) -> [Range<String.Index>] {
    let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedQuery.isEmpty, !value.isEmpty else { return [] }

    var result: [Range<String.Index>] = []
    var searchStart = value.startIndex
    let options: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive, .widthInsensitive]

    while searchStart < value.endIndex,
        let match = value.range(of: trimmedQuery, options: options, range: searchStart..<value.endIndex)
    {
        result.append(match)
        // Always advance. This avoids an infinite loop for unusual zero-width
        // Unicode matches while preserving overlapping-safe forward matching.
        searchStart =
            match.upperBound > searchStart
            ? match.upperBound
            : value.index(after: searchStart)
    }
    return result
}

func searchTextMatches(value: String, query: String) -> Bool {
    !searchMatchRanges(in: value, query: query).isEmpty
}

/// Builds a compact preview around the first match, then recalculates all
/// matches in the resulting display text so every visible occurrence can be
/// styled. The query is never cut out of the returned line.
func searchDisplayText(_ value: String, query: String, maximumLength: Int = 58) -> SearchDisplayText {
    let ranges = searchMatchRanges(in: value, query: query)
    guard !ranges.isEmpty, value.count > maximumLength else {
        return SearchDisplayText(value: value, matchRanges: ranges)
    }

    let first = ranges[0]
    let matchStart = value.distance(from: value.startIndex, to: first.lowerBound)
    let matchLength = value.distance(from: first.lowerBound, to: first.upperBound)
    let matchEnd = matchStart + matchLength
    let context = max(12, (maximumLength - matchLength) / 2)
    let startOffset = max(0, matchStart - context)
    let endOffset = min(value.count, max(matchEnd + context, startOffset + maximumLength))
    let start = value.index(value.startIndex, offsetBy: startOffset)
    let end = value.index(value.startIndex, offsetBy: min(value.count, endOffset))

    var snippet = String(value[start..<end])
    if startOffset > 0 { snippet = "…" + snippet }
    if endOffset < value.count { snippet += "…" }
    return SearchDisplayText(value: snippet, matchRanges: searchMatchRanges(in: snippet, query: query))
}
