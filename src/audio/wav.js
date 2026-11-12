const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * PCM WAV from an AudioBuffer (or { numberOfChannels, sampleRate, length, getChannelData }).
 * Samples are clamped to [-1, 1]; NaN and infinities become silence.
 * @param {{ bitDepth?: 16 | 24 }} [opts]
 * @returns {ArrayBuffer}
 */
export function encodeWav(buffer, opts = {}) {
  const bitDepth = opts.bitDepth ?? 16;
  if (bitDepth !== 16 && bitDepth !== 24) throw new Error(`Unsupported bit depth: ${bitDepth}`);
  const channels = buffer.numberOfChannels;
  const { sampleRate, length } = buffer;
  const bytes = bitDepth / 8;
  const blockAlign = channels * bytes;
  const dataSize = length * blockAlign;
  const pad = dataSize & 1; // RIFF chunks are word-aligned

  const out = new ArrayBuffer(44 + dataSize + pad);
  const view = new DataView(out);
  const ascii = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize + pad, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);

  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  if (bitDepth === 24) write24(new Uint8Array(out, 44, dataSize), data, length);
  else if (LITTLE_ENDIAN) write16(out, data, length);
  else write16Portable(view, data, length);
  return out;
}

// Symmetric scale: +1.0 clamps to max, -1.0 maps to min exactly; NaN and
// infinities are silence. Rounds like Math.round (x + scale is never negative here).
function toInt(x, scale, max) {
  if (x > -1 && x < 1) {
    const v = ((x * scale + scale + 0.5) | 0) - scale;
    return v > max ? max : v;
  }
  if (x >= 1) return x < Infinity ? max : 0;
  if (x <= -1) return x > -Infinity ? -scale : 0;
  return 0;
}

// frame by frame so the output is written front to back
function write16(out, data, length) {
  const channels = data.length;
  if (channels === 2) {
    const L = data[0], R = data[1];
    const frames = new Int32Array(out, 44, length);
    for (let i = 0; i < length; i++) {
      frames[i] = (toInt(L[i], 32768, 32767) & 0xffff) | (toInt(R[i], 32768, 32767) << 16);
    }
    return;
  }
  const s = new Int16Array(out, 44, length * channels);
  if (channels === 1) {
    const d = data[0];
    for (let i = 0; i < length; i++) s[i] = toInt(d[i], 32768, 32767);
    return;
  }
  for (let i = 0, p = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) s[p++] = toInt(data[c][i], 32768, 32767);
  }
}

function write16Portable(view, data, length) {
  const channels = data.length;
  for (let i = 0, p = 44; i < length; i++) {
    for (let c = 0; c < channels; c++, p += 2) view.setInt16(p, toInt(data[c][i], 32768, 32767), true);
  }
}

function write24(out, data, length) {
  const channels = data.length;
  for (let i = 0, p = 0; i < length; i++) {
    for (let c = 0; c < channels; c++, p += 3) {
      const v = toInt(data[c][i], 8388608, 8388607);
      out[p] = v;
      out[p + 1] = v >> 8;
      out[p + 2] = v >> 16;
    }
  }
}
