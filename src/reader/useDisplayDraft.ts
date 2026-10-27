// The Display panel's sliders on the reader screen: `draft` holds the values
// being dragged, drawn by LivePreview over the page. On release the values are
// saved and the preview stays until the reader has laid out pages with them
// (or a few seconds at most).

import { useCallback, useEffect, useRef, useState } from 'react';
import { type ReaderSettings, setSettings } from '@/lib/settings';

/** The preview is taken off this long after a release at most, laid out or not. */
const DRAFT_MS = 4000;

export function useDisplayDraft(settings: ReaderSettings) {
  const [draft, setDraft] = useState<Partial<ReaderSettings> | null>(null);
  // Layouts the reader has finished, counted; on release we wait for the next one.
  const readyCount = useRef(0);
  const waitingAfter = useRef<number | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const endDraft = useCallback(() => {
    waitingAfter.current = null;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    setDraft(null);
  }, []);
  /** The reader has laid out pages in a layout (WebReader onLayoutReady). */
  const onLayoutReady = useCallback(() => {
    readyCount.current++;
    if (waitingAfter.current !== null && readyCount.current > waitingAfter.current) endDraft();
  }, [endDraft]);
  const onSlide = useCallback(
    (patch: Partial<ReaderSettings>, done: boolean) => {
      if (!done) {
        if (draftTimer.current) clearTimeout(draftTimer.current);
        waitingAfter.current = null;
        setDraft((d) => ({ ...d, ...patch }));
        return;
      }
      const changed = (Object.keys(patch) as (keyof ReaderSettings)[]).some((k) => patch[k] !== settings[k]);
      setSettings(patch);
      // Scroll mode redraws at once; page mode needs its new pages first.
      if (!changed || settings.mode !== 'page') return endDraft();
      waitingAfter.current = readyCount.current;
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(endDraft, DRAFT_MS);
    },
    [settings, endDraft],
  );
  useEffect(
    () => () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    },
    [],
  );
  return { draft, onLayoutReady, onSlide };
}
