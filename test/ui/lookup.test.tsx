/// <reference types="jest" />
// The look-up card in a Turkish book: TDK's definition with the English meaning under it, each
// credited; and translations go into the language chosen for books in that language (Turkish
// books into English, English books into Turkish), not one language for all.

import { fireEvent, render, screen } from '@testing-library/react-native';
import { THEMES } from '@/lib/settings';
import { LookupSheet } from '@/reader/LookupSheet';

const json = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(JSON.stringify(body)) });
const fetchMock = jest.fn();
(global as { fetch: unknown }).fetch = fetchMock;
beforeEach(() => fetchMock.mockReset());

/** The network as it answers for "evlerinden": TDK knows "ev", Wiktionary "ev" (Turkish), Google the form itself. */
function serve() {
  fetchMock.mockImplementation((url: string) => {
    const u = new URL(url);
    if (u.hostname === 'sozluk.gov.tr') {
      return json(u.searchParams.get('ara') === 'ev' ? [{ madde: 'ev', anlamlarListe: [{ anlam: 'Bir kimsenin veya ailenin içinde yaşadığı yer', ozelliklerListe: [{ tur: '3', tam_adi: 'isim' }] }] }] : { error: 'Sonuç bulunamadı' });
    }
    if (u.hostname === 'en.wiktionary.org') {
      return u.pathname.endsWith('/ev') ? json({ tr: [{ partOfSpeech: 'Noun', language: 'Turkish', definitions: [{ definition: 'house, home' }] }] }) : json({}, 404);
    }
    if (u.searchParams.get('dj') === '1') return json({ sentences: [{ trans: 'from their homes', orig: 'evlerinden' }], src: 'tr' });
    const to = u.searchParams.get('tl');
    return json([[[`[${to}] ${u.searchParams.get('q')}`, u.searchParams.get('q'), null, null, 3]], null, 'tr']);
  });
}

it('a Turkish word: TDK’s definition of the word it comes from, the English meaning, what the form means, and who says so', async () => {
  serve();
  await render(<LookupSheet lookup={{ kind: 'define', text: 'evlerinden,' }} lang="tr" theme={THEMES.light} onChange={() => {}} />);
  expect(await screen.findByText('Bir kimsenin veya ailenin içinde yaşadığı yer')).toBeTruthy();
  expect(screen.getByText('house, home')).toBeTruthy();
  expect(screen.getByText('“evlerinden”: from their homes')).toBeTruthy();
  expect(screen.getByText('From TDK Güncel Türkçe Sözlük')).toBeTruthy();
  expect(screen.getByText('From Wiktionary')).toBeTruthy();
});

it('translations go where they were chosen for books in that language', async () => {
  serve();
  const sheet = (lang: string) => <LookupSheet lookup={{ kind: 'translate', text: 'Evlerinden çıktılar.' }} lang={lang} theme={THEMES.light} onChange={() => {}} />;
  // A Turkish book on a phone in English: into English, not Turkish into Turkish.
  const view = await render(sheet('tr'));
  expect(await screen.findByText('[en] Evlerinden çıktılar.')).toBeTruthy();
  // An English book: pick Turkish once...
  await view.rerender(sheet('en'));
  await fireEvent.press(await screen.findByLabelText('Translate into Türkçe'));
  expect(await screen.findByText('[tr] Evlerinden çıktılar.')).toBeTruthy();
  // ...and Turkish books still go into English.
  await view.unmount();
  await render(sheet('tr'));
  expect(await screen.findByText('[en] Evlerinden çıktılar.')).toBeTruthy();
});
