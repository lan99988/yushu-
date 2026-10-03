const fs = require('node:fs');
const path = require('node:path');
const { Store, readJson, atomicJson } = require('./store');
const { SourceBook, classifySource, publicSource, normalizeSourceInput, contentIdentity } = require('./routing');
const { checkRelease, checkSample, inputKind, REQUIRED, HISTORICAL } = require('./check-release');
function report(store, document) {
  const dir = path.join(store.root, 'qa-v030'); fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'acceptance-three.json');
  const previous = fs.existsSync(target) ? readJson(target) : {};
  const legacyFile = path.join(dir, 'acceptance.json');
  const legacy = fs.existsSync(legacyFile) ? readJson(legacyFile) : {};
  const jobsDir = path.join(store.root, 'jobs');
  const jobs = fs.existsSync(jobsDir) ? fs.readdirSync(jobsDir).filter(n => /^vt-[a-f0-9]{24}$/.test(n)).map(n => store.read(n))
    .filter(j => j.request_id?.startsWith('qa-v030-')) : [];
  const samples = [];
  for (const job of jobs) {
    let platform; let identity;
    try { const canonical = job.canonical_source || job.source; platform = classifySource(canonical).platform; identity = contentIdentity(canonical); }
    catch (_) { continue; }
    if (!REQUIRED.includes(platform)) continue;
    const prior = (previous.samples || []).find(s => s.job_id === job.job_id);
    const sample = { platform, status: 'blocked', job_id: job.job_id, source: job.source, canonical_source: job.canonical_source || job.source,
      content_id: identity, input_kind: inputKind(job.source, platform), trans_id: job.trans_id || null, task_id: job.task_id || null,
      raw_sha256: job.raw_sha256 || null, media_sha256: job.media_cache?.sha256 || null,
      duration_seconds: job.media_cache?.duration_seconds || null, spoken_audio_verified: prior?.spoken_audio_verified === true,
      ...(prior?.spoken_audio_note ? { spoken_audio_note: prior.spoken_audio_note } : {}),
      verified_at: prior?.verified_at || null, error: job.last_error || null, attempts: job.attempts || [] };
    if (job.artifacts.raw && !job.imported && !job.attached) {
      sample.status = sample.spoken_audio_verified ? 'validation_failed' : 'awaiting_spoken_verification';
      if (sample.spoken_audio_verified) {
        try { checkSample(sample, store); sample.status = 'passed'; }
        catch (e) { sample.error = { code: e.code || 'ACCEPTANCE_INVALID', reason: e.details?.reason || 'artifact_validation_failed' }; }
      }
    } else if (job.trans_id || job.task_id || job.remote_name) sample.status = 'awaiting_raw';
    samples.push(sample);
  }
  const overseasFile = path.join(dir, 'overseas.json');
  const observations = fs.existsSync(overseasFile) ? readJson(overseasFile).observations || [] : [];
  const manifest = { schema_version: 2, version: '0.3.0-rc.2', scope: 'three-platform-spoken-video', completed: false,
    generated_at: new Date().toISOString(), samples,
    historical: { platforms: HISTORICAL.map(platform => ({ platform, status: 'not_accepted_in_current_scope',
      previous_samples: (legacy.samples || []).filter(s => s.platform === platform) })),
      yuanbao: previous.historical?.yuanbao || legacy.yuanbao || { transcript_verification: 'pending' },
      overseas: previous.historical?.overseas || legacy.overseas || ['x', 'youtube'].map(platform => ({ platform, status: 'deferred', attempts: observations.filter(o => o.platform === platform) })) } };
  try { manifest.gate = checkRelease(manifest, store); manifest.completed = true; }
  catch (e) { manifest.gate = { publish_allowed: false, code: e.code || 'ACCEPTANCE_INVALID', ...(e.details || {}) }; }
  const esc = value => String(value ?? '—').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
  const labels = { passed: '真实取稿及口播核验通过', awaiting_raw: '等待原稿', blocked: '未取得真实原稿', validation_failed: '产物核验失败', awaiting_spoken_verification: '待人工确认口播及验证日期' };
  let md = '# 视频转写插件 0.3.0 三平台验收记录\n\n候选版本：0.3.0-rc.2。当前状态：' + (manifest.completed ? '九例门槛通过，尚需正式发布' : '未完成，禁止正式发布') + '。本轮要求 B站、抖音、小红书各至少三个不同的有口播视频，分别覆盖分享短链、普通页面和至少600秒的较长视频。单元测试不能代替真实听悟原稿。\n\n';
  md += '| 平台 | 状态 | 来源（脱敏） | 内容ID | 输入类型 | 时长（秒） | job_id | trans_id | 原稿SHA256 | 媒体SHA256 | 验证日期 |\n|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const s of samples) md += '| ' + [s.platform, labels[s.status], publicSource(normalizeSourceInput(s.source)), s.content_id, s.input_kind, s.duration_seconds, s.job_id, s.trans_id, s.raw_sha256, s.media_sha256, s.verified_at].map(esc).join(' | ') + ' |\n';
  for (const platform of REQUIRED) if (!samples.some(s => s.platform === platform)) md += '| ' + platform + ' | 尚无验收样例 | 待验证 | — | — | — | — | — | — | — | — |\n';
  md += '\n其他七个平台保留历史，但未在当前范围验收，不承诺支持。元宝逐字稿验证和 X、YouTube 尝试保留历史，不属于本次发布门槛。旧 acceptance.json 不覆盖。\n\n';
  md += '原稿须来自本插件实际提交的听悟任务，远端状态为0；禁止使用 import-result、attach 或同内容多个任务凑数。验证原稿、段落和媒体摘要，逐条记录人工确认有口播的结果。完整访问参数只保存在私有清单。\n';
  const book = new SourceBook(store.root); book.document = path.resolve(document); book.render = () => md;
  const unlock = book.evidenceLock();
  try { atomicJson(target, manifest); book.writeDocumentUnlocked(); } finally { unlock(); }
  return { completed: manifest.completed, passed: samples.filter(s => s.status === 'passed').length, total: 9,
    document: book.document, manifest: target, gate: manifest.gate, warnings: book.takeWarnings() };
}
if (require.main === module) {
  try { console.log(JSON.stringify(report(new Store(process.argv[2]), path.resolve(process.argv[3])))); }
  catch (e) { console.log(JSON.stringify({ completed: false, error: { code: e.code || 'REPORT_FAILED', message: '验收报告生成失败' } })); process.exitCode = 1; }
}
module.exports = { report };

