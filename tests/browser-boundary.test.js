const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startPublicProxy } = require('../scripts/media-proxy');
const { sourceBrowserOptions } = require('../scripts/media-session');
const { browserPath } = require('../scripts/tingwu');

test('来源浏览器关闭loopback bypass且移动context使用同一公网代理', () => {
  assert.equal(typeof sourceBrowserOptions, 'function');
  const options = sourceBrowserOptions('http://127.0.0.1:12345');
  assert.equal(options.proxy.server, 'http://127.0.0.1:12345');
  assert.ok(options.args.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(options.args.includes('--disable-quic'));
  assert.equal(options.serviceWorkers, 'block');
});

test('真实Chromium导航和页面fetch均不能访问本机服务', async t => {
  assert.equal(typeof sourceBrowserOptions, 'function');
  const executablePath = browserPath();
  if (!executablePath) return t.skip('未安装可用于浏览器边界验证的Chrome');
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end('LOCAL_SECRET'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const proxy = await startPublicProxy();
  let browser;
  try {
    browser = await require('playwright-core').chromium.launch({ executablePath, headless: true, ...sourceBrowserOptions(proxy.url) });
    const context = await browser.newContext({ proxy: { server: proxy.url }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const url = `http://127.0.0.1:${server.address().port}/secret`;
    await page.goto(url).catch(() => null);
    assert.equal(hits, 0);
    await page.setContent('<html><body>测试来源页面</body></html>');
    const body = await page.evaluate(async target => { try { return await (await fetch(target)).text(); } catch { return 'blocked'; } }, url);
    assert.equal(hits, 0);
    assert.doesNotMatch(body, /LOCAL_SECRET/);
  } finally { if (browser) await browser.close(); await proxy.close(); await new Promise(resolve => server.close(resolve)); }
});
