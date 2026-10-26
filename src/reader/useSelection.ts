// Text selected on the page with a long press, and what can be done with it:
// copy, share, look up, translate. And the highlight tool, which works like a
// marker pen: a tap or a drag highlights the text under the finger, or takes
// the highlighting away if it starts on a highlight; Note, Copy and Remove act
// on the highlight just made.

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Share } from 'react-native';
import { addHighlight, clearHighlightRange, updateHighlight, useAnnotations } from '@/lib/annotations';
import { confirmDeleteHighlight, hasNote } from '@/ui/confirm';
import { showPrompt } from '@/ui/dialogs';
import type { HighlightColor } from '@/ui/theme';
import type { LookupKind } from './LookupCard';
import { type TextPoint, type TextSel, exactText, selectBetween, selectionRanges, selectionText } from './selection';

/** A point between words means the closer of the two words. */
export function nearestWord(text: string, o: number): number {
  if (o >= text.length || !/\s/.test(text[o])) return o;
  let l = o;
  while (l >= 0 && /\s/.test(text[l])) l--;
  let r = o;
  while (r < text.length && /\s/.test(text[r])) r++;
  if (l < 0) return r < text.length ? r : o;
  if (r >= text.length) return l;
  return o - l <= r - o ? l : r;
}

interface Options {
  bookId: string;
  bookTitle: string;
  /** A block's text, or null if it isn't text. */
  textOf(b: number): string | null;
  /** Whether a block goes on with the paragraph before it (the parts of a long paragraph). */
  continues?(b: number): boolean;
  chapterOf(b: number): string | undefined;
  /** The colour the highlight tool uses (the last one picked). */
  color: HighlightColor;
}

type Range = { b: number; s: number; e: number };

export function useSelection({ bookId, bookTitle, textOf, continues, chapterOf, color }: Options) {
  const ann = useAnnotations(bookId);
  const [sel, setSel] = useState<TextSel | null>(null);
  /** A definition or translation being shown. */
  const [lookup, setLookup] = useState<{ kind: LookupKind; text: string } | null>(null);

  // Copy and Share take exactly the characters selected; Look Up and Translate the whole words they touch.
  const ranges = sel ? selectionRanges(sel, textOf) : [];
  const words = sel ? selectionText(sel, textOf, continues) : '';
  const exact = sel ? exactText(sel, textOf, continues) : '';
  const highlights = ann.highlights;

  const copy = () => {
    Clipboard.setStringAsync(exact).catch(() => {});
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setSel(null);
  };

  const share = () => {
    Share.share({ message: `“${exact.trim()}”\n— ${bookTitle}` }).catch(() => {});
    setSel(null);
  };

  /** Look up the word (one word selected), or translate the selection. */
  const show = (kind: LookupKind) => {
    setLookup({ kind, text: words.trim() });
    setSel(null);
  };

  // ---------- the highlight tool: a marker pen ----------

  /** A drag in progress, drawn as it goes: the text it covers, and whether it takes highlighting away. */
  const [stroke, setStroke] = useState<{ ranges: Range[]; erase: boolean } | null>(null);
  /** Whether the drag under way erases: decided where it started. */
  const strokeErases = useRef<boolean | null>(null);
  /** The highlights the tool just made: Note, Copy and Remove act on them. */
  const [madeIds, setMadeIds] = useState<string[]>([]);
  const made = highlights.filter((h) => madeIds.includes(h.id));

  const highlightedAt = (p: TextPoint) => highlights.some((h) => h.b === p.b && h.s <= p.o && p.o < h.e);
  const wordAt = (p: TextPoint): TextPoint => ({ b: p.b, o: nearestWord(textOf(p.b) ?? '', p.o) });

  /** Take highlighting off these ranges. A note goes when its whole highlight does: ask first. */
  const clearRanges = (rs: Range[], then?: () => void) => {
    const clearAll = () => {
      for (const r of rs) clearHighlightRange(bookId, r.b, r.s, r.e);
      then?.();
    };
    const loseNote = highlights.some((h) => hasNote(h) && rs.some((r) => r.b === h.b && r.s <= h.s && h.e <= r.e));
    if (loseNote) confirmDeleteHighlight(true, clearAll);
    else clearAll();
  };

  /** Highlight the text of a selection, or take its highlighting away. */
  const mark = (s: TextSel | null, erase: boolean) => {
    if (!s) return;
    const rs = selectionRanges(s, textOf);
    if (!rs.length) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (erase) return clearRanges(rs, () => setMadeIds([]));
    setMadeIds(rs.map((r) => addHighlight(bookId, { ...r, color, text: textOf(r.b)!.slice(r.s, r.e), chapter: chapterOf(r.b) }).id));
  };

  /** A tap with the highlight tool: the word highlighted, or its highlighting taken away. */
  const markTap = (p: TextPoint) => {
    const w = wordAt(p);
    mark(selectBetween(w, w, textOf), highlightedAt(w));
  };

  /** A drag with the highlight tool, from where it started to where the finger is; done when lifted. Nulls: cancelled. */
  const markDrag = (from: TextPoint | null, to: TextPoint | null, done: boolean) => {
    if (!from || !to) {
      strokeErases.current = null;
      setStroke(null);
      return;
    }
    if (strokeErases.current === null) strokeErases.current = highlightedAt(wordAt(from));
    const erase = strokeErases.current;
    const s = selectBetween(from, to, textOf);
    if (!done) return setStroke(s ? { ranges: selectionRanges(s, textOf), erase } : null);
    strokeErases.current = null;
    setStroke(null);
    mark(s, erase);
  };

  /** Add or edit the note of the highlight just made. */
  const noteMade = () => {
    const h = made[0];
    if (!h) return;
    showPrompt(h.note ? 'Edit note' : 'Add note', {
      initial: h.note ?? '',
      placeholder: 'Your note',
      multiline: true,
      // Emptying an existing note removes it.
      allowEmpty: !!h.note,
      onSubmit: (n) => updateHighlight(bookId, h.id, { note: n || undefined }),
    });
  };

  const copyMade = () => {
    if (!made.length) return;
    Clipboard.setStringAsync(made.map((h) => h.text).join('\n')).catch(() => {});
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  };

  const removeMade = () => clearRanges(made, () => setMadeIds([]));

  /** The highlight tool is put away. */
  const endMarking = () => {
    strokeErases.current = null;
    setStroke(null);
    setMadeIds([]);
  };

  return {
    sel,
    setSel,
    ranges,
    /** One word is selected (look up needs that). */
    oneWord: ranges.length === 1 && !/\s/.test(words.trim()),
    copy,
    share,
    show,
    lookup,
    setLookup,
    stroke,
    made,
    markTap,
    markDrag,
    noteMade,
    copyMade,
    removeMade,
    endMarking,
  };
}
