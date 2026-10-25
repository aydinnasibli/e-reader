// Share text as a file (so it can be saved to Files, mailed, sent...), or
// as plain text where file sharing isn't available.

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Share } from 'react-native';

/** iOS names file types by UTI. */
const UTIS: Record<string, string> = {
  'text/markdown': 'net.daringfireball.markdown',
  'text/plain': 'public.plain-text',
  'application/json': 'public.json',
};

export async function shareTextFile(fileName: string, text: string, mimeType = 'text/markdown') {
  try {
    if (await Sharing.isAvailableAsync()) {
      const f = new File(Paths.cache, fileName);
      if (f.exists) f.delete();
      f.writeSync(text);
      await Sharing.shareAsync(f.uri, { mimeType, UTI: UTIS[mimeType] ?? 'public.data', dialogTitle: fileName });
      return;
    }
  } catch {
    // fall back to sharing the text itself
  }
  await Share.share({ message: text, title: fileName });
}
