const { fail, validateSource } = require('./core');
const { normalizeCandidates, mediaReferer, checkChallenge, checkNavigation } = require('./platform-adapters');
function parseXhsTarget(source, allowShort = false) {
  validateSource(source, true); const u = new URL(source);
  if (allowShort && ['xhslink.com', 'xhslink.cn'].includes(u.hostname)) return { id: null, url: source };
  if (!(u.hostname === 'xiaohongshu.com' || u.hostname.endsWith('.xiaohongshu.com'))) fail('INVALID_SOURCE', '不是小红书来源');
  const id = u.pathname.match(/^\/(?:explore|discovery\/item)\/([a-f0-9]{24})(?:\/|$)/i)?.[1];
  if (!id) fail('INVALID_SOURCE', '需要精确定位的单条小红书笔记');
  return { id, url: source };
}
function parseXhsState(state, id, referer, ua) {
  const map = state?.note?.noteDetailMap;
  if (!map || typeof map !== 'object' || !map[id]?.note) fail('PLATFORM_SCHEMA_CHANGED', '小红书没有目标笔记的已验证状态');
  const note = map[id].note;
  if (note.noteId !== id) fail('IDENTITY_MISMATCH', '小红书返回了其他笔记');
  if (note.type === 'normal') fail('PLATFORM_UNSUPPORTED', '小红书图文笔记不能作为视频口播');
  if (note.type !== 'video' || !note.video?.media?.stream || typeof note.video.media.stream !== 'object') fail('PLATFORM_SCHEMA_CHANGED', '小红书视频结构变化');
  const values = [];
  for (const tracks of Object.values(note.video.media.stream)) {
    if (!Array.isArray(tracks)) fail('PLATFORM_SCHEMA_CHANGED', '小红书流字段结构变化');
    for (const track of tracks) {
      if (typeof track.masterUrl !== 'string' || (track.backupUrls !== undefined && (!Array.isArray(track.backupUrls) || track.backupUrls.some(u => typeof u !== 'string')))) fail('PLATFORM_SCHEMA_CHANGED', '小红书媒体地址结构变化');
      values.push(...[track.masterUrl, ...(track.backupUrls || [])].map(url => ({ url, label: '小红书完整视频媒体候选', headers: { 'User-Agent': ua, Referer: referer ? mediaReferer(referer) : '' } })));
    }
  }
  if (!values.length) fail('PLATFORM_SCHEMA_CHANGED', '小红书没有返回真实媒体地址');
  return normalizeCandidates(values, referer, 'xiaohongshu');
}
async function resolveXhs(source, options) {
  let target = parseXhsTarget(source, true); const session = options.sessionFactory('xiaohongshu'); let mobileSession;
  try {
    await session.open(false); let page = session.page;
    const navigation = await page.goto(source, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => fail('PLATFORM_UNAVAILABLE', '小红书网页不可用'));
    checkNavigation(navigation, page.url());
    await checkChallenge(page); const final = parseXhsTarget(page.url());
    if (target.id && final.id !== target.id) fail('IDENTITY_MISMATCH', '小红书网页定位到了其他笔记');
    target = final;
    for (let attempt = 0; attempt < 2; attempt++) {
      await checkChallenge(page);
      const result = await page.evaluate(() => ({ state: window.__INITIAL_STATE__ ?? null, userAgent: navigator.userAgent }));
      if (result.state) {
        const candidates = parseXhsState(result.state, target.id, target.url, result.userAgent);
        return { candidates, canonical_source: target.url, content_id: require('./routing').contentIdentity(target.url) };
      }
      if (attempt === 1) fail('PLATFORM_SCHEMA_CHANGED', '桌面与移动页面都没有已验证笔记状态');
      const mobile = new URL(target.url); mobile.pathname = '/discovery/item/' + target.id;
      if (options.mobilePageFactory) mobileSession = await options.mobilePageFactory(session);
      else {
        const { proxy, serviceWorkers } = session.browserNetworkOptions();
        const context = await session.context.browser().newContext({
          proxy, serviceWorkers,
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true
        });
        mobileSession = { close: () => context.close() };
        await context.addCookies(await session.context.cookies('https://www.xiaohongshu.com'));
        mobileSession.page = await context.newPage();
      }
      page = mobileSession.page;
      const mobileNavigation = await page.goto(mobile.href, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => fail('PLATFORM_UNAVAILABLE', '小红书移动页面不可用'));
      checkNavigation(mobileNavigation, page.url());
      await checkChallenge(page);
      const mobileTarget = parseXhsTarget(page.url());
      if (mobileTarget.id !== target.id) fail('IDENTITY_MISMATCH', '小红书移动页面定位到了其他笔记');
    }
  } finally { try { await mobileSession?.close(); } finally { await session.close(); } }
}
module.exports = { parseXhsTarget, parseXhsState, resolveXhs };
