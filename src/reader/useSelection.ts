// Text selected on the page (with a long press, or with the highlight tool)
// and what can be done with it: copy, share, look up, translate, highlight,
// add a note, remove highlighting.

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Share } from 'react-native';
import { type Highlight, addHighlight, clearHighlightRange, updateHighlight, useAnnotations } from '@/lib/annotations';
import { setSettings } from '@/lib/settings';
import { confirmDeleteHighlight, hasNote } from '@/ui/confirm';
import { showPrompt } from '@/ui/dialogs';
import type { HighlightColor } from '@/ui/theme';
import type { LookupKind } from './LookupCard';
import { type TextPoint, type TextSel, selectBetween, selectionRanges, selectionText } from './selection';

interface Options {
  bookId: string;
  bookTitle: string;
  /** A block's text, or null if it isn't text. */
  textOf(b: number): string | null;
  chapterOf(b: number): string | undefined;
  /** The colour the highlight tool uses (the last one picked). */
  color: HighlightColor;
}

export function useSelection({ bookId, bookTitle, textOf, chapterOf, color }: Options) {
  const ann = useAnnotations(bookId);
  const [sel, setSel] = useState<TextSel | null>(null);
  /** A definition or translation being shown. */
  const [lookup, setLookup] = useState<{ kind: LookupKind; text: string } | null>(null);

  const ranges = sel ? selectionRanges(sel, textOf) : [];
  const text = sel ? selectionText(sel, textOf) : '';
  const highlights = ann.highlights;
  /** The selection is exactly one highlight: colours and notes edit it. */
  const exact: Highlight | undefined =
    ranges.length === 1 ? highlights.find((h) => h.b === ranges[0].b && h.s === ranges[0].s && h.e === ranges[0].e) : undefined;
  /** Some of the selection is highlighted. */
  const touched = ranges.some((r) => highlights.some((h) => h.b === r.b && h.s < r.e && r.s < h.e));

  /** Select the word at a point, or the highlight there (with the highlight tool). */
  const selectAt = (p: TextPoint, preferHighlight: boolean) => {
    const h = preferHighlight ? highlights.find((x) => x.b === p.b && x.s <= p.o && p.o < x.e) : undefined;
    const next = h ? { a: { b: h.b, o: h.s }, z: { b: h.b, o: h.e - 1 } } : selectBetween(p, p, textOf);
    if (next) Haptics.selectionAsync().catch(() => {});
    setSel(next);
  };
  const selectDrag = (from: TextPoint, to: TextPoint) => setSel(selectBetween(from, to, textOf));
  const clear = () => setSel(null);

  const highlight = (c: HighlightColor) => {
    setSettings({ highlightColor: c });
    if (!sel) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (exact) updateHighlight(bookId, exact.id, { color: c });
    else for (const r of ranges) addHighlight(bookId, { ...r, color: c, text: textOf(r.b)!.slice(r.s, r.e), chapter: chapterOf(r.b) });
    setSel(null);
  };

  const note = () => {
    if (!sel) return;
    const ex = exact;
    const rs = ranges;
    setSel(null);
    showPrompt(ex?.note ? 'Edit note' : 'Add note', {
      initial: ex?.note ?? '',
      placeholder: 'Your note',
      multiline: true,
      // Emptying an existing note removes it.
      allowEmpty: !!ex?.note,
      onSubmit: (n) => {
        if (ex) return updateHighlight(bookId, ex.id, { note: n || undefined });
        // The selection is highlighted, with the note on its first part.
        rs.forEach((r, i) =>
          addHighlight(bookId, { ...r, color, text: textOf(r.b)!.slice(r.s, r.e), chapter: chapterOf(r.b), ...(i === 0 ? { note: n } : {}) }),
        );
      },
    });
  };

  const remove = () => {
    const rs = ranges;
    const clearAll = () => {
      for (const r of rs) clearHighlightRange(bookId, r.b, r.s, r.e);
      setSel(null);
    };
    // A note goes when its whole highlight does (one that is only trimmed keeps it): ask first.
    const loseNote = highlights.some((h) => hasNote(h) && rs.some((r) => r.b === h.b && r.s <= h.s && h.e <= r.e));
    if (loseNote) confirmDeleteHighlight(true, clearAll);
    else clearAll();
  };

  const copy = () => {
    Clipboard.setStringAsync(text).catch(() => {});
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setSel(null);
  };

  const share = () => {
    Share.share({ message: `“${text}”\n— ${bookTitle}` }).catch(() => {});
    setSel(null);
  };

  /** Look up the word (one word selected), or translate the selection. */
  const show = (kind: LookupKind) => {
    setLookup({ kind, text: text.trim() });
    setSel(null);
  };

  return {
    sel,
    setSel,
    ranges,
    /** One word is selected (look up needs that). */
    oneWord: ranges.length === 1 && !/\s/.test(text.trim()),
    exact,
    touched,
    selectAt,
    selectDrag,
    clear,
    highlight,
    note,
    remove,
    copy,
    share,
    show,
    lookup,
    setLookup,
  };
}
