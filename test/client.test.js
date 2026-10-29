'use strict';

// Tests for createBluOSClient() against a fake BluOS HTTP server that each
// test scripts itself: response bodies, status codes, hangs and chunking.

const { describe, it, mock } = require('node:test');
const assert = require('node:assert');

const { DEFAULTS, createBluOSClient } = require('../bridge.js');
const { startFakeBluOS, getClosedPort, volumeXml, statusXml } = require('./helpers.js');

const HOST = '127.0.0.1';

// Node renamed MockResultSpecification.args -> .arguments; accept either.
function callArgs(call) {
  return call.arguments || call.args || [];
}

function playbackCfg(overrides) {
  return { playback: Object.assign({}, DEFAULTS.playback, overrides || {}) };
}

async function withClient(t, options) {
  const opts = options || {};
  const fake = await startFakeBluOS(opts.server || {});
  t.after(() => fake.close());
  const client = createBluOSClient({ host: HOST, port: fake.port, timeoutMs: opts.timeoutMs === undefined ? 1000 : opts.timeoutMs });
  return { fake, client, requests: fake.requests };
}

describe('createBluOSClient', () => {
  describe('getVolume', () => {
    it('parses level and mute out of a 200 XML body', async (t) => {
      const body = volumeXml({ level: 33, mute: 0 });
      const handler = mock.fn((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(body);
      });
      const { client, requests } = await withClient(t, { server: { handle: handler } });

      assert.deepEqual(await client.getVolume(), { level: 33, mute: false });
      assert.deepEqual(requests, ['/Volume'], 'only the /Volume read should have happened');
      assert.equal(handler.mock.callCount(), 1);
      assert.equal(callArgs(handler.mock.calls[0])[0].url, '/Volume');
    });

    it('parses a muted device (muteVolume wins)', async (t) => {
      const body = volumeXml({ level: 0, mute: 1, muteVolume: 24, db: '-100' });
      const { client } = await withClient(t, { server: { volumeBody: body } });
      assert.deepEqual(await client.getVolume(), { level: 24, mute: true });
    });

    it('resolves with nulls instead of throwing on a garbage body', async (t) => {
      const { client } = await withClient(t, { server: { volumeBody: 'this is not xml at all' } });
      assert.deepEqual(await client.getVolume(), { level: null, mute: false });
    });

    it('resolves with nulls on an empty body', async (t) => {
      const { client } = await withClient(t, { server: { volumeBody: '' } });
      assert.deepEqual(await client.getVolume(), { level: null, mute: false });
    });

    it('reassembles a response split across chunks', async (t) => {
      const handler = mock.fn((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.write('<?xml version="1.0" encoding="UTF-8"?>\n<volum');
        res.write('ute db="-18" offsetDb="0" mute="0" etag="x" source="">4');
        res.end('2</volume>');
      });
      const { client } = await withClient(t, { server: { handle: handler } });
      assert.deepEqual(await client.getVolume(), { level: 42, mute: false });
      assert.equal(handler.mock.callCount(), 1);
    });
  });

  describe('setLevel / setMute', () => {
    it('requests /Volume?level=<n> and resolves with the body', async (t) => {
      const { client, requests } = await withClient(t);
      const body = await client.setLevel(20);
      assert.deepEqual(requests, ['/Volume?level=20']);
      assert.equal(body, volumeXml());
    });

    it('sends the level verbatim, including 0 and the top of the range', async (t) => {
      const { client, requests } = await withClient(t);
      await client.setLevel(0);
      await client.setLevel(100);
      assert.deepEqual(requests, ['/Volume?level=0', '/Volume?level=100']);
    });

    it('requests /Volume?mute=1 and /Volume?mute=0', async (t) => {
      const { client, requests } = await withClient(t);
      await client.setMute(true);
      await client.setMute(false);
      await client.setMute('truthy');
      await client.setMute(0);
      assert.deepEqual(requests, ['/Volume?mute=1', '/Volume?mute=0', '/Volume?mute=1', '/Volume?mute=0']);
    });

    it('keeps requests in order across mixed calls', async (t) => {
      const { client, requests } = await withClient(t);
      await client.setLevel(19);
      await client.setMute(true);
      await client.getVolume();
      assert.deepEqual(requests, ['/Volume?level=19', '/Volume?mute=1', '/Volume']);
    });
  });

  describe('getStatus', () => {
    it('parses state, service and name', async (t) => {
      const body = statusXml({ state: 'stream', service: 'Capture', name: 'Optical Input' });
      const handler = mock.fn((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        res.end(body);
      });
      const { client, requests } = await withClient(t, { server: { handle: handler } });
      assert.deepEqual(await client.getStatus(), { state: 'stream', service: 'Capture', name: 'Optical Input', inputTypeIndex: null });
      assert.deepEqual(requests, ['/Status']);
      assert.equal(callArgs(handler.mock.calls[0])[0].url, '/Status');
    });

    it('resolves with nulls for a stopped device without service/name', async (t) => {
      const { client } = await withClient(t, { server: { statusBody: statusXml({ state: 'stop' }) } });
      assert.deepEqual(await client.getStatus(), { state: 'stop', service: null, name: null, inputTypeIndex: null });
    });

    it('resolves with nulls instead of throwing on a garbage body', async (t) => {
      const { client } = await withClient(t, { server: { statusBody: '<<<>>>' } });
      assert.deepEqual(await client.getStatus(), { state: null, service: null, name: null, inputTypeIndex: null });
    });
  });

  describe('selectInput', () => {
    it('requests /Play?inputType=<enc>&index=<n> when playUrl is null', async (t) => {
      const { client, requests } = await withClient(t);
      await client.selectInput(playbackCfg({ inputType: 'spdif', index: 0, playUrl: null }));
      assert.deepEqual(requests, ['/Play?inputType=spdif&index=0']);
    });

    it('percent-encodes the input type and passes the index through', async (t) => {
      const { client, requests } = await withClient(t);
      await client.selectInput(playbackCfg({ inputType: 'opt ical&x', index: 3, playUrl: null }));
      assert.deepEqual(requests, ['/Play?inputType=opt%20ical%26x&index=3']);
    });

    it('requests /Play?url=<encoded> when playUrl is set', async (t) => {
      const playUrl = 'http://192.0.2.5:11000/Play?custom=1&x=y';
      const { client, requests } = await withClient(t);
      await client.selectInput(playbackCfg({ playUrl: playUrl }));
      assert.deepEqual(requests, ['/Play?url=' + encodeURIComponent(playUrl)]);
    });

    it('prefers playUrl over inputType/index', async (t) => {
      const { client, requests } = await withClient(t);
      await client.selectInput(playbackCfg({ playUrl: 'https://example/stream', inputType: 'bluetooth', index: 7 }));
      assert.deepEqual(requests, ['/Play?url=https%3A%2F%2Fexample%2Fstream']);
    });
  });

  describe('failure modes', () => {
    it('rejects with the HTTP status for a non-200 response', async (t) => {
      const { client } = await withClient(t, {
        server: { routes: [{ match: '/Volume', status: 500, body: 'internal error' }] },
      });
      await assert.rejects(() => client.getVolume(), /HTTP 500 for \/Volume/);
    });

    it('rejects for a non-200 on a mutating request, naming the path', async (t) => {
      const { client } = await withClient(t, {
        server: { routes: [{ match: '/Volume?level', status: 500, body: 'nope' }] },
      });
      await assert.rejects(() => client.setLevel(20), /HTTP 500 for \/Volume\?level=20/);
    });

    it('rejects on 404', async (t) => {
      const { client } = await withClient(t, {
        server: { routes: [{ match: '/Status', status: 404, body: 'not found' }] },
      });
      await assert.rejects(() => client.getStatus(), /HTTP 404 for \/Status/);
    });

    it('rejects on 302 (only 200 is accepted)', async (t) => {
      const { client } = await withClient(t, {
        server: { routes: [{ match: '/Volume', status: 302, body: '' }] },
      });
      await assert.rejects(() => client.getVolume(), /HTTP 302/);
    });

    it('rejects with "timeout after" when the server never responds', async (t) => {
      const { client } = await withClient(t, {
        timeoutMs: 150,
        server: { routes: [{ match: '/Volume', never: true }] },
      });
      await assert.rejects(() => client.getVolume(), /timeout after 150ms for \/Volume/);
    });

    it('rejects a slow-but-eventual response with a timeout', async (t) => {
      const { client } = await withClient(t, {
        timeoutMs: 120,
        server: { routes: [{ match: '/Status', delayMs: 4000, body: statusXml({ state: 'play' }) }] },
      });
      await assert.rejects(() => client.getStatus(), /timeout after 120ms for \/Status/);
    });

    it('rejects with ECONNREFUSED when nothing is listening', async (t) => {
      const port = await getClosedPort();
      const client = createBluOSClient({ host: HOST, port: port, timeoutMs: 1000 });
      await assert.rejects(
        () => client.getVolume(),
        (error) => {
          assert.equal(error.code, 'ECONNREFUSED');
          assert.match(error.message, /ECONNREFUSED/);
          return true;
        },
      );
    });

    it('rejects a mutating request too when the device is gone', async (t) => {
      const port = await getClosedPort();
      const client = createBluOSClient({ host: HOST, port: port, timeoutMs: 1000 });
      await assert.rejects(() => client.setLevel(10), { code: 'ECONNREFUSED' });
      await assert.rejects(() => client.selectInput(playbackCfg()), { code: 'ECONNREFUSED' });
    });
  });
});
