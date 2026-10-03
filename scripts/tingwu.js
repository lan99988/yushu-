const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail, checkApi, normalizeList, normalizeResult, findTask, remoteState } = require('./core');
const { atomicJson, readJson } = require('./store');
const { executableOnPath } = require('./media');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function browserPath(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  const onPath = options.onPath || executableOnPath;
  if (env.VTRANS_CHROME) {
    if (!fs.existsSync(env.VTRANS_CHROME)) fail('BROWSER_MISSING', 'VTRANS_CHROME 指向的文件不存在');
    return env.VTRANS_CHROME;
  }
  const folder = path.join(home, '.agent-browser', 'browsers');
  const candidates = fs.existsSync(folder) ? fs.readdirSync(folder).filter(n => /^chrome-/.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map(n => path.join(folder, n, 'chrome.exe')) : [];
  if (platform === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(root, 'Google/Chrome/Application/chrome.exe'),
        path.join(root, 'Microsoft/Edge/Application/msedge.exe'));
    }
  }
  if (platform === 'darwin') {
    for (const root of [options.applications || '/Applications', path.join(home, 'Applications')]) {
      candidates.push(path.join(root, 'Google Chrome.app/Contents/MacOS/Google Chrome'),
        path.join(root, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
    }
  }
  candidates.push(onPath('google-chrome'), onPath('google-chrome-stable'), onPath('chromium'),
    onPath('chromium-browser'), onPath('microsoft-edge'));
  return candidates.find(p => p && fs.existsSync(p)) || null;
}
class Tingwu {
  constructor(store) { this.store = store; this.privateDir = path.join(store.root, 'session'); }
  async open(interactive = false) {
    this.unlock = this.store.lock('browser');
    try {
      const executablePath = browserPath();
      if (!executablePath) fail('BROWSER_MISSING', '未找到 Chrome，请设置 VTRANS_CHROME');
      fs.mkdirSync(this.privateDir, { recursive: true });
      const { chromium } = require('playwright-core');
      this.context = await chromium.launchPersistentContext(path.join(this.privateDir, 'profile'), {
        executablePath, headless: !interactive, viewport: { width: 1280, height: 900 } });
      this.page = this.context.pages()[0] || await this.context.newPage();
      this.page.setDefaultTimeout(15000);
      const cookies = path.join(this.privateDir, 'cookies.json');
      if (fs.existsSync(cookies)) {
        await this.context.clearCookies(); await this.context.addCookies(readJson(cookies));
      }
      await this.page.goto('https://tingwu.aliyun.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.page.getByText('上传音视频', { exact: true }).first().waitFor({ timeout: 20000 });
      if (!await this.loggedIn()) {
        if (!interactive) fail('LOGIN_REQUIRED', '听悟登录过期，请运行 login 在浏览器中人工登录');
      } else await this.saveSession();
      return this;
    } catch (e) { await this.close(); throw e; }
  }
  async loggedIn() {
    return !await this.page.getByText('立即登录', { exact: true }).first().isVisible().catch(() => false) &&
      await this.page.getByText('上传音视频', { exact: true }).first().isVisible().catch(() => false);
  }
  async login(seconds = 180) {
    if (await this.loggedIn()) return { logged_in: true };
    await this.page.getByText('立即登录', { exact: true }).first().click();
    process.stderr.write('请在弹出的听悟浏览器窗口中完成登录、验证码或滑块；脚本不收集账号密码。\n');
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) {
      if (await this.loggedIn()) { await this.saveSession(); return { logged_in: true }; }
      await sleep(1000);
    }
    fail('LOGIN_REQUIRED', '等待人工登录超时，请重新运行 login');
  }
  async saveSession() { atomicJson(path.join(this.privateDir, 'cookies.json'), await this.context.cookies()); }
  async close() {
    try { if (this.context) await this.context.close(); }
    finally { this.context = null; if (this.unlock) { this.unlock(); this.unlock = null; } }
  }
  async api(endpoint, body) {
    const response = await this.page.evaluate(async ({ endpoint, body }) => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: controller.signal });
        const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
        return { status: r.status, data };
      } finally { clearTimeout(timer); }
    }, { endpoint, body }).catch(() => fail('NETWORK_TIMEOUT', '听悟查询接口网络失败或超时；恢复时只查询已有任务'));
    if ([401, 403].includes(response.status)) fail('LOGIN_REQUIRED', '听悟会话已失效');
    if (response.status !== 200 || !response.data) fail('API_UNAVAILABLE', '听悟接口暂不可用');
    checkApi(response.data); return response.data;
  }
  async list(showName = '') {
    const all = [];
    for (let pageNo = 1; pageNo <= 20; pageNo++) {
      const response = await this.api('/api/trans/request?getTransList&c=web', {
        action: 'getTransList', version: '1.0', userId: '',
        filter: { status: [0, 1, 2, 3, 4, 5, 11, 20, 21, 22], fileTypes: [], beginTime: '', endTime: '', showName, read: '', lang: '', shareUserId: '', client: '' },
        preview: 1, pageNo, pageSize: 100 });
      const rows = normalizeList(response); all.push(...rows);
      if (rows.length < 100) break;
    }
    return all;
  }
  async inspect(job) {
    if (!job.trans_id && !job.task_id && job.remote_name) {
      const row = await this.resolveByMarker(job.remote_name);
      if (!row) fail('REMOTE_TASK_NOT_FOUND', '尚未找到带本次唯一标识的转写任务，稍后查询或人工检查');
      return { row, remote_status: row.status, trans_id: row.transId, task_id: row.taskId };
    }
    const response = await this.api('/api/trans/request?getTransStatus&c=web', {
      action: 'getTransStatus', version: '1.0', userId: '', preview: 1,
      transIds: job.trans_id ? [job.trans_id] : [], taskIds: job.task_id ? [job.task_id] : [] });
    const row = findTask(normalizeList(response), job);
    if (!row) fail('REMOTE_TASK_NOT_FOUND', '未找到确切任务，请检查账号或 attach trans_id');
    return { row, remote_status: row.status, trans_id: row.transId || job.trans_id, task_id: row.taskId || job.task_id };
  }
  async resolveByMarker(name) {
    const rows = (await this.list(name)).filter(r => r.tag?.showName === name && r.tag?.fileType === 'net_source');
    if (rows.length > 1) fail('AMBIGUOUS_TASK', '唯一标识出现多个任务，请人工确认 trans_id');
    return rows[0] || null;
  }
  async result(transId) {
    const r = await this.api('/api/trans/getTransResult?c=web', { action: 'getTransResult', version: '1.0', transId });
    // Status 0 is completed in both the real successful fixture and live getTransStatus.
    // Do not interpret unfamiliar numbers as success, even when a partial result exists.
    if (remoteState(r.data?.status) === 'failed') fail('REMOTE_FAILED', '听悟转写或上传失败', { remote_status: r.data.status });
    if (r.data?.status !== 0) fail('RESULT_NOT_READY', '尚未确认转写完成', { remote_status: r.data?.status ?? null });
    return { segments: normalizeResult(r), remote_status: r.data?.status };
  }
  async captureSubmit(action) {
    // Capture only the exact mutation response, never unrelated list rows or signed URLs.
    const response = await this.page.waitForResponse(async r => {
      if (new URL(r.url()).hostname !== 'tingwu.aliyun.com') return false;
      try { return r.request().postDataJSON()?.action === action; } catch { return false; }
    }, { timeout: action === 'syncPutLink' ? 300000 : 90000 });
    const payload = await response.json(); checkApi(payload);
    return payload.data;
  }
  async submit(media, job) {
    const marker = `vtrans-${job.job_id.slice(3)}-${crypto.randomBytes(4).toString('hex')}`;
    if (media.kind === 'direct') return this.submitLink(media.source, job, marker);
    return this.submitFile(media.source, job, marker);
  }
  async configureLanguage(scope, language) {
    const names = { cn: '中文', en: '英语', ja: '日语', yue: '粤语', mixed: '中英文自由说' };
    if (language) await scope.getByText(names[language], { exact: true }).click();
  }
  async submitFile(file, job, marker) {
    await this.page.getByText('上传音视频', { exact: true }).first().click();
    await this.page.getByText('上传本地音视频文件', { exact: true }).first().click();
    const dialog = this.page.locator('[role=dialog]:visible').last();
    if (job.language) await this.configureLanguage(dialog, job.language);
    const input = this.page.locator('input[type=file]').first();
    await input.waitFor({ state: 'attached' });
    // Unique basename helps human recovery; no shared media path across jobs.
    const renamed = path.join(this.store.jobDir(job.job_id), marker + path.extname(file));
    fs.copyFileSync(file, renamed, fs.constants.COPYFILE_EXCL);
    this.store.update(job.job_id, { state: 'submitting', submission_marker: marker });
    const captured = this.captureSubmit('generatePutLink').catch(() => null);
    const synced = this.captureSubmit('syncPutLink').then(data => ({ received: true, data })).catch(() => null);
    await input.setInputFiles(renamed);
    // Some versions start uploading when selecting a file; others need this button once.
    const start = this.page.getByRole('button', { name: '开始转写', exact: true }).first();
    await sleep(1000);
    if (await start.isVisible().catch(() => false)) await start.click();
    const data = await captured;
    if (!data?.transId) fail('SUBMISSION_UNKNOWN', '上传响应未返回 transId；请人工检查，禁止重复上传');
    // generatePutLink identifies the upload, not its completion; persist identity immediately.
    this.store.update(job.job_id, { trans_id: data.transId, task_id: data.taskId || null, state: 'uploading' });
    const confirmation = await synced;
    if (!confirmation) fail('UPLOAD_PENDING', '上传任务 ID 已保存，但未确认 syncPutLink；先 status，不重复提交');
    return { trans_id: data.transId, task_id: data.taskId || null };
  }
  async parseLink(url, language) {
    await this.page.getByText('播客链接转写', { exact: true }).first().click();
    // Scope to a visible dialog to avoid filling the search input on the home page.
    const dialogs = this.page.locator('[role=dialog]:visible');
    await dialogs.last().waitFor({ state: 'visible' });
    const scope = dialogs.last();
    if (language) await this.configureLanguage(scope, language);
    const inputs = scope.locator('input:visible, textarea:visible');
    const count = await inputs.count(); let chosen = null;
    for (let i = 0; i < count; i++) {
      const item = inputs.nth(i); const placeholder = await item.getAttribute('placeholder') || '';
      if (/RSS|链接|url|输入/i.test(placeholder) && !/搜索/.test(placeholder)) { chosen = item; break; }
    }
    if (!chosen && count === 1) chosen = inputs.first();
    if (!chosen) fail('UI_CHANGED', '未找到唯一媒体链接输入框；页面可能改版');
    await chosen.fill(url);
    await scope.getByText('开始解析', { exact: true }).click();
    const start = scope.getByRole('button', { name: '开始转写', exact: true });
    const parsedUntil = Date.now() + 90000;
    while (true) {
      const text = await scope.innerText();
      if (/解析失败|暂不支持|不支持该|链接无效|无法解析|源内容不含音频/.test(text)) fail('PARSE_FAILED', '听悟无法解析此直链，请提供其他媒体直链或本地文件');
      if (/验证码|验证身份|访问频繁|额度不足/.test(text)) fail('INTERACTION_REQUIRED', '听悟需要人工验证或额度检查');
      if (await start.isVisible().catch(() => false) && await start.isEnabled().catch(() => false)) break;
      if (Date.now() >= parsedUntil) fail('PARSE_NOT_READY', '听悟未完成媒体解析，尚未提交转写', { submitted: false });
      await sleep(1000);
    }
    return { scope, start };
  }
  async probe(url, language) {
    await this.parseLink(url, language);
    return { accepted: true, submitted: false };
  }
  async submitLink(url, job, marker) {
    const { start } = await this.parseLink(url, job.language);
    const remoteName = `${String(job.title).slice(0, 80)} [${marker}]`;
    // putNetSourceUrl returns an empty data array in the live frontend. Inject a unique
    // showName into this one request so identity recovery uses exact equality, not recency.
    const routeHandler = async route => {
      let request; try { request = route.request().postDataJSON(); } catch { return route.continue(); }
      if (request?.action !== 'putNetSourceUrl') return route.continue();
      if (!Array.isArray(request.files) || request.files.length !== 1) return route.abort();
      request.files[0].tag = { ...request.files[0].tag, showName: remoteName };
      return route.continue({ postData: JSON.stringify(request) });
    };
    await this.page.route('**/api/trans/request**', routeHandler);
    const captured = this.page.waitForResponse(r => {
      if (new URL(r.url()).hostname !== 'tingwu.aliyun.com') return false;
      try { return r.request().postDataJSON()?.action === 'putNetSourceUrl'; } catch { return false; }
    }, { timeout: 45000 }).catch(() => null);
    this.store.update(job.job_id, { state: 'submitting', submission_marker: marker, remote_name: remoteName });
    let response;
    try { await start.click(); response = await captured; }
    finally { await this.page.unroute('**/api/trans/request**', routeHandler); }
    if (!response) fail('SUBMISSION_UNKNOWN', '未确认 putNetSourceUrl 响应，请人工检查后 attach');
    const payload = await response.json(); checkApi(payload);
    // Store field structure only for adapting changed response shapes, never response values.
    const shape = (value, depth = 0) => depth > 5 ? typeof value : Array.isArray(value) ?
      { count: value.length, first: value.length ? shape(value[0], depth + 1) : null } :
      value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shape(v, depth + 1)])) : typeof value;
    atomicJson(path.join(this.store.jobDir(job.job_id), 'submit-response-shape.json'), shape(payload));
    const files = response.request().postDataJSON()?.files;
    // The live frontend passes each parsed media fileId to putNetSourceUrl.
    // Do not choose one when an RSS feed selected several episodes.
    if (!Array.isArray(files) || files.length !== 1 || !files[0].fileId)
      fail('SUBMISSION_UNKNOWN', '本次没有唯一的媒体 fileId，不能代取最新任务');
    this.store.update(job.job_id, { state: 'submitted' });
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const row = await this.resolveByMarker(remoteName);
      if (row) return { trans_id: row.transId || null, task_id: row.taskId || null, remote_status: row.status };
      await sleep(1000);
    }
    // Keep the exact marker so a later status call can recover, without creating a new task.
    return { trans_id: null, task_id: null };
  }
}
module.exports = { Tingwu, browserPath };
