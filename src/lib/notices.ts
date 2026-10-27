// What the data modules have to tell the person (a save that keeps failing, a
// book that needs its file again), said in one place rather than from inside
// the stores. A system alert unless the app shows them its own way.

import { Alert } from 'react-native';

type Show = (title: string, message: string) => void;

let show: Show = (title, message) => Alert.alert(title, message);

export function notice(title: string, message: string) {
  try {
    show(title, message);
  } catch {
    // telling is a courtesy; the data is what matters
  }
}

/** Show notices another way (the app's own dialogs); returns a function that puts the alert back. */
export function setNoticeHandler(handler: Show): () => void {
  const before = show;
  show = handler;
  return () => {
    show = before;
  };
}
