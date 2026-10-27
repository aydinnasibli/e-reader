// Room on the phone: how much is free, and whether an error says there was none.

import { Paths } from 'expo-file-system';

/** Free space on the phone, in bytes (Infinity when it can't be told). */
export function freeSpace(): number {
  try {
    const n = Paths.availableDiskSpace;
    return typeof n === 'number' && Number.isFinite(n) ? n : Infinity;
  } catch {
    return Infinity;
  }
}

const NO_SPACE = /ENOSPC|no space|not enough (free )?space|disk full|storage full/i;

/** The error (from a write, a copy or a download) says the phone is full. */
export function isNoSpace(e: unknown): boolean {
  return NO_SPACE.test(String(e));
}
