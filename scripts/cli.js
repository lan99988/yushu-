#!/usr/bin/env node
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Store, readJson, atomicJson } = require('./store');
const { fail, normalizeResult, renderMarkdown, validateSource, remoteState } = require('./core');
const { Tingwu, browserPath } = require('./tingwu');
const { prepareMedia, downloadMedia, executableOnPath } = require('./media');
const { classifySource, publicSource, SourceBook, runRoutedSubmission, PARSER_URL } = require('./routing');
const { ParseVideo } = require('./parsevideo');
const { Acquisition, runRoutedSubmission: routedSubmit, errorInfo, identifySource } = require('./acquisition');
const { MediaSession } = require('./media-session');
const { yuanbaoLoggedIn } = require('./platform-adapters');
const VERSION = require('../package.json').version;
const COMMANDS = ['doctor', 'catalog', 'route', 'probe', 'resolve', 'acquire', 'resume', 'media-login', 'media-session-import', 'sources', 'source-add', 'source-record', 'login', 'session-import', 'submit', 'attach', 'status', 'fetch', 'import-result', 'preferences', 'finalize', 'unlock'];
function parse(argv) {
  const options = {}; let command = argv.shift() || 'help';
  while (argv.length) {
    const flag = argv.shift();
    if (!/^--[a-z-]+$/.test(flag) || !argv.length || argv[0].startsWith('--')) fail('INVALID_REQUEST', '参数应为 --name value');
    options[flag.slice(2).replace(/-/g, '_')] = argv.shift();
  }
  const allowed = ['file', 'state_root', 'source', 'request_id', 'title', 'language', 'job_id', 'trans_id', 'task_id', 'wait', 'cards', 'corrected_file', 'summary_file', 'card_file', 'name', 'check_login', 'stage', 'outcome', 'note', 'platform'];
  for (const key of Object.keys(options)) if (!allowed.includes(key)) fail('INVALID_REQUEST', `未知参数 ${key}`);
  return { command, options };
}
function boundedNumber(value, fallback, max) {
  if (value === undefined) return fallback;
  const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > max) fail('INVALID_REQUEST', `等待秒数应为 0..${max}`);
  return n;
}
function publicJob(job, store) {
  const prefs = store.preferences();
  const elapsed = Date.now() - Date.parse(job.submitted_at || job.created_at);
  const waiting = !job.artifacts.raw && !!(job.trans_id || job.task_id || job.remote_name) &&
    remoteState(job.remote_status) !== 'completed' && remoteState(job.remote_status) !== 'failed' && elapsed >= 300000;
  return { job_id: job.job_id, state: job.state, trans_id: job.trans_id || null, task_id: job.task_id || null,
    ...(waiting ? { waiting_extended: true, next: '等待超过5分钟；对同一 job_id 调用 status 或 resume，只查询已有任务，禁止重提' } : {}),
    stage: job.stage || job.state, attempts: job.attempts || [], error: job.last_error || null,
    remote_status: job.remote_status ?? null, remote_state: remoteState(job.remote_status), artifacts: job.artifacts,
    ai: job.artifacts.raw ? { performed_by: 'calling_agent', preserve_raw: true, timestamps: false,
      required: ['corrected_transcript', 'summary'], cards: job.card_decision || prefs.cards,
      next: job.state === 'complete' ? 'done' : '读取原稿，另存校正版和摘要；卡片仅本地生成；调用 finalize 登记' } : null };
}
async function withBrowser(store, interactive, action) {
  const engine = new Tingwu(store);
  try { await engine.open(interactive); return await action(engine); }
  finally { await engine.close(); }
}
async function execute(command, fields, store, requestId) {
  const book = new SourceBook(store.root);
  try {
    const result = await executeInternal(command, fields, store, requestId, book);
    const warnings = book.takeWarnings();
    return { ...result, warnings: [...(result.warnings || []), ...warnings] };
  } catch (e) {
    const jobId = e.details?.job_id || fields.job_id;
    if (/^vt-[a-f0-9]{24}$/.test(jobId || '')) {
      const dir = path.join(store.jobDir(jobId), 'diagnostics'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `execution-${randomUUID()}.txt`), e.stack || e.message, { mode: 0o600 });
    }
    e.details = { ...(e.details || {}), ...(jobId ? { job_id: jobId } : {}), ...errorInfo(e), warnings: book.takeWarnings() }; throw e;
  }
}
async function executeInternal(command, fields, store, requestId, book) {
  const acquisition = new Acquisition(store, book);
  if (command === 'resume') {
    const job = store.read(fields.job_id);
    if (job.artifacts.raw || job.trans_id || job.task_id || job.remote_name)
      return execute('fetch', { job_id: job.job_id, wait: fields.wait || 0 }, store, requestId);
    if (['submitting', 'submission_unknown', 'uploading'].includes(job.state))
      fail('SUBMISSION_UNKNOWN', '提交结果未知且缺乏可恢复身份，禁止再次提交', { job_id: job.job_id });
    return execute(job.acquisition_only ? 'acquire' : job.resolver_only ? 'resolve' : 'submit',
      { source: job.source, title: job.title, language: job.language }, store, job.request_id);
  }
  if (command === 'media-session-import') return new MediaSession(store, fields.platform).importCookies(fields.source);
  if (command === 'media-login') return new MediaSession(store, fields.platform).login(boundedNumber(fields.wait, 180, 600),
    ['wechat', 'yuanbao'].includes(fields.platform) ? yuanbaoLoggedIn : undefined);
  const record = (source, stage, error) => book.observe(source, stage, error ? (error.code === 'PARSE_FAILED' ? 'unsupported' : 'error') : 'accepted', error?.code || '自动验证');
  const resolveMedia = (source, job) => acquisition.acquire(source, job, { parseVideoOnly: true });
  if (command === 'sources') return { document: book.writeDocument(), records: book.records().map(r => ({ ...r, source: publicSource(r.source), canonical_source: r.canonical_source ? publicSource(r.canonical_source) : undefined, sources: (r.sources || []).map(publicSource) })), warnings: book.takeWarnings() };
  if (command === 'source-add') {
    const row = book.collect(fields.source);
    return { source: publicSource(row.source), platform: row.platform, document: book.document, evidence_count: row.history.length };
  }
  if (command === 'source-record') {
    const row = book.observe(fields.source, fields.stage, fields.outcome, fields.note);
    return { source: publicSource(row.source), history: row.history, document: book.document };
  }
  if (command === 'route') {
    const media = classifySource(fields.source); const hint = book.routeHint(fields.source);
    return { kind: media.kind, platform: media.platform, source: publicSource(media.source),
      route: media.route,
      tingwu_evidence: hint, parser: PARSER_URL, document: book.document };
  }
  if (command === 'probe') {
    const source = classifySource(fields.source);
    if (source.kind === 'local') fail('INVALID_REQUEST', 'probe 仅验证网页或媒体直链；本地文件使用 submit');
    try {
      const result = await withBrowser(store, false, engine => engine.probe(source.source, fields.language));
      record(fields.source, 'tingwu_parse'); return { ...result, document: book.document };
    } catch (e) { record(fields.source, 'tingwu_parse', e); throw e; }
  }
  if (['resolve', 'acquire'].includes(command)) {
    const media = classifySource(fields.source);
    if (command === 'resolve' && media.kind !== 'page') fail('INVALID_REQUEST', 'resolve 用于视频网页链接；本地文件或媒体直链无需该网站');
    const job = store.create(requestId, { source: fields.source, title: fields.title || '视频解析', ...(command === 'resolve' ? { resolver_only: true } : { acquisition_only: true }) });
    const unlock = store.lock(job.job_id);
    try {
      const local = command === 'resolve' ? await resolveMedia(fields.source, job) : await acquisition.acquire(fields.source, job);
      return { ...publicJob(store.read(job.job_id), store), media_file: local.source, metadata: local.metadata, sha256: local.sha256, submitted: false, document: book.document, warnings: book.takeWarnings() };
    } catch (e) {
      e.details = { ...(e.details || {}), job_id: job.job_id, state: store.read(job.job_id).state };
      throw e;
    } finally { unlock(); }
  }
  if (command === 'catalog') return { capabilities: COMMANDS, version: VERSION };
  if (command === 'doctor') {
    let dependency = false; try { dependency = !!require('playwright-core').chromium; } catch {}
    const browser = browserPath();
    const result = { version: VERSION, node: process.version, playwright: dependency, browser,
      yt_dlp: executableOnPath('yt-dlp'), state_root: store.root,
      ffmpeg: executableOnPath('ffmpeg'), ffprobe: executableOnPath('ffprobe'), deno: executableOnPath('deno'),
      channels: { tingwu: { ready: dependency && !!browser }, local_media: { ready: !!executableOnPath('ffprobe') && !!executableOnPath('ffmpeg') },
        ...Object.fromEntries(['bilibili', 'douyin', 'xiaohongshu'].map(platform => [platform, {
          ready: dependency && !!browser && !!executableOnPath('ffprobe') && !!executableOnPath('ffmpeg'),
          acquisition: 'platform_adapter_then_yt_dlp_then_parsevideo', login: 'isolated_manual', online_verified: false
        }])),
        webpage: { ready: !!executableOnPath('yt-dlp') }, youtube: { runtime: executableOnPath('deno') || process.execPath, runtime_kind: executableOnPath('deno') ? 'deno' : 'node', runtime_available: Number(process.versions.node.split('.')[0]) >= 22 || !!executableOnPath('deno') } },
      session_saved: fs.existsSync(path.join(store.root, 'session/cookies.json')),
      preferences: store.preferences(), online_verified: false };
    if (!dependency || !browser) fail('DEPENDENCY_MISSING', '请先安装依赖或配置 Chrome', result);
    if (fields.check_login === true || fields.check_login === 'true') {
      await withBrowser(store, false, async () => {}); result.online_verified = true;
    }
    return result;
  }
  if (command === 'preferences') return store.preferences(fields.cards);
  if (command === 'unlock') { store.clearLock(fields.name || 'browser'); return { unlocked: fields.name || 'browser' }; }
  if (command === 'session-import') {
    if (!fields.source) fail('INVALID_REQUEST', 'source 必须指向本机 Cookie JSON 文件');
    const input = readJson(path.resolve(fields.source));
    if (!Array.isArray(input)) fail('INVALID_SESSION', '需要浏览器 Cookie 数组');
    const cookies = input.filter(c => c.domain === 'aliyun.com' || c.domain?.endsWith('.aliyun.com'));
    if (!cookies.length || cookies.some(c => !c.name || typeof c.value !== 'string')) fail('INVALID_SESSION', '没有有效的听悟/阿里云 Cookie');
    const unlock = store.lock('browser');
    try { atomicJson(path.join(store.root, 'session/cookies.json'), cookies); }
    finally { unlock(); }
    return { imported: true, cookie_count: cookies.length };
  }
  if (command === 'login') return withBrowser(store, true, engine => engine.login(boundedNumber(fields.wait, 180, 600)));
  if (command === 'submit') {
    let classified = classifySource(fields.source);
    if (fields.language && !['cn', 'en', 'ja', 'yue', 'mixed'].includes(fields.language)) fail('INVALID_REQUEST', 'language 应为 cn/en/ja/yue/mixed');
    const job = store.create(requestId, { source: fields.source, title: fields.title || '转写原稿', ...(fields.language ? { language: fields.language } : {}) });
    const unlock = store.lock(job.job_id);
    try {
      if (!['prepared', 'submitting', 'submission_unknown'].includes(job.state)) return publicJob(job, store);
      store.assertSubmittable(job);
      try {
        classified = await identifySource(classified.source);
        const ids = await routedSubmit(classified, {
          acquire: media => acquisition.acquire(media.source, store.read(job.job_id)),
          direct: async media => withBrowser(store, false, async engine => {
            const probe = engine.parseLink.bind(engine);
            engine.parseLink = async (...args) => {
              try { const result = await probe(...args); record(job.source, 'tingwu_parse'); return result; }
              catch (e) { record(job.source, 'tingwu_parse', e); throw e; }
            };
            return engine.submit({ ...media, kind: 'direct' }, job);
          }),
          upload: media => {
            store.update(job.job_id, { stage: 'tingwu_upload' });
            return withBrowser(store, false, engine => engine.submit(media, job));
          },
          resolve: media => resolveMedia(media.source, job),
          download: async media => {
            try { const local = await downloadMedia(media, store.jobDir(job.job_id)); record(job.source, 'download'); return local; }
            catch (e) { record(job.source, 'download', e); throw e; }
          },
          bilibili: async media => {
            try { const local = await prepareMedia(media.source, store.jobDir(job.job_id)); book.observe(job.source, 'download', 'accepted', 'B站 yt-dlp 兜底'); return local; }
            catch (e) { record(job.source, 'download', e); throw e; }
          }
        }, book.routeHint(job.source));
        const next = store.update(job.job_id, { ...ids, state: 'submitted', stage: 'transcribing', submitted_at: new Date().toISOString(), last_error: null });
        record(job.source, 'tingwu_submit');
        return { ...publicJob(next, store), warnings: book.takeWarnings() };
      } catch (e) {
        const current = store.read(job.job_id);
        if (current.state === 'submitting') store.update(job.job_id, { state: 'submission_unknown' });
        store.update(job.job_id, { last_error: errorInfo(e) });
        e.details = { ...(e.details || {}), job_id: job.job_id, state: store.read(job.job_id).state };
        throw e;
      }
    } finally { unlock(); }
  }
  if (command === 'import-result') {
    if (!fields.source) fail('INVALID_REQUEST', '需要 source 指向听悟结果 JSON');
    const segments = normalizeResult(readJson(path.resolve(fields.source)));
    const job = store.create(requestId, { source: path.resolve(fields.source), title: fields.title || '转写原稿', imported: true });
    const unlock = store.lock(job.job_id);
    try {
      if (job.artifacts.raw) { store.verifyRaw(job.job_id); return publicJob(job, store); }
      return publicJob(store.writeRaw(job.job_id, renderMarkdown(segments, job.title), segments), store);
    } finally { unlock(); }
  }
  if (command === 'attach') {
    if (!fields.trans_id || typeof fields.trans_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(fields.trans_id))
      fail('INVALID_REQUEST', '需要确切的 trans_id');
    let job;
    if (fields.job_id) job = store.read(fields.job_id);
    else job = store.create(requestId, { source: `tingwu:${fields.trans_id}`, title: fields.title || '转写原稿', attached: true });
    const unlock = store.lock(job.job_id);
    try {
      if (job.artifacts.raw) fail('RAW_EXISTS', '已有原稿的任务不能关联另一远端任务');
      const next = store.update(job.job_id, { trans_id: fields.trans_id, task_id: fields.task_id || null, state: 'submitted' });
      return publicJob(next, store);
    } finally { unlock(); }
  }
  if (['status', 'fetch'].includes(command)) {
    const unlock = store.lock(fields.job_id || 'invalid');
    try {
      let job = store.read(fields.job_id);
      if (job.artifacts.raw) {
        store.verifyRaw(job.job_id);
        if (!job.attached && !job.imported && !book.records().some(r => r.history.some(h => h.stage === 'tingwu_fetch' && h.note.includes(job.job_id))))
          book.observe(job.canonical_source || job.source, 'tingwu_fetch', 'accepted', `job_id=${job.job_id}; trans_id=${job.trans_id}; sha256=${job.raw_sha256}`);
        return publicJob(job, store);
      }
      if (!job.trans_id && !job.task_id && !job.remote_name) fail('SUBMISSION_UNKNOWN', '未持有远端任务 ID 或唯一标识，禁止查询最新任务代替');
      return await withBrowser(store, false, async engine => {
        let observed;
        try { observed = await engine.inspect(job); }
        catch (e) {
          if (command !== 'fetch' || !job.trans_id || !['NETWORK_TIMEOUT', 'API_UNAVAILABLE'].includes(e.code)) throw e;
          // Both endpoints use the same saved identity. A read failure never permits a new submit.
          const result = await engine.result(job.trans_id);
          job = store.update(job.job_id, { remote_status: result.remote_status });
          const saved = store.writeRaw(job.job_id, renderMarkdown(result.segments, job.title), result.segments);
          if (!job.attached && !job.imported) book.observe(job.canonical_source || job.source, 'tingwu_fetch', 'accepted', `job_id=${job.job_id}; trans_id=${job.trans_id}; sha256=${saved.raw_sha256}`);
          return publicJob(saved, store);
        }
        job = store.update(job.job_id, { trans_id: observed.trans_id, task_id: observed.task_id,
          remote_status: observed.remote_status });
        if (remoteState(observed.remote_status) === 'failed') {
          store.update(job.job_id, { state: 'remote_failed', stage: 'remote_failed' });
          fail('REMOTE_FAILED', '听悟任务已失败，禁止自动再次提交', { job_id: job.job_id, remote_status: observed.remote_status });
        }
        if (command === 'status') return publicJob(job, store);
        const end = Date.now() + boundedNumber(fields.wait, 0, 60) * 1000;
        while (true) {
          if (!job.trans_id) fail('RESULT_NOT_READY', '远端尚未返回 trans_id');
          try {
            const result = await engine.result(job.trans_id);
            const saved = store.writeRaw(job.job_id, renderMarkdown(result.segments, job.title), result.segments);
            if (!job.attached && !job.imported) book.observe(job.source, 'tingwu_fetch', 'accepted', `job_id=${job.job_id}; trans_id=${job.trans_id}; sha256=${saved.raw_sha256}`);
            return { ...publicJob(saved, store), warnings: book.takeWarnings() };
          } catch (e) {
            if (e.code !== 'RESULT_NOT_READY') throw e;
            if (Date.now() >= end) return { ...publicJob(job, store), ready: false, next: '稍后对同一个 job_id 再调用 fetch；不要重新 submit' };
            await new Promise(r => setTimeout(r, Math.min(3000, Math.max(1, end - Date.now()))));
          }
        }
      });
    } finally { unlock(); }
  }
  if (command === 'finalize') {
    const unlock = store.lock(fields.job_id || 'invalid');
    try {
      const job = store.verifyRaw(fields.job_id);
      if (!fields.corrected_file || !fields.summary_file) fail('INVALID_REQUEST', '必须提供 corrected_file 和 summary_file');
      const cardPolicy = fields.cards || store.preferences().cards;
      if (!['always', 'never', 'ask'].includes(cardPolicy)) fail('INVALID_PREFERENCE', 'cards 必须是 ask、always 或 never');
      if (cardPolicy === 'ask' && !fields.card_file) fail('CARD_PREFERENCE_REQUIRED', '请先询问用户是否生成本次卡片，或是否记住每次生成的偏好');
      if (cardPolicy === 'always' && !fields.card_file) fail('CARD_REQUIRED', '每次生成卡片的偏好已启用，请提供 card_file 或明确设置本次 cards=never');
      const inputs = { corrected: fields.corrected_file, summary: fields.summary_file };
      if (fields.card_file) inputs.card = fields.card_file;
      const contents = {};
      for (const [kind, file] of Object.entries(inputs)) {
        const resolved = path.resolve(file);
        if (resolved === job.artifacts.raw) fail('INVALID_ARTIFACT', 'AI 产物不能使用原稿路径');
        const content = fs.readFileSync(resolved, 'utf8');
        if (!content.trim()) fail('INVALID_ARTIFACT', 'AI 产物不能为空');
        contents[kind] = content;
      }
      const dir = path.join(store.jobDir(job.job_id), 'editions', randomUUID()); fs.mkdirSync(dir, { recursive: true });
      const artifacts = { raw: job.artifacts.raw, segments: job.artifacts.segments };
      for (const [kind, content] of Object.entries(contents)) {
        const file = path.join(dir, `${kind}.md`); fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 }); artifacts[kind] = file;
      }
      const next = store.update(job.job_id, { state: 'complete', stage: 'complete', artifacts, card_decision: fields.card_file ? 'generated' : 'not_generated' });
      return publicJob(next, store);
    } finally { unlock(); }
  }
  fail('INVALID_REQUEST', '未知 capability，请运行 catalog');
}
async function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (command === 'help' || command === '--help') {
    return { usage: 'node cli.js <doctor|catalog|invoke|命令> [--file request.json] [--state-root 私有目录]',
      commands: COMMANDS, request: { request_id: '稳定请求标识', capability: 'submit', fields: { source: '链接或媒体路径' }, target: {} } };
  }
  const store = new Store(options.state_root || process.env.VTRANS_HOME || path.join(os.homedir(), '.agent-apps/video-transcript/private'));
  let fields = options; let capability = command; let requestId = options.request_id;
  if (command === 'invoke') {
    if (!options.file) fail('INVALID_REQUEST', 'invoke 必须使用 --file JSON 文件');
    const request = readJson(path.resolve(options.file));
    if (!COMMANDS.includes(request.capability)) fail('INVALID_REQUEST', '未知 capability');
    if (!request.fields || typeof request.fields !== 'object' || Array.isArray(request.fields)) fail('INVALID_REQUEST', 'fields 必须是对象');
    if (request.target && (typeof request.target !== 'object' || Array.isArray(request.target) || Object.keys(request.target).some(k => k !== 'job_id')))
      fail('INVALID_REQUEST', 'target 仅接受 job_id');
    fields = { ...request.fields, ...(request.target || {}) }; capability = request.capability; requestId = request.request_id;
  }
  return execute(capability, fields, store, requestId);
}
if (require.main === module) main().then(data => {
  process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
}).catch(e => {
  const code = e.code || 'INTERNAL_ERROR';
  // Playwright/OS errors can contain private page text, URLs or credentials.
  const message = e.constructor.name === 'AppError' ? e.message :
    ({ ENOENT: '文件或可执行程序不存在', DOWNLOAD_FAILED: '媒体下载失败', DOWNLOAD_TIMEOUT: '媒体下载超时' }[code] || '执行失败；请检查 doctor、登录态或页面是否改版');
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message, details: e.details || {} } }) + '\n');
  process.exitCode = ({ LOGIN_REQUIRED: 3, BUSY: 4, SUBMISSION_UNKNOWN: 5, UPLOAD_PENDING: 6 }[code] || 1);
});
module.exports = { execute, publicJob, parse };
