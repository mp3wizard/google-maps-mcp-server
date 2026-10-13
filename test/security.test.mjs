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
    const server = http.createServer((req, res) => { seen.push({ url: req.url, key: req.headers['x-goog-api-key'] }); handler(req, res); });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const PHOTO = 'places/ChIJabc_123/photos/AUc7tXV-ref_456';
const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

test('places_photos (Places API New) returns the keyless photoUri; key only in the header', async () => {
  const { server, seen, base } = await photoServer((_req, res) => json(res, 200, { name: `${PHOTO}/media`, photoUri: 'https://lh3.googleusercontent.com/photo-abc' }));
  try {
    const c = client();
    c.placesBaseUrl = base;
    const url = await c.placesPhotos(PHOTO);
    assert.equal(url, 'https://lh3.googleusercontent.com/photo-abc');
    assert.equal(seen.length, 1);
    const reqUrl = new URL(seen[0].url, base);
    assert.equal(reqUrl.pathname, `/v1/${PHOTO}/media`);
    assert.equal(reqUrl.searchParams.get('skipHttpRedirect'), 'true');
    assert.equal(reqUrl.searchParams.get('maxWidthPx'), '400', 'default size when none is given');
    assert.equal(reqUrl.searchParams.get('key'), null, 'key must not be in the URL');
    assert.equal(seen[0].key, KEY, 'key is sent in X-Goog-Api-Key');
  } finally { server.close(); }
});

test('places_photos passes the requested sizes', async () => {
  const { server, seen, base } = await photoServer((_req, res) => json(res, 200, { photoUri: 'https://lh3.googleusercontent.com/p' }));
  try {
    const c = client();
    c.placesBaseUrl = base;
    await c.placesPhotos(PHOTO, 800, 600);
    const q = new URL(seen[0].url, base).searchParams;
    assert.equal(q.get('maxWidthPx'), '800');
    assert.equal(q.get('maxHeightPx'), '600');
  } finally { server.close(); }
});

test('places_photos refuses a redirect and never forwards the key header to the redirect target', async () => {
  const target = await photoServer((_req, res) => json(res, 200, { photoUri: 'https://lh3.googleusercontent.com/x' }));
  const origin = await photoServer((_req, res) => { res.writeHead(302, { Location: `http://localhost:${new URL(target.base).port}/elsewhere` }); res.end(); });
  try {
    const c = client();
    c.placesBaseUrl = origin.base;
    const err = await failure(() => c.placesPhotos(PHOTO));
    assert.equal(target.seen.length, 0, 'redirect target must receive nothing');
    assert.ok(!serialize(err).includes(KEY));
  } finally { origin.server.close(); target.server.close(); }
});

test('places_photos refuses a photoUri that carries the key', async () => {
  const { server, base } = await photoServer((_req, res) => json(res, 200, { photoUri: `https://example.invalid/p?key=${KEY}` }));
  try {
    const c = client();
    c.placesBaseUrl = base;
    const err = await failure(() => c.placesPhotos(PHOTO));
    assert.equal(err.code, 'PHOTO_UNAVAILABLE');
    assert.ok(!serialize(err).includes(KEY));
  } finally { server.close(); }
});

test('places_photos upstream error fails cleanly without leaking the key', async () => {
  const { server, base } = await photoServer((_req, res) => json(res, 403, { error: { message: `API key ${KEY} not valid` } }));
  try {
    const c = client();
    c.placesBaseUrl = base;
    const err = await failure(() => c.placesPhotos(PHOTO));
    assert.equal(err.code, 'PHOTO_UNAVAILABLE');
    assert.ok(!serialize(err).includes(KEY));
  } finally { server.close(); }
});

test('places_photos rejects anything that is not a Places API (New) photo name, without any request', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('should not be called'); };
  for (const bad of ['legacyPhotoReference123', '../../v1/places:searchText', 'places/x/photos/y/../../z', 'places/x/photos/y?key=1', '']) {
    const err = await failure(() => client().placesPhotos(bad));
    assert.equal(err.code, 'INVALID_REQUEST', bad);
  }
  assert.equal(calls, 0);
});
