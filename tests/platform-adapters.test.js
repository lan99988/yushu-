const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PlatformAdapters, userState, parseWechatResult, parseFinderResult, normalizeCandidates } = require('../scripts/platform-adapters');

test('元宝登录与解析只接受已核对结构，不以摘要或匿名Cookie证明成功', () => {
  assert.equal(userState({ status: 200, data: { anonUser: { isAnon: true } } }), 'login_required');
  assert.equal(userState({ status: 200, data: { anonUser: { isAnon: false } } }), 'logged_in');
  assert.equal(userState({ status: 200, data: { user: { id: 'any' } } }), 'unknown');
  assert.equal(userState({ status: 401, data: {} }), 'login_required');
  assert.deepEqual(parseWechatResult({ code: 0, data: { wx_export_id: 'export' } }), { exportId: 'export', playableUrl: null });
  assert.throws(() => parseWechatResult({ code: 0, data: { summary: '概述' } }), /PLATFORM_SCHEMA_CHANGED/);
  assert.equal(parseFinderResult({ videoUrl: 'https://cdn.example.com/a.mp4' }), 'https://cdn.example.com/a.mp4');
  assert.equal(parseFinderResult({ code: 0, data: { videoUrl: 'https://cdn.example.com/a.mp4' } }), 'https://cdn.example.com/a.mp4');
  assert.throws(() => parseFinderResult({ code: 1, videoUrl: 'https://cdn.example.com/a.mp4' }), /PLATFORM_REJECTED/);
  assert.throws(() => normalizeCandidates(['http://127.0.0.1/a.mp4', 'blob:https://x/a'], 'x', 'x'), /PLATFORM_UNSUPPORTED/);
});

test('视频号按已核对接口提取多候选，返回不包含会话Cookie或逐字稿', async () => {
  const requests = []; let closed = 0;
  const page = { locator: () => ({ innerText: async () => '' }), evaluate: async (_fn, args) => {
    requests.push(args);
    const data = args.endpoint === '/api/getuserinfo' ? { anonUser: { isAnon: false } } :
      args.endpoint === '/api/weixin/get_parse_result' ? { code: 0, data: { wx_export_id: 'export', playable_url: 'https://cdn.example.com/backup.mp4' } } :
      { data: { videoUrl: 'https://cdn.example.com/main.mp4' } };
    return { status: 200, data };
  } };
  const adapters = new PlatformAdapters({}, { sessionFactory: platform => {
    assert.equal(platform, 'yuanbao'); return { page, open: async () => {}, close: async () => { closed++; } };
  } });
  const source = 'https://channels.weixin.qq.com/web/pages/feed?eid=example';
  const result = await adapters.resolve('wechat', source);
  assert.equal(result.length, 2); assert.equal(closed, 1);
  assert.deepEqual(requests[1].body, { type: 'video_channel_url', url: source, scene: 1 });
  assert.deepEqual(requests[2].body, { exportId: 'export' });
  assert.deepEqual(Object.keys(result[0]).sort(), ['label', 'provider', 'referer', 'url']);
});

test('视频号匿名状态安全停止；未知登录结构不继续解析', async () => {
  for (const info of [{ anonUser: { isAnon: true } }, { unknown: true }]) {
    let calls = 0; let closed = 0;
    const page = { locator: () => ({ innerText: async () => '' }), evaluate: async () => { calls++; return { status: 200, data: info }; } };
    const adapters = new PlatformAdapters({}, { sessionFactory: () => ({ page, open: async () => {}, close: async () => { closed++; } }) });
    await assert.rejects(adapters.resolve('wechat', 'https://channels.weixin.qq.com/web/pages/feed?eid=x'),
      e => ['MEDIA_LOGIN_REQUIRED', 'PLATFORM_SCHEMA_CHANGED'].includes(e.code));
    assert.equal(calls, 1); assert.equal(closed, 1);
  }
});

test('快手只读取明确 DOM 媒体地址，并保留多候选，不猜 JSON 字段', async () => {
  const page = { goto: async () => {}, locator: () => ({ innerText: async () => '' }),
    evaluate: async () => ({ candidates: ['https://cdn.example.com/a.mp4', 'https://cdn.example.com/a.mp4', 'https://cdn.example.com/b.mp4', 'blob:https://example.com/x'], loginRequired: false }) };
  const adapters = new PlatformAdapters({}, { sessionFactory: () => ({ page, open: async () => {}, close: async () => {} }) });
  const result = await adapters.resolve('kuaishou', 'https://www.kuaishou.com/short-video/example');
  assert.equal(result.length, 2); assert.equal(result[0].provider, 'kuaishou-dom');
  await assert.rejects(adapters.resolve('kuaishou', 'https://kuaishou.com.evil.test/x'), /PLATFORM_UNSUPPORTED/);
});

test('快手验证码立即停止，不采集或自动绕过挑战', async () => {
  let evaluated = false;
  const page = { goto: async () => {}, locator: () => ({ innerText: async () => '请完成安全验证' }), evaluate: async () => { evaluated = true; } };
  const adapters = new PlatformAdapters({}, { sessionFactory: () => ({ page, open: async () => {}, close: async () => {} }) });
  await assert.rejects(adapters.resolve('kuaishou', 'https://www.kuaishou.com/short-video/example'), /MEDIA_CAPTCHA_REQUIRED/);
  assert.equal(evaluated, false);
});
