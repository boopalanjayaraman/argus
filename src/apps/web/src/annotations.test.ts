import { describe, test, expect } from 'vitest';
import { boxAt } from './annotations';

describe('boxAt (tracked box at playback time)', () => {
  const frames = [[0, 10, 10, 20, 20, 0.9], [2, 30, 10, 40, 20, 0.9], [20, 0, 0, 5, 5, 0.9]];
  test('interpolates between close samples (fps 5)', () => {
    expect(boxAt(frames, 5, 0.2)).toEqual([20, 10, 30, 20]); // frame 1 = halfway between 0 and 2
  });
  test('holds a lone sample for one frame, then disappears across a long gap', () => {
    expect(boxAt(frames, 5, 0.5)).toEqual([30, 10, 40, 20]);   // frame 2.5, gap to 20 is > 0.6 s
    expect(boxAt(frames, 5, 1.0)).toBeNull();                  // frame 5: not visible
  });
  test('nothing before the first sample', () => {
    expect(boxAt([[3, 1, 1, 2, 2, 1]], 5, 0.1)).toBeNull();
  });
});
