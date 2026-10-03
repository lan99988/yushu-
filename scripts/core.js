const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

class AppError extends Error {
  constructor(code, message, details = {}) { super(`${code}: ${message}`); this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new AppError(code, message, details); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function checkApi(input) {
  if (!input || typeof input !== 'object') fail('API_SCHEMA_CHANGED', '听悟响应不是对象');
  if (input.success === false || (input.code != null && String(input.code) !== '0'))
    fail('API_REJECTED', '听悟拒绝请求，请检查登录态、额度或任务状态');
}
function normalizeResult(input) {
  checkApi(input);
  let result = input.data?.result;
  if (typeof result === 'string') {
    try { result = JSON.parse(result); } catch { fail('API_SCHEMA_CHANGED', '无法解析转写 result'); }
  }
  if (!Array.isArray(result?.pg)) fail('RESULT_NOT_READY', '转写正文尚未可用');
  const segments = result.pg.map(p => {
    if (!Array.isArray(p.sc) || p.sc.some(s => typeof s.tc !== 'string'))
      fail('API_SCHEMA_CHANGED', '转写词块字段发生变化');
    return { speaker: String(p.ui ?? '未知'), text: p.sc.map(s => s.tc).join(''),
      start_ms: p.sc[0]?.bt ?? null, end_ms: p.sc.at(-1)?.et ?? null };
  }).filter(s => s.text.trim());
  if (!segments.length) fail('RESULT_NOT_READY', '转写正文为空');
  return segments;
}
function renderMarkdown(segments, title = '转写原稿') {
  return `# ${String(title).replace(/[\r\n]/g, ' ')}\n\n` + segments.map(s =>
    `发言人${s.speaker.replace(/[\r\n]/g, ' ')}：${s.text}`).join('\n\n') + '\n';
}
function normalizeList(input) {
  checkApi(input);
  const d = input.data;
  const rows = Array.isArray(d) ? d : d?.list ?? d?.rows ?? input.list;
  if (!Array.isArray(rows)) fail('API_SCHEMA_CHANGED', '未知任务列表结构');
  return rows;
}
function findTask(rows, job) {
  return rows.find(r => (job.trans_id && r.transId === job.trans_id) ||
    (job.task_id && r.taskId === job.task_id)) ?? null;
}
function remoteState(status) {
  if (status === 0) return 'completed';
  if ([1, 3, 4, 5].includes(status)) return 'processing';
  if ([2, 11, 20, 21, 22, 100, 200, 301, 302, 303].includes(status)) return 'failed';
  return 'unknown';
}
function validateSource(source, allowPage = false) {
  if (typeof source !== 'string' || !source.trim()) fail('INVALID_SOURCE', '需要视频链接或本地媒体路径');
  if (/^https?:\/\//i.test(source)) {
    let u; try { u = new URL(source); } catch { fail('INVALID_SOURCE', '无效链接'); }
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (u.username || u.password || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') ||
      (net.isIP(host) && !require('./media-network').isPublicAddress(host))) fail('INVALID_SOURCE', '只接受不带账号密码的公网媒体链接');
    if (host === 'bilibili.com' || host.endsWith('.bilibili.com') || host === 'b23.tv') return { kind: 'bilibili', source };
    if (!/\.(mp3|m4a|wav|mp4|aac|ogg|flac|wma|webm)$/i.test(u.pathname)) {
      if (allowPage) return { kind: 'page', source };
      fail('INVALID_SOURCE', '需要 B 站页面或带媒体扩展名的直链；其他页面请提供本地文件');
    }
    return { kind: 'direct', source };
  }
  const resolved = path.resolve(source);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile() || !/\.(mp3|m4a|wav|mp4|aac|ogg|flac|wma|webm|mov|mkv)$/i.test(resolved))
    fail('INVALID_SOURCE', '本地媒体文件不存在或格式不支持');
  return { kind: 'local', source: resolved };
}
module.exports = { AppError, fail, hash, checkApi, normalizeResult, renderMarkdown, normalizeList, findTask, remoteState, validateSource };
