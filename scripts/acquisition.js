const fs = require('node:fs');
const path = require('node:path');
const { fail, hash } = require('./core');
const { classifySource, contentIdentity } = require('./routing');
const { identifyRemote, assertPublicUrl } = require('./media-network');
const { prepareMedia, downloadCandidates, validateMedia, fileHash } = require('./media');
const { ParseVideo, expiryOf } = require('./parsevideo');
const { cookieArgs } = require('./media-session');
const { PlatformAdapters } = require('./platform-adapters');

const STOP = new Set(['LOGIN_REQUIRED', 'MEDIA_LOGIN_REQUIRED', 'INTERACTION_REQUIRED', 'CAPTCHA_REQUIRED', 'MEDIA_CAPTCHA_REQUIRED', 'RATE_LIMITED', 'RESOLVER_QUOTA', 'RESOLVER_UNKNOWN', 'API_SCHEMA_CHANGED', 'PLATFORM_SCHEMA_CHANGED', 'PARSER_SCHEMA_CHANGED', 'IDENTITY_MISMATCH', 'PLATFORM_REJECTED', 'PART_SELECTION_REQUIRED', 'SUBMISSION_UNKNOWN', 'UPLOAD_PENDING', 'INVALID_SOURCE', 'UNSAFE_ADDRESS', 'PRIVATE_ADDRESS', 'UNSAFE_REDIRECT', 'REDIRECT_LIMIT', 'LIVE_UNSUPPORTED', 'PLAYLIST_UNSUPPORTED', 'MULTIPLE_SOURCES']);
async function identifySource(source) {
  let media = classifySource(source);
  if (media.kind === 'local') return media;
  await assertPublicUrl(media.source);
  const u = new URL(media.source);
  if (u.searchParams.has('list') || /\/(playlist|live)(\/|$)/i.test(u.pathname)) fail('PLAYLIST_UNSUPPORTED', '不自动展开播放列表或直播');
  // XHS/抖音 short links need the source browser and its access parameters. Do not
  // replace them with a HEAD redirect into a login page before the adapter runs.
  if (['xiaohongshu', 'douyin'].includes(media.platform)) return media;
  if (media.kind === 'page' && contentIdentity(media.source).startsWith('url:') || media.platform === 'unknown' || ['b23.tv', 'youtu.be', 't.co', 'v.kuaishou.com'].includes(u.hostname) || /\.m3u8$/i.test(u.pathname)) {
    const identified = await identifyRemote(media.source);
    media = classifySource(identified.source);
    if (identified.kind === 'direct' || identified.kind === 'hls') media = { ...media, kind: 'direct', hls: identified.kind === 'hls', route: 'tingwu_direct' };
  }
  return media;
}
function errorInfo(error) {
  const code = error.code || 'INTERNAL_ERROR';
  const category = /IDENTITY_MISMATCH/.test(code) ? 'identity_mismatch' : /SCHEMA_CHANGED/.test(code) ? 'upstream_changed' : /LOGIN|AUTH/.test(code) ? 'login_required' : /CAPTCHA|INTERACTION/.test(code) ? 'interaction_required' : /QUOTA|RATE_LIMIT/.test(code) ? 'rate_limited' : /EXPIRED/.test(code) ? 'media_expired' : /NO_AUDIO/.test(code) ? 'no_audio' : /DENIED|FORBIDDEN|REJECTED|403/.test(code) ? 'access_denied' : /TIMEOUT|NOT_READY/.test(code) ? 'network_timeout' : /UNSUPPORTED|NO_MEDIA|PARSE_FAILED/.test(code) ? 'unsupported' : /UNKNOWN|PENDING/.test(code) ? 'result_unknown' : 'operation_failed';
  const next = { login_required: '运行对应站点 media-login；听悟使用 login', interaction_required: '人工完成验证后恢复', rate_limited: '检查额度或等待限制解除', result_unknown: '查询已保存远端身份，禁止重提', media_expired: '重新取得媒体地址；本任务最多自动刷新一次', no_audio: '提供包含声音的媒体', access_denied: '核对来源权限和对应站点登录', network_timeout: '检查网络后对同一 job_id 调用 resume' }[category] || '核对来源和 doctor 后恢复同一任务';
  return { code, category, next };
}
function isExpired(candidates, now = Date.now()) {
  return candidates.length > 0 && candidates.every(c => c.expires_at && Date.parse(c.expires_at) <= now);
}
class Acquisition {
  constructor(store, book, options = {}) {
    this.store = store; this.book = book; this.download = options.download || downloadCandidates;
    this.identify = options.identify || identifySource; this.prepare = options.prepare || prepareMedia;
    this.validate = options.validate || validateMedia;
    this.resolvePlatform = options.resolvePlatform || ((platform, source) => new PlatformAdapters(store).resolve(platform, source));
  }
  async attempt(job, channel, action) {
    let current = this.store.read(job.job_id);
    this.store.update(job.job_id, { stage: 'acquiring', attempts: [...(current.attempts || []), { channel, state: 'started', at: new Date().toISOString() }] });
    try {
      const result = await action(); current = this.store.read(job.job_id);
      const attempts = current.attempts.slice(); attempts[attempts.length - 1] = { ...attempts.at(-1), state: 'succeeded' };
      this.store.update(job.job_id, { attempts, last_error: null }); return result;
    } catch (error) {
      if (error.private_stderr) {
        const diagnostic = path.join(this.store.jobDir(job.job_id), 'diagnostics'); fs.mkdirSync(diagnostic, { recursive: true });
        fs.writeFileSync(path.join(diagnostic, channel + '.txt'), error.private_stderr, { mode: 0o600 });
      }
      current = this.store.read(job.job_id); const info = errorInfo(error);
      const attempts = current.attempts.slice(); attempts[attempts.length - 1] = { ...attempts.at(-1), state: 'failed', error: info };
      this.store.update(job.job_id, { attempts, last_error: info }); throw error;
    }
  }
  async save(job, media, provider) {
    const local = await this.validate(media.source, this.store.jobDir(job.job_id));
    const cache = { ...local, provider, acquired_at: new Date().toISOString(), source_id: hash(job.source) };
    this.store.update(job.job_id, { media_cache: cache, resolved_local: local.source, stage: 'media_ready' });
    this.book.observe(job.source, 'media_validate', 'accepted', `job_id=${job.job_id}; sha256=${local.sha256 || local.metadata?.sha256 || ''}`);
    return local;
  }
  async resolved(job, provider, resolver) {
    let current = this.store.read(job.job_id);
    let cached = current.media_candidates;
    const registerIdentity = result => {
      if (!result?.canonical_source) return;
      const original = classifySource(current.canonical_source || job.source);
      const canonical = classifySource(result.canonical_source);
      const priorId = contentIdentity(original.source), id = contentIdentity(canonical.source);
      if (canonical.kind !== 'page' || original.platform !== canonical.platform ||
          !priorId.startsWith('url:') && priorId !== id ||
          result.content_id && result.content_id !== id)
        fail('IDENTITY_MISMATCH', '解析返回的来源与原始目标视频不符，停止下载');
      this.store.update(job.job_id, { canonical_source: canonical.source, content_id: id,
        ...(result.cid ? { source_cid: result.cid } : {}) });
      if (this.book.alias) this.book.alias(job.source, canonical.source);
    };
    if (!cached || cached.provider !== provider) {
      const result = await this.attempt(job, provider, () => resolver(false));
      registerIdentity(result);
      const candidates = Array.isArray(result) ? result : result.candidates || [{ url: result.source, referer: result.referer }];
      cached = { provider, acquired_at: new Date().toISOString(),
        ...(result.canonical_source ? { canonical_source: result.canonical_source, content_id: result.content_id, cid: result.cid } : {}),
        candidates: candidates.map(c => ({ ...c, expires_at: c.expires_at || expiryOf(c.url || c.source) })) };
      this.store.update(job.job_id, { media_candidates: cached });
    }
    registerIdentity(cached);
    const refresh = async () => {
      current = this.store.read(job.job_id);
      if ((current.refresh_count || 0) >= 1) fail('REFRESH_EXHAUSTED', '本任务的媒体解析刷新预算已用完');
      this.store.update(job.job_id, { refresh_count: (current.refresh_count || 0) + 1 });
      const result = await this.attempt(job, provider + '_refresh', () => resolver(true));
      registerIdentity(result);
      const candidates = Array.isArray(result) ? result : result.candidates || [{ url: result.source, referer: result.referer }];
      cached = { provider, acquired_at: new Date().toISOString(),
        ...(result.canonical_source ? { canonical_source: result.canonical_source, content_id: result.content_id, cid: result.cid } : {}),
        candidates: candidates.map(c => ({ ...c, expires_at: c.expires_at || expiryOf(c.url || c.source) })) };
      this.store.update(job.job_id, { media_candidates: cached });
    };
    if (isExpired(cached.candidates)) await refresh();
    try { return await this.attempt(job, provider + '_download', () => this.download(cached.candidates, this.store.jobDir(job.job_id))); }
    catch (e) {
      if (STOP.has(e.code)) throw e;
      if (e.code !== 'MEDIA_EXPIRED' && !cached.candidates.some(c => c.expires_at && Date.parse(c.expires_at) <= Date.now())) throw e;
      await refresh();
      return this.attempt(job, provider + '_download', () => this.download(cached.candidates, this.store.jobDir(job.job_id)));
    }
  }
  async acquire(source, job, { parseVideoOnly = false } = {}) {
    let current = this.store.read(job.job_id);
    if (current.media_cache?.source && fs.existsSync(current.media_cache.source)) {
      const expected = current.media_cache.sha256 || current.media_cache.metadata?.sha256;
      if (await fileHash(current.media_cache.source) !== expected) fail('MEDIA_CACHE_CHANGED', '缓存媒体摘要不符，请人工检查；不自动覆盖');
      const verified = await validateMedia(current.media_cache.source, this.store.jobDir(job.job_id));
      // Format normalization may extract audio from an intact older video cache.
      this.store.update(job.job_id, { media_cache: { ...current.media_cache, ...verified }, resolved_local: verified.source });
      return verified;
    }
    if (!current.media_cache && current.resolved_local && fs.existsSync(current.resolved_local))
      return this.save(job, { source: current.resolved_local }, 'legacy_local');
    const media = await this.identify(source);
    this.store.update(job.job_id, { canonical_source: contentIdentity(media.source).startsWith('url:') && current.content_id ? current.canonical_source : media.source });
    if (this.book.alias) this.book.alias(source, media.source);
    const dir = this.store.jobDir(job.job_id);
    if (media.kind === 'local') return this.save(job, media, 'local');
    const parser = () => this.resolved(job, 'parsevideo', refresh => new ParseVideo(this.store, this.book).resolve(media.source, this.store.read(job.job_id), { refresh }));
    if (parseVideoOnly) return this.save(job, await parser(), 'parsevideo');
    if (media.kind === 'direct') return this.save(job, await this.attempt(job, 'direct_download', () => downloadCandidates([{ url: media.source }], dir)), 'direct');
    let last;
    if (['bilibili', 'douyin', 'xiaohongshu'].includes(media.platform)) {
      const provider = media.platform + '_page';
      try {
        const local = await this.resolved(job, provider, () => this.resolvePlatform(media.platform, media.source));
        return await this.save(job, local, provider);
      } catch (e) { if (STOP.has(e.code)) throw e; last = e; }
    }
    if (media.platform === 'wechat') {
      // A changed Yuanbao schema or missing login must stop; do not send it to a third party.
      return this.save(job, await this.resolved(job, 'yuanbao', () => new PlatformAdapters(this.store).resolve('wechat', media.source)), 'yuanbao');
    }
    try {
      const local = await this.attempt(job, 'yt_dlp', () => this.prepare(media.source, dir, { cookieArgs: media.platform === 'unknown' ? [] : cookieArgs(this.store, media.platform) }));
      return await this.save(job, local, 'yt_dlp');
    } catch (e) { if (STOP.has(e.code)) throw e; last = e; }
    if (media.platform === 'kuaishou') {
      try { return await this.save(job, await this.resolved(job, 'kuaishou_page', () => new PlatformAdapters(this.store).resolve('kuaishou', media.source)), 'kuaishou_page'); }
      catch (e) { if (STOP.has(e.code)) throw e; last = e; }
    }
    try { return await this.save(job, await parser(), 'parsevideo'); }
    catch (e) { e.details = { ...(e.details || {}), prior_error: errorInfo(last || e) }; throw e; }
  }
}
async function runRoutedSubmission(media, services) {
  if (media.kind === 'local') return services.upload(await services.acquire(media));
  if (media.kind === 'page') return services.upload(await services.acquire(media));
  try { return await services.direct(media); }
  catch (e) {
    const safe = e.code === 'PARSE_FAILED' || e.code === 'PARSE_NOT_READY' && e.details?.submitted === false;
    if (!safe) throw e;
    return services.upload(await services.acquire(media));
  }
}
module.exports = { Acquisition, runRoutedSubmission, errorInfo, isExpired, STOP, identifySource };
