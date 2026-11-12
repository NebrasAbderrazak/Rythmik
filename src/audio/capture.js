// Sample-accurate mono capture. capture.record(fromFrame, toFrame) resolves with
// exactly the input samples the context processed for frames [from, to), where
// frame = round(contextTime * sampleRate). Frames already past when the request
// arrives stay zero.

export const CAPTURE_PROCESSOR = 'rythmik-capture';

// The buffer is allocated on the main thread and transferred in and out, so the
// audio thread never allocates and nothing is copied per block.
const PROCESSOR_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.job = null;
    this.alive = true;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.cmd === 'capture') this.job = { id: m.id, from: m.from, to: m.to, buf: m.buffer };
      else if (m.cmd === 'cancel') this.job = null;
      else if (m.cmd === 'close') { this.job = null; this.alive = false; }
    };
  }
  process(inputs) {
    const job = this.job;
    if (!job) return this.alive;
    const ch = inputs[0] && inputs[0][0];
    const start = currentFrame;
    const end = start + (ch ? ch.length : 128);
    if (ch && end > job.from && start < job.to) {
      const a = Math.max(start, job.from);
      const b = Math.min(end, job.to);
      job.buf.set(ch.subarray(a - start, b - start), a - job.from);
    }
    if (end >= job.to) {
      this.port.postMessage({ id: job.id, buffer: job.buf }, [job.buf.buffer]);
      this.job = null;
    }
    return this.alive;
  }
}
registerProcessor('${CAPTURE_PROCESSOR}', CaptureProcessor);
`;

const modules = new WeakMap();

// Inline Blob URL: no extra file to resolve under base './'.
function loadModule(ctx) {
  let p = modules.get(ctx);
  if (!p) {
    const url = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'text/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    p.catch(() => modules.delete(ctx));
    modules.set(ctx, p);
  }
  return p;
}

const hasWorklet = (ctx, Node) => !!(ctx.audioWorklet && typeof Node === 'function'
  && typeof Blob === 'function' && URL.createObjectURL);

/**
 * @returns {Promise<{ kind, node, record(from, to): Promise<Float32Array|null>, cancel(), dispose() }>}
 *   Connect a source to `node`; `node` is kept pulled through a silent path to the destination.
 */
export async function createCapture(ctx, opts = {}) {
  const Node = opts.AudioWorkletNode || globalThis.AudioWorkletNode;
  const capture = hasWorklet(ctx, Node) && !opts.forceScriptProcessor
    ? await createWorkletCapture(ctx, Node)
    : createScriptCapture(ctx);
  // some engines skip nodes that reach no destination
  const sink = ctx.createGain();
  sink.gain.value = 0;
  capture.node.connect(sink).connect(ctx.destination);
  const dispose = capture.dispose;
  capture.dispose = () => { dispose(); try { sink.disconnect(); } catch { /* already gone */ } };
  return capture;
}

function settle(pending, id, value) {
  const p = pending.get(id);
  if (p) { pending.delete(id); p(value); }
}

async function createWorkletCapture(ctx, Node) {
  await loadModule(ctx);
  const node = new Node(ctx, CAPTURE_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers', // stereo inputs are averaged to mono
  });
  const pending = new Map();
  let nextId = 1;
  let current = 0;
  node.port.onmessage = (e) => {
    const { id, buffer } = e.data || {};
    if (id === current) current = 0;
    settle(pending, id, buffer);
  };
  function cancel() {
    if (!current) return;
    node.port.postMessage({ cmd: 'cancel' });
    settle(pending, current, null);
    current = 0;
  }
  return {
    kind: 'worklet',
    node,
    record(from, to) {
      cancel();
      const id = nextId++;
      current = id;
      const buffer = new Float32Array(Math.max(0, to - from));
      return new Promise((resolve) => {
        pending.set(id, resolve);
        node.port.postMessage({ cmd: 'capture', id, from, to, buffer }, [buffer.buffer]);
      });
    },
    cancel,
    dispose() {
      cancel();
      node.port.postMessage({ cmd: 'close' });
      node.port.onmessage = null;
      try { node.disconnect(); } catch { /* already gone */ }
    },
  };
}

// Only for engines without AudioWorklet. The input block is taken to end where
// the output block starts (playbackTime). Engines buffer differently, so this
// can be off by about one block (~40 ms); the manual latency offset covers it.
function createScriptCapture(ctx) {
  const size = 2048;
  const node = ctx.createScriptProcessor(size, 1, 1);
  const sr = ctx.sampleRate;
  let job = null;
  node.onaudioprocess = (e) => {
    if (!job) return;
    const ch = e.inputBuffer.getChannelData(0);
    const start = Math.round(e.playbackTime * sr) - ch.length;
    const end = start + ch.length;
    if (end > job.from && start < job.to) {
      const a = Math.max(start, job.from);
      const b = Math.min(end, job.to);
      job.buf.set(ch.subarray(a - start, b - start), a - job.from);
    }
    if (end >= job.to) {
      const done = job;
      job = null;
      done.resolve(done.buf);
    }
  };
  function cancel() {
    if (job) { const j = job; job = null; j.resolve(null); }
  }
  return {
    kind: 'script-processor',
    node,
    record(from, to) {
      cancel();
      return new Promise((resolve) => {
        job = { from, to, buf: new Float32Array(Math.max(0, to - from)), resolve };
      });
    },
    cancel,
    dispose() {
      cancel();
      node.onaudioprocess = null;
      try { node.disconnect(); } catch { /* already gone */ }
    },
  };
}
