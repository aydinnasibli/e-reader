// app.json: Android offers the app for book files handed over as content://
// links. Not file:// ones: other apps may not send those since Android 7, and
// this app has no storage permission to read one, so being offered for them
// only ever ended in "Couldn't open this file".

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

type Data = { scheme?: string; mimeType?: string };
const app = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as {
  expo: { android: { intentFilters: { action: string; data: Data[] }[]; blockedPermissions: string[] } };
};
const openWith = app.expo.android.intentFilters.find((f) => f.action === 'VIEW')!;

it('"Open with" takes content:// links only, for book files and the types they often come as', () => {
  expect(openWith.data.filter((d) => d.scheme).map((d) => d.scheme)).toEqual(['content']);
  const types = openWith.data.flatMap((d) => d.mimeType ?? []);
  // FB2 and MOBI usually arrive as octet-stream; zipped FB2 as zip; the app looks at the bytes either way.
  for (const t of ['application/epub+zip', 'application/x-fictionbook+xml', 'application/x-mobipocket-ebook', 'text/plain', 'application/zip', 'application/octet-stream']) {
    expect(types).toContain(t);
  }
  expect(app.expo.android.blockedPermissions).toContain('android.permission.READ_EXTERNAL_STORAGE');
});
