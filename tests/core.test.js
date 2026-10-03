const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeResult, renderMarkdown, normalizeList, findTask, validateSource } = require('../scripts/core');
const { Store } = require('../scripts/store');

test('听悟词块保持顺序、发言人与分段；原稿无时间戳', () => {
  const input = { success: true, code: '0', data: { result: JSON.stringify({ pg: [
    { ui: '1', sc: [{ bt: 1000, et: 1200, tc: '你好', si: 1 }, { bt: 1200, et: 2000, tc: '。', si: 1 }] },
    { ui: '2', sc: [{ bt: 3000, et: 4000, tc: '谢谢。', si: 2 }] }
  ] }) } };
  const segments = normalizeResult(input);
  assert.equal(segments.length, 2);
  const md = renderMarkdown(segments, '测试');
  assert.match(md, /发言人1：你好。/);
  assert.match(md, /发言人2：谢谢。/);
  assert.doesNotMatch(md, /\[\d+:\d+\]/);
  assert.throws(() => normalizeResult({ success: false, data: input.data }), /API_REJECTED/);
  assert.throws(() => normalizeResult({ data: { result: '{}' } }), /RESULT_NOT_READY/);
});

test('列表兼容三种结构，只匹配确切任务 ID', () => {
  const rows = [{ taskId: 'other', transId: 'a' }, { taskId: 'wanted', transId: 'b' }];
  for (const data of [rows, { list: rows }, { rows }]) assert.deepEqual(normalizeList({ data }), rows);
  assert.equal(findTask(rows, { task_id: 'wanted' }).transId, 'b');
  assert.equal(findTask(rows, { task_id: 'missing' }), null);
  assert.throws(() => normalizeList({ success: false, data: rows }), /API_REJECTED/);
});

test('输入只接受公网 HTTP(S) 链接或现有本地媒体', () => {
  assert.equal(validateSource('https://www.bilibili.com/video/BV123').kind, 'bilibili');
  assert.equal(validateSource('https://example.com/a.m4a?x=1').kind, 'direct');
  for (const value of ['javascript:alert(1)', 'https://127.0.0.1/a.mp3', 'https://u:p@example.com/a.mp3'])
    assert.throws(() => validateSource(value), /INVALID_SOURCE/);
});

test('稳定 request_id 复用任务、不同输入拒绝、并发锁、原稿不可覆盖', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new Store(root);
  const a = store.create('req-1', { source: 'https://example.com/a.mp3', title: 'A' });
  assert.equal(store.create('req-1', { source: 'https://example.com/a.mp3', title: 'A' }).job_id, a.job_id);
  assert.throws(() => store.create('req-1', { source: 'https://example.com/b.mp3', title: 'A' }), /REQUEST_CONFLICT/);
  const b = store.create('req-2', { source: 'https://example.com/a.mp3', title: 'A' });
  assert.notEqual(a.job_id, b.job_id);
  const unlock = store.lock('browser');
  assert.throws(() => store.lock('browser'), /BUSY/);
  unlock();
  store.update(a.job_id, { state: 'submitting' });
  assert.throws(() => store.assertSubmittable(store.read(a.job_id)), /SUBMISSION_UNKNOWN/);
  store.writeRaw(a.job_id, '原稿', [{ text: '原稿', speaker: '1' }]);
  assert.throws(() => store.writeRaw(a.job_id, '覆盖', []), /RAW_EXISTS/);
  const raw = store.read(a.job_id).artifacts.raw;
  fs.writeFileSync(raw, '修改');
  assert.throws(() => store.verifyRaw(a.job_id), /RAW_CHANGED/);
});
