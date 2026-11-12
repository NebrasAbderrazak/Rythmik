// Time stretch that keeps the pitch: a phase vocoder with identity phase locking
// (Laroche and Dolson), which keeps tonal music much cleaner than plain bin-by-bin
// propagation. Both channels get the same phase rotation per bin, so the stereo
// image and the timing between channels stay exactly as they were.
import { createFft } from './fft.js';
import { makeYielder } from './work.js';

const TWO_PI = 2 * Math.PI;
const wrap = (x) => x - TWO_PI * Math.round(x / TWO_PI);
// peaks more than 80 dB below the loudest bin of a frame are ignored
const PEAK_FLOOR = 1e-8;

export const stretchFrameSize = (sampleRate) => (sampleRate > 64000 ? 4096 : 2048);

/**
 * channels: Float32Array[] (1 or 2 used, same length). speed 0.8 = slower and
 * longer. Output sample j lines up with input sample j * speed.
 * opts: yield(), isCancelled() (then it rejects with Error('stretch-cancelled')).
 * @returns {Promise<Float32Array[]>} each Math.round(length / speed) long
 */
export async function timeStretch(channels, sampleRate, speed, opts = {}) {
  const used = channels.slice(0, 2);
  const n = used[0]?.length || 0;
  if (speed === 1 || n === 0) return used.map((c) => c.slice());
  if (!(speed > 0)) throw new RangeError(`Bad speed: ${speed}`);
  const tick = makeYielder(opts, 'stretch-cancelled');
  const stereo = used.length > 1;
  const inL = used[0];
  const inR = stereo ? used[1] : null;
  const outLen = Math.round(n / speed);

  const N = stretchFrameSize(sampleRate);
  const half = N / 2;
  const bins = half + 1;
  const Hs = N / 4;
  const fft = createFft(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
  let ola = 0;
  for (let i = 0; i < N; i += Hs) ola += win[i] * win[i];
  const gain = 1 / ola;

  const outL = new Float32Array(outLen);
  const outR = stereo ? new Float32Array(outLen) : null;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const spec = () => new Float64Array(bins);
  let lr = spec(), li = spec(), rr = spec(), ri = spec();
  let plr = spec(), pli = spec(), prr = spec(), pri = spec();
  let rot = spec();
  let prevRot = spec();
  const power = spec();
  const peaks = new Int32Array(bins);
  const peakRot = spec();

  // reference phase at bin k: the mid (L + R), or the left alone when the
  // channels nearly cancel there
  const refPhase = (k, xr, xi, yr, yi, useMid) => (useMid
    ? Math.atan2(xi[k] + yi[k], xr[k] + yr[k])
    : Math.atan2(xi[k], xr[k]));

  let first = true;
  let prevA = 0;
  const mFirst = -Math.ceil(half / Hs);
  const mLast = Math.ceil((outLen + half) / Hs);
  for (let m = mFirst; m <= mLast; m++) {
    if ((m & 7) === 0) await tick();
    const a = Math.round(m * Hs * speed);
    const aStart = a - half;
    for (let i = 0; i < N; i++) {
      const j = aStart + i;
      const inside = j >= 0 && j < n;
      re[i] = inside ? inL[j] * win[i] : 0;
      im[i] = inside && stereo ? inR[j] * win[i] : 0;
    }
    fft.forward(re, im);

    // two real spectra from one complex FFT: x = l + i r
    let loudest = 0;
    for (let k = 0; k < bins; k++) {
      const nk = (N - k) & (N - 1);
      const xr = re[k], xi = im[k], yr = re[nk], yi = im[nk];
      lr[k] = (xr + yr) / 2;
      li[k] = (xi - yi) / 2;
      rr[k] = (xi + yi) / 2;
      ri[k] = (yr - xr) / 2;
      const p = lr[k] * lr[k] + li[k] * li[k] + rr[k] * rr[k] + ri[k] * ri[k];
      power[k] = p;
      if (p > loudest) loudest = p;
    }

    let np = 0;
    const floor = loudest * PEAK_FLOOR;
    for (let k = 2; k < bins - 2; k++) {
      const p = power[k];
      if (p > floor && p > power[k - 1] && p >= power[k + 1] && p > power[k - 2] && p >= power[k + 2]) peaks[np++] = k;
    }

    const Ha = a - prevA;
    for (let j = 0; j < np; j++) {
      const k = peaks[j];
      const mr = lr[k] + rr[k];
      const mi = li[k] + ri[k];
      const useMid = mr * mr + mi * mi >= 0.1 * power[k];
      const phase = refPhase(k, lr, li, rr, ri, useMid);
      if (first) {
        peakRot[j] = 0;
        continue;
      }
      const prevPhase = refPhase(k, plr, pli, prr, pri, useMid);
      const omega = (TWO_PI * k) / N;
      const dev = wrap(phase - prevPhase - omega * Ha);
      const out = prevPhase + prevRot[k] + (omega + dev / Ha) * Hs;
      peakRot[j] = wrap(out - phase);
    }

    // every bin turns with the peak whose region it is in
    rot.fill(0);
    for (let j = 0; j < np; j++) {
      const from = j === 0 ? 1 : ((peaks[j - 1] + peaks[j]) >> 1) + 1;
      const to = j === np - 1 ? half - 1 : (peaks[j] + peaks[j + 1]) >> 1;
      for (let k = from; k <= to; k++) rot[k] = peakRot[j];
    }

    let lastRot = NaN;
    let c = 1, s = 0;
    for (let k = 0; k < bins; k++) {
      if (rot[k] !== lastRot) { lastRot = rot[k]; c = Math.cos(lastRot); s = Math.sin(lastRot); }
      const Lr = lr[k] * c - li[k] * s;
      const Li = lr[k] * s + li[k] * c;
      const Rr = rr[k] * c - ri[k] * s;
      const Ri = rr[k] * s + ri[k] * c;
      re[k] = Lr - Ri;
      im[k] = Li + Rr;
      if (k > 0 && k < half) {
        re[N - k] = Lr + Ri;
        im[N - k] = Rr - Li;
      }
    }
    fft.inverse(re, im);

    const oStart = m * Hs - half;
    const i0 = Math.max(0, -oStart);
    const i1 = Math.min(N, outLen - oStart);
    for (let i = i0; i < i1; i++) {
      const w = win[i] * gain;
      outL[oStart + i] += re[i] * w;
      if (outR) outR[oStart + i] += im[i] * w;
    }

    [lr, plr] = [plr, lr];
    [li, pli] = [pli, li];
    [rr, prr] = [prr, rr];
    [ri, pri] = [pri, ri];
    [rot, prevRot] = [prevRot, rot];
    prevA = a;
    first = false;
  }
  return outR ? [outL, outR] : [outL];
}
