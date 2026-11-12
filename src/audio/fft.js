// In-place radix-2 complex FFT. Tables are built once per size.
const ffts = new Map();

/** @returns {{ size: number, forward(re, im): void, inverse(re, im): void }} inverse is scaled by 1/n */
export function createFft(n) {
  if (!(n >= 2) || (n & (n - 1)) !== 0) throw new RangeError(`FFT size must be a power of two: ${n}`);
  let fft = ffts.get(n);
  if (fft) return fft;
  const bits = Math.round(Math.log2(n));
  const rev = new Uint32Array(n);
  for (let i = 1; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (bits - 1));
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2); // e^{+i}, inverse
  const nsin = new Float64Array(n / 2); // e^{-i}, forward
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
    nsin[i] = -sin[i];
  }

  function transform(re, im, sn) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let i = 0; i < n; i += 2) {
      const ar = re[i], ai = im[i], br = re[i + 1], bi = im[i + 1];
      re[i] = ar + br; im[i] = ai + bi;
      re[i + 1] = ar - br; im[i + 1] = ai - bi;
    }
    // twiddle in the outer loop: each one is loaded once per stage
    for (let size = 4; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = (n / size) | 0;
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k];
        const wi = sn[k];
        for (let a = j; a < n; a += size) {
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }

  fft = {
    size: n,
    forward(re, im) { transform(re, im, nsin); },
    inverse(re, im) {
      transform(re, im, sin);
      const k = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= k; im[i] *= k; }
    },
  };
  ffts.set(n, fft);
  return fft;
}
