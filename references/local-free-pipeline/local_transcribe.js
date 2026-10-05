'use strict';
// 本地免费转写：音频/视频文件 → 文字稿（sherpa-onnx + Paraformer-zh）
// 完全本地、免费、无登录、无额度，数据不出本机。
// 用法: node local_transcribe.js <音频或视频文件> [输出txt路径]
//
// 依赖（均可通过环境变量覆盖路径）:
//   - ffmpeg（FFMPEG，默认在 PATH 找）
//   - Python + sherpa_onnx + numpy（VTRANS_PYTHON，默认 python）
//   - Paraformer-zh int8 模型目录（VTRANS_PARAFORMER_MODEL），含 model.int8.onnx + tokens.txt
//     下载: https://modelscope.cn/models/pengzhendong/sherpa-onnx-paraformer-zh/resolve/master/
//
// 实现要点:
//   - 音频先转 16k 单声道 wav 再喂模型
//   - 60 秒分块解码：单次全长解码在部分宿主环境会被 SIGTERM 杀掉，分块稳定；
//     副作用是时间戳只有分钟级粒度
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PY = process.env.VTRANS_PYTHON || 'python';
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const MODEL = process.env.VTRANS_PARAFORMER_MODEL || '';

const input = process.argv[2];
if (!input || !fs.existsSync(input)) { console.error('输入文件不存在:', input); process.exit(2); }
if (!MODEL || !fs.existsSync(path.join(MODEL, 'model.int8.onnx'))) {
  console.error('未找到 Paraformer 模型目录，请设置 VTRANS_PARAFORMER_MODEL（含 model.int8.onnx 和 tokens.txt）');
  process.exit(2);
}
const outTxt = process.argv[3] || path.join(path.dirname(input), path.basename(input).replace(/\.[^.]+$/, '') + '_转写.txt');

const tmpWav = path.join(os.tmpdir(), 'local_transcribe_' + process.pid + '.wav');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => code === 0 ? resolve() : reject(new Error(cmd + ' exit=' + code + ' ' + err.slice(-300))));
    child.on('error', reject);
  });
}

const pyCode = `
import sys, json, wave
import sherpa_onnx, numpy as np
wav_path, out_path, model_dir = sys.argv[1], sys.argv[2], sys.argv[3]
rec = sherpa_onnx.OfflineRecognizer.from_paraformer(
    paraformer=model_dir + '/model.int8.onnx',
    tokens=model_dir + '/tokens.txt',
    num_threads=2, sample_rate=16000, feature_dim=80, decoding_method='greedy_search')
with wave.open(wav_path, 'rb') as w:
    sr = w.getframerate(); n = w.getnframes()
    samples = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
chunk = 60 * sr
lines = []
for i in range(0, len(samples), chunk):
    part = samples[i:i + chunk]
    if len(part) < sr: break
    st = rec.create_stream(); st.accept_waveform(sr, part); rec.decode_stream(st)
    t = st.result.text.strip()
    if t:
        sec = i // sr
        lines.append('[{:02d}:{:02d}] {}'.format(sec // 60, sec % 60, t))
plain = ''.join(l.split('] ', 1)[1] for l in lines) if lines else ''
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(plain + '\\n\\n--- 分段时间戳 ---\\n' + '\\n'.join(lines) + '\\n')
print(json.dumps({'ok': True, 'duration': round(len(samples) / sr, 1), 'chars': len(plain),
                  'blocks': len(lines), 'out': out_path, 'preview': plain[:150]}, ensure_ascii=False))
`;

// ── 保留期自动清理（每次转写结束后自动执行，最佳努力，失败不影响转写结果）──
// 策略（2026-10-05 用户定稿）：媒体 3 天、转写文本 30 天、.download-* 临时目录 3 天
function retentionCleanup() {
  try {
    const MEDIA = new Set(['.m4a', '.mp4', '.wav', '.mp3', '.aac', '.webm', '.flv', '.part', '.m4s']);
    const TEXT = new Set(['.txt', '.md']);
    const MEDIA_DAYS = 3, TEXT_DAYS = 30, TEMP_DAYS = 3;
    const stateRoot = process.env.VTRANS_STATE_ROOT || path.join(os.homedir(), '.agent-apps/video-transcript-candidate/private');
    const xhsDir = process.env.XHS_WORK_DIR || '';
    const age = p => (Date.now() - fs.statSync(p).mtimeMs) / 86400000;
    const rm = p => { try { fs.statSync(p).isDirectory() ? fs.rmSync(p, { recursive: true, force: true }) : fs.unlinkSync(p); } catch { /* ignore */ } };
    const jobsDir = path.join(stateRoot, 'jobs');
    if (fs.existsSync(jobsDir)) {
      for (const job of fs.readdirSync(jobsDir)) {
        const mediaRoot = path.join(jobsDir, job, 'media');
        if (!fs.existsSync(mediaRoot)) continue;
        for (const name of fs.readdirSync(mediaRoot)) {
          const p = path.join(mediaRoot, name);
          let d; try { d = age(p); } catch { continue; }
          if (name.startsWith('.download-')) { if (d > TEMP_DAYS) rm(p); continue; }
          if (MEDIA.has(path.extname(name).toLowerCase()) && d > MEDIA_DAYS) rm(p);
        }
      }
    }
    if (xhsDir && fs.existsSync(xhsDir)) {
      for (const name of fs.readdirSync(xhsDir)) {
        const p = path.join(xhsDir, name);
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (!st.isFile()) continue;
        const ext = path.extname(name).toLowerCase();
        const d = (Date.now() - st.mtimeMs) / 86400000;
        if (MEDIA.has(ext) && d > MEDIA_DAYS) rm(p);
        else if (TEXT.has(ext) && d > TEXT_DAYS) rm(p);
      }
    }
  } catch { /* 清理失败不影响转写结果 */ }
}

(async () => {
  try {
    await run(FFMPEG, ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', tmpWav]);
    const child = spawn(PY, ['-u', '-c', pyCode, tmpWav, outTxt, MODEL], { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      fs.unlink(tmpWav, () => {});
      retentionCleanup();
      if (code === 0) console.log(out.trim());
      else { console.error('转写失败 exit=' + code + '\n' + err.slice(-600)); process.exit(1); }
    });
    child.on('error', e => { console.error('spawn失败:', e.code); process.exit(1); });
  } catch (e) { console.error(e.message); process.exit(1); }
})();
