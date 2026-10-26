/// <reference types="jest" />
// Checks what's on screen now on a device, at the text sizes people use, and
// with the keyboard open when there's a text box: collects every problem so
// a test lists them all at once.

import { screen } from '@testing-library/react-native';
import { type CheckOptions, type Device, type Problem, checkLayout, withFontScale, withKeyboard } from './check';

export interface Finding extends Problem {
  device: string;
  scene: string;
}

export function auditor(device: Device) {
  const found: Finding[] = [];
  const seen = new Set<string>();
  return {
    found,
    /** Lay out what's rendered now and note what goes wrong, as `scene`. */
    async check(scene: string, opts: Omit<CheckOptions, 'laidOut'> = {}) {
      const tree = screen.toJSON();
      const hasInput = (function find(n: unknown): boolean {
        if (Array.isArray(n)) return n.some(find);
        const h = n as { type?: string; children?: unknown[] } | null;
        return !!h && typeof h === 'object' && (h.type === 'TextInput' || (h.children ?? []).some(find));
      })(tree);
      const variants = [device, withFontScale(device, 1.35), withFontScale(device, 2)];
      if (hasInput) variants.push(withKeyboard(device), withKeyboard(withFontScale(device, 1.35)));
      for (const d of variants) {
        for (const p of await checkLayout(tree, d, opts)) {
          const key = `${scene}|${p.kind}|${p.what}`;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({ ...p, device: d.name, scene });
        }
      }
    },
    report: () => found.map((f) => `[${f.device}] ${f.scene}: ${f.kind}: ${f.what} — ${f.detail}`).join('\n'),
  };
}
