// The reader: the book drawn as HTML in a WebView (page or scroll mode; see
// src/reader/web/page), with the page header and footer drawn natively around
// it. The browser lays out the text and turns the pages; the page selects
// text itself, with its own handles (page/selection.ts), so the phone never
// puts a menu of its own over a selection. Only the chunks around the place
// read are ever in the page.

import Ionicons from '@expo/vector-icons/Ionicons';
import { File, Paths } from 'expo-file-system';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { Position } from '@/engine/types';
import { recordCrash } from '@/lib/crashLog';
import type { ReaderSettings, Theme } from '@/lib/settings';
import { Tap } from '@/ui/Tap';
import type { BookData, ImageInfo } from '../book';
import type { Mark } from '../marks';
import { PageNumbers, measure, roughMeasure, typicalChunks, typicalWeight } from '../pageNumbers';
import { loadPageSizes, savePageSizes } from '../pageStore';
import { drawn, layoutKeyOf, lookOf, toBlock, toDrawn } from '../look';
import type { TextPoint } from '../selection';
import { Battery, Clock, ClockBattery } from '../StatusInfo';
import { breather } from '../breather';
import { bookCss } from './css';
import { chunkHtml, chunkHtmlSliced } from './html';
import { PAGE_HTML, PAGE_SOURCE_HASH } from './page.generated';
import { FOOTER, HEADER, META_SCALE, webFrame } from './frame';
import type { Chunk, DrawnPoint, FromPage, PageCaret, PageCounts, PageMark, Target, ToPage } from './protocol';
import { webFont } from './webFonts';

/** A selection on the page: its first and last character, and where its ends are on screen (window coordinates). */
export interface PageSelection {
  a: TextPoint;
  z: TextPoint;
  start: PageCaret;
  end: PageCaret;
}

export interface PageInfo {
  /** The number of the page shown, and of the last one showing (the right-hand page of a two-page spread). */
  page: number;
  last: number;
  total: number;
  /** The total is an estimate: the book is still being converted. */
  approx: boolean;
  /** The layout's numbering: the page any place is on, and where any page is. */
  numbers: PageNumbers;
  /** The layout the numbers are for. */
  key: string;
}

/** A piece of the highlight tool's drag: block `b`, characters [s, e). */
export type StrokeMark = Mark & { b: number };

/** The window and the safe-area insets around it. */
export type Area = { width: number; height: number; top: number; bottom: number; left: number; right: number };

interface Props {
  book: BookData;
  /** The book's language (a two-letter code): hyphenation and the page's own language rules. */
  lang?: string;
  settings: ReaderSettings;
  theme: Theme;
  /**
   * The window and insets the book is laid out for (see useReadingArea);
   * nothing is laid out until `settled`, and a layout's page size is only
   * measured while `steady` (not in the moments a rotation takes to settle).
   */
  area: Area;
  settled: boolean;
  steady?: boolean;
  /** Where to open. Changing `startKey` jumps there. */
  start: Position;
  startKey: number;
  /** A jump to a page by its number (page mode): that page, rather than the one holding `start`. */
  startPage?: number;
  /** Bumped whenever the book grows (still converting) or finishes. */
  version: number;
  /**
   * The first and last position shown. `turned`: the reader got there by
   * reading on (a page turn, scrolling), not by a jump or the page being laid
   * out again; `turnedToLast`: a page turn arrived at the book's last page.
   */
  onPosition(pos: Position, end: Position | undefined, turned: boolean, turnedToLast: boolean): void;
  onTap(): void;
  /** Highlights and search hits for a block (the selection is drawn by the page itself). */
  marksFor?(b: number): Mark[] | undefined;
  /** The highlight tool's drag as it goes, in book offsets: drawn over the marks, sent on its own. */
  stroke?: StrokeMark[] | null;
  onLink?(target: string): void;
  bookmarked?: boolean;
  footerRight?: string;
  /** Called with the layout key once a page of that layout is on screen. */
  onLayoutReady?(key: string): void;
  onPageInfo?(info: PageInfo | null): void;
  /** Turn requests from outside (auto page turn); `n` increments per request. */
  turn?: { dir: 1 | -1; n: number };
  /** A forward turn on the book's last page. */
  onEnd?(): void;
  /** Scroll mode: auto-scroll speed in points per second; 0 = off. */
  autoScroll?: number;
  onAutoInterrupt?(): void;
  onAutoEnd?(): void;
  /** Scroll mode: the end of the book came into view. */
  onReachEnd?(): void;
  /** The highlight tool is out: touches mark text. */
  marking?: boolean;
  onMarkTap?(at: TextPoint | null): void;
  onMarkDrag?(from: TextPoint | null, to: TextPoint | null, done: boolean): void;
  /** Text selected on the page (a long press, then its handles), or null when it ends. */
  onSelection?(sel: PageSelection | null): void;
  /** Whether a selection is shown (false ends one the page still has). */
  selected?: boolean;
}

/** How long a change in the window's height or the insets must hold before the book is laid out for it. */
const SETTLE_MS = 300;
/**
 * After the system bars go (the menu closed, the Display panel opened), their
 * insets take a while to go too, in steps (the status bar, then the
 * navigation bar): what they are in between isn't taken until this long after.
 */
const BARS_GONE_MS = 1000;

/**
 * The size and safe-area insets the book is laid out for. The system bars
 * are hidden as the reader opens and shown with the menu, which changes the
 * insets on many phones (the status bar on an iPhone SE or on Android, the
 * navigation bar on Android, at the side of a phone on its side); laying the
 * book out again for that would move the text and change the page numbers.
 * So a change of width (rotation, split screen, a fold) is taken at once, any
 * other only once it has held for a moment with the bars hidden (longer just
 * after they went: their insets go in steps). `settled`:
 * the area has held since the reader opened, so the book is laid out once,
 * for the bars already hidden. `steady`: nothing is still settling (the
 * insets that come a moment after a rotation).
 *
 * `size` is the reader's own size, once laid out: on Android the window's
 * size leaves out the navigation bar even while it's hidden and the reader
 * goes under where it was, so the page would end short of the screen's foot
 * (and the bars drawn over the page's foot would cover its page number).
 */
export function useReadingArea(barsShown: boolean, size?: { width: number; height: number } | null): { area: Area; settled: boolean; steady: boolean } {
  const win = useWindowDimensions();
  const live = useSafeAreaInsets();
  const now: Area = { width: size?.width ?? win.width, height: size?.height ?? win.height, top: live.top, bottom: live.bottom, left: live.left, right: live.right };
  const nowRef = useRef(now);
  nowRef.current = now;
  const [area, setArea] = useState(now);
  const [settled, setSettled] = useState(false);
  /** When the bars last went away (0: not since the reader opened, when they're hidden from the start). */
  const barsGone = useRef(0);
  const barsWere = useRef(barsShown);
  useEffect(() => {
    if (barsWere.current && !barsShown) barsGone.current = Date.now();
    barsWere.current = barsShown;
  }, [barsShown]);
  /** A rotation (or the like) was laid out for at once; what comes with it is still arriving. */
  const [turning, setTurning] = useState(false);
  const across = now.width !== area.width;
  if (across) {
    setArea(now);
    setTurning(true);
  }
  const changed =
    !across && (now.height !== area.height || now.top !== area.top || now.bottom !== area.bottom || now.left !== area.left || now.right !== area.right);
  useEffect(() => {
    if (barsShown || (settled && !changed && !turning)) return;
    const t = setTimeout(
      () => {
        setArea(nowRef.current);
        setSettled(true);
        setTurning(false);
      },
      Math.max(SETTLE_MS, barsGone.current + BARS_GONE_MS - Date.now()),
    );
    return () => clearTimeout(t);
  }, [barsShown, changed, settled, turning, now.height, now.top, now.bottom, now.left, now.right]);
  return { area: across ? now : area, settled, steady: settled && !turning && !(changed && !barsShown) };
}

/** UTF-8 length of a string, to check a written file holds all of it. */
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * The page's HTML, written once per version where the WebView may read it
 * with the book's files (images, fonts): written whole or not at all, and
 * written again if what's there isn't all of it (the app stopped mid-write).
 * If it can't be written (storage full), or `inline`, the HTML is given
 * directly: the text still shows.
 */
function pageSource(inline: boolean): { uri: string } | { html: string; baseUrl: string } {
  if (!inline) {
    try {
      const f = new File(Paths.document, 'reader', `page-${PAGE_SOURCE_HASH}.html`);
      if (!f.exists || f.size !== utf8Length(PAGE_HTML)) {
        if (!f.parentDirectory.exists) f.parentDirectory.create({ intermediates: true, idempotent: true });
        const tmp = new File(f.parentDirectory, `${f.name}.tmp`);
        tmp.writeSync(PAGE_HTML);
        tmp.moveSync(f, { overwrite: true });
      }
      return { uri: f.uri };
    } catch {
      // Given directly below.
    }
  }
  return { html: PAGE_HTML, baseUrl: Paths.document.uri };
}

/** Chunks kept around the one read: the one before and the one after. */
const AROUND = 1;
/** Chunks' HTML kept ready: what the page holds, and a few it held last. */
const HTML_KEPT = 8;
/** The page says it's ready within this long, or it's loaded another way (then given up on). */
const READY_MS = 10_000;
/** The page's process dying again this soon after it was started again: something is wrong with the book's page. */
const DIED_AGAIN_MS = 10_000;
/** Laid out for another width (the phone turned): the page is covered until it's drawn for this one, or this long at most. */
const COVER_MS = 10_000;

/**
 * What a chunk is made for: to be shown (opening, a jump, the page waiting
 * at its edge: made at once), ahead of the reader, or to measure a layout on
 * (both in the background, in pieces with pauses).
 */
type ChunkUse = 'show' | 'ahead' | 'measure';

/** Every origin passes the WebView's own check; onlyBookFiles decides (react-native-webview opens a URL that fails it in the browser). */
const ORIGINS = ['*'];
/** Only the page itself and the book's own files: nothing in a book navigates away. */
const onlyBookFiles = (r: { url: string }) => r.url.startsWith('file:') || r.url.startsWith('about:');
const isWide = (a: { width: number; height: number }) => a.width > a.height;

/** The layout part of a key sent to the page (`<layout>#<content>`). */
const layoutOf = (key: string) => key.slice(0, key.lastIndexOf('#'));
/** Where a layout's page size is saved: for this build of the page (one that lays out differently is measured again). */
const sizeKey = (unit: string, layout: string) => `${unit}|${PAGE_SOURCE_HASH}|${layout}`;

export const WebReader = memo(function WebReader(props: Props) {
  const { book, lang, settings, theme, area, start, startKey, version, bookmarked, footerRight } = props;
  const mode = settings.mode;
  const { fontSize, font, letterSpacing } = settings;
  const frame = useMemo(() => webFrame(area, area, settings.margin, mode, { fontSize, font, letterSpacing }), [area, settings.margin, mode, fontSize, font, letterSpacing]);
  const web = useRef<Pick<WebView, 'injectJavaScript' | 'reload'> | null>(null);
  // Where the page comes from: its file, or (if that didn't load) its HTML given directly.
  const [inline, setInline] = useState(false);
  const source = useMemo(() => pageSource(inline), [inline]);
  // A new WebView is made (a new key) when Android's renderer process dies: the old one can't be used again.
  const [webKey, setWebKey] = useState(0);
  /** The page couldn't be shown: what to say. */
  const [broken, setBroken] = useState<string | null>(null);
  const win = useWindowDimensions();
  const { fontScale } = win;

  // ---- covered while laid out for another width ----
  /**
   * The width (and mode) the text is laid out for, and the one it was last
   * drawn for. When the phone turns, the WebView takes its new size at once
   * but its text only comes in its new layout a while later (the screen tells
   * the page, the page lays it out again): until then it's covered, rather
   * than show the old layout cut off or in half the screen (the page hides it
   * too, from the moment its size changes: page/main.ts). Also while the
   * window has turned and the reader's own size hasn't caught up yet. Not for
   * a change of height or of the insets (the system bars): the old layout
   * still fits the screen then, near enough, for the moment it takes.
   */
  const geometry = `${mode}|${frame.width}`;
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;
  const [drawnFor, setDrawnFor] = useState(geometry);
  const turningOver = isWide(win) !== isWide(area);
  const waitingFor = drawnFor !== geometry || turningOver ? `${geometry}|${turningOver}` : null;
  /** A cover that has been up COVER_MS: taken off anyway (the page may never draw). */
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  useEffect(() => {
    if (!waitingFor) return;
    const t = setTimeout(() => setGaveUp(waitingFor), COVER_MS);
    return () => clearTimeout(t);
  }, [waitingFor]);
  const covered = !!waitingFor && gaveUp !== waitingFor;

  // The latest props, for the message handler (which is created once).
  const latest = useRef(props);
  latest.current = props;

  // ---- drawn points <-> book positions ----
  const looks = useCallback(
    (b: number) => {
      const blk = book.block(b);
      return blk ? drawn(blk, lookOf(blk, settings, lang)) : null;
    },
    [book, settings, lang],
  );
  const looksRef = useRef(looks);
  looksRef.current = looks;
  const toBook = (p: DrawnPoint): Position => {
    const d = looksRef.current(p.b);
    return { b: p.b, o: d ? toBlock(d, p.i) : 0 };
  };
  const toPage = (p: Position): DrawnPoint => {
    const d = looksRef.current(p.b);
    return { b: p.b, i: d ? toDrawn(d, p.o) : 0 };
  };

  // ---- talking to the page ----
  const ready = useRef(false);
  const send = useCallback((m: ToPage) => {
    if (!ready.current) return;
    web.current?.injectJavaScript(`window.__nec&&window.__nec(${JSON.stringify(m)});true;`);
  }, []);
  /**
   * Bumped whenever what the page holds is replaced (a jump, a new page):
   * chunks still being prepared for what it held before aren't sent.
   */
  const gen = useRef(0);
  /**
   * What the page was given last, as the key it says it with: the layout
   * (setup) and the content it laid out, `<layout>#<content>`. What it says
   * about anything older (a page turned before it got a jump) is out of date.
   */
  const pageKey = useRef('');
  const pageLayout = useRef('');
  const pageContent = useRef(0);
  /** Layouts being measured on typical chunks of the book, and the page set-up each was asked of. */
  const measuring = useRef(new Map<string, string>());

  // ---- chunks ----
  /** What the chunks' HTML depends on besides the book. */
  const htmlKey = `${settings.indent}|${settings.hyphenate}|${lang ?? ''}`;
  const htmlCache = useRef(new Map<string, Promise<Chunk>>());
  /** Chunks drawn without pictures that weren't there yet (still converting): drawn again when the book is complete. */
  const missingPictures = useRef(new Set<number>());
  /** Chunks being made in the background that are now wanted on screen: made the rest of the way without pauses. */
  const hurry = useRef(new Set<number>());
  const makeChunk = useCallback(
    async (c: number, use: ChunkUse): Promise<Chunk> => {
      // The chunk's blocks are kept in the book's memory while it's on the page: its text is read from there.
      // A chunk only measured on: a damaged one fails here instead of stopping the book.
      const blocks = await (use === 'measure' ? book.tryLoadChunk(c) : book.loadChunk(c));
      const key = `${c}|${htmlKey}`;
      const cache = htmlCache.current;
      let p = cache.get(key);
      if (p) {
        cache.delete(key);
        cache.set(key, p);
        return p;
      }
      // On screen: made at once (a pause there waits for the next frame: twice as long or more). In the
      // background: its pictures taken out and its paragraphs hyphenated in pieces, the app answering between them.
      const pause = use === 'show' ? undefined : breather(() => hurry.current.has(c));
      p = (async () => {
        const images = new Map<string, ImageInfo | null>();
        await Promise.all(blocks.filter((b) => b.k === 'img' && b.s).map(async (b) => images.set(b.s!, await book.imageInfo(b.s!, pause).catch(() => null))));
        if (!book.complete && [...images.values()].some((i) => !i)) {
          missingPictures.current.add(c);
          cache.delete(key);
        }
        const settings = latest.current.settings;
        const html = pause ? await chunkHtmlSliced(blocks, book.chunkStart(c), settings, lang, images, pause) : chunkHtml(blocks, book.chunkStart(c), settings, lang, images);
        return { c, html, chars: book.chunkChars(c), joins: book.joins(c) };
      })();
      cache.set(key, p);
      p.catch(() => cache.delete(key));
      while (cache.size > HTML_KEPT) cache.delete(cache.keys().next().value!);
      return p;
    },
    [book, htmlKey, lang],
  );
  const chunkOf = useCallback(
    async (c: number, use: ChunkUse = 'show'): Promise<Chunk> => {
      if (use !== 'show') return makeChunk(c, use);
      hurry.current.add(c);
      try {
        return await makeChunk(c, use);
      } finally {
        hurry.current.delete(c);
      }
    },
    [makeChunk],
  );
  const chunkOfRef = useRef(chunkOf);
  chunkOfRef.current = chunkOf;
  useEffect(() => htmlCache.current.clear(), [htmlKey]);

  /** Chunks the page has now. */
  const shown = useRef(new Set<number>());
  const setShown = useCallback(
    (cs: Iterable<number>) => {
      shown.current = new Set(cs);
      book.keep(shown.current);
    },
    [book],
  );
  /** Chunks asked for that aren't converted yet. */
  const wanted = useRef(new Set<number>());

  const addChunks = useCallback(
    async (cs: number[], use: 'show' | 'ahead') => {
      const g = gen.current;
      const fresh = cs.filter((c) => c >= 0 && !shown.current.has(c));
      for (const c of fresh) if (c >= book.chunkCount) wanted.current.add(c);
      const have = fresh.filter((c) => c < book.chunkCount);
      if (!have.length) return;
      setShown([...shown.current, ...have]);
      const chunks = await Promise.all(have.map((c) => chunkOf(c, use)));
      // The page was given other chunks meanwhile (a jump), or dropped some of these (read back from): not added.
      const still = chunks.filter((ch) => shown.current.has(ch.c));
      if (g !== gen.current || !still.length) return;
      send({ t: 'add', chunks: still });
      sendMarksRef.current();
    },
    [book, chunkOf, send, setShown],
  );

  /** Keep the chunks around `c` in the page, and drop the ones far away. */
  const around = useCallback(
    (c: number) => {
      const far = [...shown.current].filter((x) => Math.abs(x - c) > AROUND + 1);
      if (far.length) {
        setShown([...shown.current].filter((x) => !far.includes(x)));
        send({ t: 'drop', chunks: far });
      }
      const near: number[] = [];
      for (let x = c - AROUND; x <= c + AROUND; x++) if (x >= 0) near.push(x);
      // Ahead of the reader: made in the background (the page asks for one it reaches first: 'need').
      void addChunks(near, 'ahead');
    },
    [addChunks, send, setShown],
  );

  // ---- the place read ----
  /**
   * The place kept across layout changes: where the reader last arrived (a
   * page turn, a jump, opening the book), not the start of the page shown
   * after a change, which is up to a page earlier.
   */
  const anchor = useRef<Position>(start);
  const [shownAt, setShownAt] = useState<Position>(start);
  /** The first point on the page shown, as the page gave it, and the layout it's in. */
  const lastShown = useRef<{ first: DrawnPoint; layout: string } | null>(null);
  /** Opening at a place not converted yet: wait for it. */
  const waitingForPlace = !book.complete && start.b >= book.totalBlocks;

  // ---- marks ----
  const marksFor = props.marksFor;
  const sendMarks = useCallback(() => {
    const out: PageMark[] = [];
    for (const c of shown.current) {
      for (let b = book.chunkStart(c); b < book.chunkEnd(c); b++) {
        const ms = marksFor?.(b);
        if (!ms?.length) continue;
        const d = looks(b);
        if (!d) continue;
        for (const m of ms) out.push({ b, s: toDrawn(d, m.s), e: toDrawn(d, m.e), color: m.color });
      }
    }
    send({ t: 'marks', marks: out });
  }, [book, marksFor, looks, send]);
  // Chunks are added and jumps land after awaiting their HTML: the marks of then, not of when they started.
  const sendMarksRef = useRef(sendMarks);
  sendMarksRef.current = sendMarks;
  useEffect(() => sendMarks(), [sendMarks]);
  // The highlight tool's drag, as it goes: only itself is drawn again, not every mark.
  const stroke = props.stroke;
  useEffect(() => {
    const out: PageMark[] = [];
    for (const m of stroke ?? []) {
      const d = looks(m.b);
      if (d) out.push({ b: m.b, s: toDrawn(d, m.s), e: toDrawn(d, m.e), color: m.color });
    }
    send({ t: 'stroke', marks: out });
  }, [stroke, looks, send]);

  /** Put the chunks around chunk `c` in the page and show the target (made once they're loaded: drawn offsets need the blocks). */
  const showIn = useCallback(
    async (c: number, target: () => Target) => {
      const g = ++gen.current;
      const cs: number[] = [];
      for (let x = c - AROUND; x <= c + AROUND; x++) if (x >= 0 && x < book.chunkCount) cs.push(x);
      const chunks = await Promise.all(cs.map((x) => chunkOf(x)));
      // A later jump, or a new page, took over meanwhile.
      if (g !== gen.current || !ready.current) return;
      setShown(cs);
      pageContent.current = g;
      pageKey.current = `${pageLayout.current}#${g}`;
      send({ t: 'bounds', count: book.chunkCount, complete: book.complete });
      send({ t: 'content', chunks, target: target(), key: pageKey.current });
      sendMarksRef.current();
    },
    [book, chunkOf, send, setShown],
  );
  /** Show `at`; `top`: on a page of its own (see Target). */
  const showAt = (at: Position, top: boolean) => showIn(book.chunkOf(at.b), () => ({ at: toPage(at), top }));
  /** Jumped to a page by number: the place kept is where it lands. */
  const toPageNumber = useRef(false);

  // ---- setup: fonts, sizes, colours, frame ----
  /** Everything that changes where lines and pages break. */
  const layoutKey = [mode, layoutKeyOf(settings), lang ?? '', frame.width, frame.height, frame.left, frame.right, frame.top, frame.bottom].join('|');
  /** What changes only how the page looks or answers: no text moves. */
  const lookKey = [theme.bg, theme.text, theme.accent, theme.muted, settings.pageTurn, settings.tapForward].join('|');
  const layoutKeyRef = useRef(layoutKey);
  layoutKeyRef.current = layoutKey;
  const sendSetup = useCallback(
    async (target: Target) => {
      const font = await webFont(settings.font).catch(() => ({ css: '', family: 'serif', medium: false }));
      if (!ready.current) return;
      pageLayout.current = layoutKey;
      pageKey.current = `${layoutKey}#${pageContent.current}`;
      // A measure asked of another set-up isn't answered if this one reached the page first (page/main.ts): asked again.
      for (const [k, asked] of measuring.current) if (asked !== pageKey.current) measuring.current.delete(k);
      send({
        t: 'setup',
        key: pageKey.current,
        target,
        setup: {
          mode,
          frame,
          css: bookCss(settings, theme, frame, font, mode),
          turn: settings.pageTurn,
          tapForward: settings.tapForward,
          // No percentage here: the page keeps this text, which would soon be out of date.
          processing: 'Still preparing the rest of this book…',
          theEnd: '— The End —',
          lang,
        },
      });
    },
    [layoutKey, lookKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /**
   * The highlight tool and auto-scroll, told again to a page set up afresh
   * (loaded again, or in the other mode): it has no view to give them to
   * before its setup, and drops them.
   */
  const sendState = () => {
    const p = latest.current;
    send({ t: 'tool', marking: !!p.marking });
    if (p.settings.mode === 'scroll') send({ t: 'auto', speed: p.autoScroll ?? 0 });
  };

  // First load (and a page loaded again): set up, then the content. Not before
  // the reading area has settled: the book would be laid out twice.
  const [loads, setLoads] = useState(0);
  /** What the page was last set up with. */
  const sent = useRef<{ layout: string; look: string; mode: string } | null>(null);
  useEffect(() => {
    if (!loads || !props.settled || waitingForPlace) return;
    let alive = true;
    sent.current = { layout: layoutKey, look: lookKey, mode };
    void (async () => {
      await sendSetup({ at: toPage(anchor.current), top: true });
      if (!alive) return;
      sendState();
      await showAt(anchor.current, true);
    })();
    return () => {
      alive = false;
    };
  }, [loads, props.settled, waitingForPlace]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settings changed: lay out again at the same place. A change of the
  // chunks' HTML, or of the mode (the page starts empty), sends them again.
  // Colours and the like only restyle the page shown.
  useEffect(() => {
    const was = sent.current;
    if (!ready.current || !was || waitingForPlace) return;
    sent.current = { layout: layoutKey, look: lookKey, mode };
    if (layoutKey !== was.layout) {
      void (async () => {
        await sendSetup({ at: toPage(anchor.current), top: true });
        if (mode === was.mode) return;
        sendState();
        await showAt(anchor.current, true);
      })();
    } else if (lookKey !== was.look) {
      const at = lastShown.current?.first;
      void sendSetup(at ? { at } : { at: toPage(anchor.current) });
    }
  }, [layoutKey, lookKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const firstHtml = useRef(true);
  useEffect(() => {
    if (firstHtml.current) {
      firstHtml.current = false;
      return;
    }
    if (ready.current && sent.current && !waitingForPlace) void showAt(anchor.current, true);
  }, [htmlKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- page numbers ----
  /** The page size measured for each layout (see pageNumbers.ts), as saved with the book. */
  const sizes = useRef<Map<string, number> | null>(null);
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const pageInfoRef = useRef(pageInfo);
  pageInfoRef.current = pageInfo;
  /** The last page numbers the page reported, and the layout they're in. */
  const pagesMsg = useRef<{ m: PageCounts; layout: string } | null>(null);
  const numbersCache = useRef<{ key: string; numbers: PageNumbers } | null>(null);
  /** Kept for good: page N means the same place from now on, in this layout. */
  const keepSize = useCallback((key: string, per: number) => {
    const bk = latest.current.book;
    if (!sizes.current) sizes.current = loadPageSizes(bk.entry.id, bk.complete ? bk.estimatedWeight : undefined);
    sizes.current.delete(key);
    sizes.current.set(key, per);
    savePageSizes(bk.entry.id, sizes.current, bk.complete ? bk.estimatedWeight : undefined);
  }, []);
  /** Layouts whose typical chunks can't be read (a damaged chunk): measured on the chunks laid out instead. */
  const unmeasurable = useRef(new Set<string>());
  /** Ask the page to lay out chunks like most of the book out of sight, to measure layout `key` on (see typicalChunks). */
  const measureLayout = useCallback(
    (key: string, picks: number[]) => {
      const asked = pageKey.current;
      // Asked once per set-up: one asked of an older one (the page was set up again since) got no answer.
      if (measuring.current.get(key) === asked) return;
      measuring.current.set(key, asked);
      void Promise.all(picks.map((c) => chunkOfRef.current(c, 'measure'))).then(
        (chunks) => {
          // Drawn without pictures still to come (converting), they'd take fewer pages than they will:
          // measured again once the book is complete.
          if (chunks.some((ch) => missingPictures.current.has(ch.c))) return;
          if (pageKey.current === asked) send({ t: 'measure', key: asked, chunks });
        },
        () => {
          measuring.current.delete(key);
          unmeasurable.current.add(key);
          updatePagesRef.current();
        },
      );
    },
    [send],
  );
  const updatePages = useCallback(() => {
    const pm = pagesMsg.current;
    if (!pm) return;
    const { m, layout } = pm;
    const p = latest.current;
    const bk = p.book;
    const key = sizeKey(bk.weightUnit, layout);
    if (!sizes.current) sizes.current = loadPageSizes(bk.entry.id, bk.complete ? bk.estimatedWeight : undefined);
    let per = sizes.current.get(key);
    if (per === undefined) {
      // Measured on chunks that start a page of their own (one going on from the one before shares its first page).
      const samples = m.counts.filter((x) => x.c < bk.chunkCount && !bk.joins(x.c)).map((x) => ({ weight: bk.chunkWeight(x.c), pages: x.pages }));
      const measured = measure(samples, typicalWeight(bk.chunkWeights()));
      const picks = unmeasurable.current.has(key) ? [] : typicalChunks(bk.chunkWeights(), Array.from({ length: bk.chunkCount }, (_, c) => bk.chunkChars(c)));
      // Only kept from chunks drawn with all their pictures, in an area that has stopped changing (not mid-rotation).
      const keepable = !!p.steady && !m.counts.some((x) => missingPictures.current.has(x.c));
      if (picks.length) {
        // Measured on chunks like most of the book, wherever it was opened: what the
        // chunks laid out say meanwhile, for the moment it takes (not kept).
        if (p.steady) measureLayout(key, picks);
        per = measured ?? roughMeasure(samples) ?? 1;
      } else if (measured && keepable) {
        // A book of a few chunks (or one that can't be measured otherwise): the ones laid out are all there is.
        per = measured;
        keepSize(key, per);
      } else per = measured ?? roughMeasure(samples) ?? 1; // nothing big enough laid out yet (a cover): measured properly later
    }
    const id = `${key}|${per}|${bk.chunkCount}|${bk.complete}|${Math.round(bk.estimatedWeight)}`;
    if (numbersCache.current?.key !== id) numbersCache.current = { key: id, numbers: new PageNumbers(bk.chunkWeights(), per, bk.complete, bk.estimatedWeight, (c) => bk.joins(c)) };
    const numbers = numbersCache.current.numbers;
    const pages = m.counts.find((x) => x.c === m.chunk)?.pages ?? 1;
    const page = numbers.number(m.chunk, m.page, pages);
    // In a spread the right-hand page can be the first of the chunk going on from this one.
    const right = m.page + 1 < pages ? numbers.number(m.chunk, m.page + 1, pages) : numbers.first(m.chunk + 1);
    const last = m.span === 2 ? Math.max(page, Math.min(right, numbers.total)) : page;
    const info: PageInfo = { page, last, total: numbers.total, approx: !bk.complete, numbers, key };
    setPageInfo(info);
    p.onPageInfo?.(info);
  }, [keepSize, measureLayout]);
  const updatePagesRef = useRef(updatePages);
  updatePagesRef.current = updatePages;
  // A layout not measured while the area was settling is measured once it has.
  useEffect(() => {
    if (props.steady) updatePages();
  }, [props.steady, updatePages]);
  // Scroll mode has no page numbers.
  useEffect(() => {
    if (mode === 'page') return;
    pagesMsg.current = null;
    setPageInfo(null);
    latest.current.onPageInfo?.(null);
  }, [mode]);

  // Jumps (contents, search, slider, a page by its number).
  const firstJump = useRef(true);
  useEffect(() => {
    if (firstJump.current) {
      firstJump.current = false;
      return;
    }
    anchor.current = start;
    // Not set up yet: it opens there.
    if (!ready.current || !sent.current) return;
    const place = props.startPage !== undefined && mode === 'page' ? pageInfoRef.current?.numbers.find(props.startPage) : null;
    toPageNumber.current = !!place;
    if (place) void showIn(place.c, () => (place.last ? { chunk: place.c, edge: 'last' } : { chunk: place.c, page: place.index }));
    else void showAt(start, false);
  }, [startKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The book grew (still converting) or finished.
  useEffect(() => {
    send({ t: 'bounds', count: book.chunkCount, complete: book.complete });
    const now = [...wanted.current].filter((c) => c < book.chunkCount);
    for (const c of now) wanted.current.delete(c);
    // (Asked for by the page at its edge: wanted on screen.)
    if (now.length) void addChunks(now, 'show');
    updatePages();
    // Pictures that weren't there yet while converting: their chunks are drawn again, and
    // layouts measured without them are measured again.
    if (book.complete && missingPictures.current.size) {
      const redraw = [...missingPictures.current].some((c) => shown.current.has(c));
      missingPictures.current.clear();
      measuring.current.clear();
      if (redraw && ready.current && sent.current && !waitingForPlace) void showAt(anchor.current, true);
    }
  }, [version, book, send, addChunks, updatePages]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- requests from outside ----
  useEffect(() => {
    if (props.turn) send({ t: 'turn', dir: props.turn.dir });
  }, [props.turn, send]);
  useEffect(() => {
    send({ t: 'tool', marking: !!props.marking });
  }, [props.marking, send, loads]);
  useEffect(() => {
    if (mode === 'scroll') send({ t: 'auto', speed: props.autoScroll ?? 0 });
  }, [props.autoScroll, mode, send, loads]);
  const pageSelected = useRef(false);
  /** The selection last told to the screen (see 'selection'). */
  const lastSelection = useRef('');
  useEffect(() => {
    if (props.selected) return;
    lastSelection.current = '';
    if (pageSelected.current) {
      pageSelected.current = false;
      send({ t: 'clearSelection' });
    }
  }, [props.selected, send]);

  // ---- what the page says ----
  // The handler is created once; these are the latest versions of what it calls.
  const aroundRef = useRef(around);
  aroundRef.current = around;
  const addChunksRef = useRef(addChunks);
  addChunksRef.current = addChunks;
  const readyKey = useRef('');
  const top = mode === 'page' ? area.top + HEADER : 0;
  const topRef = useRef(top);
  topRef.current = top;
  const onMessage = useCallback((e: WebViewMessageEvent) => {
    let m: FromPage;
    try {
      m = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    const p = latest.current;
    switch (m.t) {
      case 'ready':
        ready.current = true;
        return setLoads((n) => n + 1);
      case 'shown': {
        // Shown before the page got the latest layout or content (a page turned just before a jump): out of date.
        if (m.key !== pageKey.current) {
          lastShown.current = null;
          return;
        }
        const pos = toBook(m.first);
        // The text moved (scrolled, a page turned): a selection moved with it, so the next report of it is news.
        if (m.turned) lastSelection.current = '';
        // Arrived here by reading (a turn, scrolling) or at a page by its number: the place kept from now on.
        if (m.turned || toPageNumber.current) anchor.current = pos;
        toPageNumber.current = false;
        const layout = layoutOf(m.key);
        lastShown.current = { first: m.first, layout };
        // All of it in this one go (one redraw a page turn): the place, and the page numbers of the page shown.
        setShownAt(pos);
        p.onPosition(pos, m.next ? toBook(m.next) : undefined, m.turned, m.lastPage && m.turned);
        if (m.pages) {
          pagesMsg.current = { m: m.pages, layout };
          updatePagesRef.current();
        }
        aroundRef.current(m.chunk);
        if (layout === layoutKeyRef.current) {
          // Drawn for the size it's shown at: nothing to cover any more.
          setDrawnFor(geometryRef.current);
          if (readyKey.current !== layout) {
            readyKey.current = layout;
            p.onLayoutReady?.(layout);
          }
        }
        return;
      }
      case 'measured': {
        // Kept for the layout it was measured in, even if another has been set up since.
        const bk = p.book;
        const key = sizeKey(bk.weightUnit, layoutOf(m.key));
        measuring.current.delete(key);
        const samples = m.counts.map((x) => ({ weight: bk.chunkWeight(x.c), pages: x.pages }));
        // Chunks under two pages each (pictures, poems, a file a page): what they take, as they are.
        const per = measure(samples, typicalWeight(bk.chunkWeights())) ?? roughMeasure(samples);
        if (per) keepSize(key, per);
        else unmeasurable.current.add(key);
        return updatePages();
      }
      case 'need': {
        // Only the chunks next to what the page holds (a request about chunks it held before a jump is out of date).
        const have = [...shown.current];
        const lo = Math.min(...have);
        const hi = Math.max(...have);
        const next = m.chunks.filter((c) => c === lo - 1 || c === hi + 1);
        return void (next.length && addChunksRef.current(next, 'show'));
      }
      case 'tap':
        return p.onTap();
      case 'link':
        return p.onLink?.(m.target);
      case 'end':
        return p.onEnd?.();
      case 'reachEnd':
        return p.onReachEnd?.();
      case 'autoInterrupt':
        return p.onAutoInterrupt?.();
      case 'autoEnd':
        return p.onAutoEnd?.();
      case 'selection': {
        const a = toBook(m.start);
        const zEnd = toBook(m.end);
        // The end is exclusive: the last character is the one before it.
        const z = zEnd.o > 0 || zEnd.b === a.b ? { b: zEnd.b, o: Math.max(0, zEnd.o - 1) } : { b: zEnd.b - 1, o: Number.MAX_SAFE_INTEGER };
        pageSelected.current = true;
        const t = topRef.current;
        // In whole points: the page may tell the same selection again and again (while its handles
        // show), a fraction of a point apart; that's no change to draw (or to tick for).
        const caret = (c: PageCaret) => ({ x: Math.round(c.x), y: Math.round(c.y + t), h: Math.round(c.h) });
        const sel = { a, z, start: caret(m.startCaret), end: caret(m.endCaret) };
        const said = JSON.stringify(sel);
        if (said === lastSelection.current) return;
        lastSelection.current = said;
        p.onSelection?.(sel);
        return;
      }
      case 'noSelection':
        pageSelected.current = false;
        lastSelection.current = '';
        return p.onSelection?.(null);
      // The highlight tool put away: the page may not have heard yet (its message is on the way), and
      // a touch meanwhile marks nothing. A drag it was making is only taken off the screen.
      case 'markTap':
        if (!p.marking) return;
        return p.onMarkTap?.(m.at ? toBook(m.at) : null);
      case 'markDrag':
        if (!p.marking) return p.onMarkDrag?.(null, null, true);
        return p.onMarkDrag?.(m.from ? toBook(m.from) : null, m.to ? toBook(m.to) : null, m.done);
      case 'error':
        recordCrash('error', new Error(`Reader page: ${m.message}`));
        return;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the page's process, and a page that never loads ----
  /** Whatever the page held is gone: it's set up and given its chunks again once it's back. */
  const lost = useCallback(() => {
    ready.current = false;
    gen.current++;
    pageKey.current = '';
    pageLayout.current = '';
    lastShown.current = null;
    setShown([]);
  }, [setShown]);
  // iPhone: the system can stop the page's process (memory); the same WebView loads it again.
  /** Counted: the page loaded again has the same time to say it's ready as a new one. */
  const [reloads, setReloads] = useState(0);
  const reloadPage = useCallback(() => {
    lost();
    setReloads((n) => n + 1);
    web.current?.reload();
  }, [lost]);
  // Android: a WebView whose renderer process died can't be used again; a new one is made.
  const deaths = useRef<number[]>([]);
  const rendererGone = useCallback(
    (e: { nativeEvent?: { didCrash?: boolean } }) => {
      const now = Date.now();
      recordCrash('error', new Error(`Reader page: the WebView's renderer ${e?.nativeEvent?.didCrash ? 'crashed' : 'was stopped by the system'}`));
      const again = deaths.current.some((t) => now - t < DIED_AGAIN_MS);
      deaths.current = [...deaths.current.filter((t) => now - t < 60_000), now];
      lost();
      if (again) setBroken('The page stopped working twice in a row.');
      else setTimeout(() => setWebKey((k) => k + 1), 0);
    },
    [lost],
  );
  const tryAgain = useCallback(() => {
    deaths.current = [];
    lost();
    setBroken(null);
    setWebKey((k) => k + 1);
  }, [lost]);
  // Nothing from the page: its file may be damaged; load it as HTML, and if that fails too, say so.
  useEffect(() => {
    if (broken) return;
    const t = setTimeout(() => {
      if (ready.current) return;
      recordCrash('error', new Error(`Reader page: not ready after ${READY_MS / 1000} s (${inline ? 'HTML given directly' : 'page file'})`));
      if (!inline) {
        setInline(true);
        setWebKey((k) => k + 1);
      } else setBroken("The page didn't load.");
    }, READY_MS);
    return () => clearTimeout(t);
  }, [webKey, inline, broken, reloads]);

  const chapter = book.chapterAt(shownAt.b)?.t;
  const pct = book.fraction(shownAt) * 100;
  const pageText = pageInfo
    ? `${pageInfo.last > pageInfo.page ? `${pageInfo.page}–${pageInfo.last}` : pageInfo.page} of ${pageInfo.approx ? '~' : ''}${pageInfo.total} · `
    : '';

  const setWeb = useCallback((w: Pick<WebView, 'injectJavaScript' | 'reload'> | null) => {
    web.current = w;
  }, []);
  // An opaque WKWebView is white until the page first draws (a white flash in dark themes): see-through,
  // it shows the page's colour behind it instead.
  const webStyle = useMemo(() => ({ flex: 1, backgroundColor: Platform.OS === 'ios' ? 'transparent' : theme.bg }), [theme.bg]);
  const containerStyle = useMemo(() => ({ backgroundColor: theme.bg }), [theme.bg]);
  const webView = broken ? null : (
    <WebView
      key={webKey}
      ref={setWeb}
      source={source}
      originWhitelist={ORIGINS}
      allowingReadAccessToURL={Paths.document.uri}
      allowFileAccess
      allowFileAccessFromFileURLs
      onMessage={onMessage}
      onShouldStartLoadWithRequest={onlyBookFiles}
      onContentProcessDidTerminate={reloadPage}
      onRenderProcessGone={rendererGone}
      scrollEnabled={mode === 'scroll'}
      bounces={false}
      overScrollMode="never"
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
      textZoom={100}
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      // iOS only (no phone numbers or dates turned into links); Android's WebView crashes on it.
      dataDetectorTypes={Platform.OS === 'ios' ? 'none' : undefined}
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
      webviewDebuggingEnabled={__DEV__}
      style={webStyle}
      containerStyle={containerStyle}
    />
  );

  const overlay = broken ? (
    <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: theme.bg }]}>
      <Text style={{ color: theme.text, textAlign: 'center', fontSize: 16 }}>{broken}</Text>
      <Tap onPress={tryAgain} style={[styles.retry, { backgroundColor: theme.accent }]} accessibilityLabel="Try again">
        <Text style={styles.retryText}>Try again</Text>
      </Tap>
    </View>
  ) : waitingForPlace ? (
    <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: theme.bg }]}>
      <Text style={{ color: theme.muted, textAlign: 'center' }}>{`Preparing the book up to where you left off… ${Math.round(book.progress * 100)}%`}</Text>
    </View>
  ) : null;

  // The WebView keeps its place in the tree in both modes: switching modes doesn't make a new one.
  const page = mode === 'page';
  // The clock and battery get room for the phone's larger text sizes.
  const side = Math.ceil(64 * Math.min(META_SCALE, Math.max(1, fontScale)));
  return (
    <View style={[styles.root, { backgroundColor: theme.bg }, page && { paddingTop: area.top, paddingBottom: area.bottom }]}>
      {page ? (
        // Clock, chapter, battery; the right edge is kept clear for the bookmark ribbon.
        <View style={[styles.header, { paddingLeft: frame.left + (settings.showClock ? 0 : 22), paddingRight: frame.right + 22 }]}>
          {settings.showClock ? (
            <View style={{ width: side }}>
              <Clock maxScale={META_SCALE} style={[styles.meta, { color: theme.muted }]} />
            </View>
          ) : null}
          <Text numberOfLines={1} maxFontSizeMultiplier={META_SCALE} style={[styles.meta, styles.headerTitle, { color: theme.muted }]}>
            {chapter ?? book.entry.title}
          </Text>
          {settings.showClock ? (
            <View style={[styles.sideRight, { width: side }]}>
              <Battery maxScale={META_SCALE} color={theme.muted} style={[styles.meta, { color: theme.muted }]} />
            </View>
          ) : null}
          {bookmarked ? <Ionicons name="bookmark" size={20} color={theme.accent} style={styles.ribbon} /> : null}
        </View>
      ) : null}
      <View style={page ? { height: frame.height } : styles.root}>
        {webView}
        {overlay}
      </View>
      {page ? (
        <View style={[styles.footer, { paddingLeft: frame.left, paddingRight: frame.right }]}>
          <Text numberOfLines={1} maxFontSizeMultiplier={META_SCALE} style={[styles.meta, { color: theme.muted }]}>
            {book.complete ? `${pageText}${pct.toFixed(1)}%` : `${pageText}${pct.toFixed(1)}% · preparing ${Math.round(book.progress * 100)}%`}
          </Text>
          <Text numberOfLines={1} maxFontSizeMultiplier={META_SCALE} style={[styles.meta, styles.shrink, { color: theme.muted }]}>
            {footerRight ?? ''}
          </Text>
        </View>
      ) : (
        // Scroll mode: the place read, on a strip of the page's colour at the bottom that the text goes under.
        <View pointerEvents="none" style={[styles.strip, { height: area.bottom + SCROLL_BADGE }]}>
          {FADE.map((o, i) => (
            <View key={i} style={[styles.fade, { top: -FADE_STEP * (FADE.length - i), opacity: o, backgroundColor: theme.bg }]} />
          ))}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg }]} />
          <Text style={[styles.badge, { color: theme.muted, right: 12 + area.right }]} numberOfLines={1} maxFontSizeMultiplier={META_SCALE}>
            {settings.showClock ? <ClockBattery color={theme.muted} /> : null}
            {settings.showClock ? ' · ' : ''}
            {pct.toFixed(1)}%{book.complete ? '' : ` · preparing ${Math.round(book.progress * 100)}%`}
            {footerRight ? ` · ${footerRight}` : ''}
          </Text>
        </View>
      )}
      {/* Laid out for another size: the page's colour until the text is drawn for this one (taps wait too). Not over a message. */}
      {covered && !overlay ? <View testID="page-cover" style={[StyleSheet.absoluteFill, { backgroundColor: theme.bg }]} /> : null}
    </View>
  );
});

/** Height of scroll mode's strip with the place read (above the bottom inset). */
export const SCROLL_BADGE = 26;
/** The strip fades in above, so a line going under it isn't cut off sharply. */
const FADE = [0.25, 0.5, 0.75];
const FADE_STEP = 4;

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { height: HEADER, flexDirection: 'row', alignItems: 'center' },
  sideRight: { alignItems: 'flex-end' },
  headerTitle: { flex: 1, textAlign: 'center' },
  footer: { height: FOOTER, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ribbon: { position: 'absolute', right: 10, top: 2 },
  meta: { fontSize: 12 },
  shrink: { flexShrink: 1, marginLeft: 12, textAlign: 'right' },
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  retry: { marginTop: 16, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12 },
  retryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  strip: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  fade: { position: 'absolute', left: 0, right: 0, height: FADE_STEP },
  badge: { position: 'absolute', top: 6, fontSize: 12 },
});
