const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { fail } = require('./core');
const { pinnedAgent } = require('./media-egress');

function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 && c === 0)) ||
      (a === 198 && ([18, 19].includes(b) || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) !== 6) return false;
  const s = address.toLowerCase();
  // Accept globally routable unicast only; reject mapped IPv4 and documentation ranges.
  return /^[23][0-9a-f]{0,3}:/.test(s) && !s.startsWith('2001:db8:');
}
async function assertPublicUrl(value, lookup = dns.lookup) {
  let u; try { u = new URL(value); } catch { fail('INVALID_SOURCE', '无效公网链接'); }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || host === 'localhost' ||
      host.endsWith('.local') || host.endsWith('.internal')) fail('INVALID_SOURCE', '只接受无凭据的公网 HTTP 链接');
  let rows;
  try { rows = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await lookup(host, { all: true, verbatim: true }); }
  catch { fail('NETWORK_ERROR', '来源域名解析失败', { category: 'network', next_action: '检查网络后恢复任务' }); }
  if (!rows.length || rows.some(r => !isPublicAddress(r.address))) fail('PRIVATE_ADDRESS', '来源或重定向指向非公网地址');
  return { url: u, addresses: rows };
}
async function publicRequest(value, options = {}, depth = 0) {
  if (depth > 5) fail('REDIRECT_LIMIT', '来源重定向次数过多');
  const checked = await assertPublicUrl(value, options.lookup);
  const address = checked.addresses[0];
  const response = await new Promise((resolve, reject) => {
    const req = (checked.url.protocol === 'https:' ? https : http).request(checked.url, {
      method: options.method || 'GET', headers: options.headers || {}, agent: pinnedAgent(checked.url, address.address),
      // Pin the connection to the already checked address, preventing a second DNS lookup.
      lookup: (_host, lookupOptions, cb) => lookupOptions.all ? cb(null, [address]) : cb(null, address.address, address.family)
    }, resolve);
    req.setTimeout(options.timeout || 30000, () => req.destroy(Object.assign(new Error('网络超时'), { code: 'NETWORK_TIMEOUT' })));
    req.on('error', () => reject(Object.assign(new Error('公网媒体请求失败'), { code: 'NETWORK_TIMEOUT', details: { category: 'network_timeout' } })));
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
    response.resume();
    const next = new URL(response.headers.location, checked.url);
    if (checked.url.protocol === 'https:' && next.protocol !== 'https:') fail('UNSAFE_REDIRECT', '拒绝 HTTPS 降级重定向');
    // Do not carry Cookie/Authorization across hosts.
    const headers = { ...(options.headers || {}) };
    if (next.origin !== checked.url.origin) for (const key of Object.keys(headers)) if (/^(cookie|authorization)$/i.test(key)) delete headers[key];
    return publicRequest(next.href, { ...options, headers }, depth + 1);
  }
  return { response, final_url: checked.url.href };
}
async function identifyRemote(value) {
  const { response, final_url } = await publicRequest(value, { method: 'HEAD' });
  const type = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
  response.resume();
  return { source: final_url, kind: /mpegurl/.test(type) || /\.m3u8(?:$|\?)/i.test(final_url) ? 'hls' : /^(audio|video)\//.test(type) ? 'direct' : 'page', content_type: type, status: response.statusCode };
}
module.exports = { isPublicAddress, assertPublicUrl, publicRequest, identifyRemote };
