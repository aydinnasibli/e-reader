// The two "droplet" handles at the ends of a selection on the page: drag one
// to move that end (past the other, the selection turns around). Positions
// come from the reader's geometry, in window coordinates.

import { useRef } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';
import type { Theme } from '@/lib/settings';
import type { ReaderGeometry } from './geometry';
import type { Caret } from './hitTest';
import { type TextPoint, type TextSel, selectBetween } from './selection';

const KNOB = 14;
/** Touch area around a handle, bigger than what's drawn: this much past the knob, and GRIP wide. */
const PAD = 16;
const GRIP = 44;

interface Props {
  sel: TextSel;
  geometry: { current: ReaderGeometry | null };
  textOf(b: number): string | null;
  theme: Theme;
  onChange(sel: TextSel): void;
}

/** Where a selection's two ends are on screen (null if not on screen). */
export function selectionCarets(sel: TextSel, geometry: ReaderGeometry | null): { start: Caret | null; end: Caret | null } {
  return {
    start: geometry?.caretAt(sel.a, 'start') ?? null,
    end: geometry?.caretAt({ b: sel.z.b, o: sel.z.o + 1 }, 'end') ?? null,
  };
}

export function SelectionHandles({ sel, geometry, textOf, theme, onChange }: Props) {
  const { start, end } = selectionCarets(sel, geometry.current);
  return (
    <>
      {start ? <Handle caret={start} which="start" fixed={sel.z} {...{ geometry, textOf, theme, onChange }} /> : null}
      {end ? <Handle caret={end} which="end" fixed={sel.a} {...{ geometry, textOf, theme, onChange }} /> : null}
    </>
  );
}

interface HandleProps {
  caret: Caret;
  which: 'start' | 'end';
  /** The other end, which stays put while this one is dragged. */
  fixed: TextPoint;
  geometry: { current: ReaderGeometry | null };
  textOf(b: number): string | null;
  theme: Theme;
  onChange(sel: TextSel): void;
}

function Handle({ caret, which, fixed, geometry, textOf, theme, onChange }: HandleProps) {
  // The responder is made once; it reads the latest values from here.
  const latest = useRef({ caret, fixed, textOf, onChange });
  latest.current = { caret, fixed, textOf, onChange };
  const drag = useRef<{ dy: number; fixed: TextPoint }>({ dy: 0, fixed });
  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const { caret: c, fixed: f } = latest.current;
        // Follow the text line, not the knob the finger is on (above or below it).
        drag.current = { dy: c.y + c.h / 2 - e.nativeEvent.pageY, fixed: f };
      },
      onPanResponderMove: (e) => {
        const { textOf: t, onChange: change } = latest.current;
        const p = geometry.current?.pointAt(e.nativeEvent.pageX, e.nativeEvent.pageY + drag.current.dy);
        const next = p && selectBetween(drag.current.fixed, p, t);
        if (next) change(next);
      },
    }),
  ).current;

  const top = which === 'start';
  return (
    <View
      {...pan.panHandlers}
      testID={`selection-handle-${which}`}
      hitSlop={8}
      style={[
        styles.grip,
        // The start's knob sits above its line, the end's below.
        { left: caret.x - GRIP / 2, top: top ? caret.y - KNOB - PAD : caret.y, height: caret.h + KNOB + PAD, paddingTop: top ? PAD : 0 },
      ]}>
      <View style={styles.column}>
        {top ? <View style={[styles.knob, { backgroundColor: theme.accent }]} /> : null}
        <View style={[styles.bar, { height: caret.h, backgroundColor: theme.accent }]} />
        {top ? null : <View style={[styles.knob, { backgroundColor: theme.accent }]} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grip: { position: 'absolute', width: GRIP, alignItems: 'center' },
  column: { alignItems: 'center' },
  bar: { width: 2 },
  knob: { width: KNOB, height: KNOB, borderRadius: KNOB / 2 },
});
