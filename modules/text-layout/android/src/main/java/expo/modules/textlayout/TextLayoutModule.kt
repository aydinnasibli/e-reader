// Where a text's characters are drawn on screen, read from the text view's own
// layout. React Native reports line breaks from a separate measurement, which
// can disagree with what the view draws (a word that only just fits), so
// selection handles and hit testing ask the drawn layout instead.

package expo.modules.textlayout

import android.os.Build
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.style.MetricAffectingSpan
import android.view.View
import android.widget.TextView
import com.facebook.react.uimanager.RootViewUtil
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TextLayoutModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TextLayout")

    // The text's lines as drawn, in points from the React root view: where its
    // content starts, and for each line its character range, top and bottom, and
    // the x of the caret before each character and after the last. Null if the
    // view isn't a laid-out text.
    AsyncFunction("drawnLines") { tag: Int ->
      val view = appContext.findView<View>(tag) as? TextView ?: return@AsyncFunction null
      val layout = view.layout ?: return@AsyncFunction null
      val density = view.resources.displayMetrics.density
      val at = IntArray(2)
      view.getLocationInWindow(at)
      val origin = IntArray(2)
      (RootViewUtil.getRootView(view) as? View)?.getLocationInWindow(origin)
      val count = layout.lineCount
      val lines = (0 until count).map { i ->
        val xs = lineCarets(layout, i)
        mapOf(
          "start" to layout.getLineStart(i),
          "end" to layout.getLineEnd(i),
          "top" to (layout.getLineTop(i) / density).toDouble(),
          "bottom" to (layout.getLineBottom(i) / density).toDouble(),
          "xs" to DoubleArray(xs.size) { (xs[it] / density).toDouble() },
        )
      }
      mapOf(
        "x" to ((at[0] - origin[0] + view.totalPaddingLeft) / density).toDouble(),
        "y" to ((at[1] - origin[1] + view.totalPaddingTop) / density).toDouble(),
        "length" to layout.text.length,
        "lines" to lines,
      )
    }.runOnQueue(Queues.MAIN)
  }

  /** The caret's x (pixels) before each character of line `i`, and after its last. */
  private fun lineCarets(layout: Layout, i: Int): FloatArray {
    val text = layout.text
    val start = layout.getLineStart(i)
    val end = layout.getLineEnd(i)
    val last = i == layout.lineCount - 1
    val xs = FloatArray(end - start + 1)
    for (k in start until end) xs[k - start] = layout.getPrimaryHorizontal(k)
    // After the last character: the end of the text, or the line's right edge
    // (without the spaces it ends with, with a hyphen drawn at a break).
    xs[end - start] = maxOf(if (last) layout.getPrimaryHorizontal(end) else layout.getLineRight(i), if (end > start) xs[end - start - 1] else 0f)

    // getPrimaryHorizontal leaves out what justifying adds to the spaces
    // between words; add it as drawing does: a line that isn't a paragraph's
    // last fills the width, its spaces (not those it ends with) sharing what's left.
    val justified = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      layout.justificationMode == Layout.JUSTIFICATION_MODE_INTER_WORD &&
      !last && text[end - 1] != '\n'
    if (!justified) return xs
    var ink = end
    while (ink > start && isLineEndSpace(text[ink - 1])) ink--
    val spaces = (start until ink).count { text[it] == ' ' }
    if (spaces == 0) return xs
    val natural = if (ink < end) layout.getPrimaryHorizontal(ink) else Layout.getDesiredWidth(text, start, end, layout.paint) + hyphenWidth(layout, end)
    val extra = (layout.width - natural) / spaces
    var before = 0
    for (k in start until end) {
      xs[k - start] += extra * before
      if (k < ink && text[k] == ' ') before++
    }
    xs[end - start] = maxOf(layout.width.toFloat(), xs[end - start - 1])
    return xs
  }

  /** Width of the hyphen drawn where a line breaks inside a word (at a soft hyphen, or between two letters), or 0. */
  private fun hyphenWidth(layout: Layout, end: Int): Float {
    val text = layout.text
    val hyphenated = end > 0 && (text[end - 1] == '­' || (end < text.length && text[end - 1].isLetter() && text[end].isLetter()))
    if (!hyphenated) return 0f
    val paint = TextPaint(layout.paint)
    (text as? Spanned)?.getSpans(end - 1, end, MetricAffectingSpan::class.java)?.forEach { it.updateMeasureState(paint) }
    return paint.measureText("‐")
  }

  /** The spaces a justified line may end with, which aren't widened (as Android's TextLine counts them). */
  private fun isLineEndSpace(c: Char) =
    c == ' ' || c == '\t' || c == ' ' || (c in ' '..' ' && c != ' ') || c == ' ' || c == '　'
}
