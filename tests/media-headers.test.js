const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const media = require('../scripts/media');

test('媒体下载只发送UA和Referer，来源Cookie/Authorization不能进入CDN', () => {
  assert.equal(typeof media.downloadHeaders, 'function');
  const headers = media.downloadHeaders({ referer: 'https://www.bilibili.com/video/BV1GJ411x7h7/', headers: { 'User-Agent': 'BrowserUA', Cookie: 'SECRET', Authorization: 'SECRET2' } });
  assert.equal(headers['User-Agent'], 'BrowserUA');
  assert.match(headers.Referer, /bilibili/);
  assert.doesNotMatch(JSON.stringify(headers), /SECRET/);
  assert.throws(() => media.downloadHeaders({ headers: { 'User-Agent': 'UA\r\nCookie: SECRET' } }), { code: 'INVALID_MEDIA_HEADERS' });
  const xhs = media.downloadHeaders({ referer: 'https://www.xiaohongshu.com/explore/id?xsec_token=PRIVATE', headers: { Referer: 'https://www.xiaohongshu.com/explore/id' } });
  assert.equal(xhs.Referer, 'https://www.xiaohongshu.com/explore/id');
  assert.doesNotMatch(JSON.stringify(media.downloadHeaders({ referer: 'https://www.xiaohongshu.com/explore/id?xsec_token=PRIVATE' })), /PRIVATE/);
});

test('下载透传必要UA且内容长度不符时不登记媒体', async t => {
  assert.equal(typeof media.downloadHeaders, 'function');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtrans-header-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let headers;
  const request = async (_url, options) => {
    headers = options.headers;
    const response = Readable.from([Buffer.from('partial')]);
    response.statusCode = 200;
    response.headers = { 'content-type': 'audio/mp4', 'content-length': '1000' };
    return { response, final_url: 'https://cdn.example.org/audio' };
  };
  await assert.rejects(media.downloadMedia({ url: 'https://cdn.example.org/audio', headers: { 'User-Agent': 'BrowserUA', Cookie: 'PRIVATE' }, referer: 'https://www.bilibili.com/' }, dir, { request }), { code: 'DOWNLOAD_INTERRUPTED' });
  assert.equal(headers['User-Agent'], 'BrowserUA');
  assert.equal(headers.Cookie, undefined);
  assert.equal(fs.existsSync(path.join(dir, 'job.json')), false);
});

test('B站实际CDN的deadline识别为到期证据，不泛化未知站点同名参数', () => {
  const { expiryOf } = require('../scripts/parsevideo');
  assert.equal(expiryOf('https://upos.example.bilivideo.com/audio.m4s?deadline=1700000000'), '2023-11-14T22:13:20.000Z');
  assert.equal(media.expiresAt('https://upos.example.bilivideo.com/audio.m4s?deadline=1700000000'), '2023-11-14T22:13:20.000Z');
  assert.equal(expiryOf('https://cdn.example.org/audio?deadline=1700000000'), null);
});
