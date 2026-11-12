// Look-ahead scheduler ("A Tale of Two Clocks"). The ticker only wakes us up;
// note times come from the audio clock. Tempo and loop length are read per step.
// Steps count through the whole loop; a bar is always 16 of them.

import { createTicker } from './ticker.js';

export const BAR_STEPS = 16;

function advanceAnchor(anchors, a) {
  if (a.period) {
    a.at += a.period;
    anchors.sort((x, y) => x.at - y.at);
  } else anchors.shift();
}

/**
 * Moves grid.nextTime onto the first anchor when the next step is within half a
 * step of it, and grid.nextStep onto the nearest bar line of the loop (anchors:
 * ascending [{ at, period }], consumed or advanced in place). Shared by the
 * realtime scheduler and offline renders.
 */
export function snapToAnchors(grid, anchors, spb, loopSteps = BAR_STEPS) {
  const half = spb / 2;
  for (;;) {
    const a = anchors[0];
    if (!a) return;
    if (a.at < grid.nextTime - half) { advanceAnchor(anchors, a); continue; } // missed it
    if (grid.nextTime >= a.at - half) {
      grid.nextTime = a.at;
      grid.nextStep = (Math.round(grid.nextStep / BAR_STEPS) * BAR_STEPS) % loopSteps;
      advanceAnchor(anchors, a);
    }
    return;
  }
}

export class Scheduler {
  // getStepOffset delays a single step (swing) without moving the grid.
  // getLead: how early a step may sound before its grid time (negative nudge,
  // flams), so it is scheduled that much sooner. onStep(step, time, pass, gridTime)
  // may return info that is kept with the step (see getCurrentInfo).
  constructor({
    getContext, getSecondsPerStep, onStep, getStepOffset = () => 0, getLead = () => 0,
    steps = BAR_STEPS, getSteps = null, lookahead = 0.1, interval = 25, preferWorker = true,
  }) {
    this.getContext = getContext;
    this.getSecondsPerStep = getSecondsPerStep;
    this.onStep = onStep;
    this.getStepOffset = getStepOffset;
    this.getLead = getLead;
    this.getSteps = getSteps || (() => steps);
    this.lookahead = lookahead;
    this.interval = interval;
    this.running = false;
    this.preferWorker = preferWorker;
    this.ticker = null;
    this.nextStep = 0;
    this.nextTime = 0;
    this.pass = 0; // completed trips through the loop
    this.startTime = 0;
    this.queue = []; // [{ step, time, gridTime, pass, info }] scheduled, ascending time
    this.endTime = Infinity; // grid times at or after this are not scheduled
    this.anchors = []; // [{ at, period }] ascending: step 0 lands exactly on these times
    this._tick = this._tick.bind(this);
  }

  /** `at`: context time of step 0 (ignored if not in the future). */
  start(startDelay = 0.06, at = null) {
    if (this.running) return;
    const ctx = this.getContext();
    this.running = true;
    this.nextStep = 0;
    this.pass = 0;
    this.nextTime = Math.max(ctx.currentTime + startDelay, Number.isFinite(at) ? at : 0);
    this.startTime = this.nextTime;
    this.queue = [];
    this.endTime = Infinity;
    this.anchors = [];
    if (!this.ticker) this.ticker = createTicker(this.interval, this._tick, { preferWorker: this.preferWorker });
    this._tick();
    this.ticker.start();
  }

  get tickerKind() { return this.ticker ? this.ticker.kind : null; }

  stop() {
    this.running = false;
    if (this.ticker) this.ticker.stop();
    this.queue = [];
    this.anchors = [];
  }

  /**
   * Re-aligns the grid so step 0 lands on each anchor ({ at, period? }; with a
   * period it repeats). A step closer than half a step before an anchor is dropped
   * so the bar never flams.
   */
  setAnchors(list) {
    this.anchors = (list || [])
      .filter((a) => a && Number.isFinite(a.at))
      .map((a) => ({ at: a.at, period: a.period > 0 ? a.period : 0 }))
      .sort((a, b) => a.at - b.at);
  }

  _tick() {
    if (!this.running) return;
    const ctx = this.getContext();
    const horizon = ctx.currentTime + this.lookahead;
    // far behind (suspended context): resync instead of a burst of late notes
    if (this.nextTime < ctx.currentTime - 0.2) this.nextTime = ctx.currentTime + 0.02;
    const lead = Math.max(0, this.getLead() || 0);
    while (this.nextTime - lead < horizon && this.nextTime < this.endTime) {
      const spb = this.getSecondsPerStep();
      const steps = this.getSteps();
      // The loop got shorter under us: rest until the next bar line, then
      // start a new pass so nothing replays with the same chance rolls.
      if (this.nextStep >= steps) {
        this.nextTime += ((BAR_STEPS - (this.nextStep % BAR_STEPS)) % BAR_STEPS) * spb;
        this.nextStep = 0;
        this.pass++;
        continue;
      }
      if (this.anchors.length) {
        const before = this.nextStep;
        snapToAnchors(this, this.anchors, spb, steps);
        if (this.nextStep === 0 && before !== 0) this.pass++;
        if (!(this.nextTime - lead < horizon && this.nextTime < this.endTime)) break;
      }
      // offset < one step, so the queue stays sorted
      const time = this.nextTime + this.getStepOffset(this.nextStep, spb);
      const info = this.onStep(this.nextStep, time, this.pass, this.nextTime);
      this.queue.push({ step: this.nextStep, time, gridTime: this.nextTime, pass: this.pass, info });
      this.nextTime += spb;
      this.nextStep++;
      if (this.nextStep >= steps) { this.nextStep = 0; this.pass++; }
    }
    if (this.queue.length > 64) this.queue.splice(0, this.queue.length - 64);
  }

  /** Context time of the first bar line at or after minTime, assuming the current tempo holds. */
  getNextBarTime(minTime) {
    if (!this.running) return null;
    const hit = this.queue.find((q) => q.step % BAR_STEPS === 0 && q.time >= minTime);
    if (hit) return hit.time;
    const spb = this.getSecondsPerStep();
    const bar = spb * BAR_STEPS;
    let t = this.nextTime + ((BAR_STEPS - (this.nextStep % BAR_STEPS)) % BAR_STEPS) * spb;
    if (t < minTime) t += Math.ceil((minTime - t) / bar - 1e-9) * bar;
    return t;
  }

  /**
   * Loop step and pass on the grid at context time `time` (a step's grid time),
   * assuming tempo and pattern hold; null when stopped or already past.
   */
  getPositionAt(time) {
    if (!this.running) return null;
    const hit = this.queue.find((q) => Math.abs(q.gridTime - time) < 1e-6);
    if (hit) return { step: hit.step, pass: hit.pass };
    const k = Math.round((time - this.nextTime) / this.getSecondsPerStep());
    if (k < 0) return null;
    const steps = this.getSteps();
    const pos = this.nextStep + k;
    return { step: pos % steps, pass: this.pass + Math.floor(pos / steps) };
  }

  _head() {
    if (!this.running) return null;
    const now = this.getContext().currentTime;
    while (this.queue.length > 1 && this.queue[1].time <= now) this.queue.shift();
    const head = this.queue[0];
    return head && head.time <= now ? head : null;
  }

  /** -1 when stopped or nothing has sounded yet. */
  getCurrentStep() {
    const head = this._head();
    return head ? head.step : -1;
  }

  /** What onStep returned for the step sounding now, or null. */
  getCurrentInfo() {
    const head = this._head();
    return head ? head.info ?? null : null;
  }
}
