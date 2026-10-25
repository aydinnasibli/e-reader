import { Image } from 'expo-image';
import { type ComponentRef, type Ref, memo, useEffect, useState } from 'react';
import { Text, type TextLayoutEvent, View } from 'react-native';
import { type Block, type Run, makeRun, runLink, runStyle, runText, sliceRuns } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import type { BookData, ImageInfo } from './book';
import { type Look, baseTextStyle, drawn, lineHeightOf, lookOf, runTextStyle, toDrawn } from './look';
import { type Mark, applyMarks } from './marks';

/** A drawn text, as its ref gives it. */
export type TextInstance = ComponentRef<typeof Text>;

interface TextProps {
  block: Block;
  look: Look;
  theme: Theme;
  /** Draw only this [start, end) range of the drawn text (page mode). */
  range?: [number, number];
  /** Drop the top margin (first thing on a page, or a continued paragraph). */
  noTopMargin?: boolean;
  noBottomMargin?: boolean;
  /** Highlights / search hits, in block coordinates. */
  marks?: Mark[];
  /** Tap on a footnote reference. */
  onLink?: (target: string) => void;
  onTextLayout?: (e: TextLayoutEvent) => void;
  /** The text view, for asking where its lines are drawn (see drawnLayout). */
  textRef?: Ref<TextInstance>;
}

export const BlockText = memo(function BlockText({ block, look, theme, range, noTopMargin, noBottomMargin, marks, onLink, onTextLayout, textRef }: TextProps) {
  const d = drawn(block, look);
  let runs: Run[] = d.runs;
  if (range) {
    runs = sliceRuns(runs, range[0], range[1]);
    // The page ends at a hyphenation point: draw the hyphen (a soft hyphen at
    // the very end of the text would stay invisible). Same width, same layout.
    if (range[1] < d.text.length && d.text[range[1] - 1] === '\u00ad' && runs.length) {
      const last = runs[runs.length - 1];
      runs = [...runs.slice(0, -1), makeRun(runText(last).slice(0, -1) + '\u2010', runStyle(last), runLink(last))];
    }
  }
  const from = range?.[0] ?? 0;
  const segments = applyMarks(runs, marks, (o) => toDrawn(d, o) - from);
  return (
    <Text
      ref={textRef}
      allowFontScaling={false}
      // Greedy line breaking, so a paragraph split across pages breaks exactly as measured.
      textBreakStrategy="simple"
      android_hyphenationFrequency={look.hyph !== undefined ? 'normal' : 'none'}
      onTextLayout={onTextLayout}
      style={{
        ...baseTextStyle(look, block.k === 'pre'),
        color: theme.text,
        fontSize: look.fontSize,
        lineHeight: look.lineHeight,
        letterSpacing: look.letterSpacing,
        textAlign: look.textAlign,
        marginTop: noTopMargin ? 0 : look.marginTop,
        marginBottom: noBottomMargin ? 0 : look.marginBottom,
        paddingLeft: look.paddingLeft,
      }}>
      {/* Always nested texts, even plain ones: React Native builds a text of only
          strings differently from one with nested texts, so the first highlight
          (a long-pressed word) would replace the paragraph's view under the finger,
          and the touch it was part of would never end (the next one is lost). */}
      {segments.map((seg, i) => {
        const st = runTextStyle(seg.bits, look);
        const link = seg.link;
        return (
          <Text
            key={i}
            style={[st, seg.bg ? { backgroundColor: seg.bg } : null, link ? { color: theme.accent } : null]}
            onPress={link && onLink ? () => onLink(link) : undefined}
            suppressHighlighting>
            {seg.text}
          </Text>
        );
      })}
    </Text>
  );
}, sameProps);

/** Like memo's default, but ranges are compared by value (pages build new arrays each render). */
function sameProps(a: TextProps, b: TextProps) {
  for (const k of Object.keys(a) as (keyof TextProps)[]) {
    if (k === 'range') {
      if (a.range?.[0] !== b.range?.[0] || a.range?.[1] !== b.range?.[1]) return false;
    } else if (a[k] !== b[k]) return false;
  }
  return Object.keys(a).length === Object.keys(b).length;
}

/** Separator and empty-line blocks. */
export function Spacer({ block, settings, theme }: { block: Block; settings: ReaderSettings; theme: Theme }) {
  const h = lineHeightOf(settings);
  if (block.k === 'hr') {
    return (
      <View style={{ height: h, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: '30%', height: 1, backgroundColor: theme.muted, opacity: 0.6 }} />
      </View>
    );
  }
  return <View style={{ height: h }} />;
}

/** Image block. With `height` it uses a fixed box (page mode); otherwise it sizes itself. */
export function BlockImage({ book, imageKey, width, height }: { book: BookData; imageKey: string; width: number; height?: number }) {
  const [info, setInfo] = useState<ImageInfo | null | undefined>(() => book.knownImage(imageKey));
  useEffect(() => {
    let alive = true;
    if (info === undefined) book.imageInfo(imageKey).then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, [book, imageKey, info]);
  const box = height ?? imageBoxHeight(info, width, Infinity);
  if (!info) return <View style={{ height: height ?? (info === null ? 0 : 160) }} />;
  return (
    <View style={{ height: box, alignItems: 'center', justifyContent: 'center' }}>
      <Image source={{ uri: info.uri }} style={{ width: '100%', height: '100%' }} contentFit="contain" recyclingKey={info.uri} />
    </View>
  );
}

/** Height an image takes: never wider than the column, never upscaled past 2x, never taller than maxHeight. */
export function imageBoxHeight(info: ImageInfo | null | undefined, width: number, maxHeight: number): number {
  if (!info || !info.width || !info.height) return 0;
  const w = Math.min(width, info.width * 2);
  return Math.min(maxHeight, Math.round((w * info.height) / info.width));
}

export { lookOf };
