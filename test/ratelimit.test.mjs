// Regression tests for the in-process rate limiter and cache. Offline: fetch is mocked.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const { GoogleMapsClient } = await import('../dist/google-maps-client.js');

const KEY = 'DUMMY_KEY_1234';
const realFetch = globalThis.fetch;
const realWarn = console.warn;
const saved = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

const WAIT = 'LIMITER_WAIT';

function limited({ max = 3, windowMs = 60000 } = {}) {
  process.env.GOOGLE_MAPS_RATE_LIMIT_ENABLED = 'true';
  process.env.GOOGLE_MAPS_RATE_LIMIT_MAX_REQUESTS = String(max);
  process.env.GOOGLE_MAPS_RATE_LIMIT_WINDOW_MS = String(windowMs);
  const c = new GoogleMapsClient(KEY);
  c.sleep = async () => { throw new Error(WAIT); }; // reaching the limiter's wait is the signal
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response(JSON.stringify({ id: 'x', status: 'OK', results: [] }), { status: 200 }); };
  return { c, fetches: () => fetches };
}

async function outcome(fn) {
  try { await fn(); return 'ok'; } catch (e) { return e instanceof Error && e.message === WAIT ? 'blocked' : `error: ${e?.message ?? JSON.stringify(e)}`; }
}

test('geocode is throttled after the configured number of requests (control)', async () => {
  const { c } = limited();
  const results = [];
  for (let i = 1; i <= 5; i++) results.push(await outcome(() => c.geocodeSearch(`q${i}`)));
  assert.deepEqual(results, ['ok', 'ok', 'ok', 'blocked', 'blocked']);
});

test('places_details is throttled across DISTINCT place_ids (limiter bypass regression)', async () => {
  const { c, fetches } = limited();
  const results = [];
  for (let i = 1; i <= 6; i++) results.push(await outcome(() => c.placesDetails(`ChIJ${i}`)));
  assert.deepEqual(results, ['ok', 'ok', 'ok', 'blocked', 'blocked', 'blocked']);
  assert.equal(fetches(), 3, 'only the budgeted requests may reach the upstream');
});

test('place_id values cannot create new limiter buckets', async () => {
  const { c } = limited({ max: 100000 });
  for (let i = 0; i < 300; i++) await c.placesDetails(`ChIJ${i}`);
  assert.equal(c.rateLimiter.size, 1);
  assert.deepEqual([...c.rateLimiter.keys()], ['/v1/places/{id}']);
});

test('the cache is bounded', async () => {
  const { c } = limited({ max: 100000 });
  for (let i = 0; i < 1500; i++) await c.placesDetails(`ChIJ${i}`);
  assert.ok(c.cache.size <= 1000, `cache grew to ${c.cache.size}`);
});

test('a cached repeat of the same place_id does not consume limiter budget', async () => {
  const { c, fetches } = limited();
  for (let i = 0; i < 10; i++) assert.equal(await outcome(() => c.placesDetails('ChIJsame')), 'ok');
  assert.equal(fetches(), 1);
});

test('non-numeric limiter settings fall back to defaults instead of disabling the limiter', async () => {
  console.warn = () => {};
  process.env.GOOGLE_MAPS_RATE_LIMIT_ENABLED = 'true';
  process.env.GOOGLE_MAPS_RATE_LIMIT_MAX_REQUESTS = 'abc';
  process.env.GOOGLE_MAPS_RATE_LIMIT_WINDOW_MS = 'abc';
  const c = new GoogleMapsClient(KEY);
  assert.equal(c.rateLimitMaxRequests, 100);
  assert.equal(c.rateLimitWindowMs, 60000);
});
