// Minimal public reverse proxy for agent-wechat on Render.
//
// Render's Web Service requires the app to listen on 0.0.0.0:$PORT.
// The agent-wechat daemon refuses to bind --listen to anything but
// loopback (use --network-listen with TLS for network access), so this
// tiny proxy sits in front of it:
//
//   GET /health  -> forwarded to the daemon's http://127.0.0.1:6174/health
//                  (200 {"status":"ok"} when the daemon is up, 503 when down)
//   GET /        -> 200, short status text (lets a human see the service is up)
//   anything else -> 404
//
// The daemon's real API (which needs the owner token) is deliberately NOT
// exposed. All `wx` commands run inside the container via the Render Shell
// (localhost), where the CLI authenticates automatically.

const http = require('http');

const PORT = parseInt(process.env.PORT || '10000', 10);
const DAEMON_HOST = process.env.DAEMON_HOST || '127.0.0.1';
const DAEMON_PORT = parseInt(process.env.DAEMON_PORT || '6174', 10);

function daemonHealth() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: DAEMON_HOST, port: DAEMON_PORT, path: '/health', method: 'GET', timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    const up = await daemonHealth();
    if (up && up.status === 200) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(up.body || '{"status":"ok"}');
    } else {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'daemon-unavailable' }));
    }
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('agent-wechat daemon is running. Health: GET /health\n');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`proxy listening on 0.0.0.0:${PORT}, daemon at ${DAEMON_HOST}:${DAEMON_PORT}`);
});
