import { describe, it, expect } from 'vitest';
import { encodeWav } from '../src/audio/wav.js';

const fakeBuffer = (channels, sampleRate) => ({
  numberOfChannels: channels.length,
  sampleRate,
  length: channels[0].length,
  getChannelData: (c) => channels[c],
});

const str = (view, at, n) => String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(at + i)));
const int24 = (view, at) => {
  const v = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
  return v & 0x800000 ? v - 0x1000000 : v;
};

describe('encodeWav', () => {
  it('writes a correct 16-bit stereo header', () => {
    const L = new Float32Array([0, 0.5, -0.5]);
    const R = new Float32Array([0.25, -1, 1]);
    const wav = encodeWav(fakeBuffer([L, R], 48000));
    const v = new DataView(wav);
    expect(wav.byteLength).toBe(44 + 3 * 2 * 2);
    expect(str(v, 0, 4)).toBe('RIFF');
    expect(v.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(str(v, 8, 4)).toBe('WAVE');
    expect(str(v, 12, 4)).toBe('fmt ');
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(48000 * 4);
    expect(v.getUint16(32, true)).toBe(4);
    expect(v.getUint16(34, true)).toBe(16);
    expect(str(v, 36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(12);
    // interleaved L R L R ...
    const s = Array.from({ length: 6 }, (_, i) => v.getInt16(44 + i * 2, true));
    expect(s).toEqual([0, 8192, 16384, -32768, -16384, 32767]);
  });

  it('round-trips 16-bit samples within half an LSB and clamps', () => {
    const n = 1000;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.37) * 0.95;
    x[0] = 1.7; x[1] = -3; x[2] = NaN;
    const v = new DataView(encodeWav(fakeBuffer([x], 44100), { bitDepth: 16 }));
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32768);
    expect(v.getInt16(48, true)).toBe(0);
    for (let i = 3; i < n; i++) {
      expect(Math.abs(v.getInt16(44 + i * 2, true) / 32768 - x[i])).toBeLessThanOrEqual(0.5 / 32768 + 1e-9);
    }
  });

  it('writes 24-bit samples', () => {
    const x = new Float32Array([0.5, -0.25, 1, -1, 0.123456]);
    const wav = encodeWav(fakeBuffer([x], 44100), { bitDepth: 24 });
    const v = new DataView(wav);
    expect(wav.byteLength).toBe(44 + 5 * 3 + 1); // odd data size: pad byte
    expect(v.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(v.getUint32(40, true)).toBe(15);
    expect(v.getUint8(wav.byteLength - 1)).toBe(0);
    expect(v.getUint16(32, true)).toBe(3);
    expect(v.getUint16(34, true)).toBe(24);
    expect(v.getUint32(28, true)).toBe(44100 * 3);
    const got = Array.from(x, (_, i) => int24(v, 44 + i * 3));
    expect(got.slice(0, 4)).toEqual([4194304, -2097152, 8388607, -8388608]);
    expect(Math.abs(got[4] / 8388608 - x[4])).toBeLessThanOrEqual(0.5 / 8388608 + 1e-9);
  });

  it('even data size has no pad byte', () => {
    const wav = encodeWav(fakeBuffer([new Float32Array(4)], 44100), { bitDepth: 24 });
    expect(wav.byteLength).toBe(44 + 12);
  });

  it('writes a correct 16-bit mono header', () => {
    const wav = encodeWav(fakeBuffer([new Float32Array([0.5, -0.5, 0])], 22050));
    const v = new DataView(wav);
    expect(wav.byteLength).toBe(44 + 3 * 2);
    expect(v.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(22050);
    expect(v.getUint32(28, true)).toBe(22050 * 2);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(6);
    expect([0, 1, 2].map((i) => v.getInt16(44 + i * 2, true))).toEqual([16384, -16384, 0]);
  });

  it('clamps and silences NaN and infinities in both bit depths', () => {
    const x = new Float32Array([2, -2, NaN, Infinity, -Infinity, 0.99999999, -1]);
    const v16 = new DataView(encodeWav(fakeBuffer([x, x], 44100)));
    const got16 = Array.from(x, (_, i) => v16.getInt16(44 + i * 4 + 2, true));
    expect(got16).toEqual([32767, -32768, 0, 0, 0, 32767, -32768]);
    const v24 = new DataView(encodeWav(fakeBuffer([x], 44100), { bitDepth: 24 }));
    const got24 = Array.from(x, (_, i) => int24(v24, 44 + i * 3));
    expect(got24).toEqual([8388607, -8388608, 0, 0, 0, 8388607, -8388608]);
  });

  it('interleaves 24-bit stereo', () => {
    const L = new Float32Array([0.5, -0.5]);
    const R = new Float32Array([-0.25, 0.25]);
    const v = new DataView(encodeWav(fakeBuffer([L, R], 44100), { bitDepth: 24 }));
    expect([0, 1, 2, 3].map((i) => int24(v, 44 + i * 3))).toEqual([4194304, -2097152, -4194304, 2097152]);
  });

  it('encodes 10 minutes of stereo quickly', () => {
    const sr = 44100;
    const x = new Float32Array(sr * 600);
    for (let i = 0; i < x.length; i++) x[i] = ((i % 200) - 100) / 100;
    const t0 = performance.now();
    const wav = encodeWav(fakeBuffer([x, x], sr));
    const ms = performance.now() - t0;
    expect(wav.byteLength).toBe(44 + x.length * 4);
    const v = new DataView(wav);
    expect(v.getInt16(44 + 4 * 150, true)).toBe(16384);
    expect(ms).toBeLessThan(5000);
  });

  it('pads an odd 24-bit mono data chunk', () => {
    const view = new DataView(encodeWav(fakeBuffer([new Float32Array([0.1, -0.2, 0.3])], 48000), { bitDepth: 24 }));
    expect(view.byteLength).toBe(44 + 9 + 1);
    expect(view.getUint32(4, true)).toBe(view.byteLength - 8);
    expect(view.getUint32(40, true)).toBe(9);
    expect(view.getUint8(53)).toBe(0);
  });

  it('rejects other bit depths', () => {
    expect(() => encodeWav(fakeBuffer([new Float32Array(1)], 44100), { bitDepth: 8 })).toThrow();
  });
});
