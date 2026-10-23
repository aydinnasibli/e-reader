/// <reference types="jest" />
import { act, render } from '@testing-library/react-native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import type { ScreenAwake } from '@/lib/settings';
import { useScreenAwake } from '@/reader/screenAwake';

const on = activateKeepAwakeAsync as jest.Mock;
const off = deactivateKeepAwake as jest.Mock;

function Probe({ setting, page, hold = false }: { setting: ScreenAwake; page: number; hold?: boolean }) {
  useScreenAwake(setting, page, hold);
  return null;
}

beforeEach(async () => {
  jest.useFakeTimers();
  on.mockClear();
  off.mockClear();
});
afterEach(() => jest.useRealTimers());

it('5 minutes: stays on while pages turn, turns off 5 minutes after the last one', async () => {
  const r = await render(<Probe setting="5" page={1} />);
  expect(on).toHaveBeenCalledTimes(1);
  await act(() => jest.advanceTimersByTime(4 * 60_000));
  await r.rerender(<Probe setting="5" page={2} />); // a page turn restarts the count
  await act(() => jest.advanceTimersByTime(4 * 60_000));
  expect(off).not.toHaveBeenCalled();
  await act(() => jest.advanceTimersByTime(60_000 + 1));
  expect(off).toHaveBeenCalledTimes(1);
  // Turning a page wakes it up again.
  await r.rerender(<Probe setting="5" page={3} />);
  expect(on).toHaveBeenCalledTimes(2);
  await r.unmount();
  expect(off).toHaveBeenCalledTimes(2);
});

it('always: never times out; phone: never keeps the screen on', async () => {
  const r = await render(<Probe setting="always" page={1} />);
  await act(() => jest.advanceTimersByTime(60 * 60_000));
  expect(off).not.toHaveBeenCalled();
  await r.rerender(<Probe setting="system" page={1} />);
  expect(off).toHaveBeenCalledTimes(1);
  await r.rerender(<Probe setting="system" page={2} />);
  expect(on).toHaveBeenCalledTimes(1);
});

it('auto page turn holds the screen on', async () => {
  await render(<Probe setting="2" page={1} hold />);
  await act(() => jest.advanceTimersByTime(30 * 60_000));
  expect(off).not.toHaveBeenCalled();
});

it("phone's own timeout: auto page turn still keeps the screen on while it runs", async () => {
  const r = await render(<Probe setting="system" page={1} hold />);
  expect(on).toHaveBeenCalledTimes(1);
  await act(() => jest.advanceTimersByTime(30 * 60_000));
  expect(off).not.toHaveBeenCalled();
  await r.rerender(<Probe setting="system" page={1} hold={false} />); // auto stopped
  expect(off).toHaveBeenCalledTimes(1);
});
