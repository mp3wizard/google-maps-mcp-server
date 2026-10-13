// Regression tests: the operator API key must never reach a tool result.
// Offline by design: fetch is mocked, and the photo test only talks to a loopback server.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.GOOGLE_MAPS_RATE_LIMIT_ENABLED = 'false';
const { GoogleMapsClient } = await import('../dist/google-maps-client.js');

const KEY = 'DUMMY_KEY_1234';
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function client(key = KEY) {
  const c = new GoogleMapsClient(key);
  c.sleep = async () => {}; // skip retry backoff
  return c;
}

// Same shape index.ts serializes into the tool result (src/index.ts catch block)
const serialize = (e) => JSON.stringify({ error: { code: e.code, message: e.message, context: e.context } });

async function failure(fn) {
  try { await fn(); } catch (e) { return e; }
  assert.fail('expected the call to fail');
}

const failureModes = {
  ZERO_RESULTS: () => async () => new Response(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }), { status: 200 }),
  'HTTP 400': () => async () => new Response(JSON.stringify({ error: 'bad' }), { status: 400, statusText: 'Bad Request' }),
  'fetch rejection': () => async () => { throw new TypeError('fetch failed'); }
};

// Every endpoint that authenticates with the key= query parameter
const queryAuthCalls = {
  geocodeSearch: (c) => c.geocodeSearch('nowhere-xyz'),
  geocodeReverse: (c) => c.geocodeReverse(1, 2),
  elevationGet: (c) => c.elevationGet([{ lat: 1, lng: 2 }]),
  timezoneGet: (c) => c.timezoneGet(1, 2, 1700000000),
  roadsNearest: (c) => c.roadsNearest([{ lat: 1, lng: 2 }]),
  geolocationEstimate: (c) => c.geolocationEstimate({ considerIp: true })
};

for (const [mode, makeFetch] of Object.entries(failureModes)) {
  for (const [name, call] of Object.entries(queryAuthCalls)) {
    test(`${name}: error never contains the API key (${mode})`, async () => {
      globalThis.fetch = makeFetch();
      const err = await failure(() => call(client()));
      const text = serialize(err);
      assert.ok(!text.includes(KEY), `key leaked: ${text}`);
      assert.ok(!text.includes(encodeURIComponent(KEY)), 'encoded key leaked');
      assert.ok(!/[?&]key=/.test(text), 'key parameter present in error');
    });
  }
}

test('header-auth endpoint: key echoed by the fetch exception text is redacted', async () => {
  // A key with an embedded CR makes undici reject the header and quote the whole value in its message.
  // Reproduce that offline: validate headers exactly like fetch would, then stop before any network.
  const badKey = 'DUMMY\rKEY';
  globalThis.fetch = async (_url, opts) => { new Headers(opts.headers); throw new Error('network blocked in test'); };
  const err = await failure(() => client(badKey).placesSearchText('cafe'));
  const text = serialize(err);
  assert.ok(!text.includes(badKey) && !text.includes('DUMMY\\rKEY'), `key leaked: ${text}`);
  assert.ok(text.includes('[REDACTED]'), 'expected a redaction marker');
});

test('upstream error text that repeats the key is redacted', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'REQUEST_DENIED', error_message: `The key ${KEY} is invalid` }), { status: 200 });
  const err = await failure(() => client().geocodeSearch('x'));
  assert.ok(!serialize(err).includes(KEY));
});

function photoServer(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => { seen.push(req.url); handler(req, res); });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}/maps/api` }));
  });
}

test('places_photos returns the keyless redirect target, not a key-bearing URL', async () => {
  const { server, seen, base } = await photoServer((_req, res) => {
    res.writeHead(302, { Location: 'https://lh3.googleusercontent.com/photo-abc' });
    res.end();
  });
  try {
    const c = client();
    c.baseUrl = base;
    const url = await c.placesPhotos('REF', 400, 300);
    assert.equal(url, 'https://lh3.googleusercontent.com/photo-abc');
    assert.ok(!url.includes(KEY));
    assert.equal(seen.length, 1, 'redirect must not be followed');
    assert.ok(seen[0].includes(`key=${KEY}`), 'the server-side request still authenticates with the key');
  } finally { server.close(); }
});

test('places_photos refuses a redirect target that carries the key', async () => {
  const { server, base } = await photoServer((_req, res) => {
    res.writeHead(302, { Location: `https://example.invalid/p?key=${KEY}` });
    res.end();
  });
  try {
    const c = client();
    c.baseUrl = base;
    const err = await failure(() => c.placesPhotos('REF'));
    assert.ok(!serialize(err).includes(KEY));
    assert.equal(err.code, 'PHOTO_UNAVAILABLE');
  } finally { server.close(); }
});

test('places_photos without a redirect fails cleanly and does not leak the key', async () => {
  const { server, base } = await photoServer((_req, res) => { res.writeHead(200); res.end('not a redirect'); });
  try {
    const c = client();
    c.baseUrl = base;
    const err = await failure(() => c.placesPhotos('REF'));
    assert.ok(!serialize(err).includes(KEY));
    assert.equal(err.code, 'PHOTO_UNAVAILABLE');
  } finally { server.close(); }
});
