const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../scripts/store');
const { hash } = require('../scripts/core');
const { contentIdentity } = require('../scripts/routing');
const { checkRelease } = require('../scripts/check-release');
const { report } = require('../scripts/acceptance-report');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-three-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root); const samples = [];
  const platforms = ['bilibili', 'douyin', 'xiaohongshu'];
  for (const platform of platforms) for (let i = 0; i < 3; i++) {
    const canonical = platform === 'bilibili' ? `https://www.bilibili.com/video/BV1GJ411x7h${i}/` :
      platform === 'douyin' ? `https://www.douyin.com/video/123456789${i}` : `https://www.xiaohongshu.com/explore/abcdef000${i}?xsec_token=private`;
    const short = platform === 'bilibili' ? 'https://b23.tv/' : platform === 'douyin' ? 'https://v.douyin.com/' : 'https://xhslink.com/';
    const job = store.create(`qa-v030-three-${platform}-${i}`, { source: i === 0 ? short + 'sample' : canonical });
    const media = path.join(store.jobDir(job.job_id), 'media.mp3'); fs.writeFileSync(media, `unit-test media ${platform} ${i}`);
    store.writeRaw(job.job_id, `# 原稿\n\n这是第${i}条口播测试正文。\n`, [{ speaker: '1', text: `这是第${i}条口播测试正文。` }]);
    const now = new Date().toISOString(); const mediaHash = hash(fs.readFileSync(media));
    const saved = store.update(job.job_id, { canonical_source: canonical, trans_id: `trans-${platform}-${i}`, task_id: `task-${platform}-${i}`, remote_status: 0,
      media_cache: { source: media, sha256: mediaHash, duration_seconds: i === 2 ? 601 : 60, audio_codec: 'mp3', container: 'mp3', verified_at: now } });
    samples.push({ platform, status: 'passed', job_id: job.job_id, trans_id: saved.trans_id, task_id: saved.task_id,
      content_id: contentIdentity(canonical), input_kind: i === 0 ? 'share_short_link' : 'page', spoken_audio_verified: true,
      verified_at: now, raw_sha256: saved.raw_sha256, media_sha256: mediaHash });
  }
  return { store, manifest: { version: '0.3.0-rc.2', samples } };
}
test('三平台九个不同口播样例满足覆盖，历史元宝海外未验收不阻断', t => {
  const { store, manifest } = fixture(t);
  const result = checkRelease(manifest, store);
  assert.equal(result.publish_allowed, true); assert.equal(result.sample_count, 9);
  assert.deepEqual(result.platforms, ['bilibili', 'douyin', 'xiaohongshu']);
});
test('缺任何一个真实样例禁止发布', t => {
  const { store, manifest } = fixture(t); manifest.samples.pop();
  assert.throws(() => checkRelease(manifest, store), { code: 'ACCEPTANCE_INCOMPLETE' });
});
test('同内容两个任务不能凑足三例', t => {
  const { store, manifest } = fixture(t); const first = store.read(manifest.samples[0].job_id);
  const second = manifest.samples[1]; store.update(second.job_id, { canonical_source: first.canonical_source });
  second.content_id = manifest.samples[0].content_id;
  assert.throws(() => checkRelease(manifest, store), { code: 'ACCEPTANCE_INVALID' });
});
test('原稿与媒体hash不符以及空段落均不能作为真实验收', t => {
  for (const corruption of ['raw', 'media', 'segments']) {
    const { store, manifest } = fixture(t); const job = store.read(manifest.samples[0].job_id);
    fs.writeFileSync(corruption === 'media' ? job.media_cache.source : corruption === 'raw' ? job.artifacts.raw : job.artifacts.segments, corruption === 'segments' ? '[]' : '被修改');
    assert.throws(() => checkRelease(manifest, store));
  }
});
test('短链、普通页、较长三种覆盖缺一不可', t => {
  for (const missing of ['short', 'page', 'long']) {
    const { store, manifest } = fixture(t); const bili = manifest.samples.filter(s => s.platform === 'bilibili');
    if (missing === 'short') { const j = store.read(bili[0].job_id); store.update(j.job_id, { source: j.canonical_source }); bili[0].input_kind = 'page'; }
    if (missing === 'page') for (const s of bili) { store.update(s.job_id, { source: 'https://b23.tv/' + s.job_id }); s.input_kind = 'share_short_link'; }
    if (missing === 'long') { const j = store.read(bili[2].job_id); store.update(j.job_id, { media_cache: { ...j.media_cache, duration_seconds: 599 } }); }
    assert.throws(() => checkRelease(manifest, store), { code: 'ACCEPTANCE_INCOMPLETE' });
  }
});
test('错误远端身份、非口播、导入或attach任务不能通过门槛', t => {
  for (const invalid of ['identity', 'speech', 'imported', 'attached']) {
    const { store, manifest } = fixture(t); const sample = manifest.samples[0];
    if (invalid === 'identity') sample.trans_id = 'another-task';
    if (invalid === 'speech') sample.spoken_audio_verified = false;
    if (['imported', 'attached'].includes(invalid)) store.update(sample.job_id, { [invalid]: true });
    assert.throws(() => checkRelease(manifest, store), { code: 'ACCEPTANCE_INVALID' });
  }
});
test('报告不擅自确认口播，保留旧十平台历史并从九例证据生成脱敏文档', t => {
  const { store, manifest } = fixture(t); const dir = path.join(store.root, 'qa-v030'); fs.mkdirSync(dir);
  const legacy = JSON.stringify({ samples: [{ platform: 'wechat', status: 'blocked' }], yuanbao: { transcript_verification: 'pending' } });
  fs.writeFileSync(path.join(dir, 'acceptance.json'), legacy);
  const doc = path.join(store.root, 'report.md');
  assert.equal(report(store, doc).completed, false);
  fs.writeFileSync(path.join(dir, 'acceptance-three.json'), JSON.stringify(manifest));
  assert.equal(report(store, doc).completed, true);
  assert.equal(fs.readFileSync(path.join(dir, 'acceptance.json'), 'utf8'), legacy);
  assert.doesNotMatch(fs.readFileSync(doc, 'utf8'), /xsec_token=private/);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'acceptance-three.json'), 'utf8'));
  assert.equal(saved.historical.platforms.find(p => p.platform === 'wechat').previous_samples[0].status, 'blocked');
});
test('报告文档写失败仅返回警告，机器验收仍准确保存', t => {
  const { store, manifest } = fixture(t); const dir = path.join(store.root, 'qa-v030'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'acceptance-three.json'), JSON.stringify(manifest));
  const blocked = path.join(store.root, 'blocked'); fs.writeFileSync(blocked, 'file');
  const result = report(store, path.join(blocked, 'report.md'));
  assert.equal(result.completed, true); assert.equal(result.warnings[0].code, 'SOURCE_DOCUMENT_FAILED');
});
