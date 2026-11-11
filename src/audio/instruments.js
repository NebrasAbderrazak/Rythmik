// Every voice is (ctx, destination, time, opts) => handle, so the same code
// runs on realtime and offline contexts. Nodes disconnect when sources end.

const noiseCache = new WeakMap();

export function getNoiseBuffer(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    const len = ctx.sampleRate;
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 0x12345678; // deterministic, so renders are reproducible
    for (let i = 0; i < len; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      data[i] = ((seed >>> 0) / 4294967296) * 2 - 1;
    }
    noiseCache.set(ctx, buf);
  }
  return buf;
}

function cleanupOnEnd(source, nodes) {
  source.onended = () => {
    for (const n of nodes) {
      try { n.disconnect(); } catch { /* already disconnected */ }
    }
  };
}

// kill() cancels voices that were scheduled ahead but have not started yet
function makeVoice(ctx, time, end, sources, outputs) {
  let killed = false;
  return {
    startTime: time,
    endTime: end,
    get killed() { return killed; },
    kill() {
      if (killed) return;
      killed = true;
      const now = ctx.currentTime;
      for (const s of sources) {
        try { s.stop(now); } catch { /* already stopped */ }
      }
      for (const o of outputs) {
        try { o.disconnect(); } catch { /* already disconnected */ }
      }
    },
  };
}

function noiseSource(ctx, time, duration) {
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer(ctx);
  src.start(time);
  src.stop(time + duration);
  return src;
}

export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

export function kick(ctx, destination, time, opts = {}) {
  const vel = opts.velocity ?? 1;
  const decay = opts.decay ?? 0.45;
  const end = time + decay + 0.02;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(70, time + 0.03);
  osc.frequency.exponentialRampToValueAtTime(45, time + 0.14);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(0.8 * vel, time + 0.0015);
  amp.gain.setValueAtTime(0.8 * vel, time + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.001, time + decay);

  osc.connect(amp).connect(destination);
  osc.start(time);
  osc.stop(end);
  cleanupOnEnd(osc, [osc, amp]);

  const click = noiseSource(ctx, time, 0.012);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2500;
  const cAmp = ctx.createGain();
  cAmp.gain.setValueAtTime(0.3 * vel, time);
  cAmp.gain.exponentialRampToValueAtTime(0.001, time + 0.008);
  click.connect(hp).connect(cAmp).connect(destination);
  cleanupOnEnd(click, [click, hp, cAmp]);
  return makeVoice(ctx, time, end, [osc, click], [amp, cAmp]);
}

export function snare(ctx, destination, time, opts = {}) {
  const vel = opts.velocity ?? 1;

  const body = ctx.createOscillator();
  body.type = 'triangle';
  body.frequency.setValueAtTime(240, time);
  body.frequency.exponentialRampToValueAtTime(180, time + 0.06);
  const bAmp = ctx.createGain();
  bAmp.gain.setValueAtTime(0, time);
  bAmp.gain.linearRampToValueAtTime(0.5 * vel, time + 0.001);
  bAmp.gain.exponentialRampToValueAtTime(0.001, time + 0.11);
  body.connect(bAmp).connect(destination);
  body.start(time);
  body.stop(time + 0.13);
  cleanupOnEnd(body, [body, bAmp]);

  const noise = noiseSource(ctx, time, 0.22);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 2200;
  bp.Q.value = 0.7;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 900;
  const nAmp = ctx.createGain();
  nAmp.gain.setValueAtTime(0, time);
  nAmp.gain.linearRampToValueAtTime(0.75 * vel, time + 0.001);
  nAmp.gain.exponentialRampToValueAtTime(0.18 * vel, time + 0.04);
  nAmp.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
  noise.connect(bp).connect(hp).connect(nAmp).connect(destination);
  cleanupOnEnd(noise, [noise, bp, hp, nAmp]);
  return makeVoice(ctx, time, time + 0.22, [body, noise], [bAmp, nAmp]);
}

export function hat(ctx, destination, time, opts = {}) {
  const vel = opts.velocity ?? 1;
  const decay = opts.decay ?? 0.05;

  const noise = noiseSource(ctx, time, decay + 0.02);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 7500;
  hp.Q.value = 0.8;
  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = 10000;
  peak.gain.value = 4;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(0.32 * vel, time + 0.0008);
  amp.gain.exponentialRampToValueAtTime(0.001, time + decay);
  noise.connect(hp).connect(peak).connect(amp).connect(destination);
  cleanupOnEnd(noise, [noise, hp, peak, amp]);
  return makeVoice(ctx, time, time + decay + 0.02, [noise], [amp]);
}


const CHOKE_FADE = 0.01;

// choke() fades through a dedicated gain so it never fights the amp envelope
function chokableVoice(ctx, time, endTime, sources, chokeGain, level) {
  let end = endTime;
  let choked = false;
  const voice = makeVoice(ctx, time, end, sources, [chokeGain]);
  return {
    startTime: time,
    get endTime() { return end; },
    get killed() { return voice.killed; },
    get choked() { return choked; },
    kill() { voice.kill(); },
    choke(t) {
      if (choked || voice.killed || t >= end) return;
      choked = true;
      const at = Math.max(t, time);
      chokeGain.gain.setValueAtTime(level, at);
      chokeGain.gain.linearRampToValueAtTime(0, at + CHOKE_FADE);
      end = at + CHOKE_FADE + 0.004;
      for (const s of sources) {
        try { s.stop(end); } catch { /* already stopped */ }
      }
    },
  };
}

export function openhat(ctx, destination, time, opts = {}) {
  const vel = opts.velocity ?? 1;
  const decay = opts.decay ?? 0.35;
  const end = time + decay + 0.02;

  const noise = noiseSource(ctx, time, decay + 0.02);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 6800;
  hp.Q.value = 0.7;
  const peak = ctx.createBiquadFilter();
  peak.type = 'peaking';
  peak.frequency.value = 9500;
  peak.Q.value = 1.2;
  peak.gain.value = 5;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(0.3 * vel, time + 0.001);
  amp.gain.exponentialRampToValueAtTime(0.14 * vel, time + 0.06);
  amp.gain.exponentialRampToValueAtTime(0.001, time + decay);
  const chokeGain = ctx.createGain();
  chokeGain.gain.value = 1;
  noise.connect(hp).connect(peak).connect(amp).connect(chokeGain).connect(destination);
  cleanupOnEnd(noise, [noise, hp, peak, amp, chokeGain]);
  return chokableVoice(ctx, time, end, [noise], chokeGain, 1);
}

// three quick bursts ~11 ms apart, then a fourth that decays into the tail
export function clap(ctx, destination, time, opts = {}) {
  const vel = opts.velocity ?? 1;
  const level = 0.85 * vel;
  const spacing = 0.011;
  const tail = 0.18;
  const lastBurst = time + 3 * spacing;
  const end = lastBurst + tail + 0.02;

  const noise = noiseSource(ctx, time, end - time);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 650;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1350;
  bp.Q.value = 1.1;
  const amp = ctx.createGain();
  const g = amp.gain;
  g.setValueAtTime(0, time);
  for (let k = 0; k < 3; k++) {
    const bt = time + k * spacing;
    g.linearRampToValueAtTime(level, bt + 0.0008);
    g.exponentialRampToValueAtTime(level * 0.1, bt + spacing - 0.0005);
  }
  g.linearRampToValueAtTime(level, lastBurst + 0.0008);
  g.exponentialRampToValueAtTime(level * 0.25, lastBurst + 0.03);
  g.exponentialRampToValueAtTime(0.001, lastBurst + tail);
  noise.connect(hp).connect(bp).connect(amp).connect(destination);
  cleanupOnEnd(noise, [noise, hp, bp, amp]);
  return makeVoice(ctx, time, end, [noise], [amp]);
}

export function rim(ctx, destination, time, opts = {}) {
  const vel = opts.velocity ?? 1;
  const decay = 0.04;
  const end = time + decay + 0.01;

  const low = ctx.createOscillator();
  low.type = 'square';
  low.frequency.value = 460;
  const high = ctx.createOscillator();
  high.type = 'triangle';
  high.frequency.value = 1720;
  const mix = ctx.createGain();
  mix.gain.value = 1;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1700;
  bp.Q.value = 1.6;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 350;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(0.6 * vel, time + 0.0005);
  amp.gain.exponentialRampToValueAtTime(0.17 * vel, time + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.001, time + decay);
  low.connect(mix);
  high.connect(mix);
  mix.connect(bp).connect(hp).connect(amp).connect(destination);
  for (const o of [low, high]) { o.start(time); o.stop(end); }
  cleanupOnEnd(low, [low, high, mix, bp, hp, amp]);

  const click = noiseSource(ctx, time, 0.006);
  const cHp = ctx.createBiquadFilter();
  cHp.type = 'highpass';
  cHp.frequency.value = 3000;
  const cAmp = ctx.createGain();
  cAmp.gain.setValueAtTime(0.25 * vel, time);
  cAmp.gain.exponentialRampToValueAtTime(0.001, time + 0.005);
  click.connect(cHp).connect(cAmp).connect(destination);
  cleanupOnEnd(click, [click, cHp, cAmp]);
  return makeVoice(ctx, time, end, [low, high, click], [amp, cAmp]);
}

export function shaker(ctx, destination, time, opts = {}) {
  const vel = opts.velocity ?? 1;
  const decay = 0.07;
  const end = time + decay + 0.01;

  const noise = noiseSource(ctx, time, end - time);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 5500;
  bp.Q.value = 1.3;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 3200;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(0.45 * vel, time + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.001, time + decay);
  noise.connect(bp).connect(hp).connect(amp).connect(destination);
  cleanupOnEnd(noise, [noise, bp, hp, amp]);
  return makeVoice(ctx, time, end, [noise], [amp]);
}

const BASS_LEVEL = 0.55;
let shaperCurve = null;
function getSaturationCurve() {
  if (!shaperCurve) {
    const n = 1024;
    shaperCurve = new Float32Array(n);
    const drive = 2.2;
    const norm = Math.tanh(drive);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      shaperCurve[i] = Math.tanh(drive * x) / norm;
    }
  }
  return shaperCurve;
}

// saturation adds harmonics so the 808 is audible on small speakers
export function bass(ctx, destination, time, opts = {}) {
  const vel = opts.velocity ?? 1;
  const decay = opts.decay ?? 1.0;
  const note = opts.note ?? 33;
  const freq = midiToHz(note);
  const end = time + decay + 0.02;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const glide = opts.glide ?? 0.06;
  osc.frequency.setValueAtTime(freq * 1.5, time);
  osc.frequency.exponentialRampToValueAtTime(freq, time + glide);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, time);
  amp.gain.linearRampToValueAtTime(0.75 * vel, time + 0.004);
  amp.gain.setValueAtTime(0.75 * vel, time + 0.08);
  amp.gain.exponentialRampToValueAtTime(0.001, time + decay);

  const shaper = ctx.createWaveShaper();
  shaper.curve = getSaturationCurve();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1400;
  lp.Q.value = 0.5;
  const chokeGain = ctx.createGain();
  chokeGain.gain.value = BASS_LEVEL;

  osc.connect(amp).connect(shaper).connect(lp).connect(chokeGain).connect(destination);
  osc.start(time);
  osc.stop(end);
  cleanupOnEnd(osc, [osc, amp, shaper, lp, chokeGain]);

  const voice = chokableVoice(ctx, time, end, [osc], chokeGain, BASS_LEVEL);
  voice.note = note;
  // legato: only the pitch moves, the amp envelope keeps going. setTargetAtTime
  // needs no cancellation, so chained slides stay continuous.
  voice.slideTo = (nextNote, t, slideTime = 0.08) => {
    if (voice.killed || voice.choked || t >= voice.endTime - 0.05) return false;
    // wait for the initial pitch drop to finish
    const at = Math.max(t, time + glide);
    osc.frequency.setTargetAtTime(midiToHz(nextNote), at, slideTime / 3);
    voice.note = nextNote;
    return true;
  };
  return voice;
}

export const INSTRUMENTS = { kick, snare, clap, hat, openhat, rim, shaker, bass };
