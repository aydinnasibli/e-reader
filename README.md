# Nec e-book reader

An e-reader for iPhone and Android that opens very large EPUB, FB2, MOBI/AZW3
and TXT files without freezing. Built with Expo (React Native) and TypeScript.

## Try it on your phone

1. Install **Expo Go** from the App Store or Google Play.
2. On your computer (Node 20+):
   ```sh
   npm install
   npx expo start
   ```
3. Scan the QR code: with the Camera app on iPhone, or from inside Expo Go on Android.
   Phone and computer must be on the same Wi-Fi. If they can't see each other, use
   `npx expo start --tunnel`.
4. Tap **Add** and pick some books from Files / Downloads.

Tapping the middle of a page shows the menu (contents, search, bookmarks,
display settings, progress slider). Tap the left or right edge, or swipe, to
turn pages. Long-press a word to select it (drag the handles to select more),
then copy, look it up, translate or share it. The menu's Highlight tool marks
text like a highlighter: tap or drag over it, and add a note to what you
marked. Long-press a book in the library for its options.

Books can also be opened from other apps ("Open with" on Android, "Open in" /
Share on iPhone). The library's View menu backs up highlights, notes and
reading places to a file and restores them on any phone, and shows the crash
log if the app ever hit an error.

## Android app (APK) and updates

Every push to `main` builds a signed APK on GitHub Actions and publishes it as
a release (`build-<n>`, asset `nec-reader.apk`). Install it once from the
latest release; after that the app shows **Update** whenever a newer build is
published, downloads it and opens Android's installer.

The update number (Android `versionCode`) is the workflow's run number. If the
workflow is ever recreated or the repository moved, numbering restarts and
Android refuses the "older" version, so keep the workflow file in place.

## How big books stay fast

Most readers load a whole chapter (or book) into a web view and lay it all out
before showing anything; a single 40 MB chapter is enough to hang them.

This app draws its pages in a web view too, but:

1. **Converts each book once, as a stream.** The file is read 64 KB at a time,
   decoded, parsed and written out as small chunk files (~30,000 characters each)
   in a simple block format. A file is never loaded into memory whole, and
   images inside EPUBs are only extracted when shown.
2. **Lets you start reading immediately.** The first chunk is ready within a
   moment; the rest is converted in the background while you read.
3. **Only lays out what's near.** The reader page (a small HTML page in a
   WebView, `src/reader/web/page/`) holds the current chunk and its
   neighbours: in page mode laid out in CSS columns one screen wide, in scroll
   mode one under another. Chunks are added and dropped as you read. Page
   30,000 costs the same as page 3.

## Project layout

```
src/engine/           format conversion (EPUB, FB2, TXT, MOBI/AZW3), no React; runs in Node for tests
src/lib/              storage, library and settings
src/reader/           the reader: menus, sheets, settings panel, page numbers
src/reader/web/       the WebView reader: blocks as HTML, the look as CSS, messages to the page
src/reader/web/page/  the page inside the WebView (built into page.generated.ts)
src/app/              screens (Expo Router)
test/                 unit tests (vitest); test/ui/ screen tests (jest + React Native Testing Library)
bench/                stress benchmark for huge books; bench/webpage/ the reader page in browser engines
```

## Development

```sh
npx tsc --noEmit   # typecheck
npx expo lint      # lint
npm test           # unit tests and screen tests
npm run build:page # after changing src/reader/web/page/ (a test fails if it's stale)
npm run test:page  # the reader page in Chromium (Android's engine) and WebKit (iPhone's)
```

### Stress benchmark

`bench/` builds huge synthetic books (100 MB TXT, a 315 MB EPUB with a 40 MB
chapter, an 83 MB FB2, a 30 MB MOBI...) and converts them, reporting time,
memory and the longest freeze. It can run under Hermes, the JavaScript engine
React Native uses on phones:

```sh
npm install --no-save hermes-engine-cli@0.12.0
node bench/run.mjs node
HERMES=node_modules/hermes-engine-cli/linux64-bin/hermes node bench/run.mjs hermes
```

(Use the `osx-bin` folder on macOS.)
