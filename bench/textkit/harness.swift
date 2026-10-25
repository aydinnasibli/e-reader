// Lays paragraphs out the way React Native does on iOS (RCTTextLayoutManager:
// an NSLayoutManager with lineFragmentPadding 0 and usesFontLeading NO, line
// height as minimum = maximum line height, letter spacing as NSKern, the
// baseline offset of RCTApplyBaselineOffset) with macOS's TextKit, the same
// text engine, and prints for each paragraph:
//   - its lines as onTextLayout reports them (characters, used width, height),
//   - where TextKit really put the caret before every character,
//   - the widths the app's probe (CharProbe) would measure for its
//     characters and words, at the paragraph's size.
//
//   swiftc -O -sdk "$(xcrun --show-sdk-path)" bench/textkit/harness.swift -o bench/.out/textkit
//   bench/.out/textkit cases.json [font files...] > layout.json
//
// cases.json: [{ id, text, font (PostScript name or "system"), size,
// lineHeight, letterSpacing, align ("justify" | "left"), width }].

import AppKit
import CoreText
import Foundation

struct Case: Decodable {
  let id: String
  let text: String
  let font: String
  let size: Double
  let lineHeight: Double
  let letterSpacing: Double
  let align: String
  let width: Double
}

struct Line: Encodable {
  let start: Int
  let end: Int
  let w: Double
  let height: Double
  /** Caret x before each character and after the last. */
  let xs: [Double]
}

struct Result: Encodable {
  let id: String
  let lines: [Line]
  let chars: [String: Double]
  let words: [String: Double]
}

func font(_ name: String, _ size: Double) -> NSFont {
  if name == "system" { return NSFont.systemFont(ofSize: size) }
  guard let f = NSFont(name: name, size: size) else { fatalError("No font named \(name)") }
  return f
}

func attributed(_ text: String, font name: String, size: Double, lineHeight: Double, kern: Double, align: NSTextAlignment) -> NSAttributedString {
  let f = font(name, size)
  let style = NSMutableParagraphStyle()
  style.alignment = align
  style.minimumLineHeight = lineHeight
  style.maximumLineHeight = lineHeight
  let s = NSMutableAttributedString(string: text, attributes: [.font: f, .paragraphStyle: style, .kern: kern])
  let fontLine = f.ascender - f.descender + f.leading
  if lineHeight >= fontLine {
    s.addAttribute(.baselineOffset, value: (lineHeight - fontLine) / 2, range: NSRange(location: 0, length: s.length))
  }
  return s
}

func lines(_ s: NSAttributedString, width: Double) -> [Line] {
  let container = NSTextContainer(size: NSSize(width: width, height: .greatestFiniteMagnitude))
  container.lineFragmentPadding = 0
  container.lineBreakMode = .byClipping
  let layout = NSLayoutManager()
  layout.usesFontLeading = false
  layout.addTextContainer(container)
  let storage = NSTextStorage(attributedString: s)
  storage.addLayoutManager(layout)
  layout.ensureLayout(for: container)
  var out: [Line] = []
  layout.enumerateLineFragments(forGlyphRange: layout.glyphRange(for: container)) { rect, used, _, glyphs, _ in
    let chars = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
    var xs = (chars.location..<(chars.location + chars.length)).map { k in
      Double(rect.origin.x + layout.location(forGlyphAt: layout.glyphIndexForCharacter(at: k)).x)
    }
    let last = NSRange(location: glyphs.location + glyphs.length - 1, length: 1)
    xs.append(Double(layout.boundingRect(forGlyphRange: last, in: container).maxX))
    out.append(Line(start: chars.location, end: chars.location + chars.length, w: Double(used.width), height: Double(rect.height), xs: xs))
  }
  return withExtendedLifetime(storage) { out }
}

let args = CommandLine.arguments
for path in args.dropFirst(2) { CTFontManagerRegisterFontsForURL(URL(fileURLWithPath: path) as CFURL, .process, nil) }
let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
var results: [Result] = []
for c in cases {
  let text = attributed(c.text, font: c.font, size: c.size, lineHeight: c.lineHeight, kern: c.letterSpacing, align: c.align == "justify" ? .justified : .left)
  // What CharProbe measures: "||", then "|cccc|" per character, then "|word|" per word.
  let chars = Array(Set(c.text.map { String($0) }).subtracting(["\n", "\u{AD}"])).sorted() + ["-"]
  let words = Array(Set(c.text.replacingOccurrences(of: "\u{AD}", with: "").split(whereSeparator: { $0.isWhitespace }).map(String.init).filter { $0.count > 1 && $0.count <= 40 })).sorted()
  let probeText = (["||"] + chars.map { "|" + String(repeating: $0, count: 4) + "|" } + words.map { "|\($0)|" }).joined(separator: "\n")
  let probe = lines(attributed(probeText, font: c.font, size: c.size, lineHeight: (c.size * 1.5).rounded(.up), kern: 0, align: .natural), width: 4000).map { $0.w }
  var charWidths: [String: Double] = [:]
  for (i, ch) in chars.enumerated() { charWidths[ch] = (probe[i + 1] - probe[0]) / 4 }
  var wordWidths: [String: Double] = [:]
  for (i, w) in words.enumerated() { wordWidths[w] = probe[chars.count + 1 + i] - probe[0] }
  results.append(Result(id: c.id, lines: lines(text, width: c.width), chars: charWidths, words: wordWidths))
}
FileHandle.standardOutput.write(try JSONEncoder().encode(results))
