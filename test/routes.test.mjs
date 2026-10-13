// Tests for the traffic features of routes_compute / routes_matrix. Offline: fetch is mocked.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.GOOGLE_MAPS_RATE_LIMIT_ENABLED = 'false';
const { GoogleMapsClient } = await import('../dist/google-maps-client.js');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const A = { lat: 13.7456, lng: 100.5342 };
const B = { lat: 13.6900, lng: 100.7501 };

// Encode points as a Google polyline (precision 1e5), used to build fixtures
function encodePolyline(points) {
  let out = '', pLat = 0, pLng = 0;
  const enc = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1, s = '';
    while (n >= 0x20) { s += String.fromCharCode((0x20 | (n & 0x1f)) + 63); n >>= 5; }
    return s + String.fromCharCode(n + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5), lng = Math.round(p.lng * 1e5);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat; pLng = lng;
  }
  return out;
}

function haversine(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function capture(response) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : undefined, headers: opts.headers });
    return new Response(JSON.stringify(response), { status: 200 });
  };
  return calls;
}

async function failure(fn) {
  try { await fn(); } catch (e) { return e; }
  assert.fail('expected the call to fail');
}

test('driving: traffic-aware by default, reports no-traffic duration and the delay', async () => {
  const calls = capture({ routes: [{ duration: '1800s', staticDuration: '1200s', distanceMeters: 30000, polyline: { encodedPolyline: '' } }] });
  const { routes } = await new GoogleMapsClient('K').routesCompute(A, B);
  assert.equal(calls[0].body.travelMode, 'DRIVE');
  assert.equal(calls[0].body.routingPreference, 'TRAFFIC_AWARE');
  assert.match(calls[0].headers['X-Goog-FieldMask'], /routes\.staticDuration/);
  assert.equal(routes[0].duration_seconds, 1800);
  assert.equal(routes[0].static_duration_seconds, 1200);
  assert.equal(routes[0].duration_in_traffic_seconds, 1800, 'duration_in_traffic is the traffic-aware duration, not the static one');
  assert.equal(routes[0].traffic_delay_seconds, 600);
  assert.equal(routes[0].traffic, undefined, 'segments only on request');
});

test('TRAFFIC_UNAWARE: no traffic delay is reported', async () => {
  capture({ routes: [{ duration: '1200s', staticDuration: '1200s', distanceMeters: 30000 }] });
  const { routes } = await new GoogleMapsClient('K').routesCompute(A, B, { routingPreference: 'TRAFFIC_UNAWARE' });
  assert.equal(routes[0].traffic_delay_seconds, undefined);
  assert.equal(routes[0].duration_in_traffic_seconds, undefined);
  assert.equal(routes[0].static_duration_seconds, 1200);
});

for (const mode of ['WALK', 'BICYCLE', 'TRANSIT']) {
  test(`${mode}: routingPreference is not sent (Google only accepts it for driving)`, async () => {
    const calls = capture({ routes: [{ duration: '600s', distanceMeters: 1000 }] });
    await new GoogleMapsClient('K').routesCompute(A, B, { travelMode: mode });
    assert.equal(calls[0].body.travelMode, mode);
    assert.equal('routingPreference' in calls[0].body, false);
  });

  test(`${mode}: an explicit routing_preference is rejected locally, without a request`, async () => {
    const calls = capture({ routes: [] });
    const err = await failure(() => new GoogleMapsClient('K').routesCompute(A, B, { travelMode: mode, routingPreference: 'TRAFFIC_AWARE' }));
    assert.equal(err.code, 'INVALID_REQUEST');
    assert.equal(calls.length, 0);
  });
}

test('departure_time is normalized to UTC and sent as departureTime', async () => {
  const calls = capture({ routes: [{ duration: '1s', distanceMeters: 1 }] });
  await new GoogleMapsClient('K').routesCompute(A, B, { departureTime: '2099-01-01T08:00:00+07:00' });
  assert.equal(calls[0].body.departureTime, '2099-01-01T01:00:00.000Z');
});

test('departure_time: rejects past times, missing zone and garbage; allows the past for TRANSIT', async () => {
  const calls = capture({ routes: [{ duration: '1s', distanceMeters: 1 }] });
  const c = new GoogleMapsClient('K');
  const past = '2020-01-01T00:00:00Z';
  assert.equal((await failure(() => c.routesCompute(A, B, { departureTime: past }))).code, 'INVALID_REQUEST');
  assert.equal((await failure(() => c.routesCompute(A, B, { departureTime: '2099-01-01T08:00:00' }))).code, 'INVALID_REQUEST', 'no time zone');
  assert.equal((await failure(() => c.routesCompute(A, B, { departureTime: 'tomorrow morning' }))).code, 'INVALID_REQUEST');
  assert.equal(calls.length, 0);
  await c.routesCompute(A, B, { travelMode: 'TRANSIT', departureTime: past });
  assert.equal(calls.length, 1);
});

test('include_traffic_segments asks Google for the speed intervals and summarizes slow/jammed stretches', async () => {
  const pts = [
    { lat: 13.7456, lng: 100.5342 }, { lat: 13.7400, lng: 100.5500 }, { lat: 13.7300, lng: 100.5700 },
    { lat: 13.7200, lng: 100.5900 }, { lat: 13.7100, lng: 100.6100 }, { lat: 13.7000, lng: 100.6300 }
  ];
  const calls = capture({ routes: [{
    duration: '1500s', staticDuration: '900s', distanceMeters: 12000,
    polyline: { encodedPolyline: encodePolyline(pts) },
    travelAdvisory: { speedReadingIntervals: [
      { endPolylinePointIndex: 2, speed: 'NORMAL' },                                         // start index omitted = 0
      { startPolylinePointIndex: 2, endPolylinePointIndex: 3, speed: 'TRAFFIC_JAM' },
      { startPolylinePointIndex: 3, endPolylinePointIndex: 4, speed: 'TRAFFIC_JAM' },        // adjacent: merged
      { startPolylinePointIndex: 4, endPolylinePointIndex: 5, speed: 'SLOW' }
    ] }
  }] });
  const { routes } = await new GoogleMapsClient('K').routesCompute(A, B, { includeTrafficSegments: true });
  assert.deepEqual(calls[0].body.extraComputations, ['TRAFFIC_ON_POLYLINE']);
  assert.match(calls[0].headers['X-Goog-FieldMask'], /routes\.travelAdvisory\.speedReadingIntervals/);

  const t = routes[0].traffic;
  assert.ok(t, 'traffic summary present');
  assert.equal(t.segments.length, 2, 'two slow/jam stretches after merging; NORMAL is not listed');
  assert.equal(t.segments[0].speed, 'TRAFFIC_JAM');
  assert.equal(t.segments[0].start_index, 2);
  assert.equal(t.segments[0].end_index, 4);
  assert.deepEqual(t.segments[0].start, { lat: pts[2].lat, lng: pts[2].lng });
  assert.deepEqual(t.segments[0].end, { lat: pts[4].lat, lng: pts[4].lng });
  assert.equal(t.segments[1].speed, 'SLOW');

  const len = (i, j) => { let s = 0; for (let k = i; k < j; k++) s += haversine(pts[k], pts[k + 1]); return s; };
  const near = (a, b) => Math.abs(a - b) <= 3; // polyline rounding and Math.round
  assert.ok(near(t.summary_meters.normal, len(0, 2)), `normal ${t.summary_meters.normal} vs ${len(0, 2)}`);
  assert.ok(near(t.summary_meters.traffic_jam, len(2, 4)));
  assert.ok(near(t.summary_meters.slow, len(4, 5)));
  assert.equal(routes[0].traffic_delay_seconds, 600);
});

test('include_traffic_segments is rejected for non-driving or TRAFFIC_UNAWARE requests, without a request', async () => {
  const calls = capture({ routes: [] });
  const c = new GoogleMapsClient('K');
  assert.equal((await failure(() => c.routesCompute(A, B, { travelMode: 'WALK', includeTrafficSegments: true }))).code, 'INVALID_REQUEST');
  assert.equal((await failure(() => c.routesCompute(A, B, { routingPreference: 'TRAFFIC_UNAWARE', includeTrafficSegments: true }))).code, 'INVALID_REQUEST');
  assert.equal(calls.length, 0);
});

test('routes_matrix: same rules (no routingPreference for WALK, departureTime for driving)', async () => {
  const calls = capture([]);
  const c = new GoogleMapsClient('K');
  await c.routesMatrix([A], [B], { travelMode: 'WALK' });
  assert.equal('routingPreference' in calls[0].body, false);
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  await c.routesMatrix([A], [B], { departureTime: future });
  assert.equal(calls[1].body.routingPreference, 'TRAFFIC_AWARE');
  assert.equal(calls[1].body.departureTime, future);
  const err = await failure(() => c.routesMatrix([A], [B], { travelMode: 'BICYCLE', routingPreference: 'TRAFFIC_AWARE' }));
  assert.equal(err.code, 'INVALID_REQUEST');
});

test('address waypoints use the Routes API shape {address}, not {location:{address}} (HTTP 400 regression)', async () => {
  const calls = capture({ routes: [{ duration: '600s', staticDuration: '500s', distanceMeters: 5000 }] });
  const c = new GoogleMapsClient('K');

  await c.routesCompute({ address: 'BTS Sala Daeng, Bangkok' }, { address: 'Siam Paragon, Bangkok' }, {
    waypoints: [{ location: { address: 'Chulalongkorn University' } }, { location: A }]
  });
  const body = calls[0].body;
  assert.deepEqual(body.origin, { address: 'BTS Sala Daeng, Bangkok' });
  assert.deepEqual(body.destination, { address: 'Siam Paragon, Bangkok' });
  assert.deepEqual(body.intermediates[0], { address: 'Chulalongkorn University' });
  assert.deepEqual(body.intermediates[1], { location: { latLng: { latitude: A.lat, longitude: A.lng } } });
  assert.equal(JSON.stringify(body).includes('"location":{"address"'), false);

  // coordinates keep working and mixing both is fine
  await c.routesCompute(A, { address: 'Siam Paragon, Bangkok' });
  assert.deepEqual(calls[1].body.origin, { location: { latLng: { latitude: A.lat, longitude: A.lng } } });
  assert.deepEqual(calls[1].body.destination, { address: 'Siam Paragon, Bangkok' });
});

test('routes_matrix: address origins and destinations use the Routes API shape', async () => {
  const calls = capture([]);
  await new GoogleMapsClient('K').routesMatrix([{ address: 'Silom' }, A], [{ address: 'Sukhumvit 49' }]);
  const body = calls[0].body;
  assert.deepEqual(body.origins[0], { waypoint: { address: 'Silom' } });
  assert.deepEqual(body.origins[1], { waypoint: { location: { latLng: { latitude: A.lat, longitude: A.lng } } } });
  assert.deepEqual(body.destinations[0], { waypoint: { address: 'Sukhumvit 49' } });
});
