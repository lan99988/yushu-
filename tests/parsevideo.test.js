const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectCandidate } = require('../scripts/parsevideo');
test('优先直接音频，不取HLS或纯视频，不接收私网及非媒体链接', () => {
  const chosen = selectCandidate([
    { url: 'https://cdn.example.com/video.mp4', label: 'video only' },
    { url: 'https://cdn.example.com/playlist.m3u8', label: 'audio only' },
    { url: 'https://cdn.example.com/videoplayback?mime=audio%2Fmp4', label: '140 - audio only (medium)' }
  ]);
  assert.equal(chosen.mime, 'audio/mp4'); assert.equal(chosen.hls, false);
  assert.throws(() => selectCandidate([{ url: 'https://127.0.0.1/a.mp3', label: '音频' }]), /RESOLVER_NO_MEDIA/);
  assert.throws(() => selectCandidate([{ url: 'javascript:alert(1)', label: '音频' }]), /RESOLVER_NO_MEDIA/);
  assert.throws(() => selectCandidate([{ url: 'https://example.com/watch/1', label: '页面' }]), /RESOLVER_NO_MEDIA/);
});
