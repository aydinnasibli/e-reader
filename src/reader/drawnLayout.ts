// Where a paragraph's characters are drawn, asked of the text view itself
// (modules/text-layout: Android's TextView layout, iOS's TextKit). The line
// breaks React Native reports come from a separate measurement that can
// disagree with what is drawn on Android (a word that only just fits goes to
// the next line), and positions along a line are only estimates (see
// hitTest); the drawn layout is exact. Where the module isn't in the app
// (Expo Go can't load it), and until it answers, the estimates stand in.

import { requireOptionalNativeModule } from 'expo';
import { findNodeHandle } from 'react-native';
import type { DrawnLines } from './hitTest';

const native = requireOptionalNativeModule<{ drawnLines(tag: number): Promise<DrawnLines | null> }>('TextLayout');

/** Where a text view's lines are drawn; null where the phone can't say. */
export async function drawnLines(text: Parameters<typeof findNodeHandle>[0] | undefined): Promise<DrawnLines | null> {
  if (!native || !text) return null;
  const tag = findNodeHandle(text);
  if (tag == null) return null;
  try {
    return await native.drawnLines(tag);
  } catch {
    return null;
  }
}
