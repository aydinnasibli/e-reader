// Lays out a rendered screen the way a phone would and reports what a person
// would see go wrong: a button or text box off the screen, under the status
// bar or notch, behind the keyboard, cut off by its container, or on top of
// another button; text drawn over other text.
//
// The test renderer has no layout, so the rendered tree (screen.toJSON()) is
// fed to Yoga, the layout engine React Native uses, with each element's real
// styles. Text is measured with average character widths, so positions are
// close, not exact: findings near a boundary deserve a look on a phone.

import { StyleSheet } from 'react-native';
import type { Node as YogaNode, Yoga } from 'yoga-layout/load';
import { enums, loadYoga } from './yoga';

export interface Device {
  name: string;
  width: number;
  height: number;
  insets: { top: number; bottom: number; left: number; right: number };
  /** The phone's text size setting (1 = default). */
  fontScale: number;
  /** Keyboard height while one is open, 0 when closed. */
  keyboard: number;
  /** How the keyboard makes room: iOS pads KeyboardAvoidingView, Android shrinks the window. */
  platform: 'ios' | 'android';
}

export const DEVICES: Record<string, Device> = {
  phone: { name: 'iPhone 15', width: 390, height: 844, insets: { top: 47, bottom: 34, left: 0, right: 0 }, fontScale: 1, keyboard: 0, platform: 'ios' },
  small: { name: 'iPhone SE', width: 375, height: 667, insets: { top: 20, bottom: 0, left: 0, right: 0 }, fontScale: 1, keyboard: 0, platform: 'ios' },
  android: { name: 'small Android', width: 360, height: 640, insets: { top: 24, bottom: 16, left: 0, right: 0 }, fontScale: 1, keyboard: 0, platform: 'android' },
  landscape: { name: 'iPhone 15 landscape', width: 844, height: 390, insets: { top: 0, bottom: 21, left: 47, right: 47 }, fontScale: 1, keyboard: 0, platform: 'ios' },
  tablet: { name: 'iPad', width: 1024, height: 1366, insets: { top: 24, bottom: 20, left: 0, right: 0 }, fontScale: 1, keyboard: 0, platform: 'ios' },
};

/** The same device with an open keyboard. */
export const withKeyboard = (d: Device): Device => ({
  ...d,
  name: `${d.name}, keyboard open`,
  keyboard: d.height > d.width ? Math.round(d.height * 0.4) : Math.round(d.height * 0.55),
});
/** The same device with a larger text size setting. */
export const withFontScale = (d: Device, s: number): Device => ({ ...d, name: `${d.name}, text size ×${s}`, fontScale: s });

interface Host {
  type: string;
  props: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  children: (Host | string)[] | null;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
type Kind = 'touch' | 'input' | 'text' | 'scroll' | 'view';

interface Item {
  host: Host;
  kind: Kind;
  yoga: YogaNode;
  parent: Item | null;
  /** Translation from transforms on this element and above. */
  tx: number;
  ty: number;
  rect?: Rect;
  root: number;
  /** Nearest scroll view above: its content may be scrolled into view. */
  scroll: Item | null;
  /** Hidden (opacity 0, display none) or moved fully off screen on purpose (pages waiting either side). */
  hidden: boolean;
  label: string;
  /** Page text laid out by the reader's own measuring; not checked against its page box. */
  pageText: boolean;
  /** Where a top-level element of a scroll view's content is placed from (the scroll view). */
  base?: Rect;
}

export interface Problem {
  kind: 'off-screen' | 'under-keyboard' | 'clipped' | 'spills' | 'overlap' | 'text-overlap';
  what: string;
  detail: string;
}

type Style = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const CHAR = 0.53; // average glyph width / font size for the app's fonts

function textOf(n: Host | string): string {
  if (typeof n === 'string') return n;
  return (n.children ?? []).map(textOf).join('');
}

function describe(n: Host): string {
  const p = n.props;
  const name = p.accessibilityLabel ?? p.placeholder ?? p.testID ?? textOf(n).replace(/\s+/g, ' ').trim().slice(0, 40);
  return `${n.type}${name ? ` "${name}"` : ''}`;
}

const isTouch = (n: Host) => typeof n.props.onResponderRelease === 'function' || typeof n.props.onClick === 'function' || typeof n.props.onPress === 'function';

function scaleOf(props: Style, device: Device) {
  if (props.allowFontScaling === false) return 1;
  const max = props.maxFontSizeMultiplier;
  return max && max >= 1 ? Math.min(device.fontScale, max) : device.fontScale;
}

/** Greedy line breaking with average glyph widths. */
function measureText(text: string, st: Style, scale: number, numberOfLines: number | undefined, maxWidth: number) {
  const fs = (st.fontSize ?? 14) * scale;
  const ls = (st.letterSpacing ?? 0) * scale;
  const cw = fs * CHAR * (/(bold|[6-9]00)/.test(String(st.fontWeight ?? '')) ? 1.06 : 1) + ls;
  const lh = (st.lineHeight ? st.lineHeight * scale : fs * 1.25);
  let lines = 0;
  let widest = 0;
  for (const para of text.split('\n')) {
    let line = 0;
    lines++;
    for (const word of para.split(/(\s+)/)) {
      const w = word.length * cw;
      if (line + w > maxWidth && line > 0 && !/^\s+$/.test(word)) {
        widest = Math.max(widest, line);
        lines++;
        line = Math.min(w, maxWidth);
      } else line += w;
    }
    widest = Math.max(widest, Math.min(line, maxWidth));
  }
  if (numberOfLines) lines = Math.min(lines, numberOfLines);
  return { width: Math.ceil(Math.min(widest, maxWidth)), height: Math.ceil(lines * lh) };
}

function applyStyle(y: Yoga, E: ReturnType<typeof enums>, node: YogaNode, st: Style) {
  const num = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && /%$/.test(v));
  const set = <K extends keyof YogaNode>(fn: K, v: unknown) => {
    if (num(v) || v === 'auto') (node[fn] as (x: unknown) => void)(v);
  };
  set('setWidth', st.width);
  set('setHeight', st.height);
  set('setMinWidth', st.minWidth);
  set('setMinHeight', st.minHeight);
  set('setMaxWidth', st.maxWidth);
  set('setMaxHeight', st.maxHeight);
  if (typeof st.flex === 'number') node.setFlex(st.flex);
  if (typeof st.flexGrow === 'number') node.setFlexGrow(st.flexGrow);
  if (typeof st.flexShrink === 'number') node.setFlexShrink(st.flexShrink);
  set('setFlexBasis', st.flexBasis);
  if (typeof st.aspectRatio === 'number') node.setAspectRatio(st.aspectRatio);
  const dir = { row: E.FlexDirection.Row, column: E.FlexDirection.Column, 'row-reverse': E.FlexDirection.RowReverse, 'column-reverse': E.FlexDirection.ColumnReverse }[st.flexDirection as string];
  if (dir !== undefined) node.setFlexDirection(dir);
  if (st.flexWrap === 'wrap') node.setFlexWrap(E.Wrap.Wrap);
  const justify = { 'flex-start': E.Justify.FlexStart, center: E.Justify.Center, 'flex-end': E.Justify.FlexEnd, 'space-between': E.Justify.SpaceBetween, 'space-around': E.Justify.SpaceAround, 'space-evenly': E.Justify.SpaceEvenly }[st.justifyContent as string];
  if (justify !== undefined) node.setJustifyContent(justify);
  const align = (v: unknown) => ({ auto: E.Align.Auto, 'flex-start': E.Align.FlexStart, center: E.Align.Center, 'flex-end': E.Align.FlexEnd, stretch: E.Align.Stretch, baseline: E.Align.Baseline })[v as string];
  if (align(st.alignItems) !== undefined) node.setAlignItems(align(st.alignItems)!);
  if (align(st.alignSelf) !== undefined) node.setAlignSelf(align(st.alignSelf)!);
  if (st.position === 'absolute') node.setPositionType(E.PositionType.Absolute);
  if (st.display === 'none') node.setDisplay(E.Display.None);
  const edges: [string, number][] = [
    ['', E.Edge.All],
    ['Vertical', E.Edge.Vertical],
    ['Horizontal', E.Edge.Horizontal],
    ['Top', E.Edge.Top],
    ['Bottom', E.Edge.Bottom],
    ['Left', E.Edge.Left],
    ['Right', E.Edge.Right],
    ['Start', E.Edge.Start],
    ['End', E.Edge.End],
  ];
  for (const [suffix, edge] of edges) {
    if (num(st[`margin${suffix}`]) || st[`margin${suffix}`] === 'auto') node.setMargin(edge, st[`margin${suffix}`]);
    if (num(st[`padding${suffix}`])) node.setPadding(edge, st[`padding${suffix}`]);
    if (suffix !== 'Vertical' && suffix !== 'Horizontal' && typeof st[`border${suffix}Width`] === 'number') node.setBorder(edge, st[`border${suffix}Width`]);
  }
  for (const [k, edge] of [['top', E.Edge.Top], ['bottom', E.Edge.Bottom], ['left', E.Edge.Left], ['right', E.Edge.Right], ['start', E.Edge.Start], ['end', E.Edge.End]] as const) {
    if (num(st[k])) node.setPosition(edge, st[k]);
  }
  if (typeof st.gap === 'number') node.setGap(E.Gutter.All, st.gap);
  if (typeof st.rowGap === 'number') node.setGap(E.Gutter.Row, st.rowGap);
  if (typeof st.columnGap === 'number') node.setGap(E.Gutter.Column, st.columnGap);
  void y;
}

function translation(st: Style): [number, number] {
  let x = 0;
  let y = 0;
  for (const t of (st.transform as Record<string, unknown>[] | undefined) ?? []) {
    if (typeof t.translateX === 'number') x += t.translateX;
    if (typeof t.translateY === 'number') y += t.translateY;
  }
  return [x, y];
}

const inside = (a: Rect, b: Rect, tol = 1) => a.x >= b.x - tol && a.y >= b.y - tol && a.x + a.w <= b.x + b.w + tol && a.y + a.h <= b.y + b.h + tol;
const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const fmt = (r: Rect) => `x ${Math.round(r.x)}…${Math.round(r.x + r.w)}, y ${Math.round(r.y)}…${Math.round(r.y + r.h)}`;

export interface CheckOptions {
  /** Space taken above the screen's content by a navigation header (screens under one). */
  headerHeight?: number;
}

/** Lay out `tree` (screen.toJSON()) on `device` and list what goes wrong. */
export async function checkLayout(tree: unknown, device: Device, opts: CheckOptions = {}): Promise<Problem[]> {
  const y = await loadYoga();
  const E = enums();
  const W = device.width;
  const H = device.height;
  const kb = device.keyboard;
  const items: Item[] = [];
  const roots: { yoga: YogaNode; top: number; height: number }[] = [];
  /** Scroll content laid out separately, unconstrained along the scroll axis. */
  const contents: { scroll: Item; content: Host }[] = [];

  const newRoot = (top: number, height: number) => {
    const r = y.Node.create();
    r.setWidth(W);
    r.setHeight(height);
    roots.push({ yoga: r, top, height });
    return r;
  };

  const build = (host: Host | string, parentYoga: YogaNode, parent: Item | null, root: number, scroll: Item | null, hidden: boolean, base?: Rect): void => {
    if (typeof host === 'string' || host == null) return;
    if (host.type === 'Modal') {
      if (!host.props.visible) return;
      // A modal covers the whole window; on Android an open keyboard shrinks the window.
      const height = device.platform === 'android' ? H - kb : H;
      const r = newRoot(0, height);
      for (const c of host.children ?? []) build(c, r, null, roots.length - 1, null, false);
      return;
    }
    const st: Style = { ...(StyleSheet.flatten(host.props.style) ?? {}) };
    if (host.type === 'RCTScrollView') Object.assign(st, { flexGrow: st.flexGrow ?? 1, flexShrink: st.flexShrink ?? 1 }, StyleSheet.flatten(host.props.style) ?? {});
    // KeyboardAvoidingView (mocked to say so): on iOS its "padding" behaviour lifts its content above the keyboard.
    if (host.props.testID === '__kav' && host.props['data-behavior'] === 'padding' && device.platform === 'ios' && kb) st.paddingBottom = (st.paddingBottom ?? 0) + kb;
    const node = y.Node.create();
    applyStyle(y, E, node, st);
    parentYoga.insertChild(node, parentYoga.getChildCount());
    const [tx0, ty0] = translation(st);
    const kind: Kind = host.type === 'TextInput' ? 'input' : host.type === 'Text' ? 'text' : host.type === 'RCTScrollView' ? 'scroll' : isTouch(host) ? 'touch' : 'view';
    const item: Item = {
      host,
      kind,
      yoga: node,
      parent,
      tx: (parent?.tx ?? 0) + tx0,
      ty: (parent?.ty ?? 0) + ty0,
      root,
      scroll,
      hidden: hidden || st.opacity === 0 || st.display === 'none' || host.props.pointerEvents === 'none' && st.opacity === 0,
      label: describe(host),
      pageText: host.type === 'Text' && host.props.textBreakStrategy === 'simple',
      base,
    };
    items.push(item);
    if (kind === 'text' || kind === 'input') {
      const props = host.props;
      const scale = scaleOf(props, device);
      const text = kind === 'input' ? String(props.value || props.placeholder || ' ') : textOf(host);
      const pad = kind === 'input' ? (st.paddingVertical ?? st.padding ?? 0) * 2 : 0;
      node.setMeasureFunc((width, widthMode) => {
        const max = widthMode === E.MeasureMode.Undefined ? Infinity : width;
        const m = measureText(text, st, scale, kind === 'input' ? 1 : props.numberOfLines, max);
        return { width: widthMode === E.MeasureMode.Exactly ? width : m.width, height: m.height + pad };
      });
      return; // nested Text is part of the same paragraph
    }
    if (kind === 'scroll') {
      const content = (host.children ?? []).find((c): c is Host => typeof c !== 'string');
      if (content) contents.push({ scroll: item, content });
      return;
    }
    for (const c of host.children ?? []) build(c, node, item, root, scroll, item.hidden);
  };

  const top = opts.headerHeight ?? 0;
  const main = newRoot(top, (device.platform === 'android' && kb ? H - kb : H) - top);
  const trees = Array.isArray(tree) ? tree : [tree];
  for (const t of trees) build(t as Host, main, null, 0, null, false);

  // Absolute positions, then scroll contents (which need their scroll view's size first).
  const position = (it: Item) => {
    const l = it.yoga.getComputedLayout();
    const base = it.parent?.rect ?? it.base ?? { x: 0, y: roots[it.root].top, w: W, h: 0 };
    it.rect = { x: base.x + l.left, y: base.y + l.top, w: l.width, h: l.height };
  };
  for (const r of roots) r.yoga.calculateLayout(W, r.height, E.Direction.LTR);
  for (const it of items) position(it);
  for (let i = 0; i < contents.length; i++) {
    const { scroll, content } = contents[i];
    const horizontal = !!scroll.host.props.horizontal;
    const sr = scroll.rect!;
    const r = y.Node.create();
    if (horizontal) r.setFlexDirection(E.FlexDirection.Row);
    const first = items.length;
    // React Native lays a horizontal scroll view's content out in a row.
    const laidOut = horizontal ? { ...content, props: { ...content.props, style: [content.props.style, { flexDirection: 'row' }] } } : content;
    build(laidOut, r, null, scroll.root, scroll, scroll.hidden, sr);
    r.calculateLayout(horizontal ? undefined : sr.w, horizontal ? sr.h : undefined, E.Direction.LTR);
    for (let k = first; k < items.length; k++) position(items[k]);
    r.freeRecursive();
  }
  // Transforms move what's drawn (sliding pages, sheets), after layout.
  for (const it of items) {
    if (!it.rect) continue;
    it.rect = { ...it.rect, x: it.rect.x + it.tx, y: it.rect.y + it.ty };
  }

  const screenRect: Rect = { x: 0, y: 0, w: W, h: H };
  const parked = (it: Item) => !!it.rect && overlapArea(it.rect, screenRect) === 0 && (it.tx !== 0 || it.ty !== 0);
  const safe: Rect = {
    x: device.insets.left,
    y: device.insets.top,
    w: W - device.insets.left - device.insets.right,
    h: H - device.insets.top - (kb ? kb : 0),
  };
  // Only the top layer can be used: with a modal open, what's behind it waits
  // (and is checked in a scene of its own).
  const topRoot = roots.length - 1;
  // Hidden under something drawn later with an opaque background (the menu bars
  // cover the page's own header and footer).
  const opaque = (it: Item) => {
    const st = StyleSheet.flatten(it.host.props.style) ?? {};
    const bg = st.backgroundColor;
    if (typeof bg !== 'string' || bg === 'transparent') return false;
    const rgba = /rgba?\(([^)]+)\)/.exec(bg);
    if (rgba) {
      const parts = rgba[1].split(',').map((x) => parseFloat(x));
      if (parts.length === 4 && parts[3] < 1) return false;
    }
    if (/^#[0-9a-f]{8}$/i.test(bg) && !/ff$/i.test(bg)) return false;
    if (/^#[0-9a-f]{4}$/i.test(bg) && !/f$/i.test(bg)) return false;
    return true;
  };
  const covers = items.filter((it) => it.rect && !it.hidden && opaque(it));
  const occluded = (it: Item, index: number) =>
    covers.some((c) => {
      const ci = items.indexOf(c);
      if (ci <= index || c.root !== it.root) return false;
      for (let p = it.parent; p; p = p.parent) if (p === c) return false; // inside it, not under it
      return inside(it.rect!, c.rect!, 0.5);
    });
  const problems: Problem[] = [];
  // Areas that catch taps rather than buttons: the page itself, the dimmed
  // backdrop that closes a sheet or panel. Meant to cover what's under them.
  const tapCatcher = (r: Rect) => r.w * r.h > W * H * 0.25;
  const checked = items.filter((it, i) => it.root === topRoot && !it.hidden && !parked(it) && it.rect && it.rect.w > 0 && it.rect.h > 0 && !occluded(it, i));

  for (const it of checked) {
    if (it.kind !== 'touch' && it.kind !== 'input' && it.kind !== 'text') continue;
    const r = it.rect!;
    if (it.kind === 'touch' && tapCatcher(r)) continue;
    if (it.pageText) continue;
    const where = it.scroll ? { ...it.scroll.rect! } : r;
    if (it.scroll) {
      // In a scroll view: fine as long as the scroll view itself can be seen and used.
      const vis = overlapArea(it.scroll.rect!, safe);
      if (vis < Math.min(44 * 44, it.scroll.rect!.w * it.scroll.rect!.h)) {
        problems.push({ kind: kb ? 'under-keyboard' : 'off-screen', what: it.label, detail: `its scroll view (${fmt(it.scroll.rect!)}) can't be seen on screen` });
      }
    } else if (!inside(where, safe)) {
      const underKb = kb && where.y + where.h > H - kb + 1 && inside(where, { ...safe, h: H - safe.y });
      if (it.kind !== 'text' || where.y < 0 || where.x < 0 || where.x + where.w > W + 1 || where.y + where.h > H + 1 || underKb || where.y < device.insets.top - 1) {
        problems.push({
          kind: underKb ? 'under-keyboard' : 'off-screen',
          what: it.label,
          detail: `at ${fmt(where)}; visible area ${fmt(safe)}`,
        });
      }
    }
    // Cut off by a container that clips (overflow hidden), short of the screen edges;
    // or text spilling out of a fixed-size box you can see (a card, a button).
    for (let p = it.parent; p; p = p.parent) {
      const pst = StyleSheet.flatten(p.host.props.style) ?? {};
      if (pst.overflow === 'hidden' && p.rect && !inside(r, p.rect, 2)) {
        problems.push({ kind: 'clipped', what: it.label, detail: `at ${fmt(r)} but its container clips at ${fmt(p.rect)}` });
        break;
      }
      const boxed = typeof pst.height === 'number' && (pst.borderWidth || (pst.backgroundColor && pst.backgroundColor !== 'transparent'));
      if (it.kind === 'text' && boxed && p.rect && !inside(r, p.rect, 2)) {
        problems.push({ kind: 'spills', what: it.label, detail: `at ${fmt(r)}, out of its ${pst.height}-high box at ${fmt(p.rect)}` });
        break;
      }
    }
  }

  // Buttons on top of buttons, text on top of text.
  const ancestor = (a: Item, b: Item) => {
    for (let p = b.parent; p; p = p.parent) if (p === a) return true;
    return false;
  };
  const sameScrollState = (a: Item, b: Item) => a.scroll === b.scroll;
  /** What can be seen of an element: cut to the containers that clip it. */
  const visible = (it: Item): Rect => {
    let r = it.rect!;
    for (let p = it.parent; p; p = p.parent) {
      const pst = StyleSheet.flatten(p.host.props.style) ?? {};
      if (pst.overflow !== 'hidden' || !p.rect) continue;
      const x = Math.max(r.x, p.rect.x);
      const y = Math.max(r.y, p.rect.y);
      r = { x, y, w: Math.max(0, Math.min(r.x + r.w, p.rect.x + p.rect.w) - x), h: Math.max(0, Math.min(r.y + r.h, p.rect.y + p.rect.h) - y) };
    }
    return r;
  };
  for (const [kinds, kind] of [
    [['touch', 'input'], 'overlap'],
    [['text'], 'text-overlap'],
  ] as const) {
    const list = checked.filter((it) => (kinds as readonly string[]).includes(it.kind) && !it.pageText && !(it.kind === 'touch' && tapCatcher(it.rect!)));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.root !== b.root || !sameScrollState(a, b) || ancestor(a, b) || ancestor(b, a)) continue;
        const ra = visible(a);
        const rb = visible(b);
        const o = overlapArea(ra, rb);
        const small = Math.min(ra.w * ra.h, rb.w * rb.h);
        if (small > 0 && o / small > 0.25) problems.push({ kind, what: `${a.label} and ${b.label}`, detail: `${fmt(ra)} / ${fmt(rb)}` });
      }
    }
  }
  for (const r of roots) r.yoga.freeRecursive();
  return problems;
}

/** One line per problem, for test failure messages. */
export const report = (device: Device, problems: Problem[]) => problems.map((p) => `[${device.name}] ${p.kind}: ${p.what} — ${p.detail}`).join('\n');
