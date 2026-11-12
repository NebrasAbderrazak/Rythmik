/**
 * PCM WAV from an AudioBuffer (or { numberOfChannels, sampleRate, length, getChannelData }).
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
  // symmetric scale: +1.0 clamps to max, -1.0 maps to min exactly
  const scale = 2 ** (bitDepth - 1);
  const max = scale - 1;
  let p = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < channels; c++) {
      const x = data[c][i];
      let v = Number.isFinite(x) ? Math.round(x * scale) : 0;
      if (v > max) v = max;
      else if (v < -scale) v = -scale;
      if (bitDepth === 16) {
        view.setInt16(p, v, true);
      } else {
        view.setUint8(p, v & 0xff);
        view.setUint8(p + 1, (v >> 8) & 0xff);
        view.setUint8(p + 2, (v >> 16) & 0xff);
      }
      p += bytes;
    }
  }
  return out;
}
