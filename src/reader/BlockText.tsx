import { Image } from 'expo-image';
import { memo, useEffect, useState } from 'react';
import { Text, type TextLayoutEvent, View } from 'react-native';
import { type Block, type Run, runStyle, runText, sliceRuns } from '@/engine/types';
import type { ReaderSettings, Theme } from '@/lib/settings';
import type { BookData, ImageInfo } from './book';
import { type Look, drawnRuns, lineHeightOf, lookOf, runTextStyle } from './look';

interface TextProps {
  block: Block;
  look: Look;
  theme: Theme;
  /** Draw only this [start, end) range of the drawn text (page mode). */
  range?: [number, number];
  /** Drop the top margin (first thing on a page, or a continued paragraph). */
  noTopMargin?: boolean;
  noBottomMargin?: boolean;
  onTextLayout?: (e: TextLayoutEvent) => void;
}

export const BlockText = memo(function BlockText({ block, look, theme, range, noTopMargin, noBottomMargin, onTextLayout }: TextProps) {
  let runs: Run[] = drawnRuns(block, look);
  if (range) runs = sliceRuns(runs, range[0], range[1]);
  return (
    <Text
      allowFontScaling={false}
      // Greedy line breaking, so a paragraph split across pages breaks exactly as measured.
      textBreakStrategy="simple"
      onTextLayout={onTextLayout}
      style={{
        color: theme.text,
        fontSize: look.fontSize,
        lineHeight: look.lineHeight,
        fontFamily: look.fontFamily,
        fontWeight: look.fontWeight,
        textAlign: look.textAlign,
        marginTop: noTopMargin ? 0 : look.marginTop,
        marginBottom: noBottomMargin ? 0 : look.marginBottom,
        paddingLeft: look.paddingLeft,
      }}>
      {runs.map((r, i) => {
        const bits = runStyle(r);
        return bits ? (
          <Text key={i} style={runTextStyle(bits, look)}>
            {runText(r)}
          </Text>
        ) : (
          runText(r)
        );
      })}
    </Text>
  );
});

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
