const { fail, validateSource } = require('./core');
const { publicRequest } = require('./media-network');
const { normalizeCandidates, mediaReferer, checkChallenge, checkNavigation } = require('./platform-adapters');
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function parseBiliTarget(source) {
  validateSource(source, true); const u = new URL(source);
  if (!(u.hostname === 'bilibili.com' || u.hostname.endsWith('.bilibili.com'))) fail('PLATFORM_UNSUPPORTED', 'B站来源需展开为单视频页面');
  const bvid = u.pathname.match(/^\/video\/(BV[a-zA-Z0-9]{10})(?:\/|$)/)?.[1];
  if (!bvid) fail('PLATFORM_UNSUPPORTED', '只支持明确的B站BV单视频链接');
  const parts = u.searchParams.getAll('p');
  if (parts.length > 1 || parts.length && !/^[1-9]\d*$/.test(parts[0])) fail('INVALID_SOURCE', 'B站分P编号必须是唯一正整数');
  const page = parts.length ? Number(parts[0]) : 1;
  if (!Number.isSafeInteger(page)) fail('INVALID_SOURCE', 'B站分P编号无效');
  return { bvid, page, explicitPage: parts.length === 1, url: source };
}
function requirePartSelection(rows, target) {
  if (target.explicitPage === false && rows.length > 1) fail('PART_SELECTION_REQUIRED', '该B站视频包含多个分P，请指定p参数后继续', {
    parts: rows.map(row => ({ page: row.page, title: typeof row.part === 'string' ? row.part.replace(/https?:\/\/\S+/g, '[链接]').slice(0, 120) : '' }))
  });
}
function guard(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.code !== 'number') fail('PLATFORM_SCHEMA_CHANGED', 'B站接口结构发生变化');
  if ([-412, -352, 429].includes(payload.code)) fail('RATE_LIMITED', 'B站限制访问频率或触发风控');
  if ([-101, -403].includes(payload.code)) fail('MEDIA_LOGIN_REQUIRED', 'B站要求有效来源登录或访问权限');
  if (payload.code !== 0) fail('PLATFORM_REJECTED', 'B站拒绝该作品请求');
}
function bindRequest(requestUrl, target, needCid = false) {
  let u; try { u = new URL(requestUrl); } catch { fail('IDENTITY_MISMATCH', 'B站响应缺少确切来源请求身份'); }
  if (u.hostname !== 'api.bilibili.com' || u.pathname !== (needCid ? '/x/player/playurl' : '/x/player/pagelist') ||
      u.searchParams.getAll('bvid').length !== 1 || u.searchParams.get('bvid') !== target.bvid ||
      (needCid && (u.searchParams.getAll('cid').length !== 1 || u.searchParams.get('cid') !== String(target.cid)))) fail('IDENTITY_MISMATCH', 'B站请求身份不对应本次bvid/cid');
}
function parsePageList(payload, target, requestUrl) {
  bindRequest(requestUrl, target); guard(payload);
  if (!Array.isArray(payload.data)) fail('PLATFORM_SCHEMA_CHANGED', 'B站分P列表不是数组');
  requirePartSelection(payload.data, target);
  if (payload.data.some(p => p?.bvid !== undefined && p.bvid !== target.bvid)) fail('IDENTITY_MISMATCH', 'B站分P列表返回其他bvid');
  const rows = payload.data.filter(p => p?.page === target.page);
  if (!rows.length) fail('PLATFORM_UNSUPPORTED', 'B站指定分P不存在');
  if (rows.length !== 1 || !Number.isSafeInteger(rows[0].cid) || rows[0].cid <= 0) fail('PLATFORM_SCHEMA_CHANGED', 'B站未返回唯一有效cid');
  return { ...target, cid: rows[0].cid };
}
function parseBiliMedia(payload, target, requestUrl, referer, userAgent) {
  if (requestUrl) bindRequest(requestUrl, target, true); guard(payload);
  const d = payload.data;
  if (!d || typeof d !== 'object') fail('PLATFORM_SCHEMA_CHANGED', 'B站播放响应缺少data');
  if ((d.bvid !== undefined && d.bvid !== target.bvid) || (d.cid !== undefined && String(d.cid) !== String(target.cid)))
    fail('IDENTITY_MISMATCH', 'B站播放响应身份与本次视频不符');
  const values = []; const headers = { 'User-Agent': userAgent, Referer: referer ? mediaReferer(referer) : '' };
  const add = (url, label) => { if (typeof url === 'string' && url) values.push({ url, label, headers }); };
  if (d.dash !== undefined && (!d.dash || typeof d.dash !== 'object')) fail('PLATFORM_SCHEMA_CHANGED', 'B站DASH字段发生变化');
  if (d.dash?.audio !== undefined && !Array.isArray(d.dash.audio)) fail('PLATFORM_SCHEMA_CHANGED', 'B站音轨列表不是数组');
  for (const track of d.dash?.audio || []) {
    add(track.baseUrl ?? track.base_url, 'B站DASH原音');
    const backups = track.backupUrl ?? track.backup_url ?? [];
    if (!Array.isArray(backups)) fail('PLATFORM_SCHEMA_CHANGED', 'B站音轨备用地址字段发生变化');
    for (const backup of backups) add(backup, 'B站DASH原音备用');
  }
  // Never choose DASH video-only representations or background music.
  if (!values.length && d.durl !== undefined) {
    if (!Array.isArray(d.durl)) fail('PLATFORM_SCHEMA_CHANGED', 'B站复合流列表不是数组');
    if (d.durl.length > 1) fail('PLATFORM_UNSUPPORTED', 'B站多片段复合流需要拼接，不能只取首片段');
    for (const track of d.durl) {
      add(track.url, 'B站完整复合流');
      if (track.backup_url !== undefined && !Array.isArray(track.backup_url)) fail('PLATFORM_SCHEMA_CHANGED', 'B站备用地址字段发生变化');
      for (const backup of track.backup_url || []) add(backup, 'B站完整复合流备用');
    }
  }
  return normalizeCandidates(values, referer, 'bilibili');
}
function parseBiliBrowser(state, play, target, referer, ua) {
  if (state?.risk?.v_voucher) fail('RATE_LIMITED', 'B站页面触发访问风控');
  if (state?.error?.trueCode === -403) fail('MEDIA_LOGIN_REQUIRED', 'B站页面要求登录或访问权限');
  if (state?.error?.trueCode === -404) fail('PLATFORM_REJECTED', 'B站视频已删除或限制访问');
  const data = state?.videoData;
  if (!data || typeof data.bvid !== 'string' || !Number.isSafeInteger(data.cid)) fail('PLATFORM_SCHEMA_CHANGED', 'B站浏览器缺少已验证的videoData身份');
  if (data.bvid !== target.bvid) fail('IDENTITY_MISMATCH', 'B站浏览器显示其他视频');
  if (Array.isArray(data.pages)) requirePartSelection(data.pages, target);
  let cid = target.cid;
  if (!cid) {
    if (!Array.isArray(data.pages)) fail('PLATFORM_SCHEMA_CHANGED', 'B站浏览器缺少分P映射');
    const rows = data.pages.filter(p => p.page === target.page);
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0].cid)) fail('PLATFORM_UNSUPPORTED', 'B站浏览器无法确认指定分P');
    cid = rows[0].cid;
  }
  if (data.cid !== cid) fail('IDENTITY_MISMATCH', 'B站浏览器没有选中指定cid');
  return parseBiliMedia(play, { ...target, cid }, null, referer, ua);
}
async function publicJson(url, headers) {
  const { response, final_url } = await publicRequest(url, { headers, timeout: 20000 });
  if ([401, 403].includes(response.statusCode)) { response.resume(); fail('MEDIA_LOGIN_REQUIRED', 'B站公共接口要求登录或权限'); }
  if ([412, 429].includes(response.statusCode)) { response.resume(); fail('RATE_LIMITED', 'B站公共接口限制访问'); }
  if (response.statusCode !== 200) { response.resume(); fail('PLATFORM_UNAVAILABLE', 'B站公共接口暂不可用'); }
  let bytes = 0; const chunks = [];
  for await (const chunk of response) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) { response.destroy(); fail('PLATFORM_SCHEMA_CHANGED', 'B站响应超出结构验证边界'); }
    chunks.push(chunk);
  }
  let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('PLATFORM_SCHEMA_CHANGED', 'B站接口未返回JSON'); }
  return { payload, requestUrl: final_url };
}
async function resolveBilibili(source, options) {
  let target = parseBiliTarget(source); const request = options.publicJson || publicJson;
  const headers = { 'User-Agent': DEFAULT_UA, Referer: `https://www.bilibili.com/video/${target.bvid}/` };
  try {
    const listUrl = `https://api.bilibili.com/x/player/pagelist?bvid=${target.bvid}`;
    const list = await request(listUrl, headers); target = parsePageList(list.payload, target, list.requestUrl);
    const playUrl = `https://api.bilibili.com/x/player/playurl?bvid=${target.bvid}&cid=${target.cid}&fnval=16&qn=32`;
    const play = await request(playUrl, headers);
    return { candidates: parseBiliMedia(play.payload, target, play.requestUrl, source, DEFAULT_UA), canonical_source: source, content_id: require('./routing').contentIdentity(source), page: target.page, cid: target.cid };
  } catch (e) {
    if (!['PLATFORM_UNAVAILABLE', 'PLATFORM_UNSUPPORTED', 'NETWORK_ERROR', 'NETWORK_TIMEOUT'].includes(e.code)) throw e;
  }
  const session = options.sessionFactory('bilibili');
  try {
    await session.open(false);
    const navigation = await session.page.goto(source, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => fail('PLATFORM_UNAVAILABLE', 'B站视频页面暂不可用'));
    checkNavigation(navigation, session.page.url());
    await checkChallenge(session.page);
    const final = parseBiliTarget(session.page.url());
    if (final.bvid !== target.bvid || final.page !== target.page) fail('IDENTITY_MISMATCH', 'B站页面重定向到了其他视频或分P');
    const read = await session.page.evaluate(() => ({ state: { videoData: window.__INITIAL_STATE__?.videoData, error: window.__INITIAL_STATE__?.error, risk: window._riskdata_ }, play: window.__playinfo__, userAgent: navigator.userAgent }));
    const candidates = parseBiliBrowser(read.state, read.play, target, source, read.userAgent);
    return { candidates, canonical_source: final.url, content_id: require('./routing').contentIdentity(final.url), page: target.page, cid: target.cid || read.state.videoData.cid };
  } finally { await session.close(); }
}
module.exports = { parseBiliTarget, parsePageList, parseBiliMedia, parseBiliBrowser, resolveBilibili, publicJson };
