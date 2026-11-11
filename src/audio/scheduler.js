// Look-ahead scheduler ("A Tale of Two Clocks"). The ticker only wakes us up;
// note times come from the audio clock. Tempo is read per step.

import { createTicker } from './ticker.js';

export class Scheduler {
  // getStepOffset delays a single step (swing) without moving the grid
  constructor({
    getContext, getSecondsPerStep, onStep, getStepOffset = () => 0,
    steps = 16, lookahead = 0.1, interval = 25, preferWorker = true,
  }) {
    this.getContext = getContext;
    this.getSecondsPerStep = getSecondsPerStep;
    this.onStep = onStep;
    this.getStepOffset = getStepOffset;
    this.steps = steps;
    this.lookahead = lookahead;
    this.interval = interval;
    this.running = false;
    this.preferWorker = preferWorker;
    this.ticker = null;
    this.nextStep = 0;
    this.nextTime = 0;
    this.queue = []; // [{ step, time }] scheduled, ascending time
    this._tick = this._tick.bind(this);
  }

  start(startDelay = 0.06) {
    if (this.running) return;
    const ctx = this.getContext();
    this.running = true;
    this.nextStep = 0;
    this.nextTime = ctx.currentTime + startDelay;
    this.queue = [];
    if (!this.ticker) this.ticker = createTicker(this.interval, this._tick, { preferWorker: this.preferWorker });
    this._tick();
    this.ticker.start();
  }

  get tickerKind() { return this.ticker ? this.ticker.kind : null; }

  stop() {
    this.running = false;
    if (this.ticker) this.ticker.stop();
    this.queue = [];
  }

  _tick() {
    if (!this.running) return;
    const ctx = this.getContext();
    const horizon = ctx.currentTime + this.lookahead;
    // far behind (suspended context): resync instead of a burst of late notes
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.02;
    while (this.nextTime < horizon) {
      const spb = this.getSecondsPerStep();
      // offset < one step, so the queue stays sorted
      const time = this.nextTime + this.getStepOffset(this.nextStep, spb);
      this.onStep(this.nextStep, time);
      this.queue.push({ step: this.nextStep, time });
      this.nextTime += spb;
      this.nextStep = (this.nextStep + 1) % this.steps;
    }
    if (this.queue.length > 64) this.queue.splice(0, this.queue.length - 64);
  }

  /** -1 when stopped or nothing has sounded yet. */
  getCurrentStep() {
    if (!this.running) return -1;
    const now = this.getContext().currentTime;
    while (this.queue.length > 1 && this.queue[1].time <= now) this.queue.shift();
    const head = this.queue[0];
    return head && head.time <= now ? head.step : -1;
  }
}
