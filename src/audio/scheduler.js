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
    this.endTime = Infinity; // grid times at or after this are not scheduled
    this._tick = this._tick.bind(this);
  }

  /** `at`: context time of step 0 (ignored if not in the future). */
  start(startDelay = 0.06, at = null) {
    if (this.running) return;
    const ctx = this.getContext();
    this.running = true;
    this.nextStep = 0;
    this.nextTime = Math.max(ctx.currentTime + startDelay, Number.isFinite(at) ? at : 0);
    this.queue = [];
    this.endTime = Infinity;
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
    while (this.nextTime < horizon && this.nextTime < this.endTime) {
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

  /** Context time of the first step-0 at or after minTime, assuming the current tempo holds. */
  getNextBarTime(minTime) {
    if (!this.running) return null;
    const hit = this.queue.find((q) => q.step === 0 && q.time >= minTime);
    if (hit) return hit.time;
    const spb = this.getSecondsPerStep();
    const bar = spb * this.steps;
    let t = this.nextTime + ((this.steps - this.nextStep) % this.steps) * spb;
    if (t < minTime) t += Math.ceil((minTime - t) / bar - 1e-9) * bar;
    return t;
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
