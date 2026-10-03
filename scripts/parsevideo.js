const { fail, validateSource } = require('./core');
const { PARSER_URL } = require('./routing');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rankCandidates(candidates) {
  const eligible = [];
  for (const candidate of candidates) {
    try { validateSource(candidate.url, true); } catch { continue; }
    const u = new URL(candidate.url);
    if (u.hostname === new URL(PARSER_URL).hostname) continue;
    const mime = u.searchParams.get('mime') || '';
    const label = candidate.label || '';
    const isAudio = /^audio\//i.test(mime) || /audio only|音频|纯音频/i.test(label);
    const hls = /\.m3u8(?:$|\?)/i.test(candidate.url);
    const extension = u.pathname.match(/\.(m4a|mp3|mp4|wav|aac|ogg|webm|flac|flv|m3u8)$/i)?.[1];
    // Silent DASH video representations must not be sent to a transcription engine.
    if (/video only|纯视频/i.test(label) && !isAudio) continue;
    if (!isAudio && !extension && !/^video\//i.test(mime) && !/视频|video|下载/i.test(label)) continue;
    let score = isAudio ? 100 : 0;
    if (/m4a|mp3/.test(extension || '') || mime === 'audio/mp4' || mime === 'audio/mpeg') score += 30;
    if (hls) score -= 60;
    if (/DRC/i.test(label)) score -= 10;
    if (/medium|high/i.test(label)) score += 5;
    eligible.push({ ...candidate, score, hls, mime });
  }
  eligible.sort((a, b) => b.score - a.score);
  if (!eligible.length) fail('RESOLVER_NO_MEDIA', '解析网站没有返回可确认的音频或带声音媒体链接');
  return eligible;
}
function selectCandidate(candidates) { return rankCandidates(candidates)[0]; }
function expiryOf(url) {
  const u = new URL(url);
  const biliDeadline = (u.hostname === 'bilivideo.com' || u.hostname.endsWith('.bilivideo.com')) ? u.searchParams.get('deadline') : null;
  const value = u.searchParams.get('expire') || u.searchParams.get('expires') || biliDeadline || u.pathname.match(/\/expire\/(\d+)/)?.[1];
  if (!value || !/^\d{10,13}$/.test(value)) return null;
  const time = Number(value) * (value.length === 13 ? 1 : 1000);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
class ParseVideo {
  constructor(store, book) { this.store = store; this.book = book; }
  async resolve(source, job, { refresh = false } = {}) {
    const cached = this.store.read(job.job_id).resolver_attempt;
    if (cached?.state === 'resolved' && !refresh) return cached.media;
    if (refresh && cached?.state !== 'resolved') fail('RESOLVER_UNKNOWN', '仅允许刷新已确认成功的过期媒体解析');
    if (cached?.state === 'failed') fail(cached.code === 'RESOLVER_UNAVAILABLE' ? 'RESOLVER_UNKNOWN' : cached.code || 'RESOLVER_FAILED', '本任务此前已解析失败或结果未知，不自动重复消耗网站额度');
    if (cached?.state === 'started') fail('RESOLVER_UNKNOWN', '上次解析结果未知，请人工确认；不自动再次解析');
    const unlock = this.store.lock('resolver'); let browser;
    try {
      const { chromium } = require('playwright-core');
      const executablePath = require('./tingwu').browserPath();
      browser = await chromium.launch({ executablePath, headless: true });
      // Anonymous isolated context: never inject Tingwu cookies into a third-party site.
      const context = await browser.newContext(); const page = await context.newPage();
      await page.goto(PARSER_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const input = page.locator('#url'); await input.waitFor({ timeout: 15000 }); await input.fill(source);
      this.store.update(job.job_id, { resolver_attempt: { state: 'started', provider: PARSER_URL, at: new Date().toISOString() } });
      await page.getByRole('button', { name: '开始解析', exact: true }).click();
      const end = Date.now() + 60000;
      while (Date.now() < end) {
        const candidates = await page.evaluate(() => Array.from(document.querySelectorAll('#results_list .btn-download'))
          .map(a => ({ url: a.href, label: a.parentElement?.parentElement?.innerText || '' })).filter(a => /^https?:/.test(a.url)));
        if (candidates.length) {
          const ranked = rankCandidates(candidates);
          const chosen = ranked[0];
          const media = { kind: 'resolved', source: chosen.url, referer: source, hls: chosen.hls, mime: chosen.mime,
            candidates: ranked.map(c => ({ ...c, referer: source, expires_at: expiryOf(c.url) })),
            acquired_at: new Date().toISOString(), expires_at: expiryOf(chosen.url), provider: 'parsevideo' };
          this.store.update(job.job_id, { resolver_attempt: { state: 'resolved', provider: PARSER_URL, media, at: new Date().toISOString() } });
          this.book.observe(source, 'parser_parse', 'accepted', 'ParseVideo 返回可确认的媒体地址；下载和听悟使用需另行验证');
          return media;
        }
        const text = await page.locator('#results').innerText().catch(() => '');
        if (/次数|额度|VIP|会员|登录|验证码/i.test(text)) fail('RESOLVER_QUOTA', '解析网站要求登录、验证码或已到额度限制');
        if (/解析失败|不支持|错误|失败/.test(text)) fail('RESOLVER_FAILED', '解析网站未能解析这条链接');
        await sleep(1000);
      }
      fail('RESOLVER_UNAVAILABLE', '解析网站超时；尚未取得可用媒体链接');
    } catch (e) {
      const state = this.store.read(job.job_id).resolver_attempt?.state;
      const code = state === 'started' && (!e.code?.startsWith('RESOLVER_') || e.code === 'RESOLVER_UNAVAILABLE') ? 'RESOLVER_UNKNOWN' : e.code?.startsWith('RESOLVER_') ? e.code : 'RESOLVER_UNAVAILABLE';
      if (state === 'started') this.store.update(job.job_id, { resolver_attempt: { state: 'failed', provider: PARSER_URL, code, at: new Date().toISOString() } });
      this.book.observe(source, 'parser_parse', 'failed', code);
      if (e.code === code) throw e;
      fail(code, code === 'RESOLVER_UNKNOWN' ? '解析请求已发出但结果未知，禁止自动再消耗额度' : '解析网站暂不可用或界面已改变');
    } finally { if (browser) await browser.close(); unlock(); }
  }
}
module.exports = { ParseVideo, selectCandidate, rankCandidates, expiryOf };
