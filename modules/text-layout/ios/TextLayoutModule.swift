// Where a text's characters are drawn on screen (iOS). React Native lays a
// paragraph out afresh with TextKit every time it draws it (RCTTextLayoutManager)
// from the attributed string the paragraph view keeps, at the size of its
// drawing frame. Laying that same string out the same way says exactly where
// each character is, justified lines included: TextKit also opens the gaps
// between letters of a loose line, which no estimate from widths gets right.
//
// Not in Expo Go, which can't load an app's own native code: there the reader
// estimates (see src/reader/drawnLayout.ts).

import ExpoModulesCore
import UIKit

public class TextLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TextLayout")

    // As on Android: in points from the React root view, where the text's
    // content starts, and for each line its character range, top and bottom,
    // and the x of the caret before each character and after the last. Null
    // if the view isn't a laid-out text.
    AsyncFunction("drawnLines") { (tag: Int) -> [String: Any]? in
      guard let view = self.appContext?.findView(withTag: tag, ofType: UIView.self) else { return nil }
      return drawnLines(of: view)
    }.runOnQueue(.main)
  }
}

private func drawnLines(of paragraph: UIView) -> [String: Any]? {
  // RCTParagraphComponentView: the attributed string it draws.
  guard paragraph.responds(to: NSSelectorFromString("attributedText")),
    let text = paragraph.value(forKey: "attributedText") as? NSAttributedString, text.length > 0
  else { return nil }
  // Its RCTParagraphTextView draws the text into `drawingFrame`, laid out at that frame's size.
  let drawer = paragraph.subviews.first { $0.responds(to: NSSelectorFromString("drawingFrame")) }
  let frame = (drawer?.value(forKey: "drawingFrame") as? NSValue)?.cgRectValue ?? paragraph.bounds
  guard frame.width > 0, frame.height > 0 else { return nil }

  // As RCTTextLayoutManager's _textStorageAndLayoutManagerWithAttributesString
  // (no line limit: the reader never sets numberOfLines).
  let container = NSTextContainer(size: frame.size)
  container.lineFragmentPadding = 0
  container.lineBreakMode = .byClipping
  container.maximumNumberOfLines = 0
  let layout = NSLayoutManager()
  layout.usesFontLeading = false
  layout.addTextContainer(container)
  let storage = NSTextStorage(attributedString: text)
  storage.addLayoutManager(layout)
  layout.ensureLayout(for: container)

  var lines: [[String: Any]] = []
  layout.enumerateLineFragments(forGlyphRange: layout.glyphRange(for: container)) { rect, _, _, glyphs, _ in
    let chars = layout.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
    var xs: [Double] = []
    for k in chars.location..<NSMaxRange(chars) {
      xs.append(Double(rect.minX + layout.location(forGlyphAt: layout.glyphIndexForCharacter(at: k)).x))
    }
    // After the last character: where its glyph ends (a hyphen drawn at a break included).
    let last = NSRange(location: NSMaxRange(glyphs) - 1, length: 1)
    xs.append(max(Double(layout.boundingRect(forGlyphRange: last, in: container).maxX), xs.last ?? 0))
    lines.append(["start": chars.location, "end": NSMaxRange(chars), "top": Double(rect.minY), "bottom": Double(rect.maxY), "xs": xs])
  }
  let origin = (drawer ?? paragraph).convert(frame.origin, to: rootView(of: paragraph))
  return withExtendedLifetime(storage) {
    ["x": Double(origin.x), "y": Double(origin.y), "length": text.length, "lines": lines]
  }
}

/** The view touches' pageX and pageY are measured from (RCTSurfaceTouchHandler): React Native's root view. */
private func rootView(of view: UIView) -> UIView? {
  var v: UIView? = view
  while let current = v {
    if NSStringFromClass(type(of: current)).contains("RootComponentView") { return current }
    v = current.superview
  }
  return nil // the window
}
