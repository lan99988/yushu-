const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {isPublicAddress,assertPublicUrl}=require('../scripts/media-network');
const {classifyDownloadError,verifyMedia,validateMedia,verifyCachedMedia,expiresAt,downloadCandidates,run,executableOnPath}=require('../scripts/media');
const lookup=async()=>[{address:'93.184.216.34',family:4}];
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'vtrans-media-'));}
const probe=async()=>JSON.stringify({streams:[{codec_type:'audio',codec_name:'pcm_s16le'}],format:{duration:'2.0',format_name:'wav'}});
test('real ffmpeg extracts audio from a video before registration', {skip:!executableOnPath('ffmpeg')||!executableOnPath('ffprobe')}, async()=>{
 const d=tmp(),file=path.join(d,'video.mp4');try{
  await run(executableOnPath('ffmpeg'),['-v','error','-nostdin','-f','lavfi','-i','color=c=black:s=32x32:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','mpeg4','-c:a','aac','-shortest',file]);
  assert.equal((await verifyMedia(file)).video_tracks,1);
  const registered=await validateMedia(file,d);assert.equal(registered.video_tracks,0);assert.match(registered.source,/\.m4a$/);assert.ok(registered.duration_seconds>0);
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('DNS safety rejects private and mixed answers including IPv6',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1','2001:db8::1'])assert.equal(isPublicAddress(ip),false,ip);
 assert.equal(isPublicAddress('8.8.8.8'),true);assert.equal(isPublicAddress('2606:4700::1111'),true);
 await assert.rejects(()=>assertPublicUrl('https://safe.example',async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]),{code:'PRIVATE_ADDRESS'});
 await assertPublicUrl('https://safe.example',lookup);
});
test('download error categories distinguish 403 from expiry and redact signed URLs',()=>{
 const e=classifyDownloadError('HTTP 403 https://media.example/?token=SECRET');assert.equal(e.code,'ACCESS_DENIED');assert.ok(!JSON.stringify(e).includes('SECRET'));
 assert.equal(classifyDownloadError('URL expired').code,'MEDIA_EXPIRED');assert.equal(classifyDownloadError('HTTP 429').code,'RATE_LIMITED');assert.equal(classifyDownloadError('Sign in to confirm you are not a bot').code,'CAPTCHA_REQUIRED');assert.equal(classifyDownloadError('Unsupported URL').code,'PARSER_UNSUPPORTED');
});
test('validation rejects no audio and invalid duration',async()=>{const d=tmp(),file=path.join(d,'x.wav');fs.writeFileSync(file,'media');try{
 await assert.rejects(()=>verifyMedia(file,{ffprobe:'test',run:async()=>JSON.stringify({streams:[{codec_type:'video'}],format:{duration:'1',format_name:'mp4'}})}),{code:'NO_AUDIO_TRACK'});
 await assert.rejects(()=>verifyMedia(file,{ffprobe:'test',run:async()=>JSON.stringify({streams:[{codec_type:'audio'}],format:{duration:'NaN',format_name:'wav'}})}),{code:'MEDIA_INVALID'});
}finally{fs.rmSync(d,{recursive:true,force:true});}});
test('registered media has hash, cache rejects corruption and explicit expiry',async()=>{const d=tmp(),file=path.join(d,'x.wav');fs.writeFileSync(file,'audio');try{
 const options={ffprobe:'test',run:probe};const media=await validateMedia(file,d,options);assert.equal(media.kind,'local');assert.equal(media.sha256.length,64);assert.equal(media.metadata.duration_seconds,2);assert.equal(await verifyCachedMedia(media,options),true);
 assert.equal(await verifyCachedMedia({...media,expires_at:'2000-01-01T00:00:00Z'},options),false);fs.writeFileSync(media.source,'tampered');assert.equal(await verifyCachedMedia(media,options),false);
}finally{fs.rmSync(d,{recursive:true,force:true});}});
test('candidate switching validates the next candidate after no audio',async()=>{const d=tmp(),a=path.join(d,'a.wav'),b=path.join(d,'b.wav');fs.writeFileSync(a,'silent');fs.writeFileSync(b,'audio');try{
 const media=await downloadCandidates([{kind:'local',source:a},{kind:'local',source:b}],d,{ffprobe:'test',run:async(_exe,args)=>args.at(-1)===a?JSON.stringify({streams:[],format:{duration:'1'}}):probe()});assert.equal(media.attempts[0].code,'NO_AUDIO_TRACK');assert.equal(media.sha256.length,64);
}finally{fs.rmSync(d,{recursive:true,force:true});}});
test('expiry only recognizes explicit timestamps',()=>{assert.equal(expiresAt('https://cdn.example/a?expires=1700000000'),'2023-11-14T22:13:20.000Z');assert.equal(expiresAt('https://cdn.example/a?token=secret'),null);});
const http=require('node:http');
const net=require('node:net');
const {startPublicProxy}=require('../scripts/media-proxy');
test('yt-dlp boundary proxy rejects private HTTP and CONNECT destinations',async()=>{
 const proxy=await startPublicProxy();const port=Number(new URL(proxy.url).port);
 try{
 const status=await new Promise((resolve,reject)=>{const req=http.request({hostname:'127.0.0.1',port,path:'http://127.0.0.1:9/secret'},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});assert.equal(status,403);
 const reply=await new Promise((resolve,reject)=>{const socket=net.connect(port,'127.0.0.1',()=>socket.write('CONNECT 169.254.169.254:443 HTTP/1.1\r\nHost: 169.254.169.254:443\r\n\r\n'));socket.on('data',d=>{resolve(d.toString());socket.destroy();});socket.on('error',reject);});assert.match(reply,/403 Forbidden/);
 }finally{await proxy.close();}
});
test('expired url candidates produce MEDIA_EXPIRED without network access',async()=>{await assert.rejects(()=>downloadCandidates([{url:'https://cdn.example/audio?expires=1700000000'}],tmp()),{code:'MEDIA_EXPIRED'});});
const {connectPinned}=require('../scripts/media-egress');
test('configured egress proxy receives checked literal IP rather than resolving source host',async()=>{
 const before=process.env.HTTPS_PROXY;let destination;
 const server=http.createServer();server.on('connect',(req,socket)=>{destination=req.url;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 process.env.HTTPS_PROXY=`http://127.0.0.1:${server.address().port}`;
 try{await assert.rejects(()=>connectPinned('8.8.8.8',443),{code:'NETWORK_ERROR'});assert.equal(destination,'8.8.8.8:443');}
 finally{if(before===undefined)delete process.env.HTTPS_PROXY;else process.env.HTTPS_PROXY=before;await new Promise(resolve=>server.close(resolve));}
});
const {run:runMedia}=require('../scripts/media');
test('subprocess diagnostics stay non-enumerable and outside public error JSON',async()=>{
 try{await runMedia(process.execPath,['-e',"process.stderr.write('HTTP 403 https://cdn.example/?token=SYNTHETIC_SECRET');process.exit(1)"]);assert.fail('expected rejection');}
 catch(error){assert.equal(error.code,'ACCESS_DENIED');assert.match(error.private_stderr,/SYNTHETIC_SECRET/);assert.equal(Object.prototype.propertyIsEnumerable.call(error,'private_stderr'),false);assert.ok(!JSON.stringify(error).includes('SYNTHETIC_SECRET'));assert.ok(!error.message.includes('SYNTHETIC_SECRET'));}
});
