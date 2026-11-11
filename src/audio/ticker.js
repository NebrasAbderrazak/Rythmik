// Background tabs throttle main-thread setTimeout to ~1 s, which gaps the
// beat. Worker timers are not throttled like that. The worker is an inline
// blob so it works under any base path; falls back to setTimeout where Workers
// are unavailable (node, blob: blocked by CSP).

const WORKER_SOURCE = `
let id = null;
onmessage = (e) => {
  const { cmd, interval } = e.data || {};
  if (id !== null) { clearInterval(id); id = null; }
  if (cmd === 'start') id = setInterval(() => postMessage('tick'), interval);
};
`;

function createWorkerTicker(interval, onTick) {
  const W = globalThis.Worker;
  const Url = globalThis.URL;
  if (typeof W !== 'function' || typeof globalThis.Blob !== 'function' || !Url?.createObjectURL) return null;
  let worker;
  try {
    const url = Url.createObjectURL(new globalThis.Blob([WORKER_SOURCE], { type: 'text/javascript' }));
    worker = new W(url);
    Url.revokeObjectURL?.(url);
  } catch {
    return null;
  }
  let running = false;
  worker.onmessage = () => { if (running) onTick(); };
  return {
    kind: 'worker',
    start() { running = true; worker.postMessage({ cmd: 'start', interval }); },
    stop() { running = false; worker.postMessage({ cmd: 'stop' }); },
    dispose() { running = false; worker.terminate(); },
  };
}

function createTimeoutTicker(interval, onTick) {
  let timer = null;
  const loop = () => { timer = setTimeout(loop, interval); onTick(); };
  return {
    kind: 'timeout',
    start() { if (timer === null) timer = setTimeout(loop, interval); },
    stop() { if (timer !== null) clearTimeout(timer); timer = null; },
    dispose() { this.stop(); },
  };
}

export function createTicker(interval, onTick, opts = {}) {
  const preferWorker = opts.preferWorker ?? true;
  return (preferWorker && createWorkerTicker(interval, onTick)) || createTimeoutTicker(interval, onTick);
}
