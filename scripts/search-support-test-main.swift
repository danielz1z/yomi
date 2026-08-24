import Foundation

private func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else {
        fputs("[search-support-test] FAIL: \(message)\n", stderr)
        exit(1)
    }
}

@main
struct SearchSupportTest {
    static func main() {
        let chinese = searchDisplayText("報名網址：115年8月13日，https://example.test/viewform/三號場次", query: "三", maximumLength: 24)
        expect(chinese.value.contains("三"), "Chinese match must remain visible in a compact snippet")
        expect(chinese.matchRanges.count == 1, "Chinese match should have one exact range")

        let english = searchMatchRanges(in: "Café Cafe CAFÉ", query: "cafe")
        expect(english.count == 3, "case and diacritic insensitive matching must find every occurrence")

        let repeated = searchDisplayText("三／三／三／三／三", query: "三", maximumLength: 12)
        expect(repeated.matchRanges.count >= 3, "all visible repeated matches must be highlighted")

        expect(searchTextMatches(value: "A 贏友善推廣團體", query: "三") == false, "title mismatch must not be treated as a result")
        expect(searchTextMatches(value: "報名網址：三號場次", query: "三"), "preview match must be searchable")
        expect(searchMatchRanges(in: "abc", query: "").isEmpty, "empty query must not match")
    }
}
