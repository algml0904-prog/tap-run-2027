'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const QRCode = require('./vendor/QRCode');
const QRErrorCorrectLevel = require('./vendor/QRCode/QRErrorCorrectLevel');
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, 'public');
const rooms = new Map();
const MAX_PLAYERS = 19;
const ROOM_TTL = 1000 * 60 * 60 * 5;
const now = () => Date.now();
const rand = n => crypto.randomBytes(n).toString('hex');
const validRoom = x => /^[A-Z2-9]{6}$/.test(x || '');
function roomCode() { let v; do { v = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.split('').sort(()=>Math.random()-.5).slice(0,6).join(''); } while(rooms.has(v)); return v; }
function send(res, code, value) {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(value));
}
function error(res, code, message) { send(res, code, {error:message}); }
function parseBody(req) { return new Promise((resolve,reject)=>{let raw=''; req.on('data',d=>{raw+=d;if(raw.length>4096){reject(new Error('요청 데이터가 너무 큽니다.'));req.destroy();}});req.on('end',()=>{try{resolve(JSON.parse(raw||'{}'));}catch{reject(new Error('요청 형식이 올바르지 않습니다.'));}});req.on('error',reject);}); }
function roomFor(code) { const r=rooms.get(code); return r && now()-r.lastSeen<ROOM_TTL ? r : null; }
function auth(r, token) {if(token && token===r.hostToken)return {type:'host'};const p=r.players.find(x=>x.token===token);return p?{type:'player',player:p}:null;}
function rank(r) { const active = r.eligible ? r.players.filter(p=>r.eligible.includes(p.id)):r.players; return active.slice().sort((a,b)=>b.score-a.score || a.joined-b.joined).map((p,i)=>({id:p.id,name:p.name,score:p.score,place:1+active.filter(o=>o.score>p.score).length,active:true})); }
function publicState(r, who) { return {room:r.code,phase:r.phase,round:r.round,duration:r.duration,configuredDuration:r.configuredDuration,startAt:r.startAt,endAt:r.endAt,serverNow:now(),isHost:who.type==='host',selfId:who.player?.id||null,players:r.players.map(p=>({id:p.id,name:p.name,score:p.score,active:!r.eligible||r.eligible.includes(p.id)})),ranking:rank(r),maxPlayers:MAX_PLAYERS}; }
function publish(r) {for(const client of r.clients){try{client.res.write(`event: state\ndata: ${JSON.stringify(publicState(r,client.who))}\n\n`);}catch{r.clients.delete(client);}}}
function advance(r) {const t=now();if(r.phase==='countdown' && t>=r.startAt){r.phase='running';publish(r);}if(r.phase==='running'&&t>=r.endAt){r.phase='finished';publish(r);}}
function svgQR(url) {
  const qr = new QRCode(0,QRErrorCorrectLevel.M); qr.addData(url);qr.make();const n=qr.getModuleCount(); const cells=[];
  for(let r=0;r<n;r++)for(let c=0;c<n;c++)if(qr.isDark(r,c))cells.push(`<rect x="${c+4}" y="${r+4}" width="1" height="1"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n+8} ${n+8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><g fill="#091025">${cells.join('')}</g></svg>`;
}
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.svg':'image/svg+xml; charset=utf-8','.png':'image/png'};
const server=http.createServer(async (req,res)=>{
  const u=new URL(req.url,'http://localhost'); const route=u.pathname;
  try {
    if(req.method==='GET'&&route==='/health')return send(res,200,{ok:true,rooms:rooms.size});
    if(req.method==='POST'&&route==='/api/create') {
      const code=roomCode(), token=rand(24);
      const r={code,hostToken:token,players:[],clients:new Set(),phase:'waiting',round:1,configuredDuration:60,duration:60,eligible:null,startAt:0,endAt:0,lastSeen:now()};rooms.set(code,r);
      return send(res,201,{room:code,hostToken:token});
    }
    if(req.method==='POST'&&route==='/api/join') {
      const b=await parseBody(req);const r=roomFor(String(b.room||'').toUpperCase());if(!r)return error(res,404,'경기방이 없거나 종료되었습니다.');
      if(r.phase!=='waiting')return error(res,409,'경기가 시작되어 지금은 입장할 수 없습니다.');
      const name=String(b.name||'').trim().replace(/[<>]/g,'').slice(0,16);
      if(name.length<1)return error(res,400,'이름 또는 닉네임을 입력하세요.');
      if(r.players.length>=MAX_PLAYERS)return error(res,409,'참가 인원이 19명으로 가득 찼습니다.');
      if(r.players.some(p=>p.name.toLowerCase()===name.toLowerCase()))return error(res,409,'같은 이름이 있어요. 다른 이름을 입력해 주세요.');
      const p={id:rand(6),token:rand(24),name,score:0,joined:now(),lastReported:0,lastAccepted:now(),tapWindowStart:now(),tapWindowCount:0};r.players.push(p);r.lastSeen=now();publish(r);
      return send(res,201,{room:r.code,playerToken:p.token,playerId:p.id});
    }
    if(req.method==='POST'&&route==='/api/host') {
      const b=await parseBody(req);const r=roomFor(String(b.room||'').toUpperCase());if(!r)return error(res,404,'경기방이 없습니다.');
      if(b.token!==r.hostToken)return error(res,403,'진행자 권한이 없습니다.');
      r.lastSeen=now();advance(r);
      switch(b.action){
        case 'duration':if(r.phase!=='waiting'||r.round!==1)return error(res,409,'시작 전 일반 경기에서만 시간을 변경할 수 있습니다.');if(![60,120].includes(b.value))return error(res,400,'60초 또는 120초만 선택 가능합니다.');r.configuredDuration=b.value;r.duration=b.value;break;
        case 'start':if(r.phase!=='waiting')return error(res,409,'이미 경기가 시작되었습니다.');if(r.players.length<1)return error(res,409,'참가자가 입장한 뒤 시작하세요.');r.startAt=now()+4000;r.endAt=r.startAt+r.duration*1000;r.phase='countdown';break;
        case 'reset':r.round=1;r.eligible=null;r.phase='waiting';r.duration=r.configuredDuration;r.startAt=0;r.endAt=0;r.players.forEach(p=>{p.score=0;p.lastReported=0;p.tapWindowCount=0;p.tapWindowStart=now();});break;
        case 'final':{
          if(r.phase!=='finished')return error(res,409,'경기 종료 후에 결승전을 열 수 있습니다.');const best=rank(r);const top=best[0]?.score;
          const tied=best.filter(p=>p.score===top);if(tied.length<2)return error(res,409,'공동 1위가 없어서 결승전이 필요하지 않습니다.');
          r.eligible=tied.map(p=>p.id);r.round=2;r.duration=10;r.phase='waiting';r.startAt=0;r.endAt=0;r.players.forEach(p=>{p.score=0;p.lastReported=0;p.tapWindowCount=0;p.tapWindowStart=now();});break;}
        default:return error(res,400,'지원하지 않는 명령입니다.');
      }
      publish(r);return send(res,200,{ok:true});
    }
    if(req.method==='POST'&&route==='/api/tap') {
      const b=await parseBody(req);const r=roomFor(String(b.room||'').toUpperCase());if(!r)return error(res,404,'경기방이 없습니다.');
      const a=auth(r,b.token);if(!a||a.type!=='player')return error(res,403,'참가자 인증이 필요합니다.');
      advance(r);const p=a.player;const t=now();
      if(r.phase!=='running'||t>r.endAt||r.eligible&&!r.eligible.includes(p.id))return send(res,200,{ok:false,score:p.score});
      const total=Number(b.total);if(!Number.isSafeInteger(total)||total<0)return error(res,400,'점수 데이터가 올바르지 않습니다.');
      let delta=Math.max(0,total-p.lastReported); p.lastReported=Math.max(p.lastReported,total);
      if(t-p.tapWindowStart>=1000){p.tapWindowStart=t;p.tapWindowCount=0;}
      const allowed=Math.max(0,45-p.tapWindowCount);delta=Math.min(allowed,delta,60);
      p.score+=delta;p.tapWindowCount+=delta;p.lastAccepted=t;r.lastSeen=t;
      publish(r);return send(res,200,{ok:true,score:p.score});
    }
    if(req.method==='GET'&&route==='/api/stream') {
      const code=String(u.searchParams.get('room')||'').toUpperCase(), token=u.searchParams.get('token');const r=roomFor(code);if(!r)return error(res,404,'경기방이 없습니다.');const who=auth(r,token);if(!who)return error(res,403,'입장 정보가 유효하지 않습니다.');
      res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','Access-Control-Allow-Origin':'same-origin'});
      const client={res,who};r.clients.add(client);res.write('retry: 1500\n\n');res.write(`event: state\ndata: ${JSON.stringify(publicState(r,who))}\n\n`);req.on('close',()=>r.clients.delete(client));r.lastSeen=now();return;
    }
    if(req.method==='GET'&&route==='/api/qr.svg'){
      const code=String(u.searchParams.get('room')||'').toUpperCase();if(!validRoom(code)||!roomFor(code))return error(res,404,'경기방이 없습니다.');
      // Origin comes from the current browser location; restrict untrusted headers to valid host characters.
      const hostname=String(req.headers['x-forwarded-host']||req.headers.host||'').split(',')[0].trim();if(!/^[a-z0-9.:-]+$/i.test(hostname))return error(res,400,'주소 오류');
      const protocol=req.headers['x-forwarded-proto']==='https'?'https':req.socket.encrypted?'https':'http';const url=`${protocol}://${hostname}/?room=${code}`;
      const svg=svgQR(url);res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'",'X-Content-Type-Options':'nosniff'});return res.end(svg);
    }
    if(req.method==='GET'&&(route==='/'||route==='/index.html'||route==='/app.js'||route==='/style.css')){
      const file=path.join(ROOT,route==='/'?'index.html':route.replace(/^\//,'')); const data=fs.readFileSync(file);const ext=path.extname(file);
      res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream','Cache-Control':ext==='.html'?'no-store':'public, max-age=300','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});return res.end(data);
    }
    return error(res,404,'페이지를 찾을 수 없습니다.');
  } catch(e) {console.error(e);if(!res.headersSent)error(res,500,e?.message||'일시적인 오류가 발생했습니다.');}
});
setInterval(()=>{for(const [code,r] of rooms){advance(r);if(now()-r.lastSeen>ROOM_TTL){for(const c of r.clients)try{c.res.end();}catch{}rooms.delete(code);}}},250).unref();
setInterval(()=>{for(const r of rooms.values())for(const c of r.clients)try{c.res.write(': ping\n\n');}catch{r.clients.delete(c);}},20000).unref();
server.listen(PORT,'0.0.0.0',()=>console.log(`TapRun listening on port ${PORT}`));
