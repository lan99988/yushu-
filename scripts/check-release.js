const fs = require('node:fs');
const { Store, readJson } = require('./store');
const { classifySource, normalizeSourceInput, contentIdentity } = require('./routing');
const { hash, fail } = require('./core');
const REQUIRED = ['bilibili', 'douyin', 'xiaohongshu'];
const HISTORICAL = ['kuaishou', 'weibo', 'tencent', 'iqiyi', 'youku', 'xigua', 'wechat'];
const SHORT_DOMAINS = { bilibili: ['b23.tv'], douyin: ['v.douyin.com'], xiaohongshu: ['xhslink.com', 'xhslink.cn'] };
function inputKind(source, platform) {
  const url = new URL(normalizeSourceInput(source));
  return SHORT_DOMAINS[platform]?.includes(url.hostname) ? 'share_short_link' : 'page';
}
function checkSample(sample, store) {
  const invalid = reason => fail('ACCEPTANCE_INVALID', '验收记录与真实任务及产物不一致', { platform: sample.platform, job_id: sample.job_id, reason });
  let job;
  try { job = store.verifyRaw(sample.job_id); } catch (_) { invalid('raw_integrity'); }
  const canonical = job.canonical_source || job.source;
  let identity; let platform;
  try { identity = contentIdentity(canonical); platform = classifySource(canonical).platform; } catch (_) { invalid('source_identity'); }
  if (job.imported || job.attached || !job.trans_id || job.remote_status !== 0) invalid('remote_completion');
  if (sample.trans_id !== job.trans_id || (job.task_id && sample.task_id !== job.task_id)) invalid('remote_identity');
  if (platform !== sample.platform || !identity.startsWith(`${sample.platform}:`) || sample.content_id !== identity) invalid('content_identity');
  if (!Number.isFinite(Date.parse(sample.verified_at)) || sample.spoken_audio_verified !== true) invalid('spoken_audio_verification');
  if (sample.input_kind !== inputKind(job.source, sample.platform)) invalid('input_coverage_evidence');
  const media = job.media_cache;
  if (!media?.source || !/^[a-f0-9]{64}$/.test(media.sha256 || '') || sample.media_sha256 !== media.sha256 ||
    !Number.isFinite(media.duration_seconds) || media.duration_seconds <= 0 || !media.container || !media.audio_codec ||
    !Number.isFinite(Date.parse(media.verified_at))) invalid('media_validation');
  try { if (hash(fs.readFileSync(media.source)) !== media.sha256) invalid('media_integrity'); }
  catch (e) { if (e.code === 'ACCEPTANCE_INVALID') throw e; invalid('media_integrity'); }
  if (sample.raw_sha256 !== job.raw_sha256) invalid('raw_digest');
  let segments;
  try { segments = readJson(job.artifacts.segments); } catch (_) { invalid('segments_missing'); }
  if (!Array.isArray(segments) || !segments.length || segments.some(s => typeof s.text !== 'string' || !s.text.trim())) invalid('segments_empty');
  return { job, content_id: identity, duration_seconds: media.duration_seconds, input_kind: sample.input_kind };
}
function checkRelease(manifest, store) {
  if (!Array.isArray(manifest.samples)) fail('ACCEPTANCE_INCOMPLETE', '缺少真实验收样例清单');
  const missing = []; const coverage = {}; let count = 0;
  for (const platform of REQUIRED) {
    const samples = manifest.samples.filter(s => s.platform === platform && s.status === 'passed');
    const identities = new Set(); const jobs = new Set(); const verified = samples.map(sample => {
      const checked = checkSample(sample, store);
      if (identities.has(checked.content_id) || jobs.has(sample.job_id)) fail('ACCEPTANCE_INVALID', '同内容或同任务不能重复计数', { platform });
      identities.add(checked.content_id); jobs.add(sample.job_id); return checked;
    });
    coverage[platform] = { samples: verified.length, share_short_link: verified.some(s => s.input_kind === 'share_short_link'),
      page: verified.some(s => s.input_kind === 'page'), long_video: verified.some(s => s.duration_seconds >= 600) };
    if (verified.length < 3 || !coverage[platform].share_short_link || !coverage[platform].page || !coverage[platform].long_video) missing.push(platform);
    count += verified.length;
  }
  if (missing.length) fail('ACCEPTANCE_INCOMPLETE', '三平台各三例及短链、普通页、较长视频覆盖尚未完成，禁止发布', { missing, coverage });
  return { publish_allowed: true, platforms: REQUIRED, sample_count: count, coverage, historical_platforms: HISTORICAL };
}
if (require.main === module) {
  try { console.log(JSON.stringify({ ok: true, data: checkRelease(readJson(process.argv[2]), new Store(process.argv[3])) })); }
  catch (e) { console.log(JSON.stringify({ ok: false, error: { code: e.code || 'ACCEPTANCE_INVALID', message: '验收门槛未通过', details: e.details || {} } })); process.exitCode = 1; }
}
module.exports = { checkRelease, checkSample, inputKind, REQUIRED, HISTORICAL };
