// Shape checks for what is read back from the phone's files (readJson's
// `valid`) and from picked files: JSON of the wrong shape is treated as
// damaged instead of reaching code that expects, say, an array.

export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `key` is one of `table`'s own keys (not one every object inherits, such as "constructor"). */
export const ownKey = <K extends string>(table: Record<K, unknown>, key: unknown): key is K => typeof key === 'string' && Object.prototype.hasOwnProperty.call(table, key);
