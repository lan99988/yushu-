const { fail, validateSource } = require('./core');
const { MediaSession } = require('./media-session');

// Implemented from independently verified public-page behavior. These private
// endpoints are compatibility adapters, not a supported Tencent public API.
const YUANBAO_ORIGIN = 'https://yuanbao.tencent.com';
function userState(response) {
  if ([401, 403].includes(response.status)) return 'login_required';
  if (response.status !== 200 || !response.data || typeof response.data !== 'object') return 'unknown';
  const anon = response.data.anonUser?.isAnon;
  if (anon === true) return 'login_required';
  if (anon === false) return 'logged_in';
  return 'unknown';
}
function parseWechatResult(payload) {
  if (!payload || typeof payload !== 'object' || payload.code !== 0 || !payload.data ||
      typeof payload.data.wx_export_id !== 'string' || !payload.data.wx_export_id.trim())
    fail('PLATFORM_SCHEMA_CHANGED', '元宝解析响应不符合已验证结构，停止提取');
  const exportId = payload.data.wx_export_id;
  const playable = payload.data.playable_url;
  if (playable !== undefined && playable !== null && typeof playable !== 'string')
    fail('PLATFORM_SCHEMA_CHANGED', '元宝媒体地址字段结构发生变化');
  return { exportId, playableUrl: playable || null };
}
function parseFinderResult(payload) {
  if (!payload || typeof payload !== 'object') fail('PLATFORM_SCHEMA_CHANGED', '元宝媒体响应不是对象');
  if (payload.code !== undefined && payload.code !== 0) fail('PLATFORM_REJECTED', '元宝拒绝媒体地址请求');
  const url = payload.videoUrl ?? payload.data?.videoUrl;
  if (typeof url !== 'string' || !url.trim()) fail('PLATFORM_SCHEMA_CHANGED', '元宝未返回已验证 videoUrl 字段');
  return url;
}
function normalizeCandidates(values, referer, provider) {
  const seen = new Set(); const candidates = [];
  for (const value of values) {
    const url = typeof value === 'string' ? value : value?.url;
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    try { validateSource(url, true); } catch { continue; }
    seen.add(url);
    const headers = {};
    for (const [name, v] of Object.entries(value?.headers || {}))
      if (/^(User-Agent|Referer)$/i.test(name) && typeof v === 'string' && !/[\r\n]/.test(v)) headers[name] = v;
    candidates.push({ url, label: typeof value?.label === 'string' ? value.label : '来源网页媒体候选', referer, provider,
      ...(Object.keys(headers).length ? { headers } : {}) });
  }
  if (!candidates.length) fail('PLATFORM_UNSUPPORTED', '来源没有可确认的公网媒体候选');
  return candidates;
}
function mediaReferer(source) { const url = new URL(source); return url.origin + url.pathname; }
async function requestJson(page, endpoint, body) {
  const response = await page.evaluate(async ({ endpoint, body, origin }) => {
    if (location.origin !== origin) return { status: 0, data: null };
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(endpoint, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        signal: controller.signal });
      let data; try { data = await response.json(); } catch { data = null; }
      return { status: response.status, data };
    } finally { clearTimeout(timer); }
  }, { endpoint, body, origin: YUANBAO_ORIGIN }).catch(() => fail('PLATFORM_UNAVAILABLE', '来源接口网络错误或超时'));
  return response;
}
async function yuanbaoLoggedIn(page) {
  const state = userState(await requestJson(page, '/api/getuserinfo'));
  if (state === 'unknown') fail('PLATFORM_SCHEMA_CHANGED', '无法按已验证结构确认元宝登录状态');
  return state === 'logged_in';
}
async function checkChallenge(page) {
  const text = await page.locator('body').innerText().catch(() => '');
  if (/访问过于频繁|请求过于频繁|操作频繁|访问频率过高/.test(text)) fail('RATE_LIMITED', '来源限制访问频率，请等待限制解除');
  if (/请完成.{0,12}验证|安全验证|滑动.{0,8}验证|拖动.{0,8}滑块|输入验证码|访问过于频繁/.test(text))
    fail('MEDIA_CAPTCHA_REQUIRED', '来源要求人工安全验证，请使用 media-login 后重试');
  if (/请先登录|登录后观看|登录后即可观看|登录后查看完整|登录后才能/.test(text))
    fail('MEDIA_LOGIN_REQUIRED', '来源要求登录，请使用对应平台 media-login');
}
function checkNavigation(response, finalUrl) {
  const status = response?.status?.();
  if ([401, 403].includes(status) || /\/(?:login|signin)(?:\/|\?|$)/i.test(new URL(finalUrl).pathname)) fail('MEDIA_LOGIN_REQUIRED', '来源要求人工登录');
  if ([412, 429].includes(status)) fail('RATE_LIMITED', '来源限制访问频率');
  if ([404, 410].includes(status)) fail('PLATFORM_REJECTED', '来源作品已失效或不可访问');
  if (status && status >= 400) fail('PLATFORM_UNAVAILABLE', '来源网页不可用');
}
class PlatformAdapters {
  constructor(store, options = {}) { this.store = store; this.options = options; this.sessionFactory = options.sessionFactory || ((platform) => new MediaSession(store, platform)); }
  async resolve(platform, source) {
    validateSource(source, true);
    if (platform === 'wechat') return this.wechat(source);
    if (platform === 'kuaishou') return this.kuaishou(source);
    const options = { ...this.options, store: this.store, sessionFactory: this.sessionFactory };
    if (platform === 'bilibili') return require('./platform-bilibili').resolveBilibili(source, options);
    if (platform === 'douyin') return require('./platform-douyin').resolveDouyin(source, options);
    if (platform === 'xiaohongshu') return require('./platform-xhs').resolveXhs(source, options);
    fail('PLATFORM_UNSUPPORTED', '平台没有已验证的网页媒体适配器');
  }
  async wechat(source) {
    const url = new URL(source);
    if (!(url.hostname === 'channels.weixin.qq.com' || url.hostname.endsWith('.channels.weixin.qq.com') ||
      (url.hostname === 'weixin.qq.com' && url.pathname.startsWith('/sph/'))))
      fail('PLATFORM_UNSUPPORTED', '元宝适配器仅接受视频号分享链接');
    const session = this.sessionFactory('yuanbao');
    try {
      await session.open(false); await checkChallenge(session.page);
      if (!await yuanbaoLoggedIn(session.page)) fail('MEDIA_LOGIN_REQUIRED', '元宝来源会话未登录，请使用 media-login --platform yuanbao');
      const parsed = await requestJson(session.page, '/api/weixin/get_parse_result', { type: 'video_channel_url', url: source, scene: 1 });
      if ([401, 403].includes(parsed.status)) fail('MEDIA_LOGIN_REQUIRED', '元宝登录失效');
      if (parsed.status !== 200) fail('PLATFORM_UNAVAILABLE', '元宝解析接口不可用');
      const { exportId, playableUrl } = parseWechatResult(parsed.data);
      const found = await requestJson(session.page, '/api/findergetobjecturl', { exportId });
      if ([401, 403].includes(found.status)) fail('MEDIA_LOGIN_REQUIRED', '元宝登录失效');
      if (found.status !== 200) fail('PLATFORM_UNAVAILABLE', '元宝媒体接口不可用');
      const videoUrl = parseFinderResult(found.data);
      await checkChallenge(session.page);
      // Returned addresses are media candidates only, never a transcript. Do not
      // forward this session's cookies with downloads from media/CDN origins.
      return normalizeCandidates([{ url: videoUrl, label: '元宝 videoUrl 媒体候选' },
        ...(playableUrl ? [{ url: playableUrl, label: '元宝 playable_url 媒体候选' }] : [])], source, 'yuanbao');
    } finally { await session.close(); }
  }
  async kuaishou(source) {
    const url = new URL(source);
    if (!['kuaishou.com', 'gifshow.com'].some(d => url.hostname === d || url.hostname.endsWith('.' + d)))
      fail('PLATFORM_UNSUPPORTED', '快手适配器仅接受快手分享链接');
    const session = this.sessionFactory('kuaishou');
    try {
      await session.open(false);
      await session.page.goto(source, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => fail('PLATFORM_UNAVAILABLE', '快手来源网页不可用'));
      const end = Date.now() + 15000;
      while (true) {
        await checkChallenge(session.page);
        const result = await session.page.evaluate(() => ({
          candidates: Array.from(document.querySelectorAll('video, audio')).flatMap(el => [el.currentSrc, el.src,
            ...Array.from(el.querySelectorAll('source')).map(s => s.src)]).filter(Boolean),
          loginRequired: /请先登录|登录后观看|登录后即可观看/.test(document.body?.innerText || '')
        }));
        if (result.loginRequired) fail('MEDIA_LOGIN_REQUIRED', '快手要求人工登录来源会话');
        if (result.candidates?.some(u => /^https?:\/\//i.test(u))) return normalizeCandidates(result.candidates, source, 'kuaishou-dom');
        if (Date.now() >= end) fail('PLATFORM_UNSUPPORTED', '快手页面未暴露已验证 DOM 媒体地址；不猜测未知 JSON 字段');
        await new Promise(r => setTimeout(r, 500));
      }
    } finally { await session.close(); }
  }
}
module.exports = { PlatformAdapters, userState, parseWechatResult, parseFinderResult, normalizeCandidates, mediaReferer, requestJson, yuanbaoLoggedIn, checkChallenge, checkNavigation };
