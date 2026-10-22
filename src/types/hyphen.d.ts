declare module 'hyphen/*' {
  export function hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string;
}
