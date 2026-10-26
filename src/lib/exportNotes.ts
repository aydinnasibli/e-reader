// Highlights and notes as a Markdown document, for sharing or keeping.

export interface ExportBook {
  title: string;
  author: string;
  highlights: { text: string; note?: string; chapter?: string; color: string }[];
}

const quote = (s: string) =>
  s
    .trim()
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join('\n');

export function notesMarkdown(books: ExportBook[], date = new Date()): string {
  const out: string[] = ['# Highlights & notes', '', `_Exported from Nec Reader on ${date.toLocaleDateString()}_`];
  for (const b of books) {
    if (!b.highlights.length) continue;
    out.push('', `## ${b.title}${b.author ? ` — ${b.author}` : ''}`);
    let chapter: string | undefined;
    for (const h of b.highlights) {
      if (h.chapter && h.chapter !== chapter) {
        chapter = h.chapter;
        out.push('', `### ${chapter}`);
      }
      out.push('', quote(h.text));
      if (h.note?.trim()) out.push('', `**Note:** ${h.note.trim()}`);
    }
  }
  return out.join('\n') + '\n';
}

/** A file name safe on every system. */
export function exportFileName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${clean || 'Highlights'}.md`;
}
