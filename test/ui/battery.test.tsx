/// <reference types="jest" />
import { render, screen } from '@testing-library/react-native';
import { BATTERY_LOW, BatteryGlyph } from '@/reader/StatusInfo';

/** The fill's style: width and colour. */
async function fill(level: number) {
  await render(<BatteryGlyph level={level} color="#333333" />);
  const body = screen.getByTestId('battery-glyph').queryAll((n) => [n.props.style].flat().some((st: { width?: unknown } | null) => typeof st?.width === 'string'));
  return Object.assign({}, ...[body[0].props.style].flat()) as { width: string; backgroundColor: string };
}

it('the battery is filled to its level, in the text colour', async () => {
  expect(await fill(0.82)).toMatchObject({ width: '82%', backgroundColor: '#333333' });
  expect((await fill(0.5)).width).toBe('50%');
});

it('red when low', async () => {
  const low = await fill(BATTERY_LOW);
  expect(low.width).toBe('20%');
  expect(low.backgroundColor).not.toBe('#333333');
});
