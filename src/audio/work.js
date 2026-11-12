// Long offline jobs run in slices so the page stays responsive.
const SLICE_MS = 20;
const defaultYield = () => new Promise((r) => setTimeout(r, 0));
const now = () => globalThis.performance?.now() ?? Date.now();

/**
 * Returns tick(): call it often; it yields to the event loop about every 20 ms.
 * opts: yield() (custom pause), isCancelled() (tick throws Error(cancelMessage)).
 */
export function makeYielder(opts = {}, cancelMessage = 'cancelled') {
  const yieldFn = opts.yield || defaultYield;
  let last = now();
  return async () => {
    if (opts.isCancelled?.()) throw new Error(cancelMessage);
    if (now() - last < SLICE_MS) return;
    await yieldFn();
    if (opts.isCancelled?.()) throw new Error(cancelMessage);
    last = now();
  };
}
