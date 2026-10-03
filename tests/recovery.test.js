const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Store, atomicJson } = require('../scripts/store');
const { hash } = require('../scripts/core');
const { SourceBook, normalizeSourceInput, contentIdentity, classifySource } = require('../scripts/routing');

function temp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function stage(store, id) {
  const dir = store.jobDir(id); const raw = '未修改的原稿'; const segments = '[{"text":"未修改的原稿"}]\n';
  fs.writeFileSync(path.join(dir, 'raw.pending'), raw);
  fs.writeFileSync(path.join(dir, 'segments.pending'), segments);
  atomicJson(path.join(dir, 'raw-commit.json'), { schema_version: 1, status: 'pending', raw_sha256: hash(raw), segments_sha256: hash(segments) });
  return { dir, raw, segments };
}

test('原稿提交在两个文件之间或任务登记前崩溃后可恢复，且不改正文', t => {
  const store = new Store(temp(t));
  for (const count of [0, 1, 2]) {
    const job = store.create(`crash-${count}`, { source: 'https://example.com/a.mp3' });
    const { dir, raw } = stage(store, job.job_id);
    if (count >= 1) fs.renameSync(path.join(dir, 'raw.pending'), path.join(dir, 'transcript_raw.md'));
    if (count >= 2) fs.renameSync(path.join(dir, 'segments.pending'), path.join(dir, 'segments.json'));
    const recovered = new Store(store.root).read(job.job_id);
    assert.equal(recovered.state, 'ai_ready'); assert.equal(recovered.stage, 'ai_ready'); assert.equal(recovered.raw_sha256, hash(raw));
    assert.equal(fs.readFileSync(recovered.artifacts.raw, 'utf8'), raw);
    assert.equal(store.verifyRaw(job.job_id).job_id, job.job_id);
    assert.throws(() => store.writeRaw(job.job_id, '新稿', []), { code: 'RAW_EXISTS' });
  }
});

test('原稿或段落内容与提交记录冲突时停止恢复，不覆盖现有文件', t => {
  const store = new Store(temp(t)); const job = store.create('conflict', {}); const { dir } = stage(store, job.job_id);
  fs.writeFileSync(path.join(dir, 'transcript_raw.md'), '已有另一原稿');
  assert.throws(() => store.read(job.job_id), { code: 'RAW_CONFLICT' });
  assert.equal(fs.readFileSync(path.join(dir, 'transcript_raw.md'), 'utf8'), '已有另一原稿');
  assert.equal(fs.existsSync(path.join(dir, 'segments.json')), false);
});

test('旧任务无事务记录可以读取，新的段落摘要防止悄然篡改', t => {
  const store = new Store(temp(t)); const job = store.create('old', {});
  assert.equal(store.read(job.job_id).schema_version, 1);
  const ready = store.writeRaw(job.job_id, '正文', [{ text: '正文' }]);
  fs.writeFileSync(ready.artifacts.segments, '[]');
  assert.throws(() => store.verifyRaw(job.job_id), { code: 'RAW_CHANGED' });
});

test('分享文本只允许单链接，平台ID归一化，内容证据关联时保留访问参数', t => {
  assert.equal(normalizeSourceInput('分享 这是视频 https://www.douyin.com/video/123?token=access，'), 'https://www.douyin.com/video/123?token=access');
  assert.throws(() => normalizeSourceInput('https://example.com/a https://example.com/b'), { code: 'MULTIPLE_SOURCES' });
  assert.equal(classifySource('BV1GJ411x7h7').platform, 'bilibili');
  assert.equal(classifySource('youtube:jNQXAC9IVRw').platform, 'youtube');
  assert.equal(classifySource('https://weixin.qq.com/sph/a123').platform, 'wechat');
  assert.equal(classifySource('https://x.com/user/status/123').platform, 'x');
  assert.equal(contentIdentity('https://www.youtube.com/watch?v=jNQXAC9IVRw&share=first'), contentIdentity('https://youtu.be/jNQXAC9IVRw?share=second'));
  const book = new SourceBook(temp(t));
  book.observe('https://www.douyin.com/video/123?token=one', 'tingwu_parse', 'unsupported');
  book.collect('https://www.douyin.com/video/123?token=two');
  assert.equal(book.records().length, 1); assert.equal(book.records()[0].sources.length, 2);
  assert.equal(book.routeHint('https://www.douyin.com/video/123?token=three'), 'unsupported');
});

test('Markdown生成失败只发警告，机器证据不丢失；sources可重建', t => {
  const book = new SourceBook(temp(t)); const blocked = path.join(book.store.root, 'not-a-directory');
  fs.writeFileSync(blocked, 'x'); book.document = path.join(blocked, 'book.md');
  book.observe('https://example.com/a.mp3', 'download', 'failed', '下载失败');
  assert.equal(book.records()[0].history[0].outcome, 'failed');
  assert.equal(book.takeWarnings()[0].code, 'SOURCE_DOCUMENT_FAILED');
  book.document = path.join(book.store.root, 'rebuilt.md');
  assert.equal(book.writeDocument(), book.document); assert.match(fs.readFileSync(book.document, 'utf8'), /下载失败/);
});

test('短链与最终内容ID持锁合并证据，重复关联不复制历史，保留完整私有访问参数', t => {
  const book = new SourceBook(temp(t));
  const short = 'https://b23.tv/short123';
  const final = 'https://www.bilibili.com/video/BV1GJ411x7h7/?token=private';
  book.observe(short, 'download', 'failed', '短链下载失败');
  book.observe(final, 'tingwu_parse', 'unsupported', '最终页面不支持直传');
  const merged = book.alias(short, final);
  assert.equal(book.records().length, 1);
  assert.equal(merged.canonical_id, 'bilibili:BV1GJ411x7h7');
  assert.equal(merged.history.length, 2); assert.ok(merged.sources.includes(final));
  assert.equal(book.routeHint(short), 'unsupported');
  assert.equal(book.routeHint('https://www.bilibili.com/video/BV1GJ411x7h7/?share=second'), 'unsupported');
  book.alias(short, final); assert.equal(book.records()[0].history.length, 2);
  book.observe(short, 'tingwu_fetch', 'accepted', '原稿已保存');
  assert.equal(book.records().length, 1); assert.equal(book.records()[0].history.length, 3);
  book.collect('https://www.bilibili.com/video/BV1GJ411x7h7/?share=third');
  assert.equal(book.records().length, 1);
  assert.doesNotMatch(book.render(), /token=private/);
});

test('多进程并发证据写入与文档重建保留每条历史', async t => {
  const root = temp(t); const modulePath = path.resolve(__dirname, '../scripts/routing.js');
  const code = `const {SourceBook}=require(process.argv[1]); const b=new SourceBook(process.argv[2]); for(let i=0;i<6;i++){b.observe('https://example.com/a.mp3','download','accepted',process.argv[3]+i);b.writeDocument();}`;
  const runs = [0, 1, 2].map(n => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code, modulePath, root, String(n)], { windowsHide: true });
    let stderr = ''; child.stderr.on('data', x => { stderr += x; }); child.on('error', reject);
    child.on('close', exit => exit === 0 ? resolve() : reject(new Error(stderr)));
  }));
  await Promise.all(runs); const book = new SourceBook(root);
  assert.equal(book.records()[0].history.length, 18);
  assert.equal(fs.readdirSync(root).filter(f => f.endsWith('.tmp')).length, 0);
  assert.equal((book.render().match(/本机下载 \| 接受/g) || []).length, 18);
});
