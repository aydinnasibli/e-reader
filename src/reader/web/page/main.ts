// The page inside the reader's WebView: draws the book's chunks as HTML (page
// or scroll mode), and tells the screen what's shown, tapped and selected.
// Built into page.generated.ts by scripts/build-reader-page.mjs.

import type { ToPage } from '../protocol';
import { listen, send } from './bridge';
import { setMarks, setStroke } from './marks';
import { Paged } from './paged';
import { Scrolled } from './scrolled';
import { clearSelection, refreshSelection, watchSelection } from './selection';
import { type TouchTarget, handleTouches } from './touch';

const viewport = document.getElementById('viewport')!;
const scrollRoot = document.getElementById('scroll')!;
let mode: 'page' | 'scroll' = 'page';
let view: Paged | Scrolled | null = null;
let marking = false;
let tapForward = false;

const FACE = /@font-face\{[^}]*\}/g;

/**
 * The book's styles. Its font faces go in a style of their own, changed only
 * when they change: a face made again is loaded from its file again, and the
 * pages are measured only once it has.
 */
function setBookStyle(css: string) {
  const faces = (css.match(FACE) ?? []).join('');
  const fonts = document.getElementById('fonts')!;
  if (fonts.textContent !== faces) fonts.textContent = faces;
  document.getElementById('book')!.textContent = faces ? css.replace(FACE, '') : css;
}

/**
 * Every face the book's CSS names, loaded. A face only starts loading once text
 * using it is laid out, and `document.fonts.ready` doesn't wait for one that
 * hasn't started: the pages would be measured in the fallback font, and the
 * text would move under them when the font came in. A face that can't load
 * stays in the fallback font.
 */
async function fontsLoaded() {
  const loads: Promise<unknown>[] = [];
  document.fonts.forEach((f) => loads.push((f.status === 'unloaded' ? f.load() : f.loaded).catch(() => undefined)));
  await Promise.all(loads);
  await document.fonts.ready;
}

/** Messages are handled one after another, each once the fonts it needs have loaded. */
let queue: Promise<void> = Promise.resolve();
/** The messages not handled yet, in order: the one being handled first. */
const pending: ToPage[] = [];
listen((m) => {
  pending.push(m);
  queue = queue
    .then(() => handle(m))
    .catch((e) => send({ t: 'error', message: String(e) }))
    .finally(() => pending.shift());
});
/** A setup is waiting behind the message being handled: the layout is about to change. */
const laterSetup = () => pending.slice(1).find((x): x is Extract<ToPage, { t: 'setup' }> => x.t === 'setup');

// ---- hidden while laid out for another width ----
/**
 * The phone turned (or the window was resized): the WebView takes its new
 * width at once, but the text comes in a layout for it only once the screen
 * has heard and sent it, which can take seconds. Until then the old layout
 * would show cut off or in part of the screen: the text is hidden instead
 * (base.css), and shown again once it's laid out for the width it has, or
 * after RELAYOUT_SAFETY_MS whatever happens.
 */
const RELAYOUT_SAFETY_MS = 10_000;
/** The width the text was last laid out for (0: not laid out yet). */
let laidWidth = 0;
let safety: ReturnType<typeof setTimeout> | null = null;
const fits = () => Math.abs(window.innerWidth - laidWidth) <= 1.5;
function relayingOut(on: boolean) {
  document.documentElement.classList.toggle('relayout', on);
  if (safety) clearTimeout(safety);
  safety = on ? setTimeout(() => relayingOut(false), RELAYOUT_SAFETY_MS) : null;
}
window.addEventListener('resize', () => {
  if (laidWidth && fits() === document.documentElement.classList.contains('relayout')) relayingOut(!fits());
});

async function handle(m: ToPage) {
  // What moves the strip waits for a page turn to land (Paged.idle).
  if (view instanceof Paged && (m.t === 'setup' || m.t === 'content' || m.t === 'add' || m.t === 'drop' || m.t === 'go' || m.t === 'measure')) await view.idle();
  switch (m.t) {
    case 'setup': {
      const s = m.setup;
      // Another layout is already on its way (the insets came a moment after the width): this one would
      // only be laid out to be laid out again at once. (Not when the view changes: what follows needs it.)
      if (view && s.mode === mode && laterSetup()?.setup.mode === mode) return;
      // Laid out again, or a new place shown: a selection ends.
      clearSelection();
      tapForward = s.tapForward;
      // The book's language: the browser's own rules for it (Turkish i in ligatures, base.css).
      document.documentElement.lang = s.lang ?? '';
      setBookStyle(s.css);
      document.documentElement.dataset.mode = s.mode;
      if (s.mode !== mode || !view) {
        mode = s.mode;
        view?.dispose();
        viewport.textContent = '';
        scrollRoot.textContent = '';
        view = mode === 'page' ? new Paged(viewport) : new Scrolled(scrollRoot);
      }
      await fontsLoaded();
      // (A turn may have started while the fonts loaded.)
      if (view instanceof Paged) await view.idle();
      view.configure(s, m.key, m.target);
      laidWidth = s.frame.width;
      if (fits()) relayingOut(false);
      return;
    }
    case 'content':
      clearSelection();
      await fontsLoaded();
      if (view instanceof Paged) await view.idle();
      view?.setContent(m.chunks, m.target, m.key);
      return;
    case 'add':
      await fontsLoaded();
      if (view instanceof Paged) await view.idle();
      view?.add(m.chunks);
      // Chunks came or went: the text can move (scroll mode), and a selection with it.
      return refreshSelection();
    case 'drop':
      view?.drop(m.chunks);
      return refreshSelection();
    case 'bounds':
      return view?.bounds(m.count, m.complete);
    case 'go':
      clearSelection();
      return view?.go(m.target);
    case 'turn':
      clearSelection();
      return view instanceof Paged ? view.turn(m.dir) : undefined;
    case 'marks':
      return setMarks(m.marks);
    case 'stroke':
      return setStroke(m.marks);
    case 'tool':
      marking = m.marking;
      if (marking) clearSelection();
      return;
    case 'clearSelection':
      return clearSelection();
    case 'auto':
      return view instanceof Scrolled ? view.auto(m.speed) : undefined;
    case 'measure': {
      // Measuring takes the page a while: not for a layout about to be replaced (the screen asks again).
      const replaced = () => !!laterSetup() && laterSetup()!.key !== m.key;
      if (!(view instanceof Paged) || replaced()) return;
      await fontsLoaded();
      await view.idle();
      return view.measureChunks(m.key, m.chunks, replaced);
    }
  }
}

const touchTarget = (): TouchTarget => {
  const v = view;
  return {
    mode,
    tapForward,
    turn: (dir) => (v instanceof Paged ? v.turn(dir) : undefined),
    drag: (dx) => (v instanceof Paged ? v.drag(dx) : undefined),
    springBack: () => (v instanceof Paged ? v.springBack() : undefined),
    followsFinger: v instanceof Paged ? v.followsFinger : false,
    touched: () => (v instanceof Scrolled ? v.touched() : undefined),
  };
};
handleTouches(touchTarget, () => marking);
watchSelection();
send({ t: 'ready' });
