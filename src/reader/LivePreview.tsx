// What the page looks like with the values of a slider being dragged.
// Laying the book out into pages takes a moment, so that happens once, when
// the slider is released; meanwhile this redraws the text from the reading
// position with every value, right where the page is, and stays until the new
// pages are ready.

import type { ReactNode } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type Position, blockLength } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import type { BookData } from './book';
import { BlockImage, BlockText, Spacer } from './BlockText';
import { drawn, lineHeightOf, lookOf, toDrawn } from './look';
import { HEADER, webFrame } from './web/frame';

interface Props {
  book: BookData;
  settings: ReaderSettings;
  theme: Theme;
  /** First position on screen. */
  pos: Position;
}

export function LivePreview({ book, settings, theme, pos }: Props) {
  const win = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { column: width, height: pageHeight, left } = webFrame(win, insets, settings.margin, 'page');
  const lang = book.manifest?.lang;

  // Enough text to fill the screen at any size, and no more.
  const lines = pageHeight / lineHeightOf(settings) + 2;
  const perLine = width / Math.max(4, settings.fontSize * 0.4);
  const budget = Math.min(12000, Math.ceil(lines * perLine));

  const items: ReactNode[] = [];
  let chars = 0;
  let c = book.chunkOf(pos.b);
  let b = pos.b;
  while (chars < budget && c < book.chunkCount) {
    // Only chunks the reader already has in memory; nothing is read from disk here.
    const blocks = book.cached(c);
    if (!blocks) break;
    const blk = blocks[b - book.chunkStart(c)];
    if (!blk) {
      c++;
      b = book.chunkStart(c);
      continue;
    }
    const first = b === pos.b;
    if (blk.k === 'img') items.push(<BlockImage key={b} book={book} imageKey={blk.s!} width={width} />);
    else if (blk.k === 'sp' || blk.k === 'hr') items.push(<Spacer key={b} block={blk} settings={settings} theme={theme} />);
    else {
      const look = lookOf(blk, settings, lang);
      const d = drawn(blk, look);
      const from = first && pos.o > 0 ? toDrawn(d, pos.o) : 0;
      items.push(<BlockText key={b} block={blk} look={look} theme={theme} range={from ? [from, d.text.length] : undefined} noTopMargin={first} />);
    }
    chars += blockLength(blk);
    b++;
  }

  // Nothing in memory to draw: leave the page visible rather than cover it.
  if (!items.length) return null;

  const frame =
    settings.mode === 'page'
      ? { top: insets.top + HEADER, height: pageHeight }
      : { top: 0, bottom: 0, paddingTop: insets.top + 12 };
  return (
    <View pointerEvents="none" style={[styles.root, frame, { paddingLeft: left, paddingRight: settings.margin + insets.right, backgroundColor: theme.bg }]}>
      <View style={{ width }}>{items}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
});
