// Makes test/fixtures/textkit-justified.json: a few justified paragraphs as
// TextKit lays them out on iOS (via harness.swift on macOS), in fonts, sizes
// and widths the iOS justification constants in src/reader/hitTest.ts were
// not fitted on. Needs Swift (Xcode or the Command Line Tools).
//
//   node bench/textkit/fixture.mjs

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'bench/.out');
mkdirSync(OUT, { recursive: true });

const sdk = execFileSync('xcrun', ['--show-sdk-path']).toString().trim();
execFileSync('swiftc', ['-O', '-sdk', process.env.SDK ?? sdk, join(ROOT, 'bench/textkit/harness.swift'), '-o', join(OUT, 'textkit')], { stdio: 'inherit' });

const EN =
  'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife. However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families, that he is considered the rightful property of some one or other of their daughters.';
const RU =
  'В начале июля, в чрезвычайно жаркое время, под вечер, один молодой человек вышел из своей каморки, которую нанимал от жильцов в С-м переулке, на улицу и медленно, как бы в нерешимости, отправился к К-ну мосту. Он благополучно избегнул встречи с своею хозяйкой на лестнице.';
const hyphenate = (lang, s) => require(join(ROOT, `node_modules/hyphen/${lang === 'en' ? 'en-us' : 'ru'}`)).hyphenateSync(s, { hyphenChar: '­', minWordLength: 5 });
const fonts = join(ROOT, 'node_modules/@expo-google-fonts');
const files = {
  'Lora-Regular': `${fonts}/lora/400Regular/Lora_400Regular.ttf`,
  'PTSerif-Regular': `${fonts}/pt-serif/400Regular/PTSerif_400Regular.ttf`,
  'OpenSans-Regular': `${fonts}/open-sans/400Regular/OpenSans_400Regular.ttf`,
  'Merriweather-Regular': `${fonts}/merriweather/400Regular/Merriweather_400Regular.ttf`,
};
const cases = [
  { font: 'Georgia', size: 21, width: 300, hyph: false, lang: 'ru' },
  { font: 'system', size: 28, width: 300, hyph: false, lang: 'en' },
  { font: 'Lora-Regular', size: 16, width: 400, hyph: true, lang: 'ru' },
  { font: 'PTSerif-Regular', size: 21, width: 400, hyph: false, lang: 'en' },
  { font: 'OpenSans-Regular', size: 21, width: 300, hyph: true, lang: 'en' },
  { font: 'Merriweather-Regular', size: 28, width: 400, hyph: false, lang: 'ru' },
].map((c) => {
  const body = c.lang === 'en' ? EN : RU;
  return {
    id: `${c.font}|${c.size}|w${c.width}|${c.hyph ? 'hyph' : 'nohyph'}|${c.lang}`,
    text: '  ' + (c.hyph ? hyphenate(c.lang, body) : body),
    font: c.font,
    size: c.size,
    lineHeight: Math.round(c.size * 1.5),
    letterSpacing: 0,
    align: 'justify',
    width: c.width,
  };
});
writeFileSync(join(OUT, 'textkit-cases.json'), JSON.stringify(cases));
const layout = JSON.parse(execFileSync(join(OUT, 'textkit'), [join(OUT, 'textkit-cases.json'), ...Object.values(files)], { maxBuffer: 1 << 28 }).toString());
const round = (x) => Math.round(x * 100) / 100;
const fixture = layout.map((r, i) => ({
  ...cases[i],
  lines: r.lines.map((l) => ({ ...l, w: round(l.w), height: round(l.height), xs: l.xs.map(round) })),
  chars: Object.fromEntries(Object.entries(r.chars).map(([k, v]) => [k, round(v * 1000) / 1000])),
  words: Object.fromEntries(Object.entries(r.words).map(([k, v]) => [k, round(v * 100) / 100])),
}));
writeFileSync(join(ROOT, 'test/fixtures/textkit-justified.json'), JSON.stringify(fixture));
console.log(`test/fixtures/textkit-justified.json: ${fixture.length} paragraphs, ${fixture.reduce((n, f) => n + f.lines.length, 0)} lines`);
