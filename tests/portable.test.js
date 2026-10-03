const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { browserPath } = require('../scripts/tingwu');
const { executableOnPath } = require('../scripts/media');
const powershell = executableOnPath('pwsh') || (process.platform === 'win32' && executableOnPath('powershell'));
const source = path.resolve(__dirname, '..');

test('浏览器可发现新用户 LocalAppData 的 Chrome 和 macOS 应用', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-browser-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const local = path.join(root, 'Local', 'Google/Chrome/Application/chrome.exe');
  fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, 'fixture');
  assert.equal(browserPath({ env: { LOCALAPPDATA: path.join(root, 'Local') }, home: root, platform: 'win32', onPath: () => null }), local);
  const mac = path.join(root, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  fs.mkdirSync(path.dirname(mac), { recursive: true }); fs.writeFileSync(mac, 'fixture');
  assert.equal(browserPath({ env: {}, home: root, platform: 'darwin', onPath: () => null, applications: path.join(root, 'Applications') }), mac);
});

test('候选入口移到新目录仍可运行，并隔离正式 VTRANS_HOME', { skip: !powershell }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-portable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const moved = path.join(root, '新的目录 空格', 'video-transcript-candidate');
  fs.mkdirSync(moved, { recursive: true });
  fs.cpSync(path.join(source, 'scripts'), path.join(moved, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(source, 'package.json'), path.join(moved, 'package.json'));
  const formal = path.join(root, 'formal'); const candidate = path.join(root, 'candidate');
  const r = spawnSync(powershell, ['-NoProfile', '-File', path.join(moved, 'scripts/vtrans-candidate.ps1'), 'catalog'], {
    encoding: 'utf8', env: { ...process.env, VTRANS_HOME: formal, VTRANS_CANDIDATE_HOME: candidate }
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.equal(JSON.parse(r.stdout).data.version, '0.3.0-rc.2');
  assert.equal(fs.existsSync(formal), false); assert.equal(fs.existsSync(candidate), true);
  const explicit = path.join(root, 'explicit');
  const r2 = spawnSync(powershell, ['-NoProfile', '-File', path.join(moved, 'scripts/vtrans-candidate.ps1'), 'catalog', '--state-root', explicit], {
    encoding: 'utf8', env: { ...process.env, VTRANS_CANDIDATE_HOME: candidate }
  });
  assert.equal(r2.status, 0, r2.stderr || r2.stdout); assert.equal(fs.existsSync(explicit), true);
  const formalBook = path.join(root, 'formal-source-book.md');
  const r3 = spawnSync(powershell, ['-NoProfile', '-File', path.join(moved, 'scripts/vtrans-candidate.ps1'), 'sources'], {
    encoding: 'utf8', env: { ...process.env, VTRANS_CANDIDATE_HOME: candidate, VTRANS_SOURCE_BOOK: formalBook }
  });
  assert.equal(r3.status, 0, r3.stderr || r3.stdout);
  assert.equal(fs.existsSync(formalBook), false);
  assert.equal(path.dirname(JSON.parse(r3.stdout).data.document), candidate);
});

test('候选安装器拒绝正式技能路径或覆盖已有安装', { skip: !powershell }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const installer = path.join(source, 'scripts/install-candidate.ps1');
  for (const name of ['video-transcript', 'video-transcript-candidate']) {
    const destination = path.join(root, name); fs.mkdirSync(destination);
    fs.writeFileSync(path.join(destination, 'untouched.txt'), 'original');
    const r = spawnSync(powershell, ['-NoProfile', '-File', installer, '-Destination', destination], { encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, name === 'video-transcript' ? /video-transcript-candidate/ : /已存在/);
    assert.equal(fs.readFileSync(path.join(destination, 'untouched.txt'), 'utf8'), 'original');
    assert.deepEqual(fs.readdirSync(destination), ['untouched.txt']);
  }
});
