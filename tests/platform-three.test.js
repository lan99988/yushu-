const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBiliTarget, parsePageList, parseBiliMedia, parseBiliBrowser } = require('../scripts/platform-bilibili');
const { parseDouyinTarget, parseDouyinDetail, resolveDouyin } = require('../scripts/platform-douyin');
const { parseXhsTarget, parseXhsState, resolveXhs } = require('../scripts/platform-xhs');

const BVID = 'BV1GJ411x7h7';
const biliUrl = `https://www.bilibili.com/video/${BVID}/?p=2`;
test('B站指定分P按page精确找到cid；请求身份与响应冲突必须停止', () => {
  const target = parseBiliTarget(biliUrl); assert.equal(target.page, 2);
  const list = { code: 0, data: [{ page: 1, cid: 111 }, { page: 2, cid: 222 }] };
  assert.equal(parsePageList(list, target, `https://api.bilibili.com/x/player/pagelist?bvid=${BVID}`).cid, 222);
  assert.throws(() => parsePageList(list, target, 'https://api.bilibili.com/x/player/pagelist?bvid=BVwrong'), /IDENTITY_MISMATCH/);
  assert.throws(() => parsePageList({ code: 0, data: [{ page: 1, cid: 111 }] }, target, `https://api.bilibili.com/x/player/pagelist?bvid=${BVID}`), /PLATFORM_UNSUPPORTED/);
  assert.throws(() => parseBiliTarget(biliUrl + '&p=not-a-number'), /INVALID_SOURCE/);
});

test('B站音频优先保留backupUrl，不能选无音轨DASH视频或其他cid', () => {
  const target = { bvid: BVID, cid: 222, page: 2 };
  const payload = { code: 0, data: { cid: 222, dash: { audio: [{ baseUrl: 'https://cdn.example.com/a.m4a', backupUrl: ['https://cdn2.example.com/a.m4a'] }], video: [{ baseUrl: 'https://cdn.example.com/silent.m4s' }] } } };
  const request = `https://api.bilibili.com/x/player/playurl?bvid=${BVID}&cid=222`;
  const result = parseBiliMedia(payload, target, request, biliUrl, 'UA');
  assert.equal(result.length, 2); assert.ok(result.every(c => !c.url.includes('silent')));
  assert.ok(result.every(c => !Object.keys(c.headers).some(k => k.toLowerCase() === 'cookie')));
  assert.throws(() => parseBiliMedia({ ...payload, data: { ...payload.data, cid: 111 } }, target, request, biliUrl, 'UA'), /IDENTITY_MISMATCH/);
  assert.throws(() => parseBiliMedia({ code: -412 }, target, request, biliUrl, 'UA'), /RATE_LIMITED/);
});

test('B站浏览器playinfo只有初始页bvid及cid同时精确匹配才接受', () => {
  const media = { code: 0, data: { durl: [{ url: 'https://cdn.example.com/full.mp4', backup_url: [] }] } };
  const state = { videoData: { bvid: BVID, cid: 222, pages: [{ page: 1, cid: 111 }, { page: 2, cid: 222 }] } };
  assert.equal(parseBiliBrowser(state, media, { bvid: BVID, page: 2, cid: 222 }, biliUrl, 'UA').length, 1);
  assert.throws(() => parseBiliBrowser({ videoData: { ...state.videoData, cid: 111 } }, media, { bvid: BVID, page: 2, cid: 222 }, biliUrl, 'UA'), /IDENTITY_MISMATCH/);
  assert.throws(() => parseBiliBrowser({ error: { trueCode: -403 } }, null, { bvid: BVID, page: 2 }, biliUrl, 'UA'), /MEDIA_LOGIN_REQUIRED/);
  assert.throws(() => parseBiliBrowser({ error: { trueCode: -404 } }, null, { bvid: BVID, page: 2 }, biliUrl, 'UA'), /PLATFORM_REJECTED/);
});

test('抖音视频ID优先modal_id；详情aweme_id必须相同且不取music配乐', () => {
  const id = '7298145681699622182';
  assert.equal(parseDouyinTarget(`https://www.douyin.com/user/name?modal_id=${id}`).id, id);
  const payload = { status_code: 0, aweme_detail: { aweme_id: id, video: { play_addr: { url_list: ['https://cdn.example.com/full.mp4', 'https://cdn2.example.com/full.mp4'] } }, music: { play_url: { url_list: ['https://cdn.example.com/music.mp3'] } } } };
  const result = parseDouyinDetail(payload, id, 'https://www.douyin.com/', 'UA');
  assert.equal(result.length, 2); assert.ok(result.every(c => !c.url.includes('music')));
  assert.throws(() => parseDouyinDetail({ ...payload, aweme_detail: { ...payload.aweme_detail, aweme_id: '1' } }, id, '', 'UA'), /IDENTITY_MISMATCH/);
  assert.throws(() => parseDouyinDetail({ status_code: 0, aweme_detail: null, captcha: {} }, id, '', 'UA'), /MEDIA_CAPTCHA_REQUIRED/);
  assert.throws(() => parseDouyinDetail({ status_code: 0, aweme_detail: { aweme_id: id, images: [{}] } }, id, '', 'UA'), /PLATFORM_UNSUPPORTED/);
});

test('小红书精确noteId，从masterUrl和backupUrls取得真实返回地址，不猜CDN', () => {
  const id = '64abcdef0123456789abcdef';
  const source = `https://www.xiaohongshu.com/explore/${id}?xsec_token=KEEP&xsec_source=pc_share`;
  assert.equal(parseXhsTarget(source).url, source);
  const note = { noteId: id, type: 'video', video: { media: { stream: { h264: [{ masterUrl: 'https://cdn.example.com/a.mp4', backupUrls: ['https://cdn2.example.com/a.mp4'] }] } } } };
  const state = { note: { firstNoteId: 'other', noteDetailMap: { [id]: { note }, other: { note: { noteId: 'other' } } } } };
  assert.equal(parseXhsState(state, id, source, 'UA').length, 2);
  assert.throws(() => parseXhsState({ note: { noteDetailMap: { [id]: { note: { ...note, noteId: 'other' } } } } }, id, source, 'UA'), /IDENTITY_MISMATCH/);
  assert.throws(() => parseXhsState({ note: { noteDetailMap: { [id]: { note: { noteId: id, type: 'normal' } } } } }, id, source, 'UA'), /PLATFORM_UNSUPPORTED/);
  assert.throws(() => parseXhsState({ note: { noteDetailMap: { [id]: { note: { noteId: id, type: 'video', video: { consumer: { originVideoKey: 'do-not-build-url' } } } } } } }, id, source, 'UA'), /PLATFORM_SCHEMA_CHANGED/);
});

function mockSession(page) { return () => ({ page, context: {}, open: async () => {}, close: async () => {} }); }
test('抖音只处理目标请求响应，不把推荐流作为本次视频', async () => {
  const id = '7298145681699622182'; let listener;
  const response = (requestedId, returnedId) => ({ url: () => `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${requestedId}`,
    status: () => 200, request: () => ({ postDataJSON: () => null }), json: async () => ({ status_code: 0, aweme_detail: { aweme_id: returnedId, video: { play_addr: { url_list: ['https://cdn.example.com/full.mp4'] } } } }) });
  const page = { on: (_event, fn) => { listener = fn; }, off: () => {}, url: () => `https://www.douyin.com/video/${id}`,
    goto: async () => { await listener(response('111', '111')); await listener(response(id, id)); },
    locator: () => ({ innerText: async () => '' }), evaluate: async () => 'UA' };
  const result = await resolveDouyin(`https://www.douyin.com/video/${id}`, { sessionFactory: mockSession(page), waitMs: 1 });
  assert.equal(result.candidates[0].url, 'https://cdn.example.com/full.mp4'); assert.equal(result.content_id, 'douyin:' + id);
});

test('小红书缺桌面state只尝试一次mobile页，保留token；验证码不触发fallback', async () => {
  const id = '64abcdef0123456789abcdef'; const source = `https://www.xiaohongshu.com/explore/${id}?xsec_token=KEEP&xsec_source=pc_share`;
  const visits = []; let reads = 0;
  const state = { note: { noteDetailMap: { [id]: { note: { noteId: id, type: 'video', video: { media: { stream: { h264: [{ masterUrl: 'https://cdn.example.com/a.mp4', backupUrls: [] }] } } } } } } } };
  const page = { goto: async url => { visits.push(url); }, url: () => visits.at(-1),
    locator: () => ({ innerText: async () => '' }), evaluate: async () => ({ state: ++reads === 1 ? null : state, userAgent: 'UA' }) };
  assert.equal((await resolveXhs(source, { sessionFactory: mockSession(page), mobilePageFactory: async () => ({ page, close: async () => {} }) })).candidates.length, 1);
  assert.equal(visits.length, 2); assert.ok(visits.every(v => new URL(v).searchParams.get('xsec_token') === 'KEEP'));
  assert.ok(visits[1].includes('/discovery/item/'));
  reads = 0; visits.length = 0; page.locator = () => ({ innerText: async () => '请完成安全验证' });
  await assert.rejects(resolveXhs(source, { sessionFactory: mockSession(page) }), /MEDIA_CAPTCHA_REQUIRED/);
  assert.equal(visits.length, 1);
});

test('小红书mobile fallback创建iPhone会话，只复制小红书来源Cookie并释放context', async () => {
  const id = '64abcdef0123456789abcdef'; const source = `https://www.xiaohongshu.com/explore/${id}?xsec_token=KEEP`;
  let config; let cookieScope; let closed = false; let mobileUrl;
  const state = { note: { noteDetailMap: { [id]: { note: { noteId: id, type: 'video', video: { media: { stream: { h264: [{ masterUrl: 'https://cdn.example.com/a.mp4' }] } } } } } } } };
  const mobile = { goto: async url => { mobileUrl = url; }, url: () => mobileUrl, locator: () => ({ innerText: async () => '' }), evaluate: async () => ({ state, userAgent: 'iPhone UA' }) };
  const page = { goto: async () => {}, url: () => source, locator: () => ({ innerText: async () => '' }), evaluate: async () => ({ state: null, userAgent: 'desktop' }) };
  const context = { cookies: async scope => { cookieScope = scope; return []; }, browser: () => ({ newContext: async value => { config = value; return { addCookies: async () => {}, newPage: async () => mobile, close: async () => { closed = true; } }; } }) };
  const result = await resolveXhs(source, { sessionFactory: () => ({ page, context, open: async () => {}, close: async () => {},
    browserNetworkOptions: () => ({ proxy: { server: 'http://127.0.0.1:12345' }, args: ['--disable-quic'], serviceWorkers: 'block' }) }) });
  assert.match(config.userAgent, /iPhone/); assert.equal(cookieScope, 'https://www.xiaohongshu.com'); assert.equal(closed, true);
  assert.deepEqual(config.proxy, { server: 'http://127.0.0.1:12345' }); assert.equal(config.serviceWorkers, 'block'); assert.equal(config.args, undefined);
  assert.equal(new URL(mobileUrl).searchParams.get('xsec_token'), 'KEEP'); assert.equal(result.candidates[0].headers['User-Agent'], 'iPhone UA');
});

test('抖音短链通过最终网页ID绑定响应，错误目标响应必须停止', async () => {
  const id = '7298145681699622182'; let listener; let returned = id;
  const page = { on: (_event, fn) => { listener = fn; }, off: () => {}, url: () => `https://www.douyin.com/video/${id}`,
    goto: async () => listener({ url: () => `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}`, status: () => 200,
      json: async () => ({ status_code: 0, aweme_detail: { aweme_id: returned, video: { play_addr: { url_list: ['https://cdn.example.com/a.mp4'] } } } }) }),
    locator: () => ({ innerText: async () => '' }), evaluate: async () => 'UA' };
  const result = await resolveDouyin('https://v.douyin.com/real-short/', { sessionFactory: mockSession(page), waitMs: 1 });
  assert.equal(result.content_id, 'douyin:' + id); assert.equal(result.canonical_source, page.url());
  returned = '111'; await assert.rejects(resolveDouyin('https://v.douyin.com/real-short/', { sessionFactory: mockSession(page), waitMs: 1 }), /IDENTITY_MISMATCH/);
});

test('抖音网页没有目标详情响应时只报不支持，允许其他已授权渠道兜底', async () => {
  const id = '7298145681699622182';
  const page = { on: () => {}, off: () => {}, goto: async () => {}, url: () => `https://www.douyin.com/video/${id}`,
    locator: () => ({ innerText: async () => '' }), evaluate: async () => 'UA' };
  await assert.rejects(resolveDouyin(page.url(), { sessionFactory: mockSession(page), waitMs: 0 }), /PLATFORM_UNSUPPORTED/);
});

test('抖音新目标响应尚在读取JSON时不把pending条目判为schema错误', async () => {
  const id = '7298145681699622182'; let listener;
  const payload = { status_code: 0, aweme_detail: { aweme_id: id, video: { play_addr: { url_list: ['https://cdn.example.com/a.mp4'] } } } };
  const response = json => ({ url: () => `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}`, status: () => 200, json });
  const page = { on: (_event, fn) => { listener = fn; }, off: () => {}, url: () => `https://www.douyin.com/video/${id}`,
    goto: async () => { listener(response(() => new Promise(resolve => setTimeout(() => {
      listener(response(() => new Promise(next => setTimeout(() => next(payload), 15)))); resolve(payload);
    }, 5)))); }, locator: () => ({ innerText: async () => '' }), evaluate: async () => 'UA' };
  const result = await resolveDouyin(page.url(), { sessionFactory: mockSession(page), waitMs: 100 });
  assert.equal(result.candidates.length, 1);
});

test('小红书两种短链展开后保留服务端token，不以其他笔记作为替代', async () => {
  const id = '64abcdef0123456789abcdef'; let other = false;
  const final = `https://www.xiaohongshu.com/explore/${id}?xsec_token=SERVER_TOKEN`;
  const page = { goto: async () => {}, url: () => final, locator: () => ({ innerText: async () => '' }),
    evaluate: async () => ({ userAgent: 'UA', state: { note: { noteDetailMap: { [id]: { note: { noteId: other ? 'other' : id, type: 'video',
      video: { media: { stream: { h264: [{ masterUrl: 'https://cdn.example.com/a.mp4' }] } } } } } } } } }) };
  for (const host of ['xhslink.cn', 'xhslink.com']) {
    const result = await resolveXhs(`https://${host}/a/example`, { sessionFactory: mockSession(page) });
    assert.equal(result.canonical_source, final); assert.equal(result.content_id, 'xiaohongshu:' + id);
  }
  other = true; await assert.rejects(resolveXhs('https://xhslink.cn/a/example', { sessionFactory: mockSession(page) }), /IDENTITY_MISMATCH/);
});

test('B站公共响应结构改变或限流不启动浏览器、不取多片段首段', async () => {
  const { resolveBilibili } = require('../scripts/platform-bilibili'); let opened = 0;
  const options = { sessionFactory: () => { opened++; throw Error('must not open'); },
    publicJson: async requestUrl => ({ requestUrl, payload: { changed: true } }) };
  await assert.rejects(resolveBilibili(biliUrl, options), /PLATFORM_SCHEMA_CHANGED/); assert.equal(opened, 0);
  options.publicJson = async requestUrl => ({ requestUrl, payload: { code: -412 } });
  await assert.rejects(resolveBilibili(biliUrl, options), /RATE_LIMITED/); assert.equal(opened, 0);
  assert.throws(() => parseBiliMedia({ code: 0, data: { durl: [{ url: 'https://cdn.example.com/part1.mp4' }, { url: 'https://cdn.example.com/part2.mp4' }] } }, { bvid: BVID, cid: 222 }, null, biliUrl, 'UA'), /PLATFORM_UNSUPPORTED/);
});

test('B站未指定分P且存在多P时返回选择要求，不擅自选择P1', () => {
  const target = parseBiliTarget(`https://www.bilibili.com/video/${BVID}/`);
  assert.throws(() => parsePageList({ code: 0, data: [{ page: 1, cid: 111, part: '第一讲' }, { page: 2, cid: 222, part: '第二讲' }] }, target,
    `https://api.bilibili.com/x/player/pagelist?bvid=${BVID}`), /PART_SELECTION_REQUIRED/);
});
