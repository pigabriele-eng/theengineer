import { describe, expect, it } from 'vitest';

import type { SessionRun, TheoreticalAnswer } from './api';
import { cornersOf, driverCode, eventLabel, interp, lapTime, theoreticalPicks } from './board';

const run = (id: number, driver: string | null, laps: [number, number, boolean?][]): SessionRun => ({
  id, name: `Run ${id}`, short: `${id}`, driver, driver_id: null,
  laps: laps.map(([number, time, clean]) => ({ number, time, clean: clean ?? true, sections: null })),
});

describe('theoreticalPicks', () => {
  it('takes each stint’s quickest clean lap, quickest first', () => {
    const runs = [run(1, 'A', [[1, 120, false], [2, 108.2], [3, 107.9]]), run(2, 'B', [[1, 107.5], [2, 109]])];
    expect(theoreticalPicks(runs)).toEqual([{ session_id: 2, lap: 1 }, { session_id: 1, lap: 3 }]);
  });
  it('takes a lone stint’s two quickest', () => {
    const runs = [run(7, null, [[2, 110.5], [5, 107.6], [7, 107.44], [8, 116, false]])];
    expect(theoreticalPicks(runs)).toEqual([{ session_id: 7, lap: 7 }, { session_id: 7, lap: 5 }]);
  });
});

const tip = (code: string, gain: number, from: [string, number], versus: [string, number], does: string[],
  also: string[] = []) => ({ code, gain_s: gain, phase: 'exit', phase_s: gain, from, versus, does, also });

describe('cornersOf', () => {
  const answer: TheoreticalAnswer = {
    sections: [], stints: [],
    combined: { time: 107, gap_s: 0.3, best_run: '7', best_lap: 7, best_time: 107.44, laps: 6, from: [], tips: [
      tip('T13', 0.046, ['7', 6], ['7', 7], ['turns in 6 m earlier']),
      tip('T15-T17', 0.201, ['7', 6], ['7', 7], ['turns in 5 m later', 'carries 3 km/h more at the slowest point'],
        ['is flat out 15 m sooner']),
      tip('T11/T12', 0.065, ['7', 3], ['7', 7], []),
      tip('T1', 0.01, ['7', 3], ['7', 7], ['brakes 2 m later']),
    ] },
  };
  it('puts the biggest gains first, in words, with the time worth', () => {
    const got = cornersOf(answer, [run(7, 'Gabriele Piana', [[3, 109.8], [6, 107.68], [7, 107.44]])]);
    expect(got.map((c) => c.code)).toEqual(['T15-T17', 'T11/T12', 'T13']);
    expect(got[0].words).toBe('Lap 6 turns in 5 m later and carries 3 km/h more at the slowest point than lap 7.');
    expect(got[0].also).toBe('It also is flat out 15 m sooner.');
    expect(got[1].words).toBe('Lap 3 is quicker here than lap 7, most of it on the exit.');
  });
  it('names the drivers when two share the car', () => {
    const answer2: TheoreticalAnswer = { sections: [], stints: [], combined: { ...answer.combined!, tips: [
      tip('T6', 0.31, ['2', 4], ['1', 7], ['brakes 8 m later'])] } };
    const got = cornersOf(answer2, [run(1, 'Gabriele Piana', [[7, 107]]), run(2, 'Max Rackl', [[4, 107.2]])]);
    expect(got[0].words).toBe('Lap 4 of stint 2 (RAC) brakes 8 m later than lap 7 of stint 1 (PIA).');
  });
});

describe('formats', () => {
  it('writes lap times as the timing screen does', () => {
    expect(lapTime(107.44)).toBe('1:47.44');
    expect(lapTime(47.4)).toBe('47.40');
    expect(lapTime(null)).toBe('–');
  });
  it('writes the three letters', () => {
    expect(driverCode('Gabriele Piana')).toBe('PIA');
    expect(driverCode(null)).toBeNull();
  });
  it('names events by series and year, tests by month', () => {
    expect(eventLabel('x', 'GT4 European Series', '2025-05-05')).toBe('GT4 Euro 2025');
    expect(eventLabel('Test Hockenheim', null, '2026-02-10')).toBe('Test February 2026');
    expect(eventLabel('02_ADACGT4_T01_HOC', null, '2025-05-05')).toBe('02_ADACGT4_T01_HOC');
  });
  it('interpolates', () => {
    expect(interp(5, [0, 10], [0, 1])).toBe(0.5);
    expect(interp(-1, [0, 10], [0, 1])).toBe(0);
  });
});
