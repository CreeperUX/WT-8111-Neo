// WT 8111 Neo — C2 Console
// Server admin: persistent right panel room management, no viewer password needed

(() => {
'use strict';

const C = {
  bg:'#101416', surf:'#171d20', surf2:'#20282b', surf3:'#111719',
  line:'#334044', text:'#eef3ef', muted:'#9aaba7',
  accent:'#53c7d4', green:'#8ecf85', amber:'#e7bf62', red:'#e36b5e', purple:'#8858a8',
};

const AFFIL = {
  0:{name:'Friendly',stroke:'#31dfff',fill:'rgba(49,223,255,0.58)',ink:'#061014'},
  1:{name:'Hostile',stroke:'#ff6358',fill:'rgba(255,99,88,0.58)',ink:'#130706'},
  2:{name:'Neutral',stroke:'#93e979',fill:'rgba(147,233,121,0.54)',ink:'#081207'},
  3:{name:'Unknown',stroke:'#ffd25f',fill:'rgba(255,210,95,0.60)',ink:'#151006'},
};

const CLASS_NAMES = {0:'Aircraft',1:'Ground',2:'Objective',3:'Spawn',4:'Other'};

const ST = {
  server: window.location.hostname||'localhost',
  port: window.location.port||'17712',
  connected: false, roomId: null,
  tracks: new Map(), rois: new Map(),
  summary: {total:0,hostile:0,friendly:0,stale:0},
  selId: null,
  frameCount:0, lastFps:performance.now(), fps:0,
};

const $ = s => document.querySelector(s);
let D = {};

function cacheDom() {
  D.statusConn = $('#status-connection');
  D.statusRoom = $('#status-room');
  D.roomName   = $('#room-name');
  D.roomStats  = $('#room-stats');
  D.statusFps  = $('#status-fps');
  D.statTotal  = $('#stat-total');
  D.statHostile = $('#stat-hostile');
  D.statFriend = $('#stat-friendly');
  D.statStale  = $('#stat-stale');
  D.detailHint = $('#detail-hint');
  D.detailEmpty = $('#detail-empty');
  D.detailGrid = $('#detail-content');
  D.tracklist  = $('#tracklist-content');
  D.trackCount = $('#tracklist-count');
  D.canvas     = $('#tactical-map');
  D.loading    = $('#map-loading');
  D.roomList   = $('#room-list');
  D.roomListCount = $('#room-list-count');
  D.serverAddr = $('#server-addr');
  D.serverRelay = $('#server-relay-tpl');
  D.serverViewer = $('#server-viewer-tpl');
  D.createResult = $('#create-result');
  D.modalSet   = $('#modal-settings');
}

// ── Canvas ──
const cvs = document.getElementById('tactical-map');
const ctx = cvs.getContext('2d');
let W=0,H=0;
const MAP=65535;

function resize() {
  const r = cvs.parentElement.getBoundingClientRect();
  const dpr = devicePixelRatio||1;
  W=r.width; H=r.height;
  cvs.width=W*dpr; cvs.height=H*dpr;
  cvs.style.width=W+'px'; cvs.style.height=H+'px';
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener('resize', resize);

function sx(u){return(u/MAP)*W;}
function sy(u){return(u/MAP)*H;}

function drawNatoFrame(ctx,aff,cx,cy,w,h){
  const s=AFFIL[aff]||AFFIL[3];
  ctx.fillStyle=s.fill;ctx.strokeStyle=s.ink;ctx.lineWidth=1.2;
  if(aff===1){ctx.beginPath();ctx.moveTo(cx,cy-h*.75);ctx.lineTo(cx+w*.52,cy);ctx.lineTo(cx,cy+h*.75);ctx.lineTo(cx-w*.52,cy);ctx.closePath();}
  else if(aff===3){const r=h*.34;ctx.beginPath();ctx.moveTo(cx-r,cy-h*.5);ctx.quadraticCurveTo(cx,cy-h*.75,cx+r,cy-h*.5);ctx.quadraticCurveTo(cx+w*.5,cy-r,cx+w*.5,cy);ctx.quadraticCurveTo(cx+w*.5,cy+r,cx+r,cy+h*.5);ctx.quadraticCurveTo(cx,cy+h*.75,cx-r,cy+h*.5);ctx.quadraticCurveTo(cx-w*.5,cy+r,cx-w*.5,cy);ctx.quadraticCurveTo(cx-w*.5,cy-r,cx-r,cy-h*.5);ctx.closePath();}
  else{ctx.beginPath();aff===2?ctx.rect(cx-h/2,cy-h/2,h,h):ctx.rect(cx-w/2,cy-h/2,w,h);}
  ctx.fill();ctx.stroke();
}
function drawNatoIcon(ctx,cls,aff,cx,cy,w,h){
  const s=AFFIL[aff]||AFFIL[3];ctx.strokeStyle=s.ink;ctx.fillStyle='none';ctx.lineWidth=1.3;ctx.lineCap='round';
  if(cls<=1){ctx.beginPath();ctx.ellipse(cx,cy,w*.18,h*.19,0,0,Math.PI*2);ctx.stroke();}
  else if(cls===2){ctx.beginPath();ctx.arc(cx,cy,h*.2,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(cx-w*.2,cy);ctx.lineTo(cx+w*.2,cy);ctx.moveTo(cx,cy-h*.28);ctx.lineTo(cx,cy+h*.28);ctx.stroke();}
  else if(cls===3){ctx.beginPath();ctx.moveTo(cx,cy-h*.28);ctx.lineTo(cx+w*.18,cy+h*.22);ctx.lineTo(cx-w*.18,cy+h*.22);ctx.closePath();ctx.stroke();}
  else{ctx.beginPath();ctx.moveTo(cx-w*.14,cy-h*.18);ctx.lineTo(cx+w*.14,cy+h*.18);ctx.moveTo(cx+w*.14,cy-h*.18);ctx.lineTo(cx-w*.14,cy+h*.18);ctx.stroke();}
}
function drawTrack(t){
  const x=sx(t.x_u16||0),y=sy(t.y_u16||0),w=18,h=14,conf=(t.confidence_u8||255)/255,s=AFFIL[t.affiliation]||AFFIL[3];
  ctx.beginPath();ctx.arc(x,y,h*.75+2,0,Math.PI*2);ctx.strokeStyle=s.stroke;ctx.globalAlpha=conf*.4;ctx.lineWidth=1;ctx.stroke();ctx.globalAlpha=1;
  drawNatoFrame(ctx,t.affiliation,x,y,w,h);drawNatoIcon(ctx,t.class_id,t.affiliation,x,y,w,h);
  if(t.heading_i16){const rad=(t.heading_i16/100)*Math.PI/180;ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+Math.sin(rad)*(h*.75+8),y-Math.cos(rad)*(h*.75+8));ctx.strokeStyle=s.stroke;ctx.lineWidth=1;ctx.globalAlpha=.5;ctx.stroke();ctx.globalAlpha=1;}
  if(ST.selId===t.track_id){ctx.beginPath();ctx.arc(x,y,h*.75+8,0,Math.PI*2);ctx.strokeStyle=C.accent;ctx.lineWidth=2;ctx.setLineDash([3,3]);ctx.stroke();ctx.setLineDash([]);}
}
function drawROI(r){
  const cx=sx(r.center_x_u16||0),cy=sy(r.center_y_u16||0),rx=(r.radius_major_u16||200)/MAP*W,ry=(r.radius_minor_u16||200)/MAP*H,ang=((r.heading_i16||0)/100)*Math.PI/180,alpha=(r.confidence_u8||128)/255;
  ctx.save();ctx.translate(cx,cy);ctx.rotate(ang);ctx.beginPath();ctx.ellipse(0,0,Math.max(rx,1),Math.max(ry,1),0,0,Math.PI*2);ctx.strokeStyle='rgba(136,88,168,'+(alpha*.55)+')';ctx.setLineDash([6,4]);ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([]);ctx.restore();
  ctx.beginPath();ctx.arc(sx(r.anchor_x_u16||0),sy(r.anchor_y_u16||0),2.5,0,Math.PI*2);ctx.fillStyle='rgba(136,88,168,'+alpha+')';ctx.fill();
}
function drawGrid(){ctx.strokeStyle='rgba(238,243,239,0.10)';ctx.lineWidth=.5;const s=W/10;for(let i=1;i<10;i++){ctx.beginPath();ctx.moveTo(i*s,0);ctx.lineTo(i*s,H);ctx.stroke();ctx.beginPath();ctx.moveTo(0,i*s);ctx.lineTo(W,i*s);ctx.stroke();}}
function renderMap(){ctx.clearRect(0,0,W,H);ctx.fillStyle='#0b0e0f';ctx.fillRect(0,0,W,H);drawGrid();for(const r of ST.rois.values())drawROI(r);for(const t of ST.tracks.values())drawTrack(t);}

cvs.addEventListener('click',e=>{
  const r=cvs.getBoundingClientRect(),mx=e.clientX-r.left,my=e.clientY-r.top;
  let best=null,bestD=1/0;
  for(const t of ST.tracks.values()){const x=sx(t.x_u16||0),y=sy(t.y_u16||0),d=Math.hypot(x-mx,y-my);if(d<16&&d<bestD){best=t;bestD=d;}}
  ST.selId=best?best.track_id:null;updateDetail();updateTrackList();
});

function updateDetail(){
  const t=ST.tracks.get(ST.selId);
  if(!t){D.detailEmpty.style.display='block';D.detailGrid.style.display='none';D.detailHint.textContent='click map';return;}
  D.detailEmpty.style.display='none';D.detailGrid.style.display='grid';D.detailHint.textContent=t.track_id;
  const a=AFFIL[t.affiliation]||AFFIL[3],cl=CLASS_NAMES[t.class_id]||'Other';
  const age=t.last_seen_ms_ago?(t.last_seen_ms_ago/1000).toFixed(1)+'s':'now';
  const tage=t.total_age_ms?(t.total_age_ms/1000).toFixed(2)+'s':'—';
  D.detailGrid.innerHTML='<span class=k>Affiliation</span><span class=v style=color:'+a.stroke+'>'+a.name+'</span><span class=k>Class</span><span class=v>'+cl+'</span><span class=k>Position</span><span class=v>'+(t.x_u16||0)+', '+(t.y_u16||0)+'</span><span class=k>Heading</span><span class=v>'+(t.heading_i16?(t.heading_i16/100).toFixed(1)+'°':'—')+'</span><span class=k>Velocity</span><span class=v>'+(t.vx_i16||0)+', '+(t.vy_i16||0)+'</span><span class=k>Confidence</span><span class=v>'+(t.confidence_u8||0)+'/255</span><span class=k>Data Age</span><span class=v>'+tage+'</span><span class=k>Last Seen</span><span class=v>'+age+'</span><span class=k>Sources</span><span class=v>'+(t.source_count||0)+' ('+(t.contributing_clients||0)+' clients)</span>';
}
function updateTrackList(){
  const a=Array.from(ST.tracks.values());D.trackCount.textContent=a.length;
  D.tracklist.innerHTML=a.map(t=>{
    const af=AFFIL[t.affiliation]||AFFIL[3],cl=CLASS_NAMES[t.class_id]||'Other',sel=t.track_id===ST.selId?' selected':'';
    return '<div class="track-item'+sel+'" data-tid="'+t.track_id+'"><span class=track-dot style=background:'+af.stroke+'></span><span class=track-item-name>'+af.name+'</span><span class=track-item-sub>'+cl+' · '+(t.confidence_u8||0)+'/255</span></div>';
  }).join('');
  D.tracklist.querySelectorAll('.track-item').forEach(el=>el.addEventListener('click',()=>{ST.selId=el.dataset.tid;updateDetail();updateTrackList();}));
}

// ── Protobuf parser ──
function readVarint(buf,off){let r=0n,s=0n,p=off;while(p<buf.length){const b=BigInt(buf[p]);p++;r|=(b&0x7Fn)<<s;s+=7n;if(!(b&0x80n))break;}return{v:Number(r),p};}
function int32(v){return v>0x7FFFFFFF?v-0x100000000:v;}
function readStr(buf,off,len){return new TextDecoder().decode(buf.slice(off,off+len));}

function parseFusedTrack(data){
  const t={track_id:'',label_id:0,class_id:0,affiliation:0,x_u16:0,y_u16:0,heading_i16:0,vx_i16:0,vy_i16:0,confidence_u8:0,last_seen_ms_ago:0,source_count:0,flags:0,total_age_ms:0,contributing_clients:0};
  let p=0;
  while(p<data.length){const tag=data[p];if(!tag)break;p++;const fn=tag>>3,wt=tag&7;
    if(wt===0){const vr=readVarint(data,p);p=vr.p;
      switch(fn){case 2:t.label_id=vr.v;break;case 3:t.class_id=vr.v;break;case 4:t.affiliation=vr.v;break;case 5:t.x_u16=vr.v;break;case 6:t.y_u16=vr.v;break;case 7:t.heading_i16=int32(vr.v);break;case 8:t.vx_i16=int32(vr.v);break;case 9:t.vy_i16=int32(vr.v);break;case 10:t.confidence_u8=vr.v;break;case 11:t.last_seen_ms_ago=vr.v;break;case 12:t.source_count=vr.v;break;case 13:t.flags=vr.v;break;case 14:t.total_age_ms=vr.v;break;case 15:t.contributing_clients=vr.v;break;}
    }else if(wt===2){const vr=readVarint(data,p);const len=vr.v;p=vr.p;if(fn===1)t.track_id=readStr(data,p,len);p+=len;}
  }
  return t.track_id?t:null;
}
function parseROI(data){
  const r={track_id:'',center_x_u16:0,center_y_u16:0,anchor_x_u16:0,anchor_y_u16:0,radius_major_u16:0,radius_minor_u16:0,heading_i16:0,expires_in_ms:0,confidence_u8:0};
  let p=0;
  while(p<data.length){const tag=data[p];if(!tag)break;p++;const fn=tag>>3,wt=tag&7;
    if(wt===0){const vr=readVarint(data,p);p=vr.p;
      switch(fn){case 2:r.center_x_u16=vr.v;break;case 3:r.center_y_u16=vr.v;break;case 4:r.anchor_x_u16=vr.v;break;case 5:r.anchor_y_u16=vr.v;break;case 6:r.radius_major_u16=vr.v;break;case 7:r.radius_minor_u16=vr.v;break;case 8:r.heading_i16=int32(vr.v);break;case 9:r.expires_in_ms=vr.v;break;case 10:r.confidence_u8=vr.v;break;}
    }else if(wt===2){const vr=readVarint(data,p);const len=vr.v;p=vr.p;if(fn===1)r.track_id=readStr(data,p,len);p+=len;}
  }
  return r.track_id?r:null;
}
function parseSummary(data){const s={total:0,hostile:0,friendly:0,stale:0};let p=0;while(p<data.length){const tag=data[p];if(!tag)break;p++;if((tag&7)===0){const vr=readVarint(data,p);p=vr.p;switch(tag>>3){case 1:s.total=vr.v;break;case 2:s.hostile=vr.v;break;case 3:s.friendly=vr.v;break;case 4:s.stale=vr.v;break;}}}return s;}

function parseSnapshot(data){
  const tracks=new Map(),rois=new Map();let summary=ST.summary,p=0;
  while(p<data.length){const tag=data[p];if(!tag)break;p++;const fn=tag>>3,wt=tag&7;
    if(wt===2){const vr=readVarint(data,p);const len=vr.v;p=vr.p;const sub=data.slice(p,p+len);p+=len;
      if(fn===2){let sp=0;while(sp<sub.length){const t2=sub[sp];if(!t2)break;sp++;const fn2=t2>>3,wt2=t2&7;
        if(wt2===2){const vr2=readVarint(sub,sp);const len2=vr2.v;sp=vr2.p;const s2=sub.slice(sp,sp+len2);sp+=len2;
          if(fn2===6){const tr=parseFusedTrack(s2);if(tr)tracks.set(tr.track_id,tr);}
          else if(fn2===7){const ro=parseROI(s2);if(ro)rois.set(ro.track_id,ro);}
          else if(fn2===8){summary=parseSummary(s2);}}}}}}}
  ST.tracks=tracks;ST.rois=rois;ST.summary=summary;ST.frameCount++;
  const now=performance.now();if(now-ST.lastFps>1000){ST.fps=Math.round(ST.frameCount/((now-ST.lastFps)/1000));ST.frameCount=0;ST.lastFps=now;}
  updateUI();
}

function updateUI(){
  D.statTotal.textContent=ST.summary.total;D.statHostile.textContent=ST.summary.hostile;
  D.statFriend.textContent=ST.summary.friendly;D.statStale.textContent=ST.summary.stale;
  D.statusFps.innerHTML='<span>◷</span> '+ST.fps+' fps';
  updateDetail();updateTrackList();renderMap();
}
function renderLoop(){requestAnimationFrame(renderLoop);if(ST.connected&&ST.tracks.size>0)renderMap();}

// ── WebSocket (no password needed for viewer) ──
let ws=null,reconnect=null;

function monitorRoom(roomId){
  if(ws&&ws.readyState===WebSocket.OPEN){ws.close();ws=null;}
  if(reconnect){clearTimeout(reconnect);reconnect=null;}
  ST.roomId=roomId;
  const proto=location.protocol==='https:'?'wss:':'ws:';
  const url=proto+'//'+ST.server+':'+ST.port+'/ws/rooms/'+roomId+'/viewer';
  D.loading.style.display='flex';D.loading.querySelector('span').textContent='Connecting to '+roomId+'...';

  ws=new WebSocket(url);ws.binaryType='arraybuffer';
  ws.onopen=()=>{
    ST.connected=true;
    D.statusConn.innerHTML='<span>●</span> Monitoring';D.statusConn.className='status-pill connected';
    D.roomName.textContent=roomId;D.loading.style.display='none';
    updateRoomList();
  };
  ws.onmessage=e=>parseSnapshot(new Uint8Array(e.data));
  ws.onclose=()=>{
    ST.connected=false;D.statusConn.innerHTML='<span>●</span> Disconnected';D.statusConn.className='status-pill disconnected';
    D.loading.style.display='flex';D.loading.querySelector('span').textContent='Reconnecting...';
    reconnect=setTimeout(()=>monitorRoom(roomId),5000);
  };
}

// ── Room Management ──
function serverBase(){return ST.server+':'+ST.port;}
function updateServerInfo(){
  const b=serverBase();D.serverAddr.textContent=b;
  D.serverRelay.textContent='ws://'+b+'/ws/rooms/{room_id}/relay';
  D.serverViewer.textContent='ws://'+b+'/ws/rooms/{room_id}/viewer';
}

async function createRoom(){
  const id=$('#room-id-input').value.trim(),pw=$('#room-password-input').value;
  if(!id)return;
  try{
    const r=await fetch('/api/rooms',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room_id:id,password:pw||null})});
    const d=await r.json();
    if(d.room_id){
      const b=serverBase();D.createResult.style.display='block';
      D.createResult.innerHTML='<div class=result-title>Room "'+d.room_id+'" created</div><div class=result-grid>'+
        '<span class=rk>Room ID</span><span class="rv copy-room">'+d.room_id+'</span>'+
        (pw?'<span class=rk>Password</span><span class="rv copy-room">'+pw+'</span>':'')+
        '<span class=rk>Relay URL</span><span class="rv copy-room">ws://'+b+'/ws/rooms/'+d.room_id+'/relay</span>'+
        '<span class=rk>Viewer URL</span><span class="rv copy-room">ws://'+b+'/ws/rooms/'+d.room_id+'/viewer</span></div>';
      D.createResult.querySelectorAll('.copy-room').forEach(el=>el.addEventListener('click',()=>{navigator.clipboard.writeText(el.textContent).then(()=>{const fb=document.createElement('span');fb.className='copied-feedback';fb.textContent='copied';el.appendChild(fb);setTimeout(()=>fb.remove(),1500);}).catch(()=>{});}));
      monitorRoom(d.room_id);await updateRoomList();
      $('#room-password-input').value='';$('#room-id-input').value='';
    }
  }catch(e){D.createResult.style.display='block';D.createResult.innerHTML='<span style=color:var(--red)>Failed to create room</span>';}
}

async function deleteRoom(roomId,el){
  if(!confirm('Delete room "'+roomId+'"?'))return;
  try{
    const r=await fetch('/api/rooms/'+roomId,{method:'DELETE'});
    if(r.ok){
      if(ST.roomId===roomId){if(ws){ws.close();ws=null;}ST.roomId=null;ST.connected=false;D.statusConn.innerHTML='<span>●</span> No Room';D.statusConn.className='status-pill disconnected';D.roomName.textContent='—';D.roomStats.textContent='';D.loading.style.display='flex';D.loading.querySelector('span').textContent='Select a room to monitor';}
      await updateRoomList();
    }
  }catch(e){}
}

async function updateRoomList(){
  try{
    const r=await fetch('/api/rooms');const rooms=await r.json();D.roomListCount.textContent=rooms.length;
    D.roomList.innerHTML=rooms.length===0?'<span style=color:var(--muted);font-size:0.72rem>No active rooms</span>':rooms.map(rr=>{
      const isActive=rr.room_id===ST.roomId,cls=isActive?'room-item-panel active':'room-item-panel';
      return '<div class="'+cls+'"><div><div class=room-item-name>'+(rr.has_password?'🔒':'◫')+' '+rr.room_id+'</div><div class=room-item-meta>↻'+rr.relay_count+' · 👁'+rr.viewer_count+' · '+rr.created_secs_ago+'s</div></div><button class="room-action-btn monitor" data-monitor="'+rr.room_id+'">'+(isActive?'Active':'Monitor')+'</button><button class="room-action-btn delete" data-delete="'+rr.room_id+'">✕</button></div>';
    }).join('');
    D.roomList.querySelectorAll('[data-monitor]').forEach(btn=>btn.addEventListener('click',()=>{const rid=btn.dataset.monitor;if(rid!==ST.roomId)monitorRoom(rid);}));
    D.roomList.querySelectorAll('[data-delete]').forEach(btn=>btn.addEventListener('click',e=>{e.stopPropagation();deleteRoom(btn.dataset.delete);}));
  }catch(e){D.roomList.innerHTML='<span style=color:var(--red);font-size:0.72rem>Load failed</span>';}
}

async function loadSettings(){
  try{
    const r=await fetch('/api/config');const c=await r.json();
    $('#settings-content').innerHTML='<div class=metric-grid><span class=k>Fusion Interval</span><span class=v>'+c.fusion_interval_ms+'ms</span><span class=k>Track History</span><span class=v>'+c.track_history_secs+'s</span><span class=k>ROI TTL</span><span class=v>'+c.roi_ttl_secs+'s</span><span class=k>Max Rooms</span><span class=v>'+c.max_rooms+'</span><span class=k>Clients/Room</span><span class=v>'+c.max_clients_per_room+'</span></div>';
  }catch(e){$('#settings-content').innerHTML='<span style=color:var(--red)>Failed to load</span>';}
}

// ── Events ──
function bindEvents(){
  $('#btn-create-room').addEventListener('click',createRoom);
  $('#btn-refresh-rooms').addEventListener('click',updateRoomList);
  $('#btn-settings').addEventListener('click',()=>{D.modalSet.classList.remove('hidden');loadSettings();});
  $('#btn-close-settings').addEventListener('click',()=>D.modalSet.classList.add('hidden'));
  D.modalSet.addEventListener('click',e=>{if(e.target===e.currentTarget)D.modalSet.classList.add('hidden');});
  $('#room-id-input').addEventListener('keydown',e=>{if(e.key==='Enter')createRoom();});
  D.serverRelay.addEventListener('click',()=>{navigator.clipboard.writeText(D.serverRelay.textContent).catch(()=>{});});
  D.serverViewer.addEventListener('click',()=>{navigator.clipboard.writeText(D.serverViewer.textContent).catch(()=>{});});
}

// ── Init ──
function init(){
  ST.server=window.location.hostname||'localhost';ST.port=window.location.port||'17712';
  cacheDom();resize();renderMap();bindEvents();updateServerInfo();updateRoomList();
  requestAnimationFrame(renderLoop);
  // Auto-refresh room list every 10s
  setInterval(updateRoomList,10000);
}
init();
})();
