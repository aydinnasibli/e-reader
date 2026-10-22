// Lays out a chunk's text invisibly and reports where every line breaks.
// The phone's own text engine does the measuring, so pages match what is drawn.

import { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type { Block } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import type { BookData } from './book';
import { BlockText, imageBoxHeight } from './BlockText';
import { type Look, drawnText, lineHeightOf, lookOf } from './look';
import { type Measure, estimateLines, lineRanges } from './paginate';

const TIMEOUT_MS = 4000;

interface Props {
  book: BookData;
  blocks: Block[];
  settings: ReaderSettings;
  theme: Theme;
  width: number;
  pageHeight: number;
  onDone(measures: Measure[], looks: Look[]): void;
}

export function Measurer({ book, blocks, settings, theme, width, pageHeight, onDone }: Props) {
  const looks = useRef<Look[]>(blocks.map((b) => lookOf(b, settings, book.manifest?.lang))).current;
  const results = useRef<(Measure | undefined)[]>(blocks.map(() => undefined)).current;
  const finished = useRef(false);
  const ready = useRef(false);
  const pendingImages = useRef(0);

  const textCount = blocks.filter((b) => b.r && b.r.length).length;
  const reported = useRef(0);

  const finish = () => {
    if (finished.current || !ready.current) return;
    if (reported.current < textCount || pendingImages.current > 0) return;
    finished.current = true;
    // A copy: text layout events can still arrive and must not change pages already cut.
    onDone(results.slice() as Measure[], looks);
  };

  // Images and spacers need no text layout.
  useEffect(() => {
    const lh = lineHeightOf(settings);
    blocks.forEach((b, i) => {
      if (b.k === 'img') {
        const known = book.knownImage(b.s!);
        if (known !== undefined) {
          results[i] = { kind: 'box', height: imageBoxHeight(known, width, pageHeight) };
          return;
        }
        pendingImages.current++;
        book.imageInfo(b.s!).then((info) => {
          results[i] = { kind: 'box', height: imageBoxHeight(info, width, pageHeight) };
          pendingImages.current--;
          finish();
        });
      } else if (b.k === 'sp' || b.k === 'hr') {
        results[i] = { kind: 'box', height: lh };
      } else if (!b.r || !b.r.length) {
        results[i] = { kind: 'box', height: 0 };
      }
    });
    ready.current = true;
    finish();
    const timer = setTimeout(() => {
      // Fill in anything the text engine never reported.
      blocks.forEach((b, i) => {
        if (!results[i]) {
          const text = drawnText(b, looks[i]);
          results[i] = { kind: 'text', lines: estimateLines(text, looks[i], width), length: text.length };
        }
      });
      reported.current = textCount;
      pendingImages.current = 0;
      finish();
    }, TIMEOUT_MS);
    return () => clearTimeout(timer);
    // Runs once per mount; the parent remounts with a new key for new input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View pointerEvents="none" style={[styles.hidden, { width }]}>
      {blocks.map((b, i) =>
        b.r && b.r.length ? (
          <BlockText
            key={i}
            block={b}
            look={looks[i]}
            theme={theme}
            onTextLayout={(e) => {
              if (finished.current) return;
              const first = !results[i];
              const text = drawnText(b, looks[i]);
              results[i] = { kind: 'text', lines: lineRanges(text, e.nativeEvent.lines), length: text.length };
              if (first) {
                reported.current++;
                finish();
              }
            }}
          />
        ) : null,
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', left: 0, top: 0, opacity: 0 },
});
