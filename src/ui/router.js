// Hash routes: #beat (default), #booth, #guide.
export const MODES = ['beat', 'booth'];
export const ROUTES = [...MODES, 'guide'];
export const DEFAULT_ROUTE = 'beat';

export function parseRoute(hash) {
  const name = String(hash ?? '')
    .replace(/^#\/?/, '')
    .split(/[/?&]/)[0]
    .trim()
    .toLowerCase();
  return ROUTES.includes(name) ? name : DEFAULT_ROUTE;
}

export function routeHash(route) {
  return `#${ROUTES.includes(route) ? route : DEFAULT_ROUTE}`;
}
