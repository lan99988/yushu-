const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateSource, hash, fail } = require('./core');
const { Store, readJson, atomicJson } = require('./store');
const PARSER_URL = 'https://pv.vlogdownloader.com/';
const PLATFORMS = [
  { id: 'bilibili', name: 'B站', domains: ['bilibili.com', 'b23.tv'], example: 'https://www.bilibili.com/video/BV1GJ411x7h7/' },
  { id: 'youtube', name: 'YouTube', domains: ['youtube.com', 'youtu.be'], example: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
  { id: 'douyin', name: '抖音', domains: ['douyin.com', 'iesdouyin.com'] },
  { id: 'kuaishou', name: '快手', domains: ['kuaishou.com', 'gifshow.com'] },
  { id: 'xiaohongshu', name: '小红书', domains: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn'] },
  { id: 'tiktok', name: 'TikTok', domains: ['tiktok.com'] },
  { id: 'vimeo', name: 'Vimeo', domains: ['vimeo.com'] },
  { id: 'weibo', name: '微博', domains: ['weibo.com', 'weibo.cn'] },
  { id: 'tencent', name: '腾讯视频', domains: ['v.qq.com'] },
  { id: 'iqiyi', name: '爱奇艺', domains: ['iqiyi.com', 'iq.com'] },
  { id: 'youku', name: '优酷', domains: ['youku.com'] },
  { id: 'xigua', name: '西瓜视频', domains: ['ixigua.com'] },
  { id: 'wechat', name: '微信视频号', domains: ['weixin.qq.com'] },
  { id: 'x', name: 'X', domains: ['x.com', 'twitter.com', 't.co'] }
];
function normalizeSourceInput(input, platform) {
  if (typeof input !== 'string' || !input.trim()) fail('INVALID_SOURCE', '缺少视频链接或文件');
  const value = input.trim();
  if (fs.existsSync(value)) return path.resolve(value);
  const urls = [...value.matchAll(/https?:\/\/[^\s<>"'“”]+/gi)].map(m => m[0].replace(/[，。；！？、）)\]】]+$/, ''));
  if (urls.length > 1) fail('MULTIPLE_SOURCES', '一次只能处理单条视频链接');
  if (urls.length === 1) return urls[0];
  if (/^BV[a-zA-Z0-9]{10}$/.test(value)) return `https://www.bilibili.com/video/${value}/`;
  if (/^av\d+$/i.test(value)) return `https://www.bilibili.com/video/${value}/`;
  const tagged = value.match(/^([a-z_]+):([\w-]+)$/i);
  const site = platform || tagged?.[1]?.toLowerCase(); const id = tagged?.[2] || value;
  const formats = {
    youtube: x => `https://www.youtube.com/watch?v=${x}`, douyin: x => `https://www.douyin.com/video/${x}`,
    kuaishou: x => `https://www.kuaishou.com/short-video/${x}`, xiaohongshu: x => `https://www.xiaohongshu.com/explore/${x}`,
    tencent: x => `https://v.qq.com/x/page/${x}.html`, youku: x => `https://v.youku.com/v_show/id_${x}.html`,
    xigua: x => `https://www.ixigua.com/${x}`, weibo: x => `https://weibo.com/tv/show/${x}`
  };
  if (formats[site] && /^[\w-]+$/.test(id)) return formats[site](id);
  return value;
}
function contentIdentity(source) {
  const normalized = normalizeSourceInput(source);
  if (!/^https?:/i.test(normalized)) return `local:${hash(path.resolve(normalized))}`;
  const u = new URL(normalized); const host = u.hostname.toLowerCase();
  const matchHost = domain => host === domain || host.endsWith('.' + domain);
  const platform = PLATFORMS.find(p => p.domains.some(matchHost))?.id || 'unknown';
  let id;
  if (platform === 'bilibili') {
    id = u.pathname.match(/\/(BV\w+|av\d+)(?:\/|$)/i)?.[1];
    const part = u.searchParams.get('p');
    if (part !== null && !/^[1-9]\d*$/.test(part)) fail('INVALID_SOURCE', 'B站分P必须是正整数');
    // Preserve the legacy identity for P1, but never merge evidence from other parts.
    if (id && part && Number(part) > 1) id += ':p' + part;
  }
  if (platform === 'youtube') id = matchHost('youtu.be') ? u.pathname.split('/')[1] : u.searchParams.get('v') || u.pathname.match(/\/(?:shorts|embed)\/([\w-]+)/)?.[1];
  if (platform === 'douyin') id = u.pathname.match(/\/(?:video|note)\/(\d+)/)?.[1] || u.searchParams.get('modal_id') || u.searchParams.get('vid');
  if (platform === 'kuaishou') id = u.pathname.match(/\/short-video\/([\w-]+)/)?.[1] || u.searchParams.get('photoId');
  if (platform === 'xiaohongshu') id = u.pathname.match(/\/(?:explore|item)\/([\w-]+)/)?.[1];
  if (platform === 'tencent') id = u.pathname.match(/\/([\w-]+)\.html$/)?.[1] || u.searchParams.get('vid');
  if (platform === 'iqiyi') id = u.pathname.match(/\/(v_[\w-]+)\.html$/)?.[1];
  if (platform === 'youku') id = u.pathname.match(/\/id_([\w=+-]+)\.html$/)?.[1];
  if (platform === 'xigua') id = u.pathname.match(/\/(\d+)(?:\/|$)/)?.[1];
  if (platform === 'x') id = u.pathname.match(/\/status\/(\d+)/)?.[1];
  if (platform === 'weibo') id = u.pathname.match(/\/(?:status|detail)\/(\d+)/)?.[1] || u.pathname.match(/\/tv\/show\/([\w:]+)/)?.[1] || u.pathname.match(/^\/\d+\/([\w]+)$/)?.[1];
  if (platform === 'wechat') id = u.pathname.match(/\/sph\/([\w-]+)/)?.[1] || u.searchParams.get('id') || u.searchParams.get('exportId');
  // Unknown URLs retain all access parameters in their private identity: do not merge signed resources speculatively.
  return id ? `${platform}:${id}` : `url:${hash(normalized)}`;
}
function classifySource(source) {
  source = normalizeSourceInput(source);
  const media = validateSource(source, true);
  if (media.kind === 'local') return { ...media, platform: 'local', route: 'local_upload' };
  const hostname = new URL(source).hostname;
  const platform = PLATFORMS.find(p => p.domains.some(d => hostname === d || hostname.endsWith('.' + d)));
  const mime = new URL(source).searchParams.get('mime') || '';
  const kind = /^(audio|video)\//i.test(mime) || /\.m3u8$/i.test(new URL(source).pathname) ? 'direct' : media.kind === 'bilibili' ? 'page' : media.kind;
  return { ...media, kind,
    platform: platform?.id || 'unknown', route: kind === 'direct' ? 'tingwu_direct' : 'local_acquire_then_upload' };
}
function publicSource(source) {
  if (!/^https?:/.test(source)) return `本地文件：${path.basename(source)}`;
  const u = new URL(source); const v = u.searchParams.get('v');
  if (/\/(?:expire|sig|signature|spc|token|key)\//i.test(u.pathname)) return u.origin + '/[签名媒体路径已隐藏]';
  const hadQuery = !!u.search; u.search = ''; u.hash = '';
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(u.hostname) && v) u.searchParams.set('v', v);
  return u.href + (hadQuery && !v ? '（其他查询参数已隐藏）' : '');
}
class SourceBook {
  constructor(root) {
    this.warnings = [];
    this.store = new Store(root); this.file = path.join(this.store.root, 'source-observations.json');
    const configFile = path.join(this.store.root, 'config.json');
    const config = fs.existsSync(configFile) ? readJson(configFile) : {};
    this.document = process.env.VTRANS_SOURCE_BOOK || config.source_book || path.join(this.store.root, '视频网站链接与听悟适配记录.md');
  }
  records() { return fs.existsSync(this.file) ? readJson(this.file) : []; }
  rowIdentity(row) { return contentIdentity(row.canonical_source || row.source); }
  takeWarnings() { const warnings = this.warnings; this.warnings = []; return warnings; }
  evidenceLock() {
    const until = Date.now() + 5000;
    while (true) {
      try { return this.store.lock('source-book'); }
      catch (e) {
        // Windows may transiently report access denied while another process's
        // completed lock deletion is still pending. Retry acquisition only;
        // never delete, replace or steal another process's lock.
        if (!['BUSY', 'EPERM', 'EACCES'].includes(e.code) || Date.now() >= until) throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }
  findRow(rows, source) {
    const canonical = contentIdentity(source);
    return rows.find(r => this.rowIdentity(r) === canonical || contentIdentity(r.source) === canonical ||
      r.source === normalizeSourceInput(source) || (r.sources || []).includes(normalizeSourceInput(source)));
  }
  alias(original, final) {
    original = normalizeSourceInput(original); final = normalizeSourceInput(final);
    const media = classifySource(final); classifySource(original);
    const unlock = this.evidenceLock();
    try {
      const rows = this.records(); const canonical = contentIdentity(final);
      const matched = rows.filter(r => this.rowIdentity(r) === canonical || contentIdentity(r.source) === canonical ||
        r.source === original || r.source === final || (r.sources || []).some(s => s === original || s === final));
      let row = matched[0];
      if (!row) { row = { id: hash(original), source: original, platform: media.platform, history: [] }; rows.push(row); }
      const sources = new Set([original, final]);
      for (const item of matched) for (const source of [item.source, ...(item.sources || [])]) sources.add(source);
      const history = matched.flatMap(item => item.history || []);
      // Keep every historical observation (even identical ones from separate tests),
      // while repeated alias calls remain idempotent after rows have been merged.
      row.history = history.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      row.sources = [...sources]; row.canonical_id = canonical; row.platform = media.platform;
      row.canonical_source = final;
      const merged = rows.filter(item => item === row || !matched.includes(item));
      atomicJson(this.file, merged); this.writeDocumentUnlocked(); return row;
    } finally { unlock(); }
  }
  collect(source) {
    source = normalizeSourceInput(source);
    const media = classifySource(source);
    const unlock = this.evidenceLock();
    try {
      const rows = this.records(); const id = hash(source);
      let row = this.findRow(rows, source);
      if (!row) { row = { id, source, canonical_id: contentIdentity(source), platform: media.platform, history: [] }; rows.push(row); }
      row.canonical_id = this.rowIdentity(row); row.sources = [...new Set([...(row.sources || [row.source]), source])];
      atomicJson(this.file, rows);
      this.writeDocumentUnlocked(); return row;
    } finally { unlock(); }
  }
  observe(source, stage, outcome, note = '') {
    source = normalizeSourceInput(source);
    const stages = ['tingwu_parse', 'parser_parse', 'download', 'media_validate', 'tingwu_submit', 'tingwu_fetch', 'yuanbao_parse', 'yt_dlp', 'platform_parse'];
    if (!stages.includes(stage) || !['accepted', 'unsupported', 'failed', 'error'].includes(outcome))
      fail('INVALID_OBSERVATION', '未知验证阶段或结果');
    classifySource(source);
    const unlock = this.evidenceLock();
    try {
      const rows = this.records(); const id = hash(source);
      let row = this.findRow(rows, source);
      if (!row) { row = { id, source, canonical_id: contentIdentity(source), platform: classifySource(source).platform, history: [] }; rows.push(row); }
      row.canonical_id = this.rowIdentity(row); row.sources = [...new Set([...(row.sources || [row.source]), source])];
      row.history.push({ stage, outcome, note: String(note).replace(/https?:\/\/\S+/g, '[链接]').slice(0, 500), at: new Date().toISOString() });
      atomicJson(this.file, rows);
      this.writeDocumentUnlocked(); return row;
    } finally { unlock(); }
  }
  routeHint(source) {
    source = normalizeSourceInput(source);
    const row = this.findRow(this.records(), source);
    const canonical = row ? this.rowIdentity(row) : contentIdentity(source);
    const history = this.records().filter(r => r === row || this.rowIdentity(r) === canonical || contentIdentity(r.source) === canonical)
      .flatMap(r => r.history || []).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const last = history.filter(r => r.stage === 'tingwu_parse').at(-1);
    if (!last || Date.now() - Date.parse(last.at) > 7 * 86400000) return 'unknown';
    return ['accepted', 'unsupported'].includes(last.outcome) ? last.outcome : 'unknown';
  }
  render() {
    const labels = { accepted: '接受', unsupported: '明确不支持', failed: '失败', error: '错误/未知' };
    const esc = value => String(value || '').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
    let text = `# 视频网站链接与听悟适配记录\n\n解析网站：[ParseVideo](${PARSER_URL})。本文件由 video-transcript 插件维护，追加证据请用 source-record；直接修改本表不会改变机器分流规则。\n\n`;
    text += '自动流程：媒体直链先交听悟；B站、抖音、小红书视频网页先使用精确平台适配，再尝试 yt-dlp，ParseVideo 作为最后兜底。取得媒体后验证音轨、时长与容器，再上传听悟。登录、验证码、限流及身份不符时停止；已提交或提交结果未知时禁止换渠道重提。\n\n';
    text += '同一链接7天内明确不支持听悟直接解析时，后续跳过该步；7天后重新验证。每条证据仅适用于该链接，不能推广到整个平台。解析网站失败也不能证明该平台始终不可解析。\n\n';
    text += '## 平台收集清单\n\n| 平台 | 识别域名 | 示例/待收集 | 听悟能否直接使用 | 默认处理 |\n|---|---|---|---|---|\n';
    for (const p of PLATFORMS) text += `| ${p.name} | ${p.domains.join('、')} | ${p.example || '等待实际视频链接'} | 逐链接验证，不预设支持 | ${p.id === 'wechat' ? '元宝解析媒体→下载→听悟' : '本机下载→必要时平台适配/ParseVideo→听悟'} |\n`;
    text += '\n## 实际链接验证记录\n\n| 链接 | 平台 | 阶段 | 结果 | 验证时间（UTC） | 说明 |\n|---|---|---|---|---|---|\n';
    const stages = { tingwu_parse: '听悟直接解析', parser_parse: '网站解析', download: '本机下载', media_validate: '媒体验证', tingwu_submit: '听悟提交（尚需取稿）', tingwu_fetch: '完成取稿', yuanbao_parse: '元宝媒体解析', yt_dlp: 'yt-dlp 下载', platform_parse: '平台适配' };
    for (const row of this.records()) {
      if (!row.history.length) text += `| ${esc(publicSource(row.source))} | ${row.platform} | 待验证 | 未验证 | — | 已收集链接，未进行在线测试 |\n`;
      for (const h of row.history) text += `| ${esc(publicSource(row.source))} | ${row.platform} | ${stages[h.stage]} | ${labels[h.outcome]} | ${h.at} | ${esc(h.note)} |\n`;
    }
    text += '\n媒体直链被接受解析不等于已经完成转写；完成取稿仍需确认远端状态及正文。签名查询参数不写入文档，完整输入只保存在本机私有任务记录。\n';
    return text;
  }
  writeDocument() {
    const unlock = this.evidenceLock();
    try { return this.writeDocumentUnlocked(); } finally { unlock(); }
  }
  writeDocumentUnlocked() {
    const tmp = `${this.document}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.document), { recursive: true });
      fs.writeFileSync(tmp, this.render(), { mode: 0o600 }); fs.renameSync(tmp, this.document);
      return this.document;
    } catch (_) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
      this.warnings.push({ code: 'SOURCE_DOCUMENT_FAILED', message: '适配证据已保存，Markdown 文档生成失败；可用 sources 重建。' });
      return null;
    }
  }
}
async function runRoutedSubmission(media, services, hint = 'unknown') {
  return require('./acquisition').runRoutedSubmission(media, services, hint);
}
module.exports = { PARSER_URL, PLATFORMS, normalizeSourceInput, contentIdentity, classifySource, publicSource, SourceBook, runRoutedSubmission };
