const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../scripts/store');
const { MediaSession, parseCookieFile, renderNetscape, cookieArgs, sessionPlatform } = require('../scripts/media-session');

test('来源 Cookie 严格匹配平台，JSON/Netscape 往返且禁止换行注入', () => {
  const input = [{ domain: '.kuaishou.com', name: 'session', value: 'PRIVATE', path: '/', httpOnly: true, secure: true, expires: -1 }];
  const cookie = parseCookieFile('kuaishou', JSON.stringify(input));
  const roundtrip = parseCookieFile('kuaishou', renderNetscape('kuaishou', cookie));
  assert.equal(roundtrip[0].value, 'PRIVATE'); assert.equal(roundtrip[0].httpOnly, true); assert.equal(roundtrip[0].expires, -1);
  assert.throws(() => parseCookieFile('bilibili', JSON.stringify(input)), /SESSION_DOMAIN_MISMATCH/);
  assert.throws(() => parseCookieFile('kuaishou', JSON.stringify([...input, { ...input[0], domain: 'kuaishou.com.evil.test' }])), /SESSION_DOMAIN_MISMATCH/);
  assert.throws(() => parseCookieFile('yuanbao', JSON.stringify([{ ...input[0], domain: '.tencent.com' }])), /SESSION_DOMAIN_MISMATCH/);
  assert.throws(() => parseCookieFile('kuaishou', JSON.stringify([{ ...input[0], value: 'bad\nvalue' }])), /INVALID_SESSION/);
});

test('来源会话按平台隔离，并为 yt-dlp 返回私有文件参数；导入不声称登录', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-media-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root); const input = path.join(root, 'input.json');
  fs.writeFileSync(input, JSON.stringify([{ domain: '.bilibili.com', name: 'session', value: 'PRIVATE' }]));
  const session = new MediaSession(store, 'bilibili');
  const result = session.importCookies(input);
  assert.equal(result.login_verified, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.deepEqual(cookieArgs(store, 'bilibili'), ['--cookies', session.netscapeFile]);
  assert.deepEqual(cookieArgs(store, 'youtube'), []);
  assert.notEqual(new MediaSession(store, 'youtube').directory, session.directory);
  assert.equal(sessionPlatform('wechat'), 'yuanbao');
  assert.throws(() => new MediaSession(store, '../../session'), /INVALID_PLATFORM/);
});

test('Chromium中的无名站点Cookie不使人工登录保存失败，导入文件仍严格校验', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-nameless-cookie-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new MediaSession(new Store(root), 'douyin');
  assert.equal(session.save([{ domain: '.douyin.com', name: 'sessionid', value: 'PRIVATE' }, { domain: 'www.douyin.com', name: '', value: 'SDK' }]), true);
  assert.equal(JSON.parse(fs.readFileSync(session.jsonFile)).length, 1);
  assert.throws(() => parseCookieFile('douyin', JSON.stringify([{ domain: 'www.douyin.com', name: '', value: 'SDK' }])), { code: 'INVALID_SESSION' });
});
