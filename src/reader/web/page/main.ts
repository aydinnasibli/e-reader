// The page inside the reader's WebView: draws the book's chunks as HTML (page
// or scroll mode), and tells the screen what's shown, tapped and selected.
// Built into page.generated.ts by scripts/build-reader-page.mjs.

import type { ToPage } from '../protocol';
import { listen, send } from './bridge';
import { setMarks } from './marks';
import { Paged } from './paged';
import { Scrolled } from './scrolled';
import { clearSelection, watchSelection } from './selection';
import { type TouchTarget, handleTouches } from './touch';

const viewport = document.getElementById('viewport')!;
const scrollRoot = document.getElementById('scroll')!;
let mode: 'page' | 'scroll' = 'page';
let view: Paged | Scrolled | null = null;
let marking = false;
let tapForward = false;

function setBookStyle(css: string) {
  document.getElementById('book')!.textContent = css;
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
listen((m) => {
  queue = queue.then(() => handle(m)).catch((e) => send({ t: 'error', message: String(e) }));
});

async function handle(m: ToPage) {
  switch (m.t) {
    case 'setup': {
      const s = m.setup;
      tapForward = s.tapForward;
      setBookStyle(s.css);
      document.documentElement.dataset.mode = s.mode;
      if (s.mode !== mode || !view) {
        mode = s.mode;
        viewport.textContent = '';
        scrollRoot.textContent = '';
        view = mode === 'page' ? new Paged(viewport) : new Scrolled(scrollRoot);
      }
      await fontsLoaded();
      view.configure(s, m.key, m.target);
      return;
    }
    case 'content':
      await fontsLoaded();
      view?.setContent(m.chunks, m.target, m.key);
      return;
    case 'add':
      await fontsLoaded();
      view?.add(m.chunks);
      return;
    case 'drop':
      return view?.drop(m.chunks);
    case 'bounds':
      return view?.bounds(m.count, m.complete);
    case 'go':
      return view?.go(m.target);
    case 'turn':
      return view instanceof Paged ? view.turn(m.dir) : undefined;
    case 'marks':
      return setMarks(m.marks);
    case 'tool':
      marking = m.marking;
      document.documentElement.classList.toggle('marking', marking);
      if (marking) clearSelection();
      return;
    case 'clearSelection':
      return clearSelection();
    case 'auto':
      return view instanceof Scrolled ? view.auto(m.speed) : undefined;
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
