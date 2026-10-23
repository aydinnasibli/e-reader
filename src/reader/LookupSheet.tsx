// A definition or translation of selected text, in a sheet over the page.

import type { Theme } from '@/lib/settings';
import { Sheet } from '@/ui/Sheet';
import { LookupCard, type LookupKind } from './LookupCard';

interface Props {
  lookup: { kind: LookupKind; text: string } | null;
  lang?: string;
  theme: Theme;
  onChange(lookup: { kind: LookupKind; text: string } | null): void;
}

export function LookupSheet({ lookup, lang, theme, onChange }: Props) {
  return (
    <Sheet visible={!!lookup} onClose={() => onChange(null)} colors={{ bg: theme.chrome, text: theme.text, border: theme.border }}>
      {lookup ? (
        // A card per kind: an answer is never read as the other kind.
        <LookupCard
          key={lookup.kind}
          kind={lookup.kind}
          text={lookup.text}
          lang={lang}
          theme={theme}
          onBack={() => onChange(null)}
          onSwitch={(kind) => onChange({ ...lookup, kind })}
        />
      ) : null}
    </Sheet>
  );
}
