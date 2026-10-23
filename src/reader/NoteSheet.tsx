// Footnote popup: shows the note a reference points to, without leaving the page.

import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Block, Position } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import { Sheet } from '@/ui/Sheet';
import type { BookData } from './book';
import { BlockText, Spacer } from './BlockText';
import { lookOf } from './look';
import { Tap } from '@/ui/Tap';

/** Most notes are a paragraph or two; never pull in more than this. */
const MAX_BLOCKS = 12;

type State = { kind: 'loading' } | { kind: 'missing'; reason: string } | { kind: 'ready'; start: number; blocks: Block[] };

export function NoteSheet({
  book,
  target,
  settings,
  theme,
  onClose,
  onGo,
}: {
  book: BookData;
  target: string | null;
  settings: ReaderSettings;
  theme: Theme;
  onClose(): void;
  onGo(pos: Position): void;
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    if (!target) return;
    let alive = true;
    setState({ kind: 'loading' });
    const range = book.manifest?.notes?.[target];
    if (!range) {
      setState({
        kind: 'missing',
        reason: book.complete ? "This note couldn't be found in the book." : 'Notes become available once the book has finished preparing.',
      });
      return;
    }
    const start = range[0];
    const end = Math.min(Math.max(range[1], start + 1), start + MAX_BLOCKS, book.totalBlocks);
    (async () => {
      const out: Block[] = [];
      for (let b = start; b < end; ) {
        const c = book.chunkOf(b);
        const blocks = await book.loadChunk(c);
        const first = book.chunkStart(c);
        for (; b < end && b - first < blocks.length; b++) out.push(blocks[b - first]);
        if (b - first >= blocks.length && b < end && c + 1 >= book.chunkCount) break;
      }
      // A note's own number heading ("1") adds nothing in a popup.
      const shown = out.length > 1 && out[0].k === 'h' ? out.slice(1) : out;
      if (alive) setState({ kind: 'ready', start, blocks: shown });
    })();
    return () => {
      alive = false;
    };
  }, [target, book]);

  const small = { ...settings, fontSize: Math.max(14, Math.round(settings.fontSize * 0.9)), indent: false, paraSpacing: 0.4 };

  return (
    <Sheet visible={!!target} onClose={onClose} colors={{ bg: theme.chrome, text: theme.text, border: theme.border }} title="Note">
      {state.kind === 'loading' && <ActivityIndicator style={styles.pad} color={theme.muted} />}
      {state.kind === 'missing' && <Text style={[styles.pad, { color: theme.muted, fontSize: 15 }]}>{state.reason}</Text>}
      {state.kind === 'ready' && (
        <>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyPad}>
            {state.blocks.map((b, i) =>
              b.r ? (
                <BlockText key={i} block={b} look={lookOf(b, small, book.manifest?.lang)} theme={theme} noTopMargin={i === 0} />
              ) : b.k === 'sp' || b.k === 'hr' ? (
                <Spacer key={i} block={b} settings={small} theme={theme} />
              ) : null,
            )}
          </ScrollView>
          <View style={[styles.footer, { borderColor: theme.border }]}>
            <Tap onPress={() => onGo({ b: state.start, o: 0 })} hitSlop={8}>
              <Text style={{ color: theme.accent, fontSize: 15, fontWeight: '600' }}>Go to note</Text>
            </Tap>
          </View>
        </>
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 24 },
  body: { maxHeight: 340 },
  bodyPad: { paddingHorizontal: 20, paddingBottom: 12 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 20, paddingTop: 12, alignItems: 'flex-end' },
});
