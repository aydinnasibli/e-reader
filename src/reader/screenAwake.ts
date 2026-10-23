// Keeps the screen on while reading: always, or until some minutes pass
// without a page turn (or any other activity), or not at all (the phone's
// own timeout).

import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useRef } from 'react';
import type { ScreenAwake } from '@/lib/settings';

const TAG = 'reader';

/** Milliseconds the screen stays on after activity; 0 = always, null = never. */
export function awakeMs(setting: ScreenAwake): number | null {
  if (setting === 'system') return null;
  if (setting === 'always') return 0;
  const min = Number(setting);
  return Number.isFinite(min) && min > 0 ? min * 60_000 : 0;
}

/**
 * `activity` changes whenever the reader does something (a page turn, a tap
 * on the menu); `hold` keeps the screen on regardless (auto page turn).
 */
export function useScreenAwake(setting: ScreenAwake, activity: unknown, hold: boolean) {
  const on = useRef(false);
  const set = (want: boolean) => {
    if (on.current === want) return;
    on.current = want;
    (want ? activateKeepAwakeAsync(TAG) : deactivateKeepAwake(TAG)).catch(() => {});
  };
  const ms = awakeMs(setting);
  useEffect(() => {
    if (ms === null && !hold) {
      set(false);
      return;
    }
    set(true);
    if (ms === null || ms === 0 || hold) return;
    const timer = setTimeout(() => set(false), ms);
    return () => clearTimeout(timer);
  }, [ms, activity, hold]);
  // Leaving the book: back to the phone's timeout.
  useEffect(() => () => set(false), []);
}
