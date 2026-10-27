export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock tests can move forward. */
export class ManualClock implements Clock {
  constructor(private t = Date.UTC(2026, 9, 26, 20, 0, 0)) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
