# Nec Reader

An e-reader for iPhone and Android that opens very large EPUB, FB2, MOBI/AZW3
and TXT files without freezing. Built with Expo (React Native) and TypeScript.

## Try it on your phone

1. Install **Expo Go** from the App Store or Google Play.
2. On your computer (Node 22.13 or later, or 24.3 or later; the builds use 24):
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

Searching (in a book, in the library and in Highlights & notes) ignores
capitals, accents and the Turkish dotted and dotless i: "istanbul" finds
"İstanbul" and "kirmizi" finds "Kırmızı". Page numbers are fixed for a given
look (text size, font, spacing, margins, page or scroll): page 40 is always
the same place, and changing the look switches to that look's own numbers.

A book's language decides how words are hyphenated, which dictionary Look Up
uses and what translations start from. It comes from the book, or is guessed
from its text; to set it by hand, long-press the book → Details → Language.

Books can also be opened from other apps ("Open with" on Android, "Open in" /
Share on iPhone; on iPhone only in the real build below, not in Expo Go). The
library's View menu backs up highlights, notes and reading places to a file
and restores them on any phone, and shows the crash log if the app ever hit
an error.

## Android app (APK) and updates

Every push to `main` builds a signed APK on GitHub Actions and publishes it as
a release (`build-<n>`, asset `nec-reader.apk`). Install it once from the
latest release; after that the app shows **Update** whenever a newer build is
published, downloads it and opens Android's installer.

If a build has a bug that crashes the app while it draws a screen, the error
screen it shows has **Check for updates** too, so the next build can still be
installed.

The update number (Android `versionCode`) is the workflow's run number. If the
workflow is ever recreated or the repository moved, numbering restarts and
Android refuses the "older" version, so keep the workflow file in place.

The app's id is `com.aydinnasibli.nec` (app.json, both phones). Builds up to
build-27 were `com.nec.ebookreader`, so the first build after the rename
installs as a separate, empty app (the old one's **Update** still downloads it
and opens the installer): add the books to the new one, then uninstall the old
one. Changing the id again would do the same.

## iPhone app (a real build)

Expo Go is enough to try the app, but a build of its own on the iPhone starts
faster, keeps working without the computer, and can open books from Files,
Mail or Telegram ("Open in" / Share), which Expo Go can't. A free Apple ID is
enough; it is built on this Mac with Xcode.

Once:

1. Install **Xcode** from the Mac App Store and open it once: accept the
   licence and, when it asks which platforms to install, include **iOS**
   (later: Xcode → Settings → Components).
2. Make the command-line tools use it, and install CocoaPods (Homebrew is
   already on this Mac):
   ```sh
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   brew install cocoapods
   ```
3. Sign in with your Apple ID: Xcode → Settings → Accounts → + → Apple ID.
   It shows up as "(Personal Team)". Select it → **Manage Certificates…** →
   + → **Apple Development**, so there is a certificate to sign the app with.
4. Connect the iPhone with a cable, unlock it and tap **Trust**. Turn on
   **Developer Mode** on the iPhone: Settings → Privacy & Security →
   Developer Mode (it restarts; tap Turn On afterwards).

Build and install:

```sh
npm install
npm run ios:device   # npx expo run:ios --device --configuration Release
```

Pick the iPhone from the list. The first run creates the `ios` folder
(generated from `app.json`; it isn't committed, never edit it) and takes a
while. It builds the release version, with the JavaScript inside: the phone
doesn't need the computer afterwards.

- If it stops because nothing can sign the app: run `xed ios`, select the
  **Necebookreader** target → **Signing & Capabilities**, tick *Automatically
  manage signing*, choose your Personal Team, press ▶ once with the iPhone
  selected, then run `npm run ios:device` again.
- If Xcode says the bundle identifier isn't available, change
  `ios.bundleIdentifier` in `app.json` to another name only you use.
- The first time the app opens, the iPhone calls it an untrusted developer:
  Settings → General → VPN & Device Management → your Apple ID → **Trust**.

Every 7 days the free Apple ID's permission runs out and the app stops
opening: connect the iPhone and run `npm run ios:device` again. Installing
over the app keeps its books, highlights and settings. A newer version is
installed the same way (`git pull`, `npm install`, `npm run ios:device`); the
iPhone app doesn't update itself like the Android one. (A free Apple ID can
have 3 apps of its own on a phone.)

Moving from Expo Go: in Expo Go, Library → View → **Back up highlights &
notes** and save the file (to Files, for instance). In the new app, View →
**Restore a backup…** and pick that file, then add the book files again:
each book's highlights, notes and reading place come back as it is added.

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

Node 22.13 or later (or 24.3+). CI runs Node 24.

```sh
npx tsc --noEmit   # typecheck
npx expo lint      # lint
npm test           # unit tests and screen tests
npm run build:page # after changing src/reader/web/page/ (a test fails if it's stale)
npm run test:page  # the reader page in Chromium (Android's engine) and WebKit (iPhone's)
```

### Stress benchmark

`bench/` builds huge synthetic books (100 MB TXT, a 315 MB EPUB with a 40 MB
chapter, an 83 MB FB2, a 30 MB MOBI, a 30 MB Turkish TXT in windows-1254...)
and converts them, reporting time, memory and the longest freeze. It can run
under Hermes, the JavaScript engine React Native uses on phones:

```sh
npm install --no-save hermes-engine-cli@0.12.0
node bench/run.mjs node
HERMES=node_modules/hermes-engine-cli/linux64-bin/hermes node bench/run.mjs hermes
BENCH_ONLY=txt1254 node bench/run.mjs node   # only some books (txt, epub, txt1254, ...)
```

(Use the `osx-bin` folder on macOS.)
