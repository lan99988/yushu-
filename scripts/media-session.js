const fs = require('node:fs');
const path = require('node:path');
const { fail } = require('./core');
const { atomicJson, readJson } = require('./store');
const { startPublicProxy } = require('./media-proxy');

function sourceBrowserOptions(proxyUrl) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(proxyUrl || '')) fail('INVALID_MEDIA_PROXY', '来源浏览器缺少受控公网代理');
  return { proxy: { server: proxyUrl }, args: ['--proxy-bypass-list=<-loopback>', '--disable-quic'], serviceWorkers: 'block' };
}

const SESSION_PLATFORMS = {
  youtube: { home: 'https://www.youtube.com/', domains: ['youtube.com', 'googlevideo.com', 'google.com'] },
  bilibili: { home: 'https://www.bilibili.com/', domains: ['bilibili.com', 'b23.tv', 'bilivideo.com'] },
  douyin: { home: 'https://www.douyin.com/', domains: ['douyin.com', 'iesdouyin.com'] },
  kuaishou: { home: 'https://www.kuaishou.com/', domains: ['kuaishou.com', 'gifshow.com'] },
  xiaohongshu: { home: 'https://www.xiaohongshu.com/', domains: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'] },
  tiktok: { home: 'https://www.tiktok.com/', domains: ['tiktok.com'] },
  vimeo: { home: 'https://vimeo.com/', domains: ['vimeo.com'] },
  weibo: { home: 'https://weibo.com/', domains: ['weibo.com', 'weibo.cn'] },
  tencent: { home: 'https://v.qq.com/', domains: ['qq.com'] },
  iqiyi: { home: 'https://www.iqiyi.com/', domains: ['iqiyi.com', 'iq.com'] },
  youku: { home: 'https://www.youku.com/', domains: ['youku.com'] },
  xigua: { home: 'https://www.ixigua.com/', domains: ['ixigua.com'] },
  x: { home: 'https://x.com/', domains: ['x.com', 'twitter.com'] },
  yuanbao: { home: 'https://yuanbao.tencent.com/', domains: ['yuanbao.tencent.com'] }
};
function sessionPlatform(platform) {
  const key = platform === 'wechat' ? 'yuanbao' : platform;
  if (!Object.hasOwn(SESSION_PLATFORMS, key)) fail('INVALID_PLATFORM', '此平台尚无独立来源会话');
  return key;
}
function acceptsDomain(platform, domain) {
  const host = String(domain || '').replace(/^\./, '').toLowerCase();
  if (sessionPlatform(platform) === 'tencent' && (host === 'yuanbao.tencent.com' || host.endsWith('.yuanbao.tencent.com'))) return false;
  return SESSION_PLATFORMS[sessionPlatform(platform)].domains.some(d => host === d || host.endsWith('.' + d));
}
function validateCookies(platform, input) {
  if (!Array.isArray(input) || !input.length) fail('INVALID_SESSION', 'Cookie 文件必须包含非空数组');
  return input.map(c => {
    if (!c || typeof c !== 'object' || !acceptsDomain(platform, c.domain)) fail('SESSION_DOMAIN_MISMATCH', 'Cookie 站域不属于指定来源平台');
    if (typeof c.name !== 'string' || !c.name || typeof c.value !== 'string' || /[\r\n\t]/.test(c.name + c.value + c.domain))
      fail('INVALID_SESSION', 'Cookie 名称或内容格式无效');
    const cookiePath = c.path || '/';
    if (typeof cookiePath !== 'string' || !cookiePath.startsWith('/') || /[\r\n\t]/.test(cookiePath)) fail('INVALID_SESSION', 'Cookie path 无效');
    const expires = c.expires == null ? -1 : Number(c.expires);
    if (!Number.isFinite(expires) || expires < -1) fail('INVALID_SESSION', 'Cookie 到期时间无效');
    const sameSite = c.sameSite === 'unspecified' || c.sameSite === 'no_restriction' ? 'None' : c.sameSite;
    const normalizedSameSite = sameSite == null ? 'Lax' : ({ strict: 'Strict', lax: 'Lax', none: 'None' }[String(sameSite).toLowerCase()]);
    if (!normalizedSameSite) fail('INVALID_SESSION', 'Cookie SameSite 无效');
    return { name: c.name, value: c.value, domain: c.domain, path: cookiePath, expires: expires === 0 ? -1 : expires,
      httpOnly: c.httpOnly === true, secure: c.secure === true, sameSite: normalizedSameSite };
  });
}
function parseCookieFile(platform, text) {
  const body = String(text).replace(/^\uFEFF/, '').trim();
  if (body.startsWith('[') || body.startsWith('{')) {
    let value; try { value = JSON.parse(body); } catch { fail('INVALID_SESSION', 'Cookie JSON 无效'); }
    return validateCookies(platform, Array.isArray(value) ? value : value.cookies);
  }
  const cookies = [];
  for (const raw of body.split(/\r?\n/)) {
    if (!raw || (raw.startsWith('#') && !raw.startsWith('#HttpOnly_'))) continue;
    const httpOnly = raw.startsWith('#HttpOnly_');
    const fields = (httpOnly ? raw.slice(10) : raw).split('\t');
    if (fields.length !== 7 || !['TRUE', 'FALSE'].includes(fields[1]) || !['TRUE', 'FALSE'].includes(fields[3]))
      fail('INVALID_SESSION', '需要 JSON 或 Netscape Cookie 文件');
    const [domain, , cookiePath, secure, expires, name, value] = fields;
    cookies.push({ domain, path: cookiePath, secure: secure === 'TRUE', expires: Number(expires), name, value, httpOnly });
  }
  return validateCookies(platform, cookies);
}
function renderNetscape(platform, input) {
  return '# Netscape HTTP Cookie File\n' + validateCookies(platform, input).map(c =>
    [c.httpOnly ? '#HttpOnly_' + c.domain : c.domain, c.domain.startsWith('.') ? 'TRUE' : 'FALSE', c.path,
      c.secure ? 'TRUE' : 'FALSE', c.expires < 0 ? '0' : String(Math.floor(c.expires)), c.name, c.value].join('\t')).join('\n') + '\n';
}
class MediaSession {
  constructor(store, platform) {
    this.store = store; this.platform = sessionPlatform(platform);
    this.directory = path.join(store.root, 'media-sessions', this.platform);
    this.jsonFile = path.join(this.directory, 'cookies.json'); this.netscapeFile = path.join(this.directory, 'cookies.txt');
  }
  save(cookies) {
    // Chromium may contain a nameless SDK cookie. It is unusable by the scoped
    // JSON/Netscape bridge; omit it without weakening imported-file validation.
    const scoped = cookies.filter(c => acceptsDomain(this.platform, c.domain) && c.name !== '');
    if (!scoped.length) return false;
    const checked = validateCookies(this.platform, scoped);
    atomicJson(this.jsonFile, checked);
    const tmp = this.netscapeFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, renderNetscape(this.platform, checked), { mode: 0o600 }); fs.renameSync(tmp, this.netscapeFile);
    return true;
  }
  importCookies(file) {
    const cookies = parseCookieFile(this.platform, fs.readFileSync(path.resolve(file), 'utf8'));
    const unlock = this.store.lock('media-session-' + this.platform);
    try { this.save(cookies); return { platform: this.platform, imported: true, cookie_count: cookies.length, login_verified: false }; }
    finally { unlock(); }
  }
  cookieFile() { return fs.existsSync(this.netscapeFile) ? this.netscapeFile : null; }
  browserNetworkOptions() { return sourceBrowserOptions(this.proxy?.url); }
  async open(interactive = false) {
    this.unlock = this.store.lock('media-session-' + this.platform);
    try {
      const executablePath = require('./tingwu').browserPath();
      if (!executablePath) fail('BROWSER_MISSING', '来源会话需要 Chrome 或 VTRANS_CHROME');
      fs.mkdirSync(this.directory, { recursive: true });
      const { chromium } = require('playwright-core');
      this.proxy = await startPublicProxy();
      this.context = await chromium.launchPersistentContext(path.join(this.directory, 'profile'), { executablePath,
        ...this.browserNetworkOptions(), headless: !interactive, viewport: { width: 1280, height: 900 } });
      if (fs.existsSync(this.jsonFile)) {
        await this.context.clearCookies(); await this.context.addCookies(validateCookies(this.platform, readJson(this.jsonFile)));
      }
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.page.setDefaultTimeout(15000);
      await this.page.goto(SESSION_PLATFORMS[this.platform].home, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return this;
    } catch (e) { await this.close(); throw e; }
  }
  async login(seconds = 180, verify) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) fail('INVALID_REQUEST', '人工登录等待秒数应为 1..600');
    await this.open(true);
    try {
      process.stderr.write('请在来源平台独立浏览器中人工完成登录或验证码；不会收集密码。\n');
      const end = Date.now() + seconds * 1000;
      while (Date.now() < end) {
        if (verify) {
          const verified = await verify(this.page);
          if (verified) { const saved = this.save(await this.context.cookies()); return { platform: this.platform, session_saved: saved, login_verified: true }; }
        }
        await new Promise(r => setTimeout(r, Math.min(1000, Math.max(1, end - Date.now()))));
      }
      const saved = this.save(await this.context.cookies());
      if (verify) fail('MEDIA_LOGIN_REQUIRED', '等待人工登录超时，尚未确认来源会话有效', { platform: this.platform, session_saved: saved, login_verified: false });
      return { platform: this.platform, session_saved: saved, login_verified: false,
        next: 'Cookie 已保存不等于登录有效；后续来源提取会验证登录和验证码状态' };
    } finally { await this.close(); }
  }
  async close() {
    try { if (this.context) await this.context.close(); }
    finally {
      this.context = null;
      try { if (this.proxy) await this.proxy.close(); }
      finally { this.proxy = null; if (this.unlock) { this.unlock(); this.unlock = null; } }
    }
  }
}
function cookieArgs(store, platform) {
  const file = new MediaSession(store, platform).cookieFile();
  return file ? ['--cookies', file] : [];
}
module.exports = { MediaSession, sourceBrowserOptions, SESSION_PLATFORMS, sessionPlatform, acceptsDomain, validateCookies, parseCookieFile, renderNetscape, cookieArgs };
