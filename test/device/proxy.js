'use strict';

// Recording reverse proxy for the on-device e2e suite.
//
// The bridge under test is pointed at this proxy instead of the real BluOS
// device, so every request it makes is recorded while the device behaviour
// stays real (the proxy forwards verbatim). The test's own stop/drift commands
// go directly to the device and therefore never appear in this log, which is
// what makes "the bridge never sent /Stop or /Pause" a meaningful assertion.

const http = require('node:http');

function startProxy(options) {
  const opts = options || {};
  if (!opts.targetHost) throw new Error('startProxy: targetHost is required');
  const targetHost = opts.targetHost;
  const targetPort = opts.targetPort === undefined ? 11000 : opts.targetPort;
  const timeoutMs = opts.timeoutMs === undefined ? 5000 : opts.timeoutMs;
  const requests = [];

  const server = http.createServer((req, res) => {
    // Control endpoints are local to the test and never forwarded.
    if (req.url === '/__health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/__requests') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(requests));
      return;
    }
    if (req.url === '/__reset') {
      requests.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    requests.push({ method: req.method, url: req.url, at: Date.now() });

    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: Object.assign({}, req.headers, { host: targetHost + ':' + targetPort }),
      timeout: timeoutMs,
    }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout after ' + timeoutMs + 'ms')));
    upstream.on('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('proxy: ' + error.message);
    });
    req.pipe(upstream);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        requests: requests,
        reset: () => { requests.length = 0; },
        close: () => new Promise((done) => {
          if (server.closeAllConnections) server.closeAllConnections();
          server.close(done);
        }),
      });
    });
  });
}

module.exports = { startProxy };
