const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../scripts/store');
const { execute } = require('../scripts/cli');
const { Tingwu } = require('../scripts/tingwu');
const { checkRelease } = require('../scripts/check-release');
const { isExpired, errorInfo, Acquisition } = require('../scripts/acquisition');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-reliability-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new Store(dir); }
test('解析失败时转写按钮缺席仍立即返回明确失败', async () => {
  const chosen = { getAttribute: async () => '输入链接', fill: async () => {} };
  const start = { isVisible: async () => false, isEnabled: async () => false };
  const inputs = { count: async () => 1, nth: () => chosen };
  const scope = { waitFor: async () => {}, locator: () => inputs, getByText: () => ({ click: async () => {} }), getByRole: () => start, innerText: async () => '解析失败' };
  const engine = new Tingwu({ root: 'unused' });
  engine.page = { getByText: () => ({ first: () => ({ click: async () => {} }) }), locator: () => ({ last: () => scope }) };
  await assert.rejects(engine.parseLink('https://example.com/a.wav'), e => e.code === 'PARSE_FAILED');
});
test('resume未知提交且没有远端身份时停止，不发起新提交', async t => {
  const store = fixture(t); const job = store.create('unknown', { source: 'https://example.com/a.wav', title: '测试' });
  store.update(job.job_id, { state: 'submission_unknown' });
  await assert.rejects(execute('resume', { job_id: job.job_id }, store), e => e.code === 'SUBMISSION_UNKNOWN');
  assert.equal(store.read(job.job_id).state, 'submission_unknown');
});
test('已有原稿resume离线恢复，正式发布缺任一国内平台均拒绝', async t => {
  const store = fixture(t); const job = store.create('raw', { source: 'https://example.com/a.wav', title: '测试', imported: true });
  store.writeRaw(job.job_id, '原稿\n', [{ speaker: '1', text: '原稿' }]);
  const result = await execute('resume', { job_id: job.job_id }, store);
  assert.equal(result.state, 'ai_ready');
  assert.throws(() => checkRelease({ samples: [] }, store), e => e.code === 'ACCEPTANCE_INCOMPLETE' && e.details.missing.length === 3);
});
test('分享文本路由输出不泄露签名，403不被误判过期', async t => {
  const store = fixture(t);
  const result = await execute('route', { source: '分享 https://cdn.example.com/a.mp4?token=SECRET' }, store);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  assert.equal(errorInfo({ code: 'ACCESS_DENIED' }).category, 'access_denied');
  assert.equal(isExpired([{ expires_at: null }]), false);
  assert.equal(isExpired([{ expires_at: '2000-01-01T00:00:00Z' }]), true);
});
test('混合候选中的明确到期允许刷新一次，普通403不消耗刷新预算', async t => {
  const store = fixture(t); const job = store.create('refresh', { source: 'https://example.com/video', title: '测试' });
  let downloads = 0, parses = 0;
  const acquisition = new Acquisition(store, {}, { download: async () => {
    if (++downloads === 1) throw Object.assign(new Error(), { code: 'ACCESS_DENIED' });
    return { kind: 'local', source: 'verified' };
  } });
  const resolver = async refresh => { parses++; return [{ url: 'https://cdn.example.com/a', expires_at: refresh ? '2099-01-01T00:00:00Z' : '2000-01-01T00:00:00Z' }, ...(refresh ? [] : [{ url: 'https://cdn.example.com/b' }])]; };
  await acquisition.resolved(job, 'parsevideo', resolver);
  assert.equal(parses, 2); assert.equal(store.read(job.job_id).refresh_count, 1);
  store.update(job.job_id, { media_candidates: { provider: 'parsevideo', candidates: [{ url: 'https://cdn.example.com/c', expires_at: '2000-01-01T00:00:00Z' }] } });
  await assert.rejects(acquisition.resolved(job, 'parsevideo', resolver), e => e.code === 'REFRESH_EXHAUSTED');
  assert.equal(parses, 2);
  const other = store.create('ordinary403', { source: 'https://example.com/other', title: '测试' });
  acquisition.download = async () => { throw Object.assign(new Error(), { code: 'ACCESS_DENIED' }); };
  await assert.rejects(acquisition.resolved(other, 'parsevideo', async () => [{ url: 'https://cdn.example.com/b' }]), e => e.code === 'ACCESS_DENIED');
  assert.equal(store.read(other.job_id).refresh_count, undefined);
});
