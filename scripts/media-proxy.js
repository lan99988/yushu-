const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { assertPublicUrl } = require('./media-network');
const { connectPinned, pinnedAgent } = require('./media-egress');

// A per-download loopback proxy checks every destination, including HTTPS CONNECT tunnels.
// TLS stays end-to-end; no Cookie or signed URL is logged by this proxy.
async function startPublicProxy(options = {}) {
  const sockets = new Set();
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const checked = await assertPublicUrl(incoming.url, options.lookup);
      const target = checked.addresses[0];
      const headers = { ...incoming.headers };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      const remote = (checked.url.protocol === 'https:' ? https : http).request(checked.url, {
        method: incoming.method, headers, agent: pinnedAgent(checked.url, target.address),
        lookup: (_hostname, lookupOptions, cb) => lookupOptions.all ? cb(null, [target]) : cb(null, target.address, target.family)
      }, response => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); });
      remote.setTimeout(30000, () => remote.destroy());
      remote.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      incoming.pipe(remote);
    } catch { outgoing.writeHead(403); outgoing.end('Destination blocked'); }
  });
  server.on('connect', async (request, client, head) => {
    try {
      const checked = await assertPublicUrl(`https://${request.url}`, options.lookup);
      const target = checked.addresses[0];
      const remote = await connectPinned(target.address, Number(checked.url.port || 443));
      sockets.add(remote); remote.on('close', () => sockets.delete(remote));
      remote.setTimeout(30000, () => remote.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); remote.pipe(client); client.pipe(remote);
      remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy());
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { startPublicProxy };
