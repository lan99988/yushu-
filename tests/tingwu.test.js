const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Tingwu } = require('../scripts/tingwu');
test('听悟只读查询网络失败返回脱敏类别，保留任务供恢复', async () => {
  const engine = new Tingwu({root:'unused'});
  engine.page = {evaluate:async()=>{throw new Error('AbortError private-url?token=SECRET');}};
  await assert.rejects(engine.api('/api/trans/request',{}),e=>e.code==='NETWORK_TIMEOUT'&&!e.message.includes('SECRET'));
});
test('未知状态即便有正文也不能作为最终原稿', async () => {
  const engine = new Tingwu({ root: 'unused' });
  const result = JSON.stringify({ pg: [{ ui: '1', sc: [{ tc: '尚未完成的片段' }] }] });
  engine.api = async () => ({ code: '0', success: true, data: { status: 1, result } });
  await assert.rejects(engine.result('id'), /RESULT_NOT_READY/);
  engine.api = async () => ({ code: '0', success: true, data: { status: 0, result } });
  assert.equal((await engine.result('id')).segments[0].text, '尚未完成的片段');
  engine.api = async () => ({ code: '0', success: true, data: { status: 11, result } });
  await assert.rejects(engine.result('id'), /REMOTE_FAILED/);
});
test('直链用本次唯一标识精确恢复，不取最新或相近标题', async () => {
  const engine = new Tingwu({ root: 'unused' });
  const marker = '标题 [vtrans-unique]';
  engine.list = async () => [
    { tag: { showName: marker + ' 其他', fileType: 'net_source' }, transId: 'wrong' },
    { tag: { showName: marker, fileType: 'net_source' }, transId: 'exact' }
  ];
  assert.equal((await engine.resolveByMarker(marker)).transId, 'exact');
  engine.list = async () => [
    { tag: { showName: marker, fileType: 'net_source' }, transId: 'a' },
    { tag: { showName: marker, fileType: 'net_source' }, transId: 'b' }
  ];
  await assert.rejects(engine.resolveByMarker(marker), /AMBIGUOUS_TASK/);
});
