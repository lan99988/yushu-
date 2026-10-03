const { fail, validateSource } = require('./core');
const { normalizeCandidates, mediaReferer, checkChallenge, checkNavigation } = require('./platform-adapters');
function saveDiagnostic(store, target, entries, stage) {
  if (!store?.root || !target?.id) return;
  const summary = entries.filter(e => e.id === target.id).map(e => ({ status: e.status, settled: e.settled, invalid_json: !!e.invalid,
    payload_type: !e.settled ? 'pending' : e.payload === null ? 'null' : Array.isArray(e.payload) ? 'array' : typeof e.payload,
    keys: e.payload && typeof e.payload === 'object' ? Object.keys(e.payload).filter(k => /^[a-zA-Z0-9_]{1,60}$/.test(k)).slice(0,30) : [],
    status_code: typeof e.payload?.status_code === 'number' ? e.payload.status_code : null,
    aweme_id: /^\d+$/.test(e.payload?.aweme_detail?.aweme_id || '') ? e.payload.aweme_detail.aweme_id : null }));
  require('./store').atomicJson(require('node:path').join(store.root, 'diagnostics', `douyin-${target.id}.json`), { stage, at: new Date().toISOString(), target_id: target.id, entries: summary });
}
function parseDouyinTarget(source, allowShort = false) {
  validateSource(source, true); const u = new URL(source);
  if (!['douyin.com', 'iesdouyin.com'].some(d => u.hostname === d || u.hostname.endsWith('.' + d))) fail('INVALID_SOURCE', '不是抖音来源');
  const ids = [...u.searchParams.getAll('modal_id'), ...u.searchParams.getAll('vid')];
  const path = u.pathname.match(/\/(?:video|share\/video)\/(\d+)(?:\/|$)/)?.[1];
  if (path) ids.push(path);
  if (!ids.length && allowShort && u.hostname === 'v.douyin.com') return { id: null, url: source };
  if (!ids.length || ids.some(id => !/^\d+$/.test(id)) || new Set(ids).size !== 1) fail('INVALID_SOURCE', '需要可精确定位的单条抖音视频');
  return { id: ids[0], url: source };
}
function parseDouyinDetail(payload, id, referer, ua) {
  if (!payload || typeof payload !== 'object') fail('PLATFORM_SCHEMA_CHANGED', '抖音详情结构变化');
  if (payload.captcha || payload.verify_info || payload.verify_url) fail('MEDIA_CAPTCHA_REQUIRED', '抖音要求人工验证');
  if (typeof payload.status_code !== 'number') fail('PLATFORM_SCHEMA_CHANGED', '抖音状态字段结构变化');
  if (payload.status_code !== 0) fail('PLATFORM_REJECTED', '抖音拒绝详情请求');
  const detail = payload.aweme_detail;
  if (!detail || typeof detail.aweme_id !== 'string') fail('PLATFORM_SCHEMA_CHANGED', '抖音详情身份缺失');
  if (detail.aweme_id !== id) fail('IDENTITY_MISMATCH', '抖音返回了其他视频');
  if (Array.isArray(detail.images) && detail.images.length) fail('PLATFORM_UNSUPPORTED', '图集不能作为完整视频口播');
  const video = detail.video;
  if (!video || typeof video !== 'object') fail('PLATFORM_SCHEMA_CHANGED', '抖音视频字段缺失');
  const addresses = [video.play_addr, ...(Array.isArray(video.bit_rate) ? video.bit_rate.map(v => v.play_addr) : []), video.download_addr].filter(Boolean);
  const values = [];
  for (const address of addresses) {
    if (!Array.isArray(address.url_list) || address.url_list.some(v => typeof v !== 'string')) fail('PLATFORM_SCHEMA_CHANGED', '抖音媒体地址结构变化');
    values.push(...address.url_list.map(url => ({ url, label: '抖音完整视频媒体候选', headers: { 'User-Agent': ua, Referer: referer ? mediaReferer(referer) : '' } })));
  }
  if (!values.length) fail('PLATFORM_SCHEMA_CHANGED', '抖音没有已验证的视频地址字段');
  return normalizeCandidates(values, referer, 'douyin');
}
async function resolveDouyin(source, options) {
  let target = parseDouyinTarget(source, true); const session = options.sessionFactory('douyin');
  const captured = []; const pending = new Set(); let page; let ua = ''; let listener;
  try {
    await session.open(false); page = session.page;
    listener = response => {
      const work = (async () => {
        const u = new URL(response.url());
        if (!(u.hostname === 'douyin.com' || u.hostname.endsWith('.douyin.com')) || u.pathname !== '/aweme/v1/web/aweme/detail/') return;
        const ids = u.searchParams.getAll('aweme_id');
        if (ids.length !== 1 || !/^\d+$/.test(ids[0])) return;
        // Capture identity-bound responses until a short link's final identity is known.
        const entry = { id: ids[0], status: response.status(), settled: false }; captured.push(entry);
        let timer;
        try { entry.payload = await Promise.race([response.json(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('timeout')), 20000); })]); }
        catch { entry.invalid = true; } finally { clearTimeout(timer); entry.settled = true; }
      })().catch(() => { captured.push({ invalid: true }); });
      pending.add(work); work.finally(() => pending.delete(work)); return work;
    };
    page.on('response', listener);
    const navigation = await page.goto(source, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => fail('PLATFORM_UNAVAILABLE', '抖音网页不可用'));
    checkNavigation(navigation, page.url());
    await checkChallenge(page);
    const final = parseDouyinTarget(page.url());
    if (target.id && final.id !== target.id) fail('IDENTITY_MISMATCH', '抖音网页定位到了其他视频');
    target = final; ua = await page.evaluate(() => navigator.userAgent);
    const end = Date.now() + (options.waitMs ?? 15000);
    while (true) {
      await Promise.all([...pending]); await checkChallenge(page);
      for (const entry of captured.filter(v => v.id === target.id)) {
        if ([401, 403].includes(entry.status)) { saveDiagnostic(options.store, target, captured, 'login-required'); fail('MEDIA_LOGIN_REQUIRED', '抖音来源会话要求登录'); }
        if ([412, 429].includes(entry.status)) { saveDiagnostic(options.store, target, captured, 'rate-limited'); fail('RATE_LIMITED', '抖音限制访问频率'); }
      }
      const entries = captured.filter(v => v.id === target.id && v.settled);
      if (entries.length) {
        saveDiagnostic(options.store, target, captured, 'target-responses');
        for (const entry of entries) {
          if ([401, 403].includes(entry.status)) fail('MEDIA_LOGIN_REQUIRED', '抖音来源会话要求登录');
          if ([412, 429].includes(entry.status)) fail('RATE_LIMITED', '抖音限制访问频率');
          if (entry.status !== 200 || entry.invalid) fail('PLATFORM_SCHEMA_CHANGED', '目标抖音详情不可确认');
        }
        const values = entries.flatMap(entry => parseDouyinDetail(entry.payload, target.id, target.url, ua));
        const candidates = normalizeCandidates(values, target.url, 'douyin');
        return { candidates, canonical_source: target.url, content_id: require('./routing').contentIdentity(target.url) };
      }
      if (Date.now() >= end) { saveDiagnostic(options.store, target, captured, 'no-settled-target-response'); fail('PLATFORM_UNSUPPORTED', '网页未暴露目标视频的已验证详情响应，未取得媒体'); }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, end - Date.now()))));
    }
  } finally { if (page && listener) page.off('response', listener); await session.close(); }
}
module.exports = { parseDouyinTarget, parseDouyinDetail, resolveDouyin };
