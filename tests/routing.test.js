const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classifySource, publicSource, SourceBook, runRoutedSubmission } = require('../scripts/routing');

test('按链接类型分流；未知页面先验证，不凭域名猜听悟支持', () => {
  assert.equal(classifySource('https://download.pytorch.org/a.wav').route, 'tingwu_direct');
  const bili = classifySource('https://www.bilibili.com/video/BV1GJ411x7h7');
  assert.equal(bili.platform, 'bilibili'); assert.equal(bili.kind, 'page');
  assert.equal(bili.route, 'local_acquire_then_upload');
  assert.equal(classifySource('https://youtu.be/jNQXAC9IVRw').platform, 'youtube');
  assert.equal(classifySource('https://example.org/watch/123').platform, 'unknown');
  assert.notEqual(classifySource('https://youtube.com.evil.test/watch?v=abc').platform, 'youtube');
});

test('网页先本机取得媒体；直链明确拒绝才下载上传', async () => {
  const calls = [];
  const services = { direct: async () => { calls.push('direct'); return { trans_id: 'existing' }; },
    acquire: async () => { calls.push('acquire'); return { kind: 'local', source: 'audio.mp4' }; },
    upload: async () => { calls.push('upload'); return { trans_id: 'uploaded' }; } };
  assert.equal((await runRoutedSubmission({ kind: 'page', source: 'https://example.com/watch/1' }, services)).trans_id, 'uploaded');
  assert.deepEqual(calls, ['acquire', 'upload']);
  calls.length = 0;
  services.direct = async () => { calls.push('direct'); throw Object.assign(new Error('不支持'), { code: 'PARSE_FAILED' }); };
  assert.equal((await runRoutedSubmission({ kind: 'direct', source: 'https://example.com/watch/1' }, services)).trans_id, 'uploaded');
  assert.deepEqual(calls, ['direct', 'acquire', 'upload']);
});

test('提交结果未知或登录失败不能换解析渠道重复提交', async () => {
  for (const code of ['SUBMISSION_UNKNOWN', 'LOGIN_REQUIRED', 'PARSE_NOT_READY', 'API_UNAVAILABLE']) {
    let resolved = false;
    await assert.rejects(runRoutedSubmission({ kind: 'direct', source: 'https://example.com/watch/1' }, {
      direct: async () => { throw Object.assign(new Error(code), { code }); }, resolve: async () => { resolved = true; }
    }), e => e.code === code);
    assert.equal(resolved, false);
  }
});

test('适配记录保留成功与失败，文档隐藏签名参数且不将单条证据推广到平台', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-book-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const book = new SourceBook(root);
  const url = 'https://cdn.example.com/a.mp4?token=secret&expires=99';
  book.observe(url, 'tingwu_parse', 'accepted', '实测接受');
  book.observe(url, 'tingwu_parse', 'unsupported', '本次拒绝');
  assert.equal(book.records()[0].history.length, 2);
  const md = book.render(); assert.doesNotMatch(md, /secret|token=/);
  assert.match(md, /本次拒绝/); assert.match(md, /pv\.vlogdownloader\.com/);
  assert.equal(book.routeHint(url), 'unsupported');
  assert.equal(book.routeHint('https://cdn.example.com/b.mp4'), 'unknown');
  book.collect('https://v.qq.com/x/cover/example.html');
  assert.equal(book.records()[1].history.length, 0);
  assert.match(book.render(), /已收集链接，未进行在线测试/);
  assert.doesNotMatch(publicSource('https://manifest.googlevideo.com/expire/123/sig/SECRET/a.m3u8'), /SECRET/);
});

test('确认尚未提交的解析超时可下载，上传失败不能重提', async () => {
  const calls = [];
  const services = {
    direct: async () => { calls.push('direct'); throw Object.assign(new Error(), { code: 'PARSE_NOT_READY', details: { submitted: false } }); },
    acquire: async () => { calls.push('acquire'); return { kind: 'local' }; },
    upload: async () => { calls.push('upload'); return 'submitted'; }
  };
  assert.equal(await runRoutedSubmission({ kind: 'direct' }, services), 'submitted');
  assert.deepEqual(calls, ['direct', 'acquire', 'upload']);
  calls.length = 0;
  services.upload = async () => { calls.push('upload'); throw Object.assign(new Error(), { code: 'SUBMISSION_UNKNOWN' }); };
  await assert.rejects(runRoutedSubmission({ kind: 'direct' }, services), { code: 'SUBMISSION_UNKNOWN' });
  assert.deepEqual(calls, ['direct', 'acquire', 'upload']);
});
