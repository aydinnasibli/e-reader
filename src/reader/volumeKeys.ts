// Turn pages with the volume buttons (installed app only; Expo Go doesn't
// include the native module, so this switches itself off there).
//
// The platform only reports volume *changes*, so each press is answered by
// restoring the previous volume: the volume stays where the reader left it,
// and the direction of the change tells us which way to turn.

import { useEffect, useRef } from 'react';
import { NativeModules, Platform } from 'react-native';

export const volumeKeysAvailable = Platform.OS !== 'web' && !!NativeModules.VolumeManager;

// Loaded only when the native module exists: importing the library without it
// (Expo Go) throws at load time.
type VM = typeof import('react-native-volume-manager').VolumeManager;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const volumeManager = (): VM => require('react-native-volume-manager').VolumeManager;

/** Volume down = next page, volume up = previous page (as most readers do). */
export function useVolumePageTurns(enabled: boolean, onTurn: (dir: 1 | -1) => void) {
  const turn = useRef(onTurn);
  turn.current = onTurn;

  useEffect(() => {
    if (!enabled || !volumeKeysAvailable) return;
    const VolumeManager = volumeManager();
    let base: number | null = null;
    let alive = true;

    (async () => {
      try {
        // iOS needs an (ambient, mixing) audio session to report changes; it won't stop music.
        if (Platform.OS === 'ios') await VolumeManager.enable(true, true);
        await VolumeManager.showNativeVolumeUI({ enabled: false });
        const { volume } = await VolumeManager.getVolume();
        // At the very top or bottom a press wouldn't change anything; nudge slightly inside.
        let v = volume;
        if (v >= 0.97) v = 0.9;
        else if (v <= 0.03) v = 0.1;
        if (v !== volume) await VolumeManager.setVolume(v, { showUI: false });
        if (alive) base = v;
      } catch {
        // not available on this device
      }
    })();

    const sub = VolumeManager.addVolumeListener(({ volume }) => {
      if (base === null) return;
      // Our own restore comes back as an event too; ignore it.
      if (Math.abs(volume - base) < 0.005) return;
      turn.current(volume < base ? 1 : -1);
      VolumeManager.setVolume(base, { showUI: false }).catch(() => {});
    });

    return () => {
      alive = false;
      sub.remove();
      VolumeManager.showNativeVolumeUI({ enabled: true }).catch(() => {});
    };
  }, [enabled]);
}
