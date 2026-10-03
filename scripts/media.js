const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn,spawnSync} = require('node:child_process');
const {pipeline} = require('node:stream/promises');
const {Transform} = require('node:stream');
const {fail,validateSource,AppError} = require('./core');
const {assertPublicUrl,publicRequest,identifyRemote} = require('./media-network');
const {startPublicProxy} = require('./media-proxy');
function downloadHeaders(media){
 const headers={'Accept-Encoding':'identity','User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36'};
 for(const[key,value]of Object.entries(media.headers||{})){
  if(!/^(user-agent|referer)$/i.test(key))continue;
  if(typeof value!=='string'||/[\r\n\0]/.test(value))fail('INVALID_MEDIA_HEADERS','媒体请求头格式无效');
  headers[/^user-agent$/i.test(key)?'User-Agent':'Referer']=value;
 }
 if(!headers.Referer&&media.referer)headers.Referer=media.referer;
 if(headers.Referer){if(typeof headers.Referer!=='string'||/[\r\n\0]/.test(headers.Referer))fail('INVALID_MEDIA_HEADERS','媒体Referer格式无效');validateSource(headers.Referer,true);const ref=new URL(headers.Referer);ref.search='';ref.hash='';headers.Referer=ref.href;}
 return headers;
}
function executableOnPath(name){const r=spawnSync(process.platform==='win32'?'where.exe':'which',[name],{encoding:'utf8',windowsHide:true});return r.status===0?r.stdout.trim().split(/\r?\n/)[0]:null;}
function classifyDownloadError(stderr='',timedOut=false){
 const rules=[['CAPTCHA_REQUIRED','captcha',/captcha|not a bot|verify you are human|验证码/i,'人工验证后恢复'],['RATE_LIMITED','rate_limit',/429|too many requests|rate.?limit/i,'等待限流解除'],['LOGIN_REQUIRED','login',/sign in|log.?in|authentication|401|登录|fresh cookies|cookies.{0,80}(?:needed|required)/i,'登录对应来源站点'],['MEDIA_EXPIRED','media_expired',/expired|expiration|已过期/i,'刷新解析地址'],['ACCESS_DENIED','access_denied',/403|forbidden|geo.?restrict/i,'尝试其他媒体候选'],['PARSER_UNSUPPORTED','unsupported',/unsupported url|no suitable extractor|not supported|no video formats found/i,'使用专用适配器或 ParseVideo'],['NETWORK_TIMEOUT','network_timeout',/timed? ?out|timeout|connection|network|resolve host/i,'检查网络后恢复']];
 if(timedOut)return{code:'DOWNLOAD_TIMEOUT',category:'network_timeout',next_action:'检查网络后恢复'};
 for(const[code,category,re,next_action]of rules)if(re.test(stderr))return{code,category,next_action};
 return{code:'DOWNLOAD_FAILED',category:'download_failed',next_action:'尝试其他获取渠道'};
}
function run(exe,args,timeout=300000){return new Promise((resolve,reject)=>{const p=spawn(exe,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='',timedOut=false;const timer=setTimeout(()=>{timedOut=true;if(process.platform==='win32'&&p.pid)spawn('taskkill.exe',['/PID',String(p.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else p.kill();},timeout);p.stdout.on('data',d=>{if(out.length<262144)out+=d.toString();});p.stderr.on('data',d=>{if(err.length<65536)err+=d.toString();});p.on('error',()=>{clearTimeout(timer);reject(new AppError('DEPENDENCY_MISSING','媒体工具无法启动'));});p.on('close',code=>{clearTimeout(timer);if(timedOut||code!==0){const e=classifyDownloadError(err,timedOut);const failure=new AppError(e.code,'媒体获取未成功',e);Object.defineProperty(failure,'private_stderr',{value:err,enumerable:false});reject(failure);}else resolve(out.trim());});});}
async function fileHash(file){const h=crypto.createHash('sha256');for await(const c of fs.createReadStream(file))h.update(c);return h.digest('hex');}
async function verifyMedia(file,options={}){
 if(!fs.existsSync(file)||!fs.statSync(file).isFile()||!fs.statSync(file).size)fail('MEDIA_INCOMPLETE','媒体文件缺失或为空');
 const probe=options.ffprobe||executableOnPath('ffprobe');if(!probe)fail('DEPENDENCY_MISSING','媒体验证需要 ffprobe');let info;
 try{info=JSON.parse(await(options.run||run)(probe,['-v','error','-show_streams','-show_format','-of','json',file],60000));}catch(e){if(e.code==='DEPENDENCY_MISSING')throw e;fail('MEDIA_INVALID','媒体容器无法读取',{category:'invalid_media'});}
 const audio=info.streams?.filter(s=>s.codec_type==='audio')||[];if(!audio.length)fail('NO_AUDIO_TRACK','媒体没有音轨',{category:'no_audio',next_action:'尝试包含声音的候选'});
 const duration=Number(info.format?.duration||audio.find(s=>Number(s.duration)>0)?.duration);if(!Number.isFinite(duration)||duration<=0||!info.format?.format_name)fail('MEDIA_INVALID','媒体时长或容器无效');
 return{sha256:await fileHash(file),size:fs.statSync(file).size,duration_seconds:duration,container:info.format.format_name,audio_codec:audio[0].codec_name||'unknown',video_tracks:(info.streams||[]).filter(s=>s.codec_type==='video').length,verified_at:new Date().toISOString()};
}
async function verifyCachedMedia(media,options={}){if(!media?.source||!media.sha256||!fs.existsSync(media.source))return false;if(media.expires_at&&Date.parse(media.expires_at)<=Date.now())return false;if(await fileHash(media.source)!==media.sha256)return false;await verifyMedia(media.source,options);return true;}
function expiresAt(source){try{const u=new URL(source),raw=u.searchParams.get('expire')||u.searchParams.get('expires')||u.searchParams.get('Expires')||((u.hostname==='bilivideo.com'||u.hostname.endsWith('.bilivideo.com'))?u.searchParams.get('deadline'):null)||u.pathname.match(/\/expire\/(\d+)/)?.[1];if(!raw||!/^\d+$/.test(raw))return null;const n=Number(raw),d=new Date(n<1e12?n*1000:n);return Number.isFinite(d.getTime())?d.toISOString():null;}catch{return null;}}
async function validateMedia(file,directory,options={}){
 let v=await verifyMedia(file,options);
 if(v.video_tracks>0 || !/\.(m4a|mp3|wav|mp4|aac|ogg|flac|wma|webm)$/i.test(file)){
  const ff=options.ffmpeg||executableOnPath('ffmpeg');if(!ff)fail('DEPENDENCY_MISSING','该媒体需要 ffmpeg 提取音频');
  const target=path.join(directory||path.dirname(file),'media',`.converted-${crypto.randomUUID()}.m4a`);fs.mkdirSync(path.dirname(target),{recursive:true});
  const codec=v.audio_codec==='aac'?['-c:a','copy']:['-c:a','aac','-b:a','128k'];
  await(options.run||run)(ff,['-v','error','-nostdin','-i',file,'-map','0:a:0','-vn',...codec,target]);file=target;v=await verifyMedia(file,options);
 }
 if(directory){const dest=path.join(directory,'media');fs.mkdirSync(dest,{recursive:true});const registered=path.join(dest,`${v.sha256}${path.extname(file).toLowerCase()}`);if(!fs.existsSync(registered))fs.copyFileSync(file,registered,fs.constants.COPYFILE_EXCL);else if(await fileHash(registered)!==v.sha256)fail('MEDIA_CONFLICT','已登记媒体摘要冲突');file=registered;}
 return{kind:'local',source:path.resolve(file),...v,metadata:{...v},acquired_at:new Date().toISOString()};
}
async function ytDownload(media,directory,options={}){
 const proxy=await startPublicProxy(options);try{return await ytDownloadWithProxy(media,directory,{...options,proxy:proxy.url});}finally{await proxy.close();}
}
async function ytDownloadWithProxy(media,directory,options={}){
 await assertPublicUrl(media.source,options.lookup);const exe=options.ytdlp||executableOnPath('yt-dlp');if(!exe)fail('DEPENDENCY_MISSING','媒体下载需要 yt-dlp');const temp=path.join(directory,'media',`.download-${crypto.randomUUID()}`);fs.mkdirSync(temp,{recursive:true});
 const u=new URL(media.source);if(u.searchParams.has('list')||/\/(playlist|channel|live)(\/|$)/i.test(u.pathname))fail('PLAYLIST_UNSUPPORTED','不自动展开播放列表、频道或直播');
 const common=['--proxy',options.proxy,'--socket-timeout','30','--retries','1','--js-runtimes',`node:${process.execPath}`];if(media.referer){await assertPublicUrl(media.referer,options.lookup);common.push('--referer',media.referer);}if(options.cookieArgs)common.push(...options.cookieArgs);else if(options.cookie_file)common.push('--cookies',options.cookie_file);
 let info;try{info=JSON.parse(await(options.run||run)(exe,[...common,'--flat-playlist','--playlist-end','1','--dump-single-json','--skip-download','--',media.source]));}catch(e){if(e.code)throw e;fail('PARSER_SCHEMA_CHANGED','下载器媒体信息结构异常');}
 if(info._type==='playlist'||info._type==='multi_video'||Array.isArray(info.entries))fail('PLAYLIST_UNSUPPORTED','不自动展开多视频或播放列表');if(info.is_live||['is_live','is_upcoming','post_live'].includes(info.live_status))fail('LIVE_UNSUPPORTED','不自动转写直播');
 const args=[...common,'--no-playlist','--no-progress','--max-filesize','2G','--match-filter','!is_live','-f','bestaudio/best','--print','after_move:filepath','-o',path.join(temp,'input.%(ext)s')];
 const out=await(options.run||run)(exe,[...args,'--',media.source]);const file=out.split(/\r?\n/).at(-1);if(!file||!path.resolve(file).startsWith(path.resolve(temp)+path.sep)||!fs.existsSync(file))fail('DOWNLOAD_FAILED','下载工具未产出可验证媒体');return{...await validateMedia(file,directory,options),channel:'yt-dlp',expires_at:expiresAt(media.source)};
}
async function directDownload(media,directory,options={}){
 const {response}=await(options.request||publicRequest)(media.source,{lookup:options.lookup,headers:downloadHeaders(media)});if(response.statusCode!==200){response.resume();const e=classifyDownloadError(String(response.statusCode));fail(e.code,'媒体服务器拒绝完整下载',e);}const type=String(response.headers['content-type']||'');
 if(/mpegurl/i.test(type)||/\.m3u8(?:\?|$)/i.test(media.source)){response.resume();return hlsDownload(media,directory,options);}
 const temp=path.join(directory,'media',`.download-${crypto.randomUUID()}`);fs.mkdirSync(temp,{recursive:true});const ext=/audio\/mpeg/i.test(type)?'.mp3':/audio\/wav/i.test(type)?'.wav':/(?:audio|video)\/mp4/i.test(type)?'.m4a':'.media';const file=path.join(temp,`input${ext}`);let bytes=0;const limiter=new Transform({transform(c,_e,cb){bytes+=c.length;cb(bytes>2*1024**3?new AppError('MEDIA_TOO_LARGE','媒体超过 2 GB'):null,c);}});
 try{await pipeline(response,limiter,fs.createWriteStream(file,{flags:'wx'}));}catch(e){if(e.code==='MEDIA_TOO_LARGE')throw e;fail('DOWNLOAD_INTERRUPTED','下载中断，临时文件未登记',{category:'network',next_action:'恢复任务重新下载'});}
 const expected=Number(response.headers['content-length']);if(response.headers['content-length']!==undefined&&(!Number.isSafeInteger(expected)||expected!==bytes))fail('DOWNLOAD_INTERRUPTED','下载长度与服务器声明不符，临时文件未登记');
 return{...await validateMedia(file,directory,options),channel:'http',expires_at:expiresAt(media.source)};
}
async function hlsDownload(media,directory,options={}){
 // Download and rewrite every manifest, key and segment through the pinned public HTTP client.
 const temp=path.join(directory,'media',`.hls-${crypto.randomUUID()}`);fs.mkdirSync(temp,{recursive:true});let count=0,total=0;const seen=new Map();
 async function localize(url,depth=0){if(depth>8||++count>5000)fail('HLS_LIMIT','HLS 层级或分片数过多');if(seen.has(url))return seen.get(url);const{response,final_url}=await(options.request||publicRequest)(url,{lookup:options.lookup,headers:downloadHeaders(media)});if(response.statusCode!==200){response.resume();const e=classifyDownloadError(String(response.statusCode));fail(e.code,'HLS 媒体读取失败',e);}let chunks=[];for await(const c of response){total+=c.length;if(total>2*1024**3)fail('MEDIA_TOO_LARGE','HLS 超过 2 GB');chunks.push(c);if(chunks.reduce((n,x)=>n+x.length,0)>64*1024**2)fail('HLS_SEGMENT_TOO_LARGE','单个 HLS 分片超过 64 MB');}const b=Buffer.concat(chunks),manifest=b.subarray(0,7).toString()==='#EXTM3U',name=path.join(temp,`${count}-${crypto.randomUUID()}${manifest?'.m3u8':'.bin'}`);seen.set(url,name.replaceAll('\\','/'));
 if(manifest){let lines=b.toString().split(/\r?\n/);if(lines.some(l=>l.startsWith('#EXT-X-PLAYLIST-TYPE:EVENT'))||(!lines.some(l=>l.startsWith('#EXT-X-STREAM-INF'))&&!lines.includes('#EXT-X-ENDLIST')))fail('LIVE_UNSUPPORTED','不自动下载直播或持续播放列表');for(let i=0;i<lines.length;i++){const line=lines[i];if(line&& !line.startsWith('#'))lines[i]=await localize(new URL(line,final_url).href,depth+1);else if(/URI="/.test(line)){const matches=[...line.matchAll(/URI="([^"]+)"/g)];for(const m of matches)lines[i]=lines[i].replace(m[0],`URI="${await localize(new URL(m[1],final_url).href,depth+1)}"`);}}fs.writeFileSync(name,lines.join('\n'));}else fs.writeFileSync(name,b);return name.replaceAll('\\','/');}
 const manifest=await localize(media.source);const ff=options.ffmpeg||executableOnPath('ffmpeg');if(!ff)fail('DEPENDENCY_MISSING','HLS 合并需要 ffmpeg');const output=path.join(temp,'audio.m4a');await(options.run||run)(ff,['-v','error','-nostdin','-protocol_whitelist','file,crypto,data','-allowed_extensions','ALL','-i',manifest,'-map','0:a:0','-vn','-c:a','aac',output]);return{...await validateMedia(output,directory,options),channel:'hls',expires_at:expiresAt(media.source)};
}
async function downloadMedia(media,directory,options={}){media={...media,source:media.source||media.url,kind:media.kind||'resolved'};return media.kind==='page'||media.kind==='bilibili'?ytDownload(media,directory,options):directDownload(media,directory,options);}
async function prepareMedia(source,directory,options={}){const media=validateSource(source,true);return media.kind==='local'?validateMedia(media.source,directory,options):ytDownload(media,directory,options);}
async function downloadCandidates(candidates,directory,options={}){const rows=Array.isArray(candidates)?candidates:[typeof candidates==='string'?validateSource(candidates,true):candidates],attempts=[];for(const item of rows){const media={...item,source:item.source||item.url,kind:item.kind||'resolved'};try{const expiry=media.expires_at||expiresAt(media.source);if(expiry&&Date.parse(expiry)<=Date.now())fail('MEDIA_EXPIRED','媒体地址已有明确到期证据',{category:'media_expired'});return{...await(media.kind==='local'?validateMedia(media.source,directory,options):downloadMedia(media,directory,options)),attempts};}catch(e){attempts.push({channel:media.kind==='page'?'yt-dlp':'media',code:e.code||'DOWNLOAD_FAILED',category:e.details?.category||'download_failed'});if(['CAPTCHA_REQUIRED','RATE_LIMITED','LOGIN_REQUIRED','PRIVATE_ADDRESS','INVALID_SOURCE','PLAYLIST_UNSUPPORTED','LIVE_UNSUPPORTED'].includes(e.code))throw e;}}const last=attempts.at(-1),allExpired=attempts.length&&attempts.every(a=>a.code==='MEDIA_EXPIRED');fail(allExpired?'MEDIA_EXPIRED':last?.code||'NO_MEDIA_CANDIDATE','所有媒体候选均未通过验证',{category:allExpired?'media_expired':last?.category||'unsupported',attempts,next_action:'更换渠道或提供媒体'});}
module.exports={executableOnPath,run,classifyDownloadError,downloadHeaders,fileHash,verifyMedia,validateMedia,verifyCachedMedia,expiresAt,prepareMedia,downloadMedia,downloadCandidates,acquireMedia:downloadCandidates,identifyRemote,assertPublicUrl};
