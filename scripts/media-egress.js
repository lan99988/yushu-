const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
function upstreamProxy() {
  const value = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('配置的出口代理类型不支持'), { code: 'PROXY_UNSUPPORTED' });
  return url;
}
async function connectPinned(address, port) {
  const proxy = upstreamProxy();
  if (!proxy) return new Promise((resolve, reject) => { const socket = net.connect({ host: address, port }); socket.once('connect', () => resolve(socket)); socket.once('error', reject); socket.setTimeout(30000, () => socket.destroy()); });
  return new Promise((resolve, reject) => {
    const headers = {};
    if (proxy.username || proxy.password) headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
    // Give the upstream the checked literal IP, never the hostname it could resolve differently.
    const target = `${address.includes(':') ? `[${address}]` : address}:${port}`;
    const request = (proxy.protocol === 'https:' ? https : http).request({ host: proxy.hostname, port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)), method: 'CONNECT', path: target, headers });
    request.once('connect', (response, socket, head) => { if (response.statusCode !== 200) { socket.destroy(); reject(Object.assign(new Error('出口代理拒绝连接'), { code: 'NETWORK_ERROR' })); return; } if (head.length) socket.unshift(head); resolve(socket); });
    request.once('error', reject); request.setTimeout(30000, () => request.destroy()); request.end();
  });
}
function pinnedAgent(url, address) {
  const Agent = url.protocol === 'https:' ? https.Agent : http.Agent;
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (_options, callback) => {
    connectPinned(address, Number(url.port || (url.protocol === 'https:' ? 443 : 80))).then(socket => {
      if (url.protocol === 'https:') {
        const secure = tls.connect({ socket, servername: net.isIP(url.hostname) ? undefined : url.hostname });
        secure.once('secureConnect', () => callback(null, secure)); secure.once('error', callback);
      } else callback(null, socket);
    }, callback);
  };
  return agent;
}
module.exports = { connectPinned, pinnedAgent };
