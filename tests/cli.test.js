const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cli = path.resolve(__dirname, '../scripts/cli.js');
// 本机环境 spawnSync 一律 EBUSY（宿主拦截同步进程创建），改用等价异步 spawn。
function call(root, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, '--state-root', root], { encoding: 'utf8' });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.on('close', status => {
      let value;
      try { value = JSON.parse(out); } catch (e) {
        return reject(new SyntaxError('CLI stdout 不是合法 JSON: ' + out.slice(0, 200)));
      }
      resolve({ status, value });
    });
    child.on('error', reject);
  });
}
test('CLI 离线全流程：导入、AI 产物登记、复用、偏好与原稿保护', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'input.json');
  fs.writeFileSync(fixture, JSON.stringify({ code: '0', success: true, data: { result: JSON.stringify({ pg: [
    { ui: '1', sc: [{ tc: '今天，讨论插件。', bt: 1000, et: 2000 }] }
  ] }) } }));
  const imported = await call(root, 'import-result', '--request-id', 'offline', '--source', fixture);
  assert.equal(imported.status, 0); assert.equal(imported.value.data.state, 'ai_ready');
  const job = imported.value.data;
  const original = fs.readFileSync(job.artifacts.raw, 'utf8');
  assert.doesNotMatch(original, /\[\d+:\d+\]/);
  assert.equal((await call(root, 'import-result', '--request-id', 'offline', '--source', fixture)).value.data.job_id, job.job_id);
  assert.equal((await call(root, 'preferences', '--cards', 'always')).value.data.cards, 'always');
  const corrected = path.join(root, 'corrected.md'); const summary = path.join(root, 'summary.md');
  fs.writeFileSync(corrected, '发言人1：今天讨论插件。\n'); fs.writeFileSync(summary, '讨论插件。\n');
  assert.equal((await call(root, 'finalize', '--job-id', job.job_id, '--corrected-file', corrected, '--summary-file', summary)).value.error.code, 'CARD_REQUIRED');
  const finalized = await call(root, 'finalize', '--job-id', job.job_id, '--corrected-file', corrected, '--summary-file', summary, '--cards', 'never');
  assert.equal(finalized.status, 0); assert.equal(finalized.value.data.state, 'complete');
  assert.equal(fs.readFileSync(job.artifacts.raw, 'utf8'), original);
  assert.equal(fs.readFileSync(finalized.value.data.artifacts.summary, 'utf8'), '讨论插件。\n');
  const previous = finalized.value.data.artifacts.summary;
  const again = await call(root, 'finalize', '--job-id', job.job_id, '--corrected-file', corrected, '--summary-file', summary, '--cards', 'never');
  assert.notEqual(again.value.data.artifacts.summary, previous);
  assert.equal(fs.readFileSync(previous, 'utf8'), '讨论插件。\n');
  const card = path.join(root, 'card.md'); fs.writeFileSync(card, '# 本地知识卡片\n\n讨论插件。\n');
  const withCard = await call(root, 'finalize', '--job-id', job.job_id, '--corrected-file', corrected, '--summary-file', summary, '--card-file', card);
  assert.equal(withCard.value.data.ai.cards, 'generated');
  assert.equal(fs.readFileSync(withCard.value.data.artifacts.card, 'utf8'), '# 本地知识卡片\n\n讨论插件。\n');
  const noCard = await call(root, 'finalize', '--job-id', job.job_id, '--corrected-file', corrected, '--summary-file', summary, '--cards', 'never');
  assert.equal(noCard.value.data.artifacts.card, undefined);
  assert.equal(fs.existsSync(withCard.value.data.artifacts.card), true);
  fs.writeFileSync(job.artifacts.raw, '篡改');
  assert.equal((await call(root, 'finalize', '--job-id', job.job_id, '--corrected-file', corrected, '--summary-file', summary)).value.error.code, 'RAW_CHANGED');
});
test('CLI 错误返回 JSON 和非零退出码；不输出敏感输入', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-error-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = await call(root, 'submit', '--request-id', 'bad', '--source', 'https://user:secret@example.com/a.mp3');
  assert.notEqual(r.status, 0); assert.equal(r.value.error.code, 'INVALID_SOURCE');
  assert.doesNotMatch(JSON.stringify(r.value), /secret/);
  const requestFile = path.join(root, 'request.json');
  fs.writeFileSync(requestFile, '\uFEFF' + JSON.stringify({ capability: 'preferences', fields: { cards: 'never' } }));
  assert.equal((await call(root, 'invoke', '--file', requestFile)).value.data.cards, 'never');
  assert.equal((await call(root, 'doctor', '--unknown', 'value')).value.error.code, 'INVALID_REQUEST');
});
