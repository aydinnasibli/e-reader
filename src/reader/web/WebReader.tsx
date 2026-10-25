// The reader: the book drawn as HTML in a WebView (page or scroll mode; see
// src/reader/web/page), with the page header and footer drawn natively around
// it. The browser lays out the text, turns the pages and selects text with
// its own handles, so selection is exact on every phone. Only the chunks
// around the place read are ever in the page.

import Ionicons from '@expo/vector-icons/Ionicons';
import { File, Paths } from 'expo-file-system';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { Position } from '@/engine/types';
import { recordCrash } from '@/lib/crashLog';
import type { ReaderSettings, Theme } from '@/lib/settings';
import type { BookData, ImageInfo } from '../book';
import type { Mark } from '../marks';
import { charsPerPage, pageCount, pageNumber } from '../pageNumbers';
import { drawn, layoutKeyOf, lookOf, toBlock, toDrawn } from '../look';
import type { TextPoint } from '../selection';
import { Battery, Clock, ClockBattery } from '../StatusInfo';
import { bookCss } from './css';
import { chunkHtml } from './html';
import { PAGE_HTML, PAGE_SOURCE_HASH } from './page.generated';
import { FOOTER, HEADER, META_SCALE, webFrame } from './frame';
import type { Chunk, DrawnPoint, FromPage, PageCaret, PageMark, Target, ToPage } from './protocol';
import { webFont } from './webFonts';

/** A selection on the page: its first and last character, and where its ends are on screen (window coordinates). */
export interface PageSelection {
  a: TextPoint;
  z: TextPoint;
  start: PageCaret;
  end: PageCaret;
}

export interface PageInfo {
  page: number;
  total: number;
  /** Characters per page at the current settings (for estimates like pages left). */
  cpp: number;
}

interface Props {
  book: BookData;
  settings: ReaderSettings;
  theme: Theme;
  /** Where to open. Changing `startKey` jumps there. */
  start: Position;
  startKey: number;
  /** Bumped whenever the book grows (still converting) or finishes. */
  version: number;
  /** The first and last position shown, and whether a page turn just arrived at the book's last page. */
  onPosition(pos: Position, end?: Position, turnedToLast?: boolean): void;
  onTap(): void;
  /** Highlights and search hits for a block (the selection is drawn by the page itself). */
  marksFor?(b: number): Mark[] | undefined;
  onLink?(target: string): void;
  bookmarked?: boolean;
  footerRight?: string;
  /** Called with the layout key once a page of that layout is on screen. */
  onLayoutReady?(key: string): void;
  onPageInfo?(info: PageInfo): void;
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
  /** Text selected on the page (the browser's own selection), or null when it ends. */
  onSelection?(sel: PageSelection | null): void;
  /** Whether a selection is shown (false ends one the page still has). */
  selected?: boolean;
  /** Whether the status bar is showing (with the menu). */
  statusBar?: boolean;
}

/** How long a change in the window's height or the top/bottom insets must hold before the book is laid out for it. */
const SETTLE_MS = 300;

type Area = { width: number; height: number; top: number; bottom: number; left: number; right: number };

/**
 * The window and safe-area insets the book is laid out for. Showing the status
 * bar (with the menu) changes the top inset, and on Android in landscape the
 * window's height too; laying the book out again for that would move the text
 * and change the page numbers each time the menu opens. So a change across
 * (rotation, split screen, a fold) is taken at once, any other only once it
 * has held for a moment with the status bar hidden.
 */
function useReadingArea(statusBar: boolean): Area {
  const win = useWindowDimensions();
  const live = useSafeAreaInsets();
  const now: Area = { width: win.width, height: win.height, top: live.top, bottom: live.bottom, left: live.left, right: live.right };
  const nowRef = useRef(now);
  nowRef.current = now;
  const [area, setArea] = useState(now);
  const across = now.width !== area.width || now.left !== area.left || now.right !== area.right;
  if (across) setArea(now);
  const changed = !across && (now.height !== area.height || now.top !== area.top || now.bottom !== area.bottom);
  useEffect(() => {
    if (statusBar || !changed) return;
    const t = setTimeout(() => setArea(nowRef.current), SETTLE_MS);
    return () => clearTimeout(t);
  }, [statusBar, changed, now.height, now.top, now.bottom]);
  return across ? now : area;
}

/**
 * The page's HTML, written once per version where the WebView may read it
 * with the book's files (images, fonts). If it can't be written (storage
 * full), the HTML is given directly: the text still shows.
 */
function pageSource(): { uri: string } | { html: string; baseUrl: string } {
  try {
    const f = new File(Paths.document, 'reader', `page-${PAGE_SOURCE_HASH}.html`);
    if (!f.exists) {
      if (!f.parentDirectory.exists) f.parentDirectory.create({ intermediates: true, idempotent: true });
      f.writeSync(PAGE_HTML);
    }
    return { uri: f.uri };
  } catch {
    return { html: PAGE_HTML, baseUrl: Paths.document.uri };
  }
}

/** Chunks kept around the one read: the one before and the one after. */
const AROUND = 1;

export const WebReader = memo(function WebReader(props: Props) {
  const { book, settings, theme, start, startKey, version, bookmarked, footerRight } = props;
  const mode = settings.mode;
  const area = useReadingArea(!!props.statusBar);
  const frame = useMemo(() => webFrame(area, area, settings.margin, mode), [area, settings.margin, mode]);
  const lang = book.manifest?.lang;
  const web = useRef<Pick<WebView, 'injectJavaScript' | 'reload'> | null>(null);
  const source = useMemo(() => pageSource(), []);

  // The latest props, for the message handler (which is created once).
  const latest = useRef(props);
  latest.current = props;

  // ---- drawn points <-> book positions ----
  const looks = useCallback((b: number) => {
    const blk = book.block(b);
    return blk ? drawn(blk, lookOf(blk, settings, lang)) : null;
  }, [book, settings, lang]);
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

  // ---- chunks ----
  /** What the chunks' HTML depends on besides the book. */
  const htmlKey = `${settings.indent}|${settings.hyphenate}|${lang ?? ''}`;
  const htmlCache = useRef(new Map<string, Promise<Chunk>>());
  const chunkOf = useCallback(
    (c: number): Promise<Chunk> => {
      const key = `${c}|${htmlKey}`;
      let p = htmlCache.current.get(key);
      if (!p) {
        p = (async () => {
          const blocks = await book.loadChunk(c);
          const images = new Map<string, ImageInfo | null>();
          await Promise.all(blocks.filter((b) => b.k === 'img' && b.s).map(async (b) => images.set(b.s!, await book.imageInfo(b.s!).catch(() => null))));
          return { c, html: chunkHtml(blocks, book.chunkStart(c), latest.current.settings, lang, images), chars: book.chunkChars(c) };
        })();
        htmlCache.current.set(key, p);
        p.catch(() => htmlCache.current.delete(key));
      }
      return p;
    },
    [book, htmlKey, lang],
  );
  useEffect(() => htmlCache.current.clear(), [htmlKey]);

  /** Chunks the page has now. */
  const shown = useRef(new Set<number>());
  /** Chunks asked for that aren't converted yet. */
  const wanted = useRef(new Set<number>());

  const addChunks = useCallback(
    async (cs: number[]) => {
      const fresh = cs.filter((c) => c >= 0 && !shown.current.has(c));
      for (const c of fresh) if (c >= book.chunkCount) wanted.current.add(c);
      const have = fresh.filter((c) => c < book.chunkCount);
      if (!have.length) return;
      for (const c of have) shown.current.add(c);
      const chunks = await Promise.all(have.map(chunkOf));
      send({ t: 'add', chunks });
      sendMarks();
    },
    [book, chunkOf, send], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** Keep the chunks around `c` in the page, and drop the ones far away. */
  const around = useCallback(
    (c: number) => {
      const far = [...shown.current].filter((x) => Math.abs(x - c) > AROUND + 1);
      if (far.length) {
        for (const x of far) shown.current.delete(x);
        send({ t: 'drop', chunks: far });
      }
      const near: number[] = [];
      for (let x = c - AROUND; x <= c + AROUND; x++) if (x >= 0) near.push(x);
      void addChunks(near);
    },
    [addChunks, send],
  );

  // ---- the place read ----
  /**
   * The place kept across layout changes: where the reader last arrived (a
   * page turn, a jump, opening the book), not the start of the page shown
   * after a change, which is up to a page earlier.
   */
  const anchor = useRef<Position>(start);
  const [shownAt, setShownAt] = useState<Position>(start);
  /** Opening at a place not converted yet: wait for it. */
  const waitingForPlace = !book.complete && start.b >= book.totalBlocks;

  /** Put the chunks around `at` in the page and show it. */
  const showAt = useCallback(
    async (at: Position, key: string) => {
      const c = book.chunkOf(at.b);
      const cs: number[] = [];
      for (let x = c - AROUND; x <= c + AROUND; x++) if (x >= 0 && x < book.chunkCount) cs.push(x);
      const chunks = await Promise.all(cs.map(chunkOf));
      shown.current = new Set(cs);
      const target: Target = { at: toPage(at) };
      send({ t: 'bounds', count: book.chunkCount, complete: book.complete });
      send({ t: 'content', chunks, target, key });
      sendMarks();
    },
    [book, chunkOf, send], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // ---- setup: fonts, sizes, colours, frame ----
  const layoutKey = [mode, layoutKeyOf(settings), frame.width, frame.height, frame.left, frame.right, frame.top, theme.bg, theme.text, theme.accent, theme.muted, settings.pageTurn, settings.tapForward].join('|');
  const layoutKeyRef = useRef(layoutKey);
  layoutKeyRef.current = layoutKey;
  const sendSetup = useCallback(async () => {
    const font = await webFont(settings.font).catch(() => ({ css: '', family: 'serif', medium: false }));
    send({
      t: 'setup',
      key: layoutKey,
      target: { at: toPage(anchor.current) },
      setup: {
        mode,
        frame,
        css: bookCss(settings, theme, frame, font, mode),
        turn: settings.pageTurn,
        tapForward: settings.tapForward,
        processing: `Still preparing the rest of this book… ${Math.round(book.progress * 100)}%`,
        theEnd: '— The End —',
      },
    });
  }, [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // First load (and a WebView that was killed and is loaded again): set up, then the content.
  const [loads, setLoads] = useState(0);
  const onReady = useCallback(() => {
    ready.current = true;
    setLoads((n) => n + 1);
  }, []);
  useEffect(() => {
    if (!loads || waitingForPlace) return;
    let alive = true;
    void (async () => {
      await sendSetup();
      if (alive) await showAt(anchor.current, layoutKeyRef.current);
    })();
    return () => {
      alive = false;
    };
  }, [loads, waitingForPlace]); // eslint-disable-line react-hooks/exhaustive-deps

  // Settings changed: lay out again at the same place. A change of the chunks' HTML loads them again.
  const firstSetup = useRef(true);
  useEffect(() => {
    if (firstSetup.current) {
      firstSetup.current = false;
      return;
    }
    if (ready.current && !waitingForPlace) void sendSetup();
  }, [layoutKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const firstHtml = useRef(true);
  useEffect(() => {
    if (firstHtml.current) {
      firstHtml.current = false;
      return;
    }
    if (ready.current && !waitingForPlace) void showAt(anchor.current, layoutKeyRef.current);
  }, [htmlKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jumps (contents, search, slider).
  const firstJump = useRef(true);
  useEffect(() => {
    if (firstJump.current) {
      firstJump.current = false;
      return;
    }
    anchor.current = start;
    if (ready.current) void showAt(start, layoutKeyRef.current);
  }, [startKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // The book grew (still converting) or finished.
  useEffect(() => {
    send({ t: 'bounds', count: book.chunkCount, complete: book.complete });
    const now = [...wanted.current].filter((c) => c < book.chunkCount);
    for (const c of now) wanted.current.delete(c);
    if (now.length) void addChunks(now);
  }, [version, book, send, addChunks]);
  // Waiting to open at a place being converted: open once it's there.
  useEffect(() => {
    if (ready.current && !waitingForPlace && loads) void showAt(anchor.current, layoutKeyRef.current);
  }, [waitingForPlace]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const sendMarksRef = useRef(sendMarks);
  sendMarksRef.current = sendMarks;
  useEffect(() => sendMarks(), [sendMarks]);

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
  useEffect(() => {
    if (!props.selected && pageSelected.current) {
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
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
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
        return onReady();
      case 'shown': {
        const pos = toBook(m.first);
        // Arrived here by reading (a turn, scrolling): this is the place kept from now on.
        if (m.turned) anchor.current = pos;
        setShownAt(pos);
        p.onPosition(pos, m.next ? toBook(m.next) : undefined, m.lastPage && m.turned);
        aroundRef.current(m.chunk);
        if (m.key === layoutKeyRef.current && readyKey.current !== m.key) {
          readyKey.current = m.key;
          p.onLayoutReady?.(m.key);
        }
        return;
      }
      case 'pages': {
        const cpp = charsPerPage(m.counts.map((x) => ({ chars: x.chars, pages: x.pages })));
        if (!cpp) return;
        const bk = p.book;
        const total = pageCount(bk.estimatedChars, cpp);
        const info = { page: Math.min(total, pageNumber(bk.chunks[m.chunk]?.[1] ?? 0, bk.chunkChars(m.chunk), m.page, cpp)), total, cpp };
        setPageInfo(info);
        p.onPageInfo?.(info);
        return;
      }
      case 'need':
        return void addChunksRef.current(m.chunks);
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
        p.onSelection?.({ a, z, start: { ...m.startCaret, y: m.startCaret.y + t }, end: { ...m.endCaret, y: m.endCaret.y + t } });
        return;
      }
      case 'noSelection':
        pageSelected.current = false;
        return p.onSelection?.(null);
      case 'markTap':
        return p.onMarkTap?.(m.at ? toBook(m.at) : null);
      case 'markDrag':
        return p.onMarkDrag?.(m.from ? toBook(m.from) : null, m.to ? toBook(m.to) : null, m.done);
      case 'error':
        recordCrash('error', new Error(`Reader page: ${m.message}`));
        return;
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // The system can kill the WebView's process (memory): load it again, at the same place.
  const reload = useCallback(() => {
    ready.current = false;
    shown.current.clear();
    web.current?.reload();
  }, []);

  const chapter = book.chapterAt(shownAt.b)?.t;
  const pct = book.fraction(shownAt) * 100;
  const pageText = pageInfo ? `${pageInfo.page} of ${book.complete ? '' : '~'}${pageInfo.total} · ` : '';

  const webView = (
    <WebView
      ref={(w) => {
        web.current = w;
      }}
      source={source}
      originWhitelist={['*']}
      allowingReadAccessToURL={Paths.document.uri}
      allowFileAccess
      allowFileAccessFromFileURLs
      onMessage={onMessage}
      // Only the page itself and the book's own files: nothing in a book navigates away.
      onShouldStartLoadWithRequest={(r: { url: string }) => r.url.startsWith('file:') || r.url.startsWith('about:')}
      onContentProcessDidTerminate={reload}
      onRenderProcessGone={reload}
      // No system menu over a selection: the screen shows its own (copy, look up, translate, share).
      menuItems={[]}
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
      style={{ flex: 1, backgroundColor: theme.bg }}
      containerStyle={{ backgroundColor: theme.bg }}
    />
  );

  const waitMsg = waitingForPlace ? (
    <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: theme.bg }]}>
      <Text style={{ color: theme.muted, textAlign: 'center' }}>{`Preparing the book up to where you left off… ${Math.round(book.progress * 100)}%`}</Text>
    </View>
  ) : null;

  if (mode === 'scroll') {
    return (
      <View style={[styles.root, { backgroundColor: theme.bg }]}>
        {webView}
        {waitMsg}
        <View pointerEvents="none" style={[styles.badge, { bottom: area.bottom + 6, backgroundColor: theme.bg }]}>
          <Text style={{ color: theme.muted, fontSize: 12 }} numberOfLines={1} maxFontSizeMultiplier={META_SCALE}>
            {settings.showClock ? <ClockBattery color={theme.muted} /> : null}
            {settings.showClock ? ' · ' : ''}
            {pct.toFixed(1)}%{footerRight ? ` · ${footerRight}` : ''}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View style={[styles.root, { backgroundColor: theme.bg, paddingTop: area.top, paddingBottom: area.bottom }]}>
      {/* Clock, chapter, battery; the right edge is kept clear for the bookmark ribbon. */}
      <View style={[styles.header, { paddingLeft: frame.left + (settings.showClock ? 0 : 22), paddingRight: frame.right + 22 }]}>
        {settings.showClock ? (
          <View style={styles.side}>
            <Clock maxScale={META_SCALE} style={[styles.meta, { color: theme.muted }]} />
          </View>
        ) : null}
        <Text numberOfLines={1} maxFontSizeMultiplier={META_SCALE} style={[styles.meta, styles.headerTitle, { color: theme.muted }]}>
          {chapter ?? book.entry.title}
        </Text>
        {settings.showClock ? (
          <View style={[styles.side, styles.sideRight]}>
            <Battery maxScale={META_SCALE} color={theme.muted} style={[styles.meta, { color: theme.muted }]} />
          </View>
        ) : null}
        {bookmarked ? <Ionicons name="bookmark" size={20} color={theme.accent} style={styles.ribbon} /> : null}
      </View>
      <View style={{ height: frame.height }}>
        {webView}
        {waitMsg}
      </View>
      <View style={[styles.footer, { paddingLeft: frame.left, paddingRight: frame.right }]}>
        <Text numberOfLines={1} maxFontSizeMultiplier={META_SCALE} style={[styles.meta, { color: theme.muted }]}>
          {book.complete ? `${pageText}${pct.toFixed(1)}%` : `${pageText}${pct.toFixed(1)}% · preparing ${Math.round(book.progress * 100)}%`}
        </Text>
        <Text numberOfLines={1} maxFontSizeMultiplier={META_SCALE} style={[styles.meta, styles.shrink, { color: theme.muted }]}>
          {footerRight ?? ''}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { height: HEADER, flexDirection: 'row', alignItems: 'center' },
  side: { width: 64 },
  sideRight: { alignItems: 'flex-end' },
  headerTitle: { flex: 1, textAlign: 'center' },
  footer: { height: FOOTER, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  ribbon: { position: 'absolute', right: 10, top: 2 },
  meta: { fontSize: 12 },
  shrink: { flexShrink: 1, marginLeft: 12, textAlign: 'right' },
  center: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  badge: { position: 'absolute', right: 12, paddingHorizontal: 6, borderRadius: 6, opacity: 0.9 },
});
