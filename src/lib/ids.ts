// Ids for things the app makes (books, highlights, collections, waiting
// marks): the time, so they sort by when they were made, and a few random
// characters, so two made in the same millisecond differ.

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
