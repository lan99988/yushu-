const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { fail, hash } = require('./core');
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
class Store {
  constructor(root) { this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true }); }
  jobDir(id) {
    if (!/^vt-[a-f0-9]{24}$/.test(id)) fail('INVALID_JOB', '无效 job_id');
    return path.join(this.root, 'jobs', id);
  }
  read(id) {
    const file = path.join(this.jobDir(id), 'job.json');
    if (!fs.existsSync(file)) fail('JOB_NOT_FOUND', '本地任务不存在');
    this.recoverRaw(id);
    return readJson(file);
  }
  create(requestId, fields) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 256)
      fail('INVALID_REQUEST', '提交必须有稳定 request_id');
    const id = 'vt-' + hash(requestId).slice(0, 24);
    const unlock = this.lock(id);
    try {
      const file = path.join(this.jobDir(id), 'job.json');
      const fingerprint = hash(JSON.stringify(fields));
      if (fs.existsSync(file)) {
        const old = this.read(id);
        if (old.request_id !== requestId || old.fingerprint !== fingerprint) fail('REQUEST_CONFLICT', '同一 request_id 不得用于不同输入');
        return old;
      }
      const job = { schema_version: 1, job_id: id, request_id: requestId, fingerprint, ...fields,
        state: 'prepared', created_at: new Date().toISOString(), artifacts: {} };
      atomicJson(file, job); return job;
    } finally { unlock(); }
  }
  update(id, patch) {
    const job = { ...this.read(id), ...patch, updated_at: new Date().toISOString() };
    atomicJson(path.join(this.jobDir(id), 'job.json'), job); return job;
  }
  lock(name) {
    if (!/^[a-z0-9-]+$/.test(name)) fail('INVALID_LOCK', '无效锁名称');
    const file = path.join(this.root, `${name}.lock`);
    // A lock is never stolen automatically: PID reuse or a slow upload must not cause duplicates.
    let fd; try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (e) { if (e.code === 'EEXIST') fail('BUSY', '已有操作占用；进程退出后使用 unlock --name 清理', { lock: name }); throw e; }
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); fs.closeSync(fd);
    return () => fs.unlinkSync(file);
  }
  clearLock(name) {
    if (!/^[a-z0-9-]+$/.test(name)) fail('INVALID_LOCK', '无效锁名称');
    const file = path.join(this.root, `${name}.lock`);
    if (!fs.existsSync(file)) return;
    const { pid } = readJson(file);
    try { process.kill(pid, 0); fail('BUSY', '持锁进程仍在运行'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    fs.unlinkSync(file);
  }
  assertSubmittable(job) {
    if (['submitting', 'submission_unknown'].includes(job.state))
      fail('SUBMISSION_UNKNOWN', '提交结果未知；先在听悟确认，再 attach 已有 trans_id，禁止盲目重提', { job_id: job.job_id });
    if (job.state !== 'prepared') fail('ALREADY_SUBMITTED', '任务已经提交，请 status/fetch', { job_id: job.job_id });
  }
  writeRaw(id, markdown, segments) {
    const dir = this.jobDir(id); const file = path.join(dir, 'transcript_raw.md');
    const existing = this.read(id);
    if (fs.existsSync(file) || existing.artifacts.raw) fail('RAW_EXISTS', '原始稿已存在，禁止覆盖');
    const text = String(markdown);
    const segmentText = JSON.stringify(segments, null, 2) + '\n';
    // Stage both immutable payloads before publishing the recovery record.
    fs.writeFileSync(path.join(dir, 'raw.pending'), text, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'segments.pending'), segmentText, { mode: 0o600 });
    atomicJson(path.join(dir, 'raw-commit.json'), { schema_version: 1, status: 'pending',
      raw_sha256: hash(text), segments_sha256: hash(segmentText), at: new Date().toISOString() });
    this.recoverRaw(id);
    return this.read(id);
  }
  recoverRaw(id) {
    const dir = this.jobDir(id); const record = path.join(dir, 'raw-commit.json');
    if (!fs.existsSync(record)) return false;
    const transaction = readJson(record);
    if (transaction.status === 'committed') return false;
    if (transaction.schema_version !== 1 || transaction.status !== 'pending' ||
      !/^[a-f0-9]{64}$/.test(transaction.raw_sha256) || !/^[a-f0-9]{64}$/.test(transaction.segments_sha256))
      fail('RAW_COMMIT_INVALID', '原稿恢复记录格式不正确');
    const targets = [ ['raw.pending', 'transcript_raw.md', transaction.raw_sha256],
      ['segments.pending', 'segments.json', transaction.segments_sha256] ];
    const file = path.join(dir, 'job.json'); const job = readJson(file);
    if (job.raw_sha256 && job.raw_sha256 !== transaction.raw_sha256)
      fail('RAW_CONFLICT', '已登记原稿与恢复记录不一致');
    // Validate every payload before promoting either, and never overwrite a conflicting file.
    for (const [pending, target, digest] of targets) {
      const destination = path.join(dir, target); const staged = path.join(dir, pending);
      const candidate = fs.existsSync(destination) ? destination : staged;
      if (!fs.existsSync(candidate) || hash(fs.readFileSync(candidate)) !== digest)
        fail('RAW_CONFLICT', '原稿或段落文件与提交记录不一致，停止恢复');
    }
    for (const [pending, target] of targets) {
      const destination = path.join(dir, target);
      if (!fs.existsSync(destination)) fs.renameSync(path.join(dir, pending), destination);
    }
    atomicJson(file, { ...job, state: 'ai_ready', stage: 'ai_ready', raw_sha256: transaction.raw_sha256,
      segments_sha256: transaction.segments_sha256, updated_at: new Date().toISOString(),
      artifacts: { ...job.artifacts, raw: path.join(dir, 'transcript_raw.md'), segments: path.join(dir, 'segments.json') } });
    atomicJson(record, { ...transaction, status: 'committed', committed_at: new Date().toISOString() });
    for (const [pending] of targets) { const staged = path.join(dir, pending); if (fs.existsSync(staged)) fs.unlinkSync(staged); }
    return true;
  }
  verifyRaw(id) {
    const job = this.read(id);
    if (!job.artifacts.raw || !fs.existsSync(job.artifacts.raw) || hash(fs.readFileSync(job.artifacts.raw)) !== job.raw_sha256)
      fail('RAW_CHANGED', '原始稿缺失或已被修改，不能登记 AI 产物');
    if (job.segments_sha256 && (!job.artifacts.segments || !fs.existsSync(job.artifacts.segments) ||
      hash(fs.readFileSync(job.artifacts.segments)) !== job.segments_sha256))
      fail('RAW_CHANGED', '段落文件缺失或已被修改，不能登记 AI 产物');
    return job;
  }
  preferences(value) {
    const file = path.join(this.root, 'preferences.json');
    if (value !== undefined) {
      if (!['ask', 'always', 'never'].includes(value)) fail('INVALID_PREFERENCE', 'cards 必须是 ask、always 或 never');
      atomicJson(file, { cards: value });
    }
    return fs.existsSync(file) ? readJson(file) : { cards: 'ask' };
  }
}
module.exports = { Store, atomicJson, readJson };
