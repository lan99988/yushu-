const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../scripts/store');
const { classifySource, contentIdentity, SourceBook } = require('../scripts/routing');
const { Acquisition, STOP, errorInfo } = require('../scripts/acquisition');
const { publicJob } = require('../scripts/cli');

test('小红书两种短链均识别；B站分P和抖音vid保持精确内容身份', () => {
  assert.equal(classifySource('https://xhslink.cn/o/abc').platform, 'xiaohongshu');
  assert.equal(contentIdentity('https://www.douyin.com/share/video/123456?vid=123456'), 'douyin:123456');
  assert.equal(contentIdentity('https://www.bilibili.com/video/BV1GJ411x7h7/?p=1'), 'bilibili:BV1GJ411x7h7');
  assert.notEqual(contentIdentity('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2'), contentIdentity('https://www.bilibili.com/video/BV1GJ411x7h7/'));
});

test('适配证据不会合并同BV不同分P；分享访问token仍私有保留', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'three-book-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const book = new SourceBook(root);
  book.collect('https://www.bilibili.com/video/BV1GJ411x7h7/?p=1');
  book.collect('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2');
  assert.equal(book.records().length, 2);
  const tokenUrl = 'https://www.xiaohongshu.com/explore/6411cf99000000001300b6d9?xsec_token=PRIVATE_TOKEN';
  book.collect(tokenUrl);
  assert.equal(book.records()[2].source, tokenUrl);
  assert.doesNotMatch(book.render(), /PRIVATE_TOKEN/);
});

test('旧证据中的过时canonical_id不能把P2合并到P1，历史仍保留', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'three-book-old-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const book = new SourceBook(root);
  fs.writeFileSync(book.file, JSON.stringify([{ source: 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2', canonical_id: 'bilibili:BV1GJ411x7h7', platform: 'bilibili', history: [{ stage: 'tingwu_parse', outcome: 'accepted', at: '2026-10-01T00:00:00Z' }] }]));
  book.collect('https://www.bilibili.com/video/BV1GJ411x7h7/?p=1');
  assert.equal(book.records().length, 2);
  assert.equal(book.records()[0].history.length, 1);
});

function scenario(t, platform, resolvePlatform) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'three-acquire-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root), calls = [];
  const source = 'https://www.' + (platform === 'xiaohongshu' ? 'xiaohongshu.com/explore/6411cf99000000001300b6d9' : platform === 'douyin' ? 'douyin.com/video/123456' : 'bilibili.com/video/BV1GJ411x7h7/');
  const job = store.create('request', { source });
  const acquire = new Acquisition(store, { alias() {}, observe() {} }, {
    identify: async () => ({ source, platform, kind: 'page' }),
    resolvePlatform: async () => { calls.push('platform'); return resolvePlatform(); },
    prepare: async () => { calls.push('yt-dlp'); return { source: 'validated.m4a' }; },
    download: async () => { calls.push('download'); return { source: 'validated.m4a' }; },
    validate: async source => ({ source, kind: 'local', sha256: 'a'.repeat(64) })
  });
  assert.equal(typeof acquire.identify, 'function', '来源识别必须可注入，离线故障测试不能访问真实站点');
  return { calls, acquire, store, job, source };
}

test('三平台先精确适配再下载，成功不消耗第三方或yt-dlp', async t => {
  const s = scenario(t, 'douyin', () => [{ url: 'https://cdn.example.org/video.mp4' }]);
  await s.acquire.acquire(s.source, s.job);
  assert.deepEqual(s.calls, ['platform', 'download']);
  assert.equal(s.store.read(s.job.job_id).media_cache.provider, 'douyin_page');
});

test('适配器明确不支持才尝试yt-dlp；身份冲突不能换渠道', async t => {
  const s = scenario(t, 'xiaohongshu', () => { throw Object.assign(new Error(), { code: 'PLATFORM_UNSUPPORTED' }); });
  await s.acquire.acquire(s.source, s.job);
  assert.deepEqual(s.calls, ['platform', 'yt-dlp']);
  const other = scenario(t, 'bilibili', () => { throw Object.assign(new Error(), { code: 'IDENTITY_MISMATCH' }); });
  await assert.rejects(other.acquire.acquire(other.source, other.job), { code: 'IDENTITY_MISMATCH' });
  assert.deepEqual(other.calls, ['platform']);
  assert.equal(STOP.has('IDENTITY_MISMATCH'), true);
  assert.equal(errorInfo({ code: 'PLATFORM_SCHEMA_CHANGED' }).category, 'upstream_changed');
});

test('平台返回规范身份须登记供短链取稿验收，不允许改成其他平台', async t => {
  const canonical = 'https://www.douyin.com/video/123456';
  const s = scenario(t, 'douyin', () => ({ canonical_source: canonical, content_id: 'douyin:123456', candidates: [{ url: 'https://cdn.example.org/audio' }] }));
  await s.acquire.acquire(s.source, s.job);
  assert.equal(s.store.read(s.job.job_id).canonical_source, canonical);
  assert.equal(s.store.read(s.job.job_id).content_id, 'douyin:123456');
  const other = scenario(t, 'douyin', () => ({ canonical_source: 'https://www.douyin.com/video/987654', candidates: [{ url: 'https://cdn.example.org/audio' }] }));
  await assert.rejects(other.acquire.acquire(other.source, other.job), { code: 'IDENTITY_MISMATCH' });
});

test('远端等待五分钟只提供同任务恢复提示，不能要求重新提交', () => {
  const result = publicJob({ job_id: 'vt-' + 'a'.repeat(24), state: 'submitted', trans_id: 'remote', remote_status: 1, artifacts: {}, submitted_at: '2000-01-01T00:00:00Z' }, { preferences: () => ({ cards: 'ask' }) });
  assert.equal(result.waiting_extended, true);
  assert.match(result.next, /resume/);
  assert.match(result.next, /禁止重提/);
});

test('短链下载恢复复用候选时仍保留已验证规范身份', async t => {
  const canonical = 'https://www.douyin.com/video/123456';
  const s = scenario(t, 'douyin', () => ({ canonical_source: canonical, content_id: 'douyin:123456', candidates: [{ url: 'https://cdn.example.org/audio' }] }));
  s.source = 'https://v.douyin.com/abc/';
  s.job = s.store.create('short-request', { source: s.source });
  s.acquire.identify = async () => ({ source: s.source, kind: 'page', platform: 'douyin' });
  await s.acquire.acquire(s.source, s.job);
  await s.acquire.acquire(s.source, s.job);
  assert.equal(s.store.read(s.job.job_id).canonical_source, canonical);
  assert.deepEqual(s.calls, ['platform', 'download', 'download']);
});
