#!/usr/bin/env node
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 8901;
const CONFIG = process.env.CONFIG_PATH || '/volume2/docker/grid-stream/config.env';
const GRID_CONTAINER = process.env.GRID_CONTAINER || 'grid-stream';
const MULTIVIEW = 'http://douyu-multiview:8900';
const PROXY_API = process.env.PROXY_API || 'http://stream-proxy:8888';
// 转发到 stream-proxy 的请求
function proxyReq(method, p, data) {
  return new Promise((resolve) => {
    const u = new URL(PROXY_API + p);
    const payload = data ? JSON.stringify(data) : null;
    const r2 = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      method, headers: { 'Content-Type': 'application/json' },
      timeout: 8000,
    }, (res2) => {
      let d = '';
      res2.on('data', c => d += c);
      res2.on('end', () => { try { resolve({ status: res2.statusCode, json: JSON.parse(d) }); } catch (e) { resolve({ status: res2.statusCode, json: null }); } });
    });
    r2.on('error', (e) => resolve({ status: 0, json: { error: e.message } }));
    r2.on('timeout', () => { r2.destroy(); resolve({ status: 0, json: { error: 'timeout' } }); });
    if (payload) r2.write(payload);
    r2.end();
  });
}
const IMAGES_DIR = process.env.IMAGES_DIR || '/volume2/docker/grid-stream/images';

function sh(cmd, ms) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: ms || 30000 }, (err, stdout) => resolve({ err, stdout: stdout || '' }));
  });
}

function escVal(v){
  return "'" + String(v).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/'/g, "'\\''") + "'";
}
function saveCfg(cfg){
  const lines = Object.entries(cfg).map(([k,v])=>k+'='+escVal(v));
  fs.writeFileSync(CONFIG, lines.join('\n')+'\n');
}
function unq(s){
  s = s.trim();
  if(s.length>=2 && s[0]==="'" && s[s.length-1]==="'")
    return s.slice(1,-1).replace(/'\\''/g, "'").replace(/\\(\\|n)/g, function(m,c){ return c==='n' ? '\n' : '\\'; });
  return s;
}
function getCfg() {
  const cfg = {};
  let txt = '';
  try { txt = fs.readFileSync(CONFIG, 'utf-8'); } catch(e) { return cfg; }
  for (const line of txt.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) cfg[line.slice(0, i).trim()] = unq(line.slice(i + 1));
  }
  return cfg;
}
async function syncFromMultiview(){
  try{
    const r = await new Promise((resolve)=>{
      const req = http.get(MULTIVIEW+'/api/rooms',{timeout:5000},(res)=>{
        let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){resolve([]);} });
      });
      req.on('error',()=>resolve([])); req.on('timeout',()=>{req.destroy();resolve([]);});
    });
    if(!Array.isArray(r)||!r.length) return;
    const cfg = getCfg();
    const cur = (cfg.ROOMS||'').split(',').filter(Boolean);
    let curEn = (cfg.ENABLED||'').split(',').filter(s=>s==='0'||s==='1');
    let curVol = (cfg.VOLUMES||'').split(',').filter(s=>s!=='');
    while(curEn.length<cur.length) curEn.push('1');
    curEn = curEn.slice(0,cur.length);
    while(curVol.length<cur.length) curVol.push('1.0');
    curVol = curVol.slice(0,cur.length);
    let changed=false;
    const added=[];
    const fetched=[];
    for(const rid of r){
      if(!/^[0-9]+$/.test(String(rid))) continue;
      const s=String(rid);
      if(!fetched.includes(s)) fetched.push(s);
      if(!cur.includes(s)){
        cur.push(s); curEn.push('0'); curVol.push('1.0'); changed=true; added.push(s);
      }
    }
    // 2026-10-20:镜像同步——8900 已删的房间 8901 跟着删(旧版只加不减,僵尸房间越攒越多,以 8900 为准)
    const removed=[];
    for(let i=cur.length-1;i>=0;i--){
      if(!fetched.includes(cur[i])){
        removed.push(cur[i]);
        cur.splice(i,1); curEn.splice(i,1); curVol.splice(i,1); changed=true;
      }
    }
    if(changed){
      cfg.ROOMS=cur.join(','); cfg.ENABLED=curEn.join(','); cfg.VOLUMES=curVol.join(',');
      if(removed.length && cfg.LABELS){
        cfg.LABELS=cfg.LABELS.split(';').filter(e=>{
          if(!e) return false;
          const eq=e.indexOf('=');
          const k=(eq>0?e.slice(0,eq):e).trim();
          return !removed.includes(k);
        }).join(';');
      }
      saveCfg(cfg);
      if(added.length) console.log('从 8900 同步新增房间:', added.join(','));
      if(removed.length) console.log('从 8900 同步删除房间:', removed.join(','));
      // 被删房间占用的 slot 一并清空,避免野 slot 继续拉已删房间
      for(const rid of removed){
        try{
          const sr = await proxyReq('GET','/api/slots');
          const slots = (sr && sr.json && sr.json.slots) || {};
          for(const k of Object.keys(slots)){
            if(String(slots[k])===String(rid)){
              const idx = parseInt(k.replace('slot',''),10);
              if(!isNaN(idx)) await proxyReq('POST','/api/slots',{slot:idx, rid:null});
            }
          }
        }catch(e){}
      }
    }
  }catch(e){}
}
function getLabels() {
  const m = {};
  for (const e of (getCfg().LABELS || '').split(';')) {
    const i = e.indexOf('=');
    if (i > 0) m[e.slice(0, i).trim()] = e.slice(i + 1);
  }
  return m;
}
function getRooms() {
  const cfg = getCfg();
  const rids = (cfg.ROOMS || '').split(',').filter(Boolean);
  const ens = (cfg.ENABLED || '').split(',');
  const vols = (cfg.VOLUMES || '').split(',');
  const lbs = getLabels();
  return rids.map((rid, i) => { const v=parseFloat(vols[i]); return { rid, enabled: (ens[i] || '1') === '1', volume: isNaN(v)?1.0:v, label: lbs[rid] || '' }; });
}

function getLayout() { return getCfg().LAYOUT || 'auto'; }

function getRtmpUrl() { return getCfg().RTMP_URL || ''; }

async function setConfig(rooms, rtmpUrl, layout) {
  const cfg = getCfg();
  const rids = rooms.map(r => typeof r === 'string' ? r : r.rid);
  const ens = rooms.map(r => typeof r === 'string' ? '1' : (r.enabled ? '1' : '0'));
  const vols = rooms.map(r => { if(typeof r === 'string') return '1.0'; const v=r.volume; return String((v===undefined||v===null||isNaN(v))?1.0:v); });
  cfg.ROOMS = rids.join(',');
  cfg.ENABLED = ens.join(',');
  cfg.VOLUMES = vols.join(',');
  cfg.RTMP_URL = rtmpUrl;
  if (layout) cfg.LAYOUT = layout;
  // 文字标签按房间号保留:显式传入 label 才改,删掉的房间清掉标签
  const lbs = getLabels();
  const keep = new Set(rids);
  for (const k of Object.keys(lbs)) if (!keep.has(k)) delete lbs[k];
  for (const r of rooms) {
    if (typeof r !== 'string' && r.label !== undefined) {
      if (r.label) lbs[r.rid] = r.label; else delete lbs[r.rid];
    }
  }
  cfg.LABELS = Object.entries(lbs).map(([k, v]) => k + '=' + v).join(';');
  const txt = Object.keys(cfg).map(k => k + '=' + escVal(cfg[k])).join('\n') + '\n';
  fs.writeFileSync(CONFIG, txt);
  // 不自动重启,由"应用新布局"按钮手动触发
}

async function containerStatus(name) {
  // 2026-10-18:docker 客户端太老,改用 API
  try{
    const r = await sh("curl -s --unix-socket /var/run/docker.sock http://localhost/containers/" + name + "/json 2>&1");
    const j = JSON.parse(r.stdout||'{}');
    if(j.State){
      return { running: j.State.Status==='running', started: j.State.StartedAt };
    }
  }catch(e){}
  return { running: false };
}

// 2026-10-20: 解析 ffmpeg 最后报错，转成人话
async function getFfmpegError() {
  try{
    const r = await sh('docker exec ' + GRID_CONTAINER + ' sh -c "tail -40 /app/logs/ffmpeg.log 2>/dev/null" | tr "\\r" "\\n" | grep -a -E "error|Error|failed|Failed|refused|denied|Invalid|expired" | grep -a -v "bitrate=" | tail -5', 5000);
    const lines = String(r.stdout||'').trim().split('\n').filter(Boolean);
    if(!lines.length) return '';
    const last = lines[lines.length-1];
    // wsTime 过期
    let m = last.match(/wsTime=([0-9a-fA-F]+)/);
    if(m){
      const t = parseInt(m[1], 16) * 1000;
      if(t < Date.now()) return '推流 key 已过期（wsTime），请更新推流地址';
    }
    if(/Input\/output error/i.test(last)) return '推流连接失败（I/O 错误），可能是 key 过期或网络问题';
    if(/Connection refused/i.test(last)) return '推流服务器拒绝连接';
    if(/Failed to resolve|Name or service not known/i.test(last)) return 'DNS 解析失败，检查网络';
    if(/Conversion failed/i.test(last)) return 'ffmpeg 转码失败：' + last.slice(-80);
    if(/No such file/i.test(last)) return '输入流不存在：' + last.slice(-80);
    if(/Invalid data|Invalid argument/i.test(last)) return 'ffmpeg 参数/数据错误：' + last.slice(-80);
    return 'ffmpeg 报错：' + last.slice(-100);
  }catch(e){ return ''; }
}

function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
  });
}

async function roomInfo(rid) {
  const info = await getJson(MULTIVIEW + '/api/room?rid=' + rid);
  let name = rid, live = false;
  if (info) {
    name = info.name || info.nickname || info.uname || rid;
    live = !!(info.isLive || info.live);
  }
  return { rid, name, live };
}

const PAGE = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>推流管理</title>
<style>
body{font-family:system-ui;background:#1a1a2e;color:#eee;margin:0;padding:20px}
.card{background:#16213e;border-radius:10px;padding:16px;margin-bottom:16px}
h2{margin:0 0 12px;font-size:16px}
.status{font-size:20px;font-weight:bold}
.on{color:#4ade80}.off{color:#f87171}
button{background:#0f3460;color:#fff;border:0;border-radius:6px;padding:8px 16px;margin-right:8px;cursor:pointer}
button.danger{background:#7f1d1d}
input{background:#0f172a;color:#eee;border:1px solid #334155;border-radius:6px;padding:8px;width:200px}
.room{display:flex;align-items:center;gap:12px;background:#0f172a;border-radius:8px;padding:4px 6px;margin-bottom:4px}.room>div:first-child{display:flex;align-items:center;gap:3px}.room input[type=checkbox]{margin:0;flex-shrink:0}.room>div:last-child{display:flex;gap:4px}
.badge{font-size:12px;padding:2px 8px;border-radius:10px;background:#334155}
.badge.live{background:#166534}
.meta{color:#94a3b8;font-size:12px}
</style></head><body>
<h1>推流管理</h1>
<div class="card"><h2>推流状态</h2>
<div class="status" id="st">...</div>
<div class="meta" id="stMeta"></div>
<div class="meta" id="stErr" style="display:none;color:#c00;margin-top:4px"></div>
<div class="meta" id="healthMeta" style="margin-top:2px"></div><br>
<button onclick="ctl('start')">启动</button>
<button onclick="ctl('stop')">停止</button>
<button onclick="applyLayout()" style="background:#2a7;">应用并重启</button>
</div>
<div class="card"><h2>画面布局</h2>
<div id="layout" data-value="auto" style="display:flex;gap:8px;flex-wrap:wrap">
<button data-val="auto" onclick="setLayout('auto')" style="padding:8px 16px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#eee;cursor:pointer">自动(按数量)</button>
<button data-val="grid" onclick="setLayout('grid')" style="padding:8px 16px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#eee;cursor:pointer">田字格</button>
<button data-val="side" onclick="setLayout('side')" style="padding:8px 16px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#eee;cursor:pointer">左右并排</button>
<button data-val="stack" onclick="setLayout('stack')" style="padding:8px 16px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#eee;cursor:pointer">上下并排</button>
<button data-val="pip" onclick="setLayout('pip')" style="padding:8px 16px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#eee;cursor:pointer">画中画</button>
<button data-val="focus" onclick="setLayout('focus')" style="padding:8px 16px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#eee;cursor:pointer">焦点(第一路大)</button>
<button data-val="single" onclick="setLayout('single')" style="padding:8px 16px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#eee;cursor:pointer">单路(只第一路)</button>
</div>
<div class="meta">第一路为房间列表第一个</div>
<div class="meta" style="margin-top:8px">图层列表 <span style="color:#666">(标题图片混排,越靠上越靠前,点「应用图层」约15秒生效,不用点「应用新布局」)</span><div id='layerList' style='margin-top:4px'></div><div style='margin-top:4px'><button onclick='addTitleRow()'>＋ 添加标题</button> <button onclick='document.getElementById("imgFileInput").click()'>＋ 添加图片</button><input type='file' id='imgFileInput' accept='.png,.jpg,.jpeg,.gif,.webp,.bmp' style='display:none' onchange='uploadImageFile(this)'> <button id='applyTitleBtn' onclick='applyLayersNow()' title='应用全部图层,约15秒生效'>应用标题</button></div></div>
<div class="meta" style="margin-top:8px"><label><input type="checkbox" id="labelSw" onchange="toggleLabels(this.checked)" style="width:auto;vertical-align:middle"> 每路标签</label>
  <label style="margin-left:12px"><input type="checkbox" id="giftSw" onchange="toggleGiftLabels(this.checked)" style="width:auto;vertical-align:middle"> 礼物总额</label><br><label style="font-size:12px;color:#888">礼物数据源地址 <input id="giftApiUrl" style="width:380px;background:#0f172a;color:#eee;border:1px solid #334155;border-radius:6px;padding:6px" placeholder="例:http://192.168.1.24:18023/api/public/rooms，留空=禁用"> <button onclick="saveGiftApiUrl()" style="padding:6px 12px">保存</button></label> <span style="font-size:12px;color:#666">(沙箱每60秒从此地址拉总额，?room=房间号自动拼接)</span><span style="color:#666;font-size:12px"> (每路一角显示今日礼物总额,60秒刷新)</span> 位置 <select id='labelPos' onchange='saveTextStyle()' style='background:#0f172a;color:#eee;border:1px solid #334155;border-radius:6px;padding:6px'><option value='bl'>左下</option><option value='br'>右下</option><option value='tl'>左上</option><option value='tr'>右上</option><option value='tc'>顶部居中</option><option value='bc'>底部居中</option></select> 字号 <input id='labelSize' type='number' min='10' max='72' placeholder='自动' style='width:56px' onchange='saveTextStyle()'>px 颜色 <input id='labelColor' type='color' value='#ffffff' onchange='saveTextStyle()' style='width:40px;padding:2px;vertical-align:middle'> <span style="color:#666">(改完点「应用新布局」重启生效)</span></div></select> <span style="font-size:12px;color:#888;margin-left:8px">当前生效: <b id="curLayout">-</b></span>
<div style="display:flex;gap:16px;margin-top:12px">
<div style="flex:1">
<div style="font-size:12px;color:#888;margin-bottom:4px">新布局预览(待应用)</div>
<div id="previewWrap" style="position:relative">
<div id="preview" style="display:grid;gap:4px;aspect-ratio:16/9;background:#000;border-radius:8px;overflow:hidden;font-size:12px"></div>
</div>
<div style="font-size:12px;color:#888;margin-top:4px">拖拽房间调整位置;标题虚线框可拖动定位</div>
</div>
<div style="flex:1">
<div style="font-size:12px;color:#888;margin-bottom:4px">当前布局(正在推)</div>
<div id="previewCurWrap" style="position:relative">
<div id="previewCur" style="display:grid;gap:4px;aspect-ratio:16/9;background:#000;border-radius:8px;overflow:hidden;font-size:12px"></div>
</div>
</div>
</div>

</div>
<div class="card"><h2>Slot 分配 <span class="meta">换房间不重启推流，2秒内生效</span></h2>
<div id="slots"></div>
</div>
<div class="card"><h2>房间 (<span id="cnt"></span>/10)</h2>
<div id="rooms" style="display:grid;grid-template-rows:repeat(5,auto);grid-auto-flow:column;gap:6px 16px"></div>
<div><input id="newRid" placeholder="房间号"><button onclick="addRoom()">添加</button> <button onclick="syncNow()">从8900同步</button></div>
</div>
<div class="card"><h2>推流目标</h2>
<input id="rtmp" style="width:400px" placeholder="rtmp://...">
<button onclick="saveRtmp()">保存目标</button>
<div class="meta">当前: <span id="curRtmp"></span></div>
<div style="margin-top:12px;padding-top:12px;border-top:1px solid #334155">
<div style="font-size:14px;margin-bottom:8px">推流画质</div>
<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
<span>码率 <select id="qBitrate" style="background:#0f172a;color:#eee;border:1px solid #334155;border-radius:6px;padding:6px">
<option value="1000k">1000k</option><option value="1500k">1500k</option><option value="2000k">2000k</option><option value="4000k">4000k</option><option value="6000k">6000k</option><option value="8000k">8000k</option>
</select></span>
<span>分辨率 <select id="qRes" style="background:#0f172a;color:#eee;border:1px solid #334155;border-radius:6px;padding:6px">
<option value="720p">720p</option><option value="1080p">1080p</option>
</select></span>
<span>帧率 <select id="qFps" style="background:#0f172a;color:#eee;border:1px solid #334155;border-radius:6px;padding:6px">
<option value="25">25fps</option><option value="30">30fps</option><option value="60">60fps</option>
</select></span>
<button onclick="saveQuality()" style="background:#0ea5e9;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer">保存画质</button>
</div>
<div class="meta">改完点「应用新布局」重启生效</div>
<div style="font-size:14px;margin:12px 0 8px">拉流画质</div>
<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
<span>清晰度 <select id="qPullRate" style="background:#0f172a;color:#eee;border:1px solid #334155;border-radius:6px;padding:6px">
<option value="1">流畅(标清)</option><option value="2">高清</option><option value="3">超清</option><option value="0">原画</option>
</select></span>
<button onclick="savePullRate()" style="background:#0ea5e9;color:#fff;border:0;border-radius:6px;padding:6px 12px;cursor:pointer">保存</button>
</div>
<div class="meta">保存后自动重启拉流代理生效</div>


<script>
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
async function api(p,m,b){const c=new AbortController();const t=setTimeout(()=>c.abort(),10000);try{const r=await fetch(p,{method:m||'GET',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined,signal:c.signal});clearTimeout(t);return r.json();}catch(e){clearTimeout(t);throw e;}}
function renderPreview(rooms, layout, targetId){
  const pv = document.getElementById(targetId||'preview');
  if(!pv) return;
  const enabled = rooms.filter(r=>r.enabled);
  if(!enabled.length){ pv.innerHTML='<div style="color:#666;display:flex;align-items:center;justify-content:center">无启用房间</div>'; return; }
  let cols=2, rows=2, focus=false, single=false, pip=false, autoCells=null;
  const n = enabled.length;
  if(layout==='single'||n===1){ single=true; }
  else if(layout==='focus'){ focus=true; }
  else if(layout==='pip'){ pip=true; }
  else if(layout==='side'){ cols=2; rows=Math.ceil(n/2); }
  else if(layout==='stack'){ cols=Math.ceil(n/2); rows=2; }
  else if(layout==='grid'){ cols=2; rows=2; }
  else {
    // 2026-10-20:auto 与后端 grid.sh 一致 [x%,y%,w%,h%]
    const A={
      1:[[0,0,100,100]],
      2:[[0,0,50,100],[50,0,50,100]],
      3:[[0,0,50,50],[50,0,50,50],[0,50,100,50]],
      4:[[0,0,50,50],[50,0,50,50],[0,50,50,50],[50,50,50,50]],
      5:[[0,0,33.33,50],[33.33,0,33.33,50],[66.66,0,33.34,50],[0,50,50,50],[50,50,50,50]],
      6:[[0,0,33.33,50],[33.33,0,33.33,50],[66.66,0,33.34,50],[0,50,33.33,50],[33.33,50,33.33,50],[66.66,50,33.34,50]],
      7:[[0,0,33.33,33.33],[33.33,0,33.33,33.33],[66.66,0,33.34,33.33],[0,33.33,33.33,33.33],[33.33,33.33,33.33,33.33],[66.66,33.33,33.34,33.33],[0,66.66,100,33.34]],
      8:[[0,0,33.33,33.33],[33.33,0,33.33,33.33],[66.66,0,33.34,33.33],[0,33.33,33.33,33.33],[33.33,33.33,33.33,33.33],[66.66,33.33,33.34,33.33],[0,66.66,50,33.34],[50,66.66,50,33.34]],
      9:[[0,0,33.33,33.33],[33.33,0,33.33,33.33],[66.66,0,33.34,33.33],[0,33.33,33.33,33.33],[33.33,33.33,33.33,33.33],[66.66,33.33,33.34,33.33],[0,66.66,33.33,33.34],[33.33,66.66,33.33,33.34],[66.66,66.66,33.34,33.34]]
    };
    if(A[n]) autoCells=A[n]; else { cols=5; rows=2; }
  }
  pv.style.gridTemplateColumns = single?'1fr':focus?'3fr 1fr':(pip||autoCells)?'1fr':'repeat('+cols+',1fr)';
  pv.style.gridTemplateRows = single?'1fr':focus?'1fr':(pip||autoCells)?'1fr':'repeat('+rows+',1fr)';
  pv.style.position = (pip||autoCells)?'relative':'';

  let html='';
  if(single){
    const r=enabled[0];
    html+='<div draggable="true" data-rid="'+r.rid+'" style="background:#1e293b;display:flex;align-items:center;justify-content:center;border:2px solid #3b82f6">'+esc(r.name||r.rid)+'</div>';
  } else if(pip){
    // 2026-10-20:右 1/4 宽条带，纵向平分
    const r0=enabled[0];
    html+='<div draggable="true" data-rid="'+r0.rid+'" style="position:absolute;left:0;top:0;width:100%;height:100%;background:#1e293b;display:flex;align-items:center;justify-content:center;border:2px solid #3b82f6">'+esc(r0.name||r0.rid)+'<br>(主)</div>';
    const m=enabled.length-1, ph=100/m;
    for(let i=1;i<enabled.length;i++){
      const r=enabled[i];
      html+='<div draggable="true" data-rid="'+r.rid+'" style="position:absolute;left:75%;top:'+((i-1)*ph)+'%;width:25%;height:'+ph+'%;background:#16202e;display:flex;align-items:center;justify-content:center;font-size:11px;border:1px solid #334155">'+esc(r.name||r.rid)+'</div>';
    }
  } else if(autoCells){
    for(let i=0;i<enabled.length;i++){
      const r=enabled[i], c=autoCells[i];
      html+='<div draggable="true" data-rid="'+r.rid+'" style="position:absolute;left:'+c[0]+'%;top:'+c[1]+'%;width:'+c[2]+'%;height:'+c[3]+'%;background:#1e293b;display:flex;align-items:center;justify-content:center;border:1px solid #334155;box-sizing:border-box">'+esc(r.name||r.rid)+'</div>';
    }
  } else if(focus){
    const r0=enabled[0];
    html+='<div draggable="true" data-rid="'+r0.rid+'" style="background:#1e293b;display:flex;align-items:center;justify-content:center;border:2px solid #3b82f6;grid-row:1/-1">'+esc(r0.name||r0.rid)+'<br>(大)</div>';
    html+='<div style="display:grid;gap:4px;grid-template-rows:repeat('+(enabled.length-1)+',1fr)">';
    for(let i=1;i<enabled.length;i++){
      const r=enabled[i];
      html+='<div draggable="true" data-rid="'+r.rid+'" style="background:#1e293b;display:flex;align-items:center;justify-content:center;font-size:12px;text-align:center">'+esc(r.name||r.rid)+'</div>';
    }
    html+='</div>';
  } else {
    for(const r of enabled){
      html+='<div draggable="true" data-rid="'+r.rid+'" style="background:#1e293b;display:flex;align-items:center;justify-content:center;border:1px solid #334155">'+esc(r.name||r.rid)+'</div>';
    }
  }
  pv.innerHTML=html;
  // 拖拽排序
  let dragRid=null;
  pv.querySelectorAll('[draggable]').forEach(el=>{
    el.ondragstart=e=>{dragRid=el.dataset.rid;};
    el.ondragover=e=>e.preventDefault();
    el.ondrop=async e=>{
      e.preventDefault();
      const targetRid=el.dataset.rid;
      if(dragRid&&targetRid&&dragRid!==targetRid){
        await api('/api/rooms/reorder','POST',{from:dragRid,to:targetRid});
        load();loadLayers();
      }
    };
  });
}
function renderCurLayerBoxes(){
  renderLayerBoxes('previewCurWrap', window._savedLayers||[], false);
}
function renderLayerBoxes(wrapId, layers, draggable){
  if(typeof wrapId==='undefined'){ wrapId='previewWrap'; layers=collectLayers(); draggable=true; }
  const wrap=document.getElementById(wrapId);
  if(!wrap) return;
  // 清掉旧的图层框
  wrap.querySelectorAll('.title-drag-box,.image-drag-box').forEach(function(b){ b.remove(); });
  layers=layers||[];
  const wr0=wrap.getBoundingClientRect();
  const _scale=wr0.width/1280||0.3;
  var _tn=layers.length;
  layers.forEach(function(L, idx){
    var _z=_tn-idx;
    if(L.type==='image'){ renderImageBox(L, idx, _z, wrap, _scale, draggable); return; }
    var t=L;
    if(!t.text) return;
    const box=document.createElement('div');
    box.className='title-drag-box';
    box.dataset.idx=idx;
    var _fs=t.size?parseInt(t.size):40;
    var _sfs=Math.max(8,Math.round(_fs*_scale));
    var _col=t.color||'#ffffff';
    var _pad=Math.max(2,Math.round(_sfs/6));
    box.style.cssText='position:absolute;z-index:'+_z+';cursor:'+(draggable?'move':'default')+';background:rgba(0,0,0,0.69);color:'+_col+';border:1px dashed #0ea5e9;border-radius:4px;padding:'+_pad+'px '+(_pad*2)+'px;font-size:'+_sfs+'px;white-space:pre-line;line-height:1.3;user-select:none;touch-action:none';
    if(draggable) box.title='拖动改变图层'+(idx+1)+'位置,松开后点「应用图层」生效';
    box.textContent=t.text;
    wrap.appendChild(box);
    if(draggable) box.addEventListener('pointerdown',function(e){
      e.preventDefault();
      window._dragging=true; window._dragIdx=idx;
      try{box.setPointerCapture(e.pointerId);}catch(err){}
      const br=box.getBoundingClientRect();
      window._dragDX=e.clientX-br.left; window._dragDY=e.clientY-br.top;
    });
    box.addEventListener('pointermove',function(e){
      if(!window._dragging||window._dragIdx!==idx) return;
      const wr=wrap.getBoundingClientRect();
      let nx=e.clientX-wr.left-window._dragDX, ny=e.clientY-wr.top-window._dragDY;
      nx=Math.max(0,Math.min(nx,wr.width-24)); ny=Math.max(0,Math.min(ny,wr.height-24));
      box.style.left=nx+'px'; box.style.top=ny+'px';
      box.style.right='auto'; box.style.bottom='auto'; box.style.transform='none';
    });
    const endDrag=async function(){
      if(!window._dragging||window._dragIdx!==idx) return;
      window._dragging=false;
      const wr=wrap.getBoundingClientRect(), br=box.getBoundingClientRect();
      const fx=Math.max(0,Math.min(0.98,(br.left-wr.left)/wr.width));
      const fy=Math.max(0,Math.min(0.95,(br.top-wr.top)/wr.height));
      // 更新对应行的隐藏 X/Y,并把位置设为 custom
      const row=document.querySelectorAll('#layerList .layer-row')[idx];
      if(row){
        row.querySelector('.t-x').value=fx.toFixed(3);
        row.querySelector('.t-y').value=fy.toFixed(3);
        row.querySelector('.t-pos').value='custom';
      }
    };
    box.addEventListener('pointerup',endDrag);
    box.addEventListener('pointercancel',function(){window._dragging=false;});
    // 初始位置
    const pos=t.pos||'tc';
    if(pos==='custom'&&t.x&&t.y){
      box.style.left=(parseFloat(t.x)*100)+'%';
      box.style.top=(parseFloat(t.y)*100)+'%';
    }else{
      if(pos==='tc'||pos==='bc'){box.style.left='50%';box.style.transform='translateX(-50%)';}
      else if(pos==='tr'||pos==='br'){box.style.right='8px';} else {box.style.left='8px';}
      if(pos==='tl'||pos==='tr'||pos==='tc'){box.style.top='8px';} else {box.style.bottom='8px';}
    }
  });
}
function renderImageBox(img, idx, _z, wrap, _scale, draggable){
  if(typeof draggable==='undefined') draggable=true;
  if(!img.src) return;
  var box=document.createElement('img');
  box.className='image-drag-box';
  box.dataset.idx=idx;
  box.draggable=false;
  var _k=parseFloat(img.scale)||1.0;
  if(_k<=0||_k>8) _k=1.0;
  var _def=Math.max(10,Math.round(200*_k*_scale));
  box.style.cssText='position:absolute;z-index:'+_z+';cursor:'+(draggable?'move':'default')+';border:1px dashed #0ea5e9;border-radius:4px;width:'+_def+'px;height:'+_def+'px;user-select:none;touch-action:none';
  // 倍数 x 原图尺寸,与推流端一致(onload 必须在 src 之前,否则缓存图片不触发)
  box.onload=function(){
    var _nw=box.naturalWidth||200, _nh=box.naturalHeight||150;
    box.style.width=Math.max(10,Math.round(_nw*_k*_scale))+'px';
    box.style.height=Math.max(10,Math.round(_nh*_k*_scale))+'px';
  };
  box.src='/api/images/file?src='+encodeURIComponent(img.src);
  if(draggable) box.title='拖动改变图片'+(idx+1)+'位置,松开后点「应用图层」生效';
  var _fx=parseFloat(img.x), _fy=parseFloat(img.y);
  if(!isNaN(_fx)&&!isNaN(_fy)){ box.style.left=(_fx*100)+'%'; box.style.top=(_fy*100)+'%'; }
  else { box.style.left='8px'; box.style.top='8px'; }
  wrap.appendChild(box);
  if(draggable) box.addEventListener('pointerdown',function(e){
    e.preventDefault();
    window._idragging=true; window._idragIdx=idx;
    try{box.setPointerCapture(e.pointerId);}catch(err){}
    var br=box.getBoundingClientRect();
    window._idragDX=e.clientX-br.left; window._idragDY=e.clientY-br.top;
  });
  box.addEventListener('pointermove',function(e){
    if(!window._idragging||window._idragIdx!==idx) return;
    var wr=wrap.getBoundingClientRect();
    var nx=e.clientX-wr.left-window._idragDX, ny=e.clientY-wr.top-window._idragDY;
    nx=Math.max(0,Math.min(nx,wr.width-24)); ny=Math.max(0,Math.min(ny,wr.height-24));
    box.style.left=nx+'px'; box.style.top=ny+'px';
    box.style.right='auto'; box.style.bottom='auto';
  });
  var endDrag=function(){
    if(!window._idragging||window._idragIdx!==idx) return;
    window._idragging=false;
    var wr=wrap.getBoundingClientRect(), br=box.getBoundingClientRect();
    var fx=Math.max(0,Math.min(0.98,(br.left-wr.left)/wr.width));
    var fy=Math.max(0,Math.min(0.95,(br.top-wr.top)/wr.height));
    var row=document.querySelectorAll('#layerList .layer-row')[idx];
    if(row){
      var ix=row.querySelector('.i-x'), iy=row.querySelector('.i-y');
      if(ix) ix.value=fx.toFixed(3);
      if(iy) iy.value=fy.toFixed(3);
    }
  };
  box.addEventListener('pointerup',endDrag);
  box.addEventListener('pointercancel',function(){window._idragging=false;});
}
function _isTypingIn(id){ var r=document.getElementById(id); var a=document.activeElement; if(!r||!a) return false; if(a===r||r.contains(a)){ return a.tagName==='INPUT'&&(a.type==='text'||a.type==='number'); } return false; }
function roomDragStart(ev, rid){
  try{ ev.dataTransfer.setData('text/plain', String(rid)); }catch(e){}
  window._rrd = String(rid);
}
async function load(){
  let s,rooms,slotData;
  try{ s=await api('/api/status'); }catch(e){ s=null; document.getElementById('st').textContent='状态获取失败'; }
  try{ rooms=await api('/api/rooms'); }catch(e){ rooms=[]; }
  try{ slotData=await api('/api/slots'); }catch(e){ slotData=null; }
  if(s){ document.getElementById('st').innerHTML=s.pushing?'<span class="on">推流中</span>':'<span class="off">已停止</span>';
    var _e=document.getElementById('stErr'); if(_e){ _e.textContent=s.lastError||''; _e.style.display=s.lastError?'':'none'; }
  var _m=s.pushing?("已推 "+s.uptime):""; if(s&&s.pushing&&s.bitrate){_m+=" | "+s.bitrate; if(s.speed)_m+=" "+s.speed;} document.getElementById("stMeta").textContent=_m; if(s&&s.pushing){ loadHealth(); } }
async function loadHealth(){
  try{
    var h=await api('/api/health');
    var t='';
    if(h.bitrate) t+='码率 '+h.bitrate;
    if(h.cpu) t+=(t?' | ':'')+'CPU '+h.cpu;
    if(h.mem) t+=(t?' | ':'')+'内存 '+h.mem;
    var el=document.getElementById('healthMeta');
    if(el) el.textContent=t;
  }catch(e){}
}
  document.getElementById('cnt').textContent=rooms.length;

  let html="";
  for(let i=0;i<rooms.length;i++){
    const r=rooms[i];
    const rid=r.rid;
    html+="<div class=room data-rid='"+rid+"'><div>";
    html+="<b>"+rid+"</b> "+esc(r.name||"")+" ";
    html+="<input type='range' min='0' max='200' value='"+Math.round(((r.volume===undefined||r.volume===null)?1:r.volume)*100)+"' style='width:80px;vertical-align:middle' onchange='setVolume("+rid+",this.value)' title='音量'>";
    html+="<span class='badge"+(r.live?" live":"")+"'>"+(r.live?"直播中":"未开播")+"</span>";
    html+="<input placeholder='自定义文字' title='画面左下角标签,空则显示主播名' value='"+esc(r.label||"").replace(/'/g,"&#39;")+"' style='width:110px;margin-left:8px' onchange='setLabel("+rid+",this.value)'></div><div>";
    html+="<button onclick='delRoom("+rid+")'>删除</button>";
    html+="</div></div>";
  }
  if(!_isTypingIn("rooms")) document.getElementById("rooms").innerHTML=html;
  var curL = s.layout||'auto';
  var newL = window._layoutTouched ? getLayoutVal() : curL;
  // 2026-10-18:预览用 slot 分配,不是房间列表
  let slotRooms=[];
  if(slotData && slotData.slots){
    const roomMap={}; rooms.forEach(r=>{roomMap[r.rid]=r;});
    for(let i=0;i<9;i++){
      const rid=slotData.slots['slot'+i];
      if(rid){
        const r=roomMap[rid]||{rid:rid};
        r.enabled=true; // slot 分配的强制启用,不过滤
        slotRooms.push(r);
      }
    }
  }
  renderPreview(slotRooms, newL, 'preview');
  renderPreview(slotRooms, curL, 'previewCur');
  renderCurLayerBoxes();
  if(!_isTypingIn('rtmp')) document.getElementById('rtmp').value=s.rtmpUrl;
  document.getElementById('curRtmp').textContent=s.rtmpUrl;
  document.getElementById('curLayout').textContent={auto:'自动',grid:'田字格',focus:'焦点',single:'单路',side:'左右并排',stack:'上下并排',pip:'画中画'}[s.layout||'auto']||s.layout;
  try{const l=await api('/api/labels');document.getElementById('labelSw').checked=!!l.enabled;}catch(e){}
  try{const g=await api('/api/gift-labels');document.getElementById('giftSw').checked=!!g.enabled;}catch(e){}
  loadGiftApiUrl();
  let _tt={text:''}, _pp={};
  try{const t=await api('/api/title');var _gti=document.getElementById('globalTitle');if(!_isTypingIn('globalTitle')){_gti.value=t.text||'';fitTitle(_gti);}document.getElementById('titleScroll').checked=!!t.scroll;if(!_isTypingIn('titleSpeed')) document.getElementById('titleSpeed').value=t.speed||120;_tt=t;}catch(e){}
  try{const p=await api('/api/textpos');
    if(!_isTypingIn('labelPos')) document.getElementById('labelPos').value=p.labelPos||'bl';
    if(!_isTypingIn('titlePos')) document.getElementById('titlePos').value=p.titlePos||'tc';
    if(!_isTypingIn('labelSize')) document.getElementById('labelSize').value=p.labelSize||'';
    if(!_isTypingIn('titleSize')) document.getElementById('titleSize').value=p.titleSize||'';
    if(!_isTypingIn('labelColor')) document.getElementById('labelColor').value=p.labelColor||'#ffffff';
    if(!_isTypingIn('titleColor')) document.getElementById('titleColor').value=p.titleColor||'#ffffff';
    _pp=p;
  }catch(e){}
  window._title={text:_tt.text||'',pos:_pp.titlePos||'tc',x:_pp.titleX,y:_pp.titleY};
  renderLayerBoxes();
  // 只有用户没手动改过才同步下拉(避免定时刷新覆盖)
  if(!window._layoutTouched) setLayout(s.layout||'auto', true);
  loadSlots();
}
async function loadSlots(){
  var el=document.getElementById('slots');
  var data,rooms;
  try{ data=await api('/api/slots'); }catch(e){ if(el) el.textContent='slot 获取失败'; return; }
  try{ rooms=await api('/api/rooms'); }catch(e){ rooms=[]; }
  var html="<div style='display:grid;grid-template-columns:repeat(3,1fr);gap:10px'>";
  for(var i=0;i<9;i++){
    var cur=(data.slots&&data.slots['slot'+i])||'';
    html+="<div style='display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid #334155;border-radius:8px;background:#0f172a'>";
    html+="<span style='color:#94a3b8;font-size:13px;font-weight:bold'>slot"+i+"</span>";
    html+="<select data-slot='"+i+"' onchange='setSlot(this)' style='background:#0f172a;color:#eee;border:1px solid #334155;border-radius:6px;padding:6px;min-width:200px'>";
    html+="<option value=''>（空/黑场）</option>";
    for(var j=0;j<rooms.length;j++){
      var r=rooms[j];
      var sel=(r.rid===cur)?' selected':'';
      html+="<option value='"+r.rid+"'"+sel+">"+escapeHtml(r.name||r.rid)+" ("+r.rid+")</option>";
    }
    html+="</select>";
    if(cur) html+="<span style='color:#64748b;font-size:12px'>"+escapeHtml(cur)+"</span>";
    html+="</div>";
  }
  html+="</div>";
  if(el) el.innerHTML=html;
}
async function setSlot(sel){
  var idx=parseInt(sel.getAttribute('data-slot'));
  var rid=sel.value||null;
  await api('/api/slots','POST',{slot:idx,rid:rid});
  loadSlots();
}
async function applyLayout(){
  if(!confirm('按当前房间+布局重新推流?')) return;
  var lv=getLayoutVal();
  await api('/api/layout','POST',{layout:lv});
  await api('/api/control','POST',{action:'restart'});
  window._layoutTouched=false;
  setTimeout(load,5000);
}
async function ctl(a){await api('/api/control','POST',{action:a});load();}
async function addRoom(){const v=document.getElementById('newRid').value.trim();if(!v)return;await api('/api/rooms','POST',{rid:v});document.getElementById('newRid').value='';load();}
async function delRoom(rid){if(!confirm('删除 '+rid+'?'))return;await api('/api/rooms/'+rid,'DELETE');load();}
async function saveQuality(){
  const b=document.getElementById('qBitrate').value;
  const r=document.getElementById('qRes').value;
  const f=document.getElementById('qFps').value;
  await api('/api/quality','POST',{bitrate:b,res:r,fps:f});
  alert('已保存,点「应用新布局」生效');
}
async function savePullRate(){
  const v=document.getElementById('qPullRate').value;
  const r=await api('/api/pullrate','POST',{rate:v});
  alert(r.ok?'已保存,拉流代理重启中':'保存失败');
}
async function loadPullRate(){
  try{
    const r=await (await fetch('/api/pullrate')).json();
    if(r.rate!==undefined) document.getElementById('qPullRate').value=String(r.rate);
  }catch(e){}
}
async function loadQuality(){
  try{
    const q=await (await fetch('/api/quality')).json();
    document.getElementById('qBitrate').value=q.bitrate;
    document.getElementById('qRes').value=q.res;
    document.getElementById('qFps').value=q.fps;
  }catch(e){}
}
async function setVolume(rid,v){ await api('/api/rooms/volume','POST',{rid:String(rid),volume:v/100}); }
async function setLabel(rid,v){ await api('/api/rooms/label','POST',{rid:String(rid),label:v}); }
async function toggleLabels(on){ await api('/api/labels','POST',{enabled:on}); }
async function toggleGiftLabels(on){ await api('/api/gift-labels','POST',{enabled:on}); }
async function loadGiftApiUrl(){ try{const g=await api('/api/gift-api-url');document.getElementById('giftApiUrl').value=g.url||'';}catch(e){} }
async function saveGiftApiUrl(){ const u=document.getElementById('giftApiUrl').value.trim(); if(!u){alert('地址不能为空');return;} const r=await api('/api/gift-api-url','POST',{url:u}); if(r&&r.ok){alert('已保存');}else{alert('保存失败');} }
async function setGlobalTitle(v){ await api('/api/title','POST',{text:v}); }
async function saveTitleScroll(){ const s=document.getElementById('titleScroll').checked; const v=parseInt(document.getElementById('titleSpeed').value)||120; await api('/api/title','POST',{scroll:s,speed:v}); }
function escapeHtml(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function longestLine(s){ var m=0; String(s).split("\\n").forEach(function(l){ if(l.length>m) m=l.length; }); return m; }
function fitTitleRow(el){ el.style.width=Math.max(220, longestLine(el.value)*14+30)+'px'; }
function titleRowHtml(t, idx){
  t=t||{};
  var pos=t.pos||'tc';
  var _label=(typeof idx==='number')?('标题 '+(idx+1)+' <span style="color:#64748b;font-size:11px">(越靠上图层越上)</span>'):'标题';
  var opts=['tc','tl','tr','bl','br','bc','custom'].map(function(p){
    var names={tc:'顶部居中',tl:'左上',tr:'右上',bl:'左下',br:'右下',bc:'底部居中',custom:'自定义(拖动)'};
    return "<option value='"+p+"'"+(p===pos?" selected":"")+">"+names[p]+"</option>";
  }).join('');
  return "<div class='layer-row' data-type='title' data-tidx='"+(typeof idx==='number'?idx:'')+"' style='margin:4px 0;padding:6px;background:#0f172a;border-radius:6px'>"
    +"<span class='ldh' title='按住拖动排序' style='cursor:move;color:#64748b;padding:0 6px;user-select:none;font-size:16px;touch-action:none'>⋮⋮</span>"
    +"<b style='margin-right:6px'>"+_label+"</b>"
    +"<textarea class='t-text' placeholder='标题文字,空则不显示,回车换行' rows='2' style='width:"+Math.max(220,longestLine(t.text||"")*14+30)+"px;max-width:100%;vertical-align:middle'>"+escapeHtml(t.text||'')+"</textarea> "
    +"位置 <select class='t-pos'>"+opts+"</select> "
    +"字号 <input class='t-size' type='number' min='12' max='96' placeholder='自动' value='"+(t.size||'')+"' style='width:56px'>px "
    +"颜色 <input class='t-color' type='color' value='"+(t.color||'#ffffff')+"' style='width:40px;padding:2px;vertical-align:middle'> "
    +"<label><input type='checkbox' class='t-scroll'"+(t.scroll!==false?" checked":"")+" style='width:auto;vertical-align:middle'> 滚动</label> "
    +"速度 <input class='t-speed' type='number' min='20' max='500' placeholder='120' value='"+(t.speed||'')+"' style='width:56px'>px/秒 "
    +"<input type='hidden' class='t-x' value='"+(t.x||'')+"'>"
    +"<input type='hidden' class='t-y' value='"+(t.y||'')+"'>"
    +"<button onclick='removeLayerRow(this)' title='删除此图层'>×</button></div>";
}
function imageRowHtml(img, idx){
  img=img||{};
  var _label='图层 '+(idx+1)+' <span style="color:#10b981;font-size:11px">[图片]</span> <span style="color:#64748b;font-size:11px">(越靠上越靠前)</span>';
  var _src=String(img.src||'').replace(/'/g, '&#39;');
  return "<div class='layer-row' data-type='image' style='margin:4px 0;padding:6px;background:#0f172a;border-radius:6px'>"
    +"<span class='ldh' title='按住拖动排序' style='cursor:move;color:#64748b;padding:0 6px;user-select:none;font-size:16px;touch-action:none'>⋮⋮</span>"
    +"<b style='margin-right:6px'>"+_label+"</b>"
    +"<img src='/api/images/file?src="+encodeURIComponent(_src)+"' style='max-width:80px;max-height:60px;vertical-align:middle;border-radius:4px' onload='migrateImgScale(this)' data-w='"+(img.w||'')+"' data-scale='"+(img.scale||'')+"'> "
    +"倍数 <input class='i-scale' type='number' min='0.1' max='8' step='0.1' value='"+(img.scale||'')+"' placeholder='1.0' style='width:56px'>x "
    +"<input type='hidden' class='i-src' value='"+_src+"'>"
    +"<input type='hidden' class='i-src' value='"+_src+"'>"
    +"<input type='hidden' class='i-x' value='"+(img.x||'')+"'>"
    +"<input type='hidden' class='i-y' value='"+(img.y||'')+"'>"
    +"<button onclick='removeLayerRow(this)' title='删除此图层'>×</button></div>";
}
function renderLayers(layers){
  document.getElementById('layerList').innerHTML=(layers||[]).map(function(L,i){
    if(L.type==='image') return imageRowHtml(L,i);
    return titleRowHtml(L,i);
  }).join('');
  bindLayerDrag();
}
async function loadLayers(){
  try{ var r=await api('/api/layers'); window._savedLayers=r.layers||[]; renderLayers(r.layers); renderCurLayerBoxes(); }catch(e){}
}
function addTitleRow(){
  var list=document.getElementById('layerList');
  if(list.children.length>=20){ alert('最多20个图层'); return; }
  list.insertAdjacentHTML('beforeend', titleRowHtml({type:'title'}, list.children.length));
  bindLayerDrag(); renumberLayers(); renderLayerBoxes();
}
async function uploadImageFile(input){
  var f=input.files&&input.files[0];
  input.value='';
  if(!f) return;
  if(f.size>5*1024*1024){ alert('图片超过5MB'); return; }
  var fd=new FormData(); fd.append('file', f);
  try{
    var r=await fetch('/api/images/upload',{method:'POST',body:fd});
    var d=await r.json();
    if(!r.ok||!d.ok){ alert('上传失败:'+(d.error||r.status)); return; }
    // 获取图片原始尺寸，按比例显示
    var _img = new Image();
    _img.onload = function(){
      var _nw = _img.naturalWidth || 200, _nh = _img.naturalHeight || 150;
      // 默认宽 200，高按比例
      var _w = 200, _h = Math.round(200 * _nh / _nw);
      addImageRow(d.src, _w, _h, _nw / _nh);
    };
    _img.onerror = function(){ addImageRow(d.src); };
    _img.src = '/api/images/file?src=' + encodeURIComponent(d.src);
  }catch(e){ alert('上传失败:'+e.message); }
}
function addImageRow(src, w, h, ratio){
  var list=document.getElementById('layerList');
  if(list.children.length>=20){ alert('最多20个图层'); return; }
  list.insertAdjacentHTML('beforeend', imageRowHtml({type:'image',src:src,w:w||200,h:h||150,ratio:ratio||''}, list.children.length));
  bindLayerDrag(); renumberLayers(); renderLayerBoxes();
}
function bindLayerDrag(){
  var _rc=document.getElementById('layerList');
  if(!_rc||_rc._tdBound) return;
  _rc._tdBound=true;
  var _dragEl=null;
  _rc.addEventListener('pointerdown',function(e){
    var h=e.target.closest?e.target.closest('.ldh'):null;
    if(!h) return;
    e.preventDefault();
    _dragEl=h.closest('.layer-row');
    if(_dragEl){ _dragEl.style.opacity='0.5'; }
    try{ h.setPointerCapture(e.pointerId); }catch(err){}
  });
  _rc.addEventListener('pointermove',function(e){
    if(!_dragEl) return;
    e.preventDefault();
    _rc.querySelectorAll('.layer-row').forEach(function(el){ el.style.borderTop=''; });
    var t=document.elementFromPoint(e.clientX,e.clientY);
    var row=t&&t.closest?t.closest('.layer-row'):null;
    if(row&&row!==_dragEl){ row.style.borderTop='2px solid #0ea5e9'; }
  });
  var _end=function(e){
    if(!_dragEl) return;
    var t=document.elementFromPoint(e.clientX,e.clientY);
    var row=t&&t.closest?t.closest('.layer-row'):null;
    _rc.querySelectorAll('.layer-row').forEach(function(el){ el.style.borderTop=''; el.style.opacity=''; });
    var fromEl=_dragEl;
    _dragEl=null;
    if(row&&row!==fromEl){
      _rc.insertBefore(fromEl,row);
      renumberLayers(); renderLayerBoxes();
    }
  };
  _rc.addEventListener('pointerup',_end);
  _rc.addEventListener('pointercancel',_end);
}
function renumberLayers(){
  document.querySelectorAll('#layerList .layer-row').forEach(function(el,i){
    var b=el.querySelector('b');
    if(b){
      var _t=el.dataset.type==='image'
        ? '<span style="color:#10b981;font-size:11px">[图片]</span>'
        : '<span style="color:#0ea5e9;font-size:11px">[标题]</span>';
      b.innerHTML='图层 '+(i+1)+' '+_t+' <span style="color:#64748b;font-size:11px">(越靠上越靠前)</span>';
    }
  });
}
function removeLayerRow(btn){ btn.closest('.layer-row').remove(); renumberLayers(); renderLayerBoxes(); }
function migrateImgScale(thumb){
  var row=thumb.closest('.layer-row'); if(!row) return;
  var sc=row.querySelector('.i-scale'); if(!sc||sc.value) return;
  var s=parseFloat(thumb.dataset.scale)||0, w=parseFloat(thumb.dataset.w)||0;
  if(s>0){ sc.value=s; return; }
  if(w>0&&thumb.naturalWidth>0){ sc.value=Math.max(0.1,(w/thumb.naturalWidth)).toFixed(2); }
  else sc.value='1.0';
}
function collectLayers(){
  var out=[];
  document.querySelectorAll('#layerList .layer-row').forEach(function(row){
    var _type=row.dataset.type||'title';
    if(_type==='image'){
      out.push({
        type:'image',
        src:row.querySelector('.i-src').value,
        scale:row.querySelector('.i-scale').value,
        x:row.querySelector('.i-x').value,
        y:row.querySelector('.i-y').value
      });
    }else{
      out.push({
        type:'title',
        text:row.querySelector('.t-text').value,
        pos:row.querySelector('.t-pos').value,
        size:row.querySelector('.t-size').value,
        color:row.querySelector('.t-color').value,
        scroll:row.querySelector('.t-scroll').checked,
        speed:row.querySelector('.t-speed').value,
        x:row.querySelector('.t-x').value,
        y:row.querySelector('.t-y').value
      });
    }
  });
  return out;
}
async function applyLayersNow(){
  var b=document.getElementById('applyTitleBtn');
  b.textContent='应用中…'; b.disabled=true;
  try{
    await api('/api/layers','POST',{layers:collectLayers()});
    await api('/api/title/apply','POST',{});
    await loadLayers();
    b.textContent='已应用';
  }catch(e){ b.textContent='失败'; }
  setTimeout(function(){ b.textContent='应用图层'; b.disabled=false; },2000);
}
async function saveTextStyle(){
  await api('/api/textpos','POST',{
    labelPos:document.getElementById('labelPos').value,
    labelSize:document.getElementById('labelSize').value,
    labelColor:document.getElementById('labelColor').value
  });
}
async function syncNow(){ await api('/api/sync','POST'); load(); }
function getLayoutVal(){ const el=document.getElementById('layout'); return el? (el.dataset.value||'auto') : 'auto'; }
function setLayout(v, noPreview){
  const el=document.getElementById('layout'); if(!el) return;
  el.dataset.value=v;
  el.querySelectorAll('button').forEach(b=>{
    const on=b.dataset.val===v;
    b.style.background=on?'#1e293b':'#0f172a';
    b.style.borderColor=on?'#2a7':'#334155';
  });
  if(!noPreview) previewLayout();
}
function previewLayout(){ window._layoutTouched=true;
  var v=getLayoutVal();
  Promise.all([api('/api/rooms'),api('/api/slots')]).then(function([rooms,slotData]){
    const roomMap={}; rooms.forEach(r=>{roomMap[r.rid]=r;});
    let slotRooms=[];
    if(slotData && slotData.slots){
      for(let i=0;i<9;i++){
        const rid=slotData.slots['slot'+i];
        if(rid){
          const r=roomMap[rid]||{rid:rid};
          r.enabled=true;
          slotRooms.push(r);
        }
      }
    }
    renderPreview(slotRooms,v,'preview');renderLayerBoxes();
  });
}
async function saveLayout(){const v=getLayoutVal();await api('/api/layout','POST',{layout:v});load();}
async function saveRtmp(){const v=document.getElementById('rtmp').value.trim();if(!v)return;await api('/api/rtmp','POST',{url:v});load();}
load();loadQuality(); loadPullRate();setInterval(load,15000);
if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',loadLayers);}else{loadLayers();}
setTimeout(loadTitles,1000);

</script></body></html>`;

setInterval(syncFromMultiview, 10000);
setTimeout(syncFromMultiview, 5000);

const IMG_EXTS = ['png','jpg','jpeg','gif','webp','bmp'];
function safeName(name){
  name = path.basename(String(name || ''));
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  const ext = name.slice(dot + 1).toLowerCase();
  if (!IMG_EXTS.includes(ext)) return '';
  let base = name.slice(0, dot).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 48);
  if (!base) base = 'img';
  return base + '.' + ext;
}
function titlesFromCfg(cfg){
  const titles = [];
  const n = parseInt(cfg.TITLE_COUNT) || 0;
  if (n === 0 && cfg.GLOBAL_TEXT) {
    titles.push({ text: cfg.GLOBAL_TEXT || '', pos: cfg.TITLE_POS || 'tc', size: cfg.TITLE_SIZE || '', color: cfg.TITLE_COLOR || '#ffffff', scroll: cfg.TITLE_SCROLL !== '0', speed: cfg.TITLE_SPEED || '120', x: cfg.TITLE_X || '', y: cfg.TITLE_Y || '' });
  } else {
    for (let i = 0; i < Math.min(n, 5); i++) {
      titles.push({
        text: cfg['TITLE_' + i + '_TEXT'] || '',
        pos: cfg['TITLE_' + i + '_POS'] || 'tc',
        size: cfg['TITLE_' + i + '_SIZE'] || '',
        color: cfg['TITLE_' + i + '_COLOR'] || '#ffffff',
        scroll: cfg['TITLE_' + i + '_SCROLL'] !== '0',
        speed: cfg['TITLE_' + i + '_SPEED'] || '120',
        x: cfg['TITLE_' + i + '_X'] || '',
        y: cfg['TITLE_' + i + '_Y'] || ''
      });
    }
  }
  return titles;
}
const TITLE_POS_OK = ['tl','tr','bl','br','tc','bc','custom'];
function sanitizeTitle(t){
  t = (t && typeof t === 'object') ? t : {};
  const o = { type: 'title' };
  o.text = String(t.text == null ? '' : t.text).replace(/\r/g, '').slice(0, 120);
  o.pos = TITLE_POS_OK.includes(t.pos) ? t.pos : 'tc';
  const sz = String(t.size == null ? '' : t.size).trim();
  o.size = (/^[0-9]+$/.test(sz) && +sz >= 12 && +sz <= 96) ? String(+sz) : '';
  const cl = String(t.color == null ? '' : t.color).trim();
  o.color = (/^#[0-9a-fA-F]{6}$/.test(cl)) ? cl.toLowerCase() : '#ffffff';
  o.scroll = t.scroll ? true : false;
  const sp = parseInt(t.speed);
  o.speed = (sp >= 20 && sp <= 500) ? String(sp) : '120';
  const fok = v => /^(0(\.\d+)?|1(\.0+)?)$/.test(v);
  const fx = String(t.x == null ? '' : t.x).trim(), fy = String(t.y == null ? '' : t.y).trim();
  o.x = fok(fx) ? fx : '';
  o.y = fok(fy) ? fy : '';
  return o;
}
function sanitizeImage(l){
  l = (l && typeof l === 'object') ? l : {};
  const src = safeName(l.src);
  if (!src) return null;
  const f01 = v => { v = String(v == null ? '' : v).trim(); return /^(0(\.\d+)?|1(\.0+)?)$/.test(v) ? v : ''; };
  const sc = v => { v = parseFloat(v); return (v >= 0.1 && v <= 8) ? String(v) : ''; };
  return { type: 'image', src: src, x: f01(l.x), y: f01(l.y), scale: sc(l.scale) };
}
function rawBody(req, maxBytes){
  return new Promise((resolve) => {
    const chunks = [];
    let len = 0, tooBig = false;
    req.on('data', c => { len += c.length; if (len > maxBytes) tooBig = true; else chunks.push(c); });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

// 实时电平:从 grid-stream 日志解析 ebur128

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (code, data, type) => {
    const h = { 'Content-Type': type || 'application/json' };
    if ((type||'').includes('text/html')) h['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    res.writeHead(code, h);
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  };
  const body = () => new Promise((r) => {
    let d = '', len = 0;
    req.on('data', c => { len += c.length; if (len <= 1048576) d += c; }); // 1MB 上限,防 OOM
    req.on('end', () => { try { r(JSON.parse(d)); } catch (e) { r({}); } });
    req.on('error', () => r({}));
  });

  if (url.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8');
  if (url.pathname === '/api/sync' && req.method === 'POST') {
    await syncFromMultiview();
    return send(200, {ok:true});
  }
  if (url.pathname === '/api/quality' && req.method === 'POST') {
    const b = await body();
    const cfg = getCfg();
    if(['1000k','1500k','2000k','4000k','6000k','8000k'].includes(b.bitrate)) cfg.BITRATE = b.bitrate;
    if(['720p','1080p'].includes(b.res)) cfg.RES = b.res;
    if(/^[0-9]+$/.test(String(b.fps||'')) && +b.fps>=1 && +b.fps<=120) cfg.FPS = String(b.fps);
    saveCfg(cfg);
    return send(200, {ok:true});
  }
  if (url.pathname === '/api/quality' && req.method === 'GET') {
    const cfg = getCfg();
    return send(200, {bitrate: cfg.BITRATE||'4000k', res: cfg.RES||'720p', fps: cfg.FPS||'25'});
  }
  if (url.pathname === '/api/rooms/volume' && req.method === 'POST') {
    const b = await body();
    const rooms = getRooms();
    const r = rooms.find(x => x.rid === String(b.rid));
    if (r) { const vv=parseFloat(b.volume); r.volume = Math.max(0, Math.min(2, isNaN(vv)?1.0:vv)); }
    await setConfig(rooms, getRtmpUrl());
    return send(200, {ok:true});
  }
  if (url.pathname === '/api/rooms/label' && req.method === 'POST') {
    const b = await body();
    const rid = String(b.rid || '');
    if (!/^[0-9]+$/.test(rid)) return send(400, { error: '房间号无效' });
    const label = String(b.label || '').replace(/[\r\n;]/g, '').slice(0, 24);
    const rooms = getRooms();
    const r = rooms.find(x => x.rid === rid);
    if (!r) return send(404, { error: '房间不存在' });
    r.label = label;
    await setConfig(rooms, getRtmpUrl());
    return send(200, { ok: true });
  }
  if (url.pathname === '/api/labels' && req.method === 'GET') {
    return send(200, { enabled: (getCfg().TEXT_LABELS || '1') === '1' });
  }
  if (url.pathname === '/api/labels' && req.method === 'POST') {
    const b = await body();
    const cfg = getCfg();
    cfg.TEXT_LABELS = (b.enabled === false || b.enabled === '0' || b.enabled === 0) ? '0' : '1';
    saveCfg(cfg);
    return send(200, { ok: true });
  }
  // 2026-10-19:分屏礼物总额标签开关(沙箱 gift-push 推送,entry.sh 循环读取)
  if (url.pathname === '/api/gift-labels' && req.method === 'GET') {
    return send(200, { enabled: (getCfg().GIFT_LABELS || '1') === '1' });
  }
  if (url.pathname === '/api/gift-api-url' && req.method === 'GET') {
    return send(200, { url: getCfg().GIFT_API_URL || '' });
  }
  if (url.pathname === '/api/gift-api-url' && req.method === 'POST') {
    const b = await body();
    const cfg = getCfg();
    cfg.GIFT_API_URL = String(b.url || '').trim();
    saveCfg(cfg);
    return send(200, { ok: true, url: cfg.GIFT_API_URL });
  }
  if (url.pathname === '/api/gift-labels' && req.method === 'POST') {
    const b = await body();
    const cfg = getCfg();
    cfg.GIFT_LABELS = (b.enabled === false || b.enabled === '0' || b.enabled === 0) ? '0' : '1';
    saveCfg(cfg);
    return send(200, { ok: true });
  }
  if (url.pathname === '/api/titles' && req.method === 'GET') {
    const cfg = getCfg();
    const titles = [];
    let n = parseInt(cfg.TITLE_COUNT) || 0;
    if (n === 0 && cfg.GLOBAL_TEXT) {
      titles.push({ text: cfg.GLOBAL_TEXT || '', pos: cfg.TITLE_POS || 'tc', size: cfg.TITLE_SIZE || '', color: cfg.TITLE_COLOR || '#ffffff', scroll: cfg.TITLE_SCROLL !== '0', speed: cfg.TITLE_SPEED || '120', x: cfg.TITLE_X || '', y: cfg.TITLE_Y || '' });
    } else {
      for (let i = 0; i < Math.min(n, 5); i++) {
        titles.push({
          text: cfg['TITLE_' + i + '_TEXT'] || '',
          pos: cfg['TITLE_' + i + '_POS'] || 'tc',
          size: cfg['TITLE_' + i + '_SIZE'] || '',
          color: cfg['TITLE_' + i + '_COLOR'] || '#ffffff',
          scroll: cfg['TITLE_' + i + '_SCROLL'] !== '0',
          speed: cfg['TITLE_' + i + '_SPEED'] || '120',
          x: cfg['TITLE_' + i + '_X'] || '',
          y: cfg['TITLE_' + i + '_Y'] || ''
        });
      }
    }
    return send(200, { titles });
  }
  if (url.pathname === '/api/titles' && req.method === 'POST') {
    const b = await body();
    const cfg = getCfg();
    const arr = Array.isArray(b.titles) ? b.titles.slice(0, 5) : [];
    const okp = ['tl','tr','bl','br','tc','bc','custom'];
    cfg.TITLE_COUNT = String(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i] || {};
      cfg['TITLE_' + i + '_TEXT'] = String(t.text || '').replace(/\r/g, '').slice(0, 120);
      if (okp.includes(t.pos)) cfg['TITLE_' + i + '_POS'] = t.pos;
      const sz = String(t.size == null ? '' : t.size).trim();
      cfg['TITLE_' + i + '_SIZE'] = (/^[0-9]+$/.test(sz) && +sz >= 12 && +sz <= 96) ? String(+sz) : '';
      const cl = String(t.color == null ? '' : t.color).trim();
      cfg['TITLE_' + i + '_COLOR'] = (/^#[0-9a-fA-F]{6}$/.test(cl)) ? cl.toLowerCase() : '#ffffff';
      cfg['TITLE_' + i + '_SCROLL'] = t.scroll ? '1' : '0';
      const sp = parseInt(t.speed);
      cfg['TITLE_' + i + '_SPEED'] = (sp >= 20 && sp <= 500) ? String(sp) : '120';
      const fx = String(t.x == null ? '' : t.x).trim(), fy = String(t.y == null ? '' : t.y).trim();
      const fok = v => /^(0(\.\d+)?|1(\.0+)?)$/.test(v);
      cfg['TITLE_' + i + '_X'] = fok(fx) ? fx : '';
      cfg['TITLE_' + i + '_Y'] = fok(fy) ? fy : '';
    }
    // 清理多余的旧标题
    for (let i = arr.length; i < 5; i++) {
      ['TEXT','POS','SIZE','COLOR','SCROLL','SPEED','X','Y'].forEach(k => delete cfg['TITLE_' + i + '_' + k]);
    }
    saveCfg(cfg);
    return send(200, { ok: true });
  }

  if (url.pathname === '/api/layers' && req.method === 'GET') {
    const cfg = getCfg();
    let layers = [];
    try { const p = JSON.parse(cfg.LAYERS || '[]'); if (Array.isArray(p)) layers = p; } catch (e) {}
    if (layers.length === 0) {
      layers = titlesFromCfg(cfg).map(t => Object.assign({ type: 'title' }, t));
    }
    return send(200, { layers });
  }
  if (url.pathname === '/api/layers/sh' && req.method === 'GET') {
    const cfg = getCfg();
    let layers = [];
    try { const p = JSON.parse(cfg.LAYERS || '[]'); if (Array.isArray(p)) layers = p; } catch (e) {}
    if (layers.length === 0) {
      layers = titlesFromCfg(cfg).map(t => Object.assign({ type: 'title' }, t));
    }
    let out = '';
    let ic = 0;
    layers.forEach(function(l){
      if (l && l.type === 'image' && l.src) {
        const src = String(l.src).replace(/[^a-zA-Z0-9._-]/g, '_');
        const x = parseFloat(l.x) || 0, y = parseFloat(l.y) || 0;
        const _sc = parseFloat(l.scale); const scale = (!_sc||_sc<=0||_sc>8) ? 0 : _sc;
        out += "IMAGE_"+ic+"_SRC='"+src+"'\n";
        out += "IMAGE_"+ic+"_X='"+x+"'\n";
        out += "IMAGE_"+ic+"_Y='"+y+"'\n";
        out += "IMAGE_"+ic+"_SCALE='"+scale+"'\n";
        ic++;
      }
    });
    out += "IMAGE_COUNT='"+ic+"'\n";
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end(out);
    return;
  }
  if (url.pathname === '/api/layers' && req.method === 'POST') {
    const b = await body();
    const arr = Array.isArray(b.layers) ? b.layers.slice(0, 20) : [];
    const out = [];
    for (const l of arr) {
      if (!l || typeof l !== 'object') continue;
      const s = (l.type === 'image') ? sanitizeImage(l) : sanitizeTitle(l);
      if (s) out.push(s);
    }
    const cfg = getCfg();
    cfg.LAYERS = JSON.stringify(out);
    saveCfg(cfg);
    return send(200, { ok: true, count: out.length });
  }
  if (url.pathname === '/api/images/file' && req.method === 'GET') {
    const _src = String(url.searchParams.get('src') || '');
    const _safe = path.basename(_src).replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!_safe || _safe !== _src) return send(400, { error: 'bad src' });
    const _fp = path.join(IMAGES_DIR, _safe);
    if (!_fp.startsWith(IMAGES_DIR)) return send(400, { error: 'bad path' });
    try {
      const _st = fs.statSync(_fp);
      if (!_st.isFile()) return send(404, { error: 'not found' });
      const _ext = _safe.slice(_safe.lastIndexOf('.') + 1).toLowerCase();
      const _mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[_ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': _mime, 'Content-Length': _st.size, 'Cache-Control': 'public, max-age=3600' });
      fs.createReadStream(_fp).pipe(res);
      return;
    } catch (e) { return send(404, { error: 'not found' }); }
  }
  if (url.pathname === '/api/images' && req.method === 'GET') {
    let files = [];
    try {
      files = fs.readdirSync(IMAGES_DIR).filter(f => {
        const dot = f.lastIndexOf('.');
        const ext = dot > 0 ? f.slice(dot + 1).toLowerCase() : '';
        return IMG_EXTS.includes(ext) && fs.statSync(path.join(IMAGES_DIR, f)).isFile();
      }).sort();
    } catch (e) {}
    return send(200, { images: files });
  }
  if (url.pathname === '/api/images/upload' && req.method === 'POST') {
    const ctype = req.headers['content-type'] || '';
    const bm = ctype.match(/boundary=([^;]+)/);
    if (!bm) return send(400, { error: '需要 multipart/form-data' });
    const boundary = Buffer.from('--' + bm[1].trim());
    const buf = await rawBody(req, 6 * 1024 * 1024);
    if (!buf) return send(413, { error: '请求体过大' });
    let saved = null;
    let pos = 0;
    while (pos < buf.length) {
      const bStart = buf.indexOf(boundary, pos);
      if (bStart < 0) break;
      const hEnd = buf.indexOf('\r\n\r\n', bStart);
      if (hEnd < 0) break;
      const head = buf.slice(bStart, hEnd).toString('latin1');
      let rawFn = '';
      const fstar = head.match(/filename\*=UTF-8''([^;\r\n]+)/i);
      if (fstar) { try { rawFn = decodeURIComponent(fstar[1].trim()); } catch (e) { rawFn = ''; } }
      if (!rawFn) {
        const fnm = head.match(/filename="([^"]*)"/);
        if (fnm) { try { rawFn = Buffer.from(fnm[1], 'latin1').toString('utf8'); } catch (e) { rawFn = fnm[1]; } }
      }
      const nextB = buf.indexOf(boundary, hEnd + 4);
      if (rawFn && nextB > 0) {
        const data = buf.slice(hEnd + 4, nextB - 2);
        const src = safeName(rawFn);
        if (!src) return send(400, { error: '不支持的图片格式(仅 png/jpg/jpeg/gif/webp/bmp)' });
        if (data.length === 0) return send(400, { error: '空文件' });
        if (data.length > 5 * 1024 * 1024) return send(413, { error: '文件过大(最大5MB)' });
        try { fs.mkdirSync(IMAGES_DIR, { recursive: true }); } catch (e) {}
        const dot = src.lastIndexOf('.');
        const ext = src.slice(dot + 1), base = src.slice(0, dot);
        let dest = path.join(IMAGES_DIR, src), i = 1;
        while (fs.existsSync(dest)) { dest = path.join(IMAGES_DIR, base + '-' + (i++) + '.' + ext); }
        fs.writeFileSync(dest, data);
        saved = path.basename(dest);
        break;
      }
      if (nextB < 0) break;
      pos = nextB + boundary.length;
    }
    if (!saved) return send(400, { error: '未找到图片文件' });
    return send(200, { ok: true, src: saved });
  }
  if (url.pathname === '/api/health' && req.method === 'GET') {
    const h={cpu:'',mem:'',bitrate:''};
    try{
      const st=await sh('docker stats --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}" ' + GRID_CONTAINER + ' 2>&1',8000);
      const m=(st.stdout||'').match(/([\d.]+)%\|([\d.]+\w+)/);
      if(m){ h.cpu=m[1]+'%'; h.mem=m[2]; }
    }catch(e){}
    try{
      const r1=await sh('docker exec ' + GRID_CONTAINER + ' cat /sys/class/net/eth0/statistics/tx_bytes 2>&1',5000);
      const b1=parseInt((r1.stdout||'').trim());
      await new Promise(r=>setTimeout(r,2000));
      const r2=await sh('docker exec ' + GRID_CONTAINER + ' cat /sys/class/net/eth0/statistics/tx_bytes 2>&1',5000);
      const b2=parseInt((r2.stdout||'').trim());
      if(b1>0&&b2>b1){ h.bitrate=Math.round((b2-b1)*8/2/1000)+'kbps'; }
    }catch(e){}
    return send(200,h);
  }
  if (url.pathname === '/api/pullrate' && req.method === 'GET') {
    let rate='1';
    try{ rate=(require('fs').readFileSync('/volume2/docker/stream-proxy/pull_rate.conf','utf8').trim())||'1'; }catch(e){}
    if(!/^[0-3]$/.test(rate)) rate='1';
    return send(200, { rate });
  }
  if (url.pathname === '/api/pullrate' && req.method === 'POST') {
    const b = await body();
    const rate = String(b.rate||'').trim();
    if(!/^[0-3]$/.test(rate)) return send(400, { error: 'bad rate' });
    require('fs').writeFileSync('/volume2/docker/stream-proxy/pull_rate.conf', rate+'\n');
    return send(200, { ok: true, rate });
  }
  if (url.pathname === '/api/title/apply' && req.method === 'POST') {
    try{
      const cfg= getCfg();
      let layers=[]; try{ const p=JSON.parse(cfg.LAYERS||'[]'); if(Array.isArray(p)) layers=p; }catch(e){}
      const titles=layers.filter(l=>l&&l.type==='title');
      cfg.TITLE_COUNT=String(titles.length);
      titles.forEach(function(t,i){
        cfg['TITLE_'+i+'_TEXT']=String(t.text||'').replace(/\r/g,'').slice(0,120);
        cfg['TITLE_'+i+'_POS']=t.pos||'tc';
        cfg['TITLE_'+i+'_SIZE']=t.size||'';
        const cl=String(t.color||'').trim();
        cfg['TITLE_'+i+'_COLOR']=(/^#[0-9a-fA-F]{6}$/.test(cl))?cl.toLowerCase():'#ffffff';
        cfg['TITLE_'+i+'_SCROLL']=t.scroll?'1':'0';
        cfg['TITLE_'+i+'_SPEED']=t.speed||'120';
        cfg['TITLE_'+i+'_X']=t.x||''; cfg['TITLE_'+i+'_Y']=t.y||'';
      });
      saveCfg(cfg);
    }catch(e){}
    // 2026-10-18:docker 客户端太老,改用 API 重启容器(标题需重建滤镜)
    // 2026-10-19:重启不 await——daemon 的 restart 是同步的(等停稳 10s 才返回),
    // 前端 10s 超时必误报"失败";改 fire-and-forget,立即返回,重启在后台完成
    sh('curl -s --unix-socket /var/run/docker.sock -X POST http://localhost/containers/' + GRID_CONTAINER + '/restart').then(r => { if (r.err) console.error('[title/apply] 重启失败:', r.err.message); });
    return send(200, { ok: true });
  }
  if (url.pathname === '/api/title' && req.method === 'GET') {
    const cfg0 = getCfg();
    return send(200, { text: cfg0.GLOBAL_TEXT || '', scroll: cfg0.TITLE_SCROLL !== '0', speed: parseInt(cfg0.TITLE_SPEED) || 120 });
  }
  if (url.pathname === '/api/title' && req.method === 'POST') {
    const b = await body();
    const cfg = getCfg();
    if (b.text !== undefined) cfg.GLOBAL_TEXT = String(b.text || '').replace(/\r/g, '').slice(0, 120);
    if (b.scroll !== undefined) cfg.TITLE_SCROLL = b.scroll ? '1' : '0';
    if (b.speed !== undefined) { const _sp = parseInt(b.speed); if (_sp >= 20 && _sp <= 500) cfg.TITLE_SPEED = String(_sp); }
    saveCfg(cfg);
    return send(200, { ok: true });
  }
  if (url.pathname === '/api/textpos' && req.method === 'GET') {
    const cfg = getCfg();
    return send(200, {
      labelPos: cfg.LABEL_POS || 'bl', titlePos: cfg.TITLE_POS || 'tc',
      titleX: cfg.TITLE_X || '0.5', titleY: cfg.TITLE_Y || '0.03',
      labelSize: cfg.LABEL_SIZE || '', titleSize: cfg.TITLE_SIZE || '',
      labelColor: cfg.LABEL_COLOR || '#ffffff', titleColor: cfg.TITLE_COLOR || '#ffffff'
    });
  }
  if (url.pathname === '/api/textpos' && req.method === 'POST') {
    const b = await body();
    const cfg = getCfg();
    const okp = ['tl', 'tr', 'bl', 'br', 'tc', 'bc', 'custom'];
    if (okp.includes(b.labelPos)) cfg.LABEL_POS = b.labelPos;
    const fracOk = (v) => { v = String(v == null ? '' : v).trim(); return /^(0(\.\d+)?|1(\.0+)?)$/.test(v) ? v : null; };
    if (b.titlePos === 'custom') {
      const fx = fracOk(b.titleX), fy = fracOk(b.titleY);
      if (fx !== null && fy !== null) { cfg.TITLE_POS = 'custom'; cfg.TITLE_X = fx; cfg.TITLE_Y = fy; }
    } else if (okp.includes(b.titlePos)) cfg.TITLE_POS = b.titlePos;
    // 没提交的字段保持不动;提交空字符串=清空(回自动/默认)
    const setNum = (key, raw, a, z) => {
      if (raw === undefined) return;
      const v = String(raw).trim();
      if (v === '') { cfg[key] = ''; return; }
      if (/^[0-9]+$/.test(v) && +v >= a && +v <= z) cfg[key] = String(+v);
    };
    const setCol = (key, raw) => {
      if (raw === undefined) return;
      const v = String(raw).trim();
      if (v === '') { cfg[key] = ''; return; }
      if (/^#[0-9a-fA-F]{6}$/.test(v)) cfg[key] = v.toLowerCase();
    };
    setNum('LABEL_SIZE', b.labelSize, 10, 72);
    setNum('TITLE_SIZE', b.titleSize, 12, 96);
    setCol('LABEL_COLOR', b.labelColor);
    setCol('TITLE_COLOR', b.titleColor);
    saveCfg(cfg);
    return send(200, { ok: true });
  }
  if (url.pathname === '/api/rooms/reorder' && req.method === 'POST') {
    const b = await body();
    const cfg = getCfg();
    const rids = (cfg.ROOMS||'').split(',').filter(Boolean);
    const ens = (cfg.ENABLED||'').split(',').filter(s=>s==='0'||s==='1');
    const vols = (cfg.VOLUMES||'').split(',').filter(s=>s!=='');
    while(ens.length<rids.length) ens.push('1');
    while(vols.length<rids.length) vols.push('1.0');
    const fromIdx = rids.indexOf(String(b.from));
    const toIdx = rids.indexOf(String(b.to));
    if(fromIdx>=0 && toIdx>=0 && fromIdx!==toIdx){
      const [rid] = rids.splice(fromIdx,1);
      const [en] = ens.splice(fromIdx,1);
      const [vo] = vols.splice(fromIdx,1);
      rids.splice(toIdx,0,rid);
      ens.splice(toIdx,0,en);
      vols.splice(toIdx,0,vo);
      cfg.ROOMS = rids.join(',');
      cfg.ENABLED = ens.join(',');
      cfg.VOLUMES = vols.join(',');
      saveCfg(cfg);
    }
    return send(200, {ok:true});
  }

  if (url.pathname === '/api/status') {
    const gs = await containerStatus(GRID_CONTAINER);
    let pushing = false, uptime = '';
    if (gs.running) {
      pushing = true;
      if (gs.started) {
        const mins = Math.floor((Date.now() - new Date(gs.started).getTime()) / 60000);
        uptime = mins < 60 ? mins + ' 分钟' : Math.floor(mins/60) + ' 小时 ' + (mins%60) + ' 分钟';
      }
    }
    let bitrate='', speed='';
    if(pushing){
      try{
        const lg = await sh('docker logs --tail 50 ' + GRID_CONTAINER + ' 2>&1 | tr "\\r" "\\n" | grep -a -o "bitrate=.*speed=[0-9.]*x" | tail -1', 5000);
        const line = String((lg&&lg.stdout)||'');
        const bm = line.match(/bitrate=\s*([0-9.]+kbits\/s)/);
        const sm = line.match(/speed=\s*([0-9.]+x)/);
        if(bm) bitrate=bm[1]; if(sm) speed=sm[1];
      }catch(e){}
    }
    let lastError='';
    if(!pushing){
      lastError = await getFfmpegError();
    }else{
      // 推流中也查一下是否有报错（比如 key 刚过期还在重试）
      const e = await getFfmpegError();
      if(e) lastError = e;
    }
    return send(200, { pushing, uptime, rtmpUrl: getRtmpUrl(), layout: getLayout(), bitrate, speed, lastError });
  }

  if (url.pathname === '/api/rooms') {
    if (req.method === 'GET') {
      const rooms = getRooms();
      const infos = await Promise.all(rooms.map(async (r) => {
        const info = await roomInfo(r.rid);
        return { rid: r.rid, name: info.name, live: info.live, enabled: r.enabled, volume: r.volume, label: r.label || '' };
      }));
      return send(200, infos);
    }
    if (req.method === 'POST') {
      const b = await body();
      const rid = (b.rid || '').trim();
      let valid = true;
      for (const ch of rid) { if (ch < '0' || ch > '9') valid = false; }
      if (!valid || !rid) return send(400, { error: '房间号无效' });
      const rooms = getRooms();
      if (rooms.some(r => r.rid === rid)) return send(400, { error: '已存在' });
      if (rooms.length >= 10) return send(400, { error: '最多10个' });
      rooms.push({ rid, enabled: false });
      await setConfig(rooms, getRtmpUrl());
      // 2026-10-20:8901 加房间同步推给 8900,否则镜像同步会把它当 8900 没有的房间删掉
      try {
        const list = await new Promise((resolve) => {
          const req = http.get(MULTIVIEW + '/api/rooms', { timeout: 5000 }, (res2) => {
            let d = ''; res2.on('data', c => d += c);
            res2.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
          });
          req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
        });
        if (Array.isArray(list) && !list.map(String).includes(String(rid))) {
          const payload = JSON.stringify({ rooms: [...list.map(String), String(rid)] });
          await new Promise((resolve) => {
            const u = new URL(MULTIVIEW + '/api/rooms');
            const r2 = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname,
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
              timeout: 8000 }, (res2) => { res2.resume(); res2.on('end', () => resolve()); });
            r2.on('error', () => resolve()); r2.on('timeout', () => { r2.destroy(); resolve(); });
            r2.write(payload); r2.end();
          });
        }
      } catch (e) {}
      return send(200, { ok: true });
    }
  }

  if (url.pathname.indexOf('/api/rooms/') === 0 && req.method === 'DELETE') {
    const rid = url.pathname.slice(11);
    const rooms = getRooms().filter(r => r.rid !== rid);
    await setConfig(rooms, getRtmpUrl());
    // 2026-10-19:删房间顺带清空占用的 slot,避免留下野 slot 继续拉已删房间
    try {
      const sr = await proxyReq('GET', '/api/slots');
      const slots = (sr && sr.json && sr.json.slots) || {};
      for (const k of Object.keys(slots)) {
        if (String(slots[k]) === String(rid)) {
          const idx = parseInt(k.replace('slot', ''), 10);
          if (!isNaN(idx)) await proxyReq('POST', '/api/slots', { slot: idx, rid: null });
        }
      }
    } catch (e) {}
    // 2026-10-19:同步删掉 8900 的该房间,否则 syncFromMultiview 10 秒内把它加回来,等于白删
    try {
      const list = await new Promise((resolve) => {
        const req = http.get(MULTIVIEW + '/api/rooms', { timeout: 5000 }, (res2) => {
          let d = ''; res2.on('data', c => d += c);
          res2.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
        });
        req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
      });
      if (Array.isArray(list)) {
        const filtered = list.map(String).filter(r => r !== String(rid));
        if (filtered.length !== list.length) {
          await new Promise((resolve) => {
            const payload = JSON.stringify({ rooms: filtered });
            const u = new URL(MULTIVIEW + '/api/rooms');
            const r2 = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname,
              method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
              timeout: 8000 }, (res2) => { res2.resume(); res2.on('end', () => resolve()); });
            r2.on('error', () => resolve()); r2.on('timeout', () => { r2.destroy(); resolve(); });
            r2.write(payload); r2.end();
          });
        }
      }
    } catch (e) {}
    return send(200, { ok: true });
  }



  if (url.pathname === '/api/rtmp' && req.method === 'POST') {
    const b = await body();
    const rtmpUrl = (b.url || '').trim();
    if (rtmpUrl.indexOf('rtmp://') !== 0) return send(400, { error: '地址无效' });
    await setConfig(getRooms(), rtmpUrl);
    return send(200, { ok: true });
  }

  if (url.pathname === '/api/slots') {
    if (req.method === 'GET') {
      const r = await proxyReq('GET', '/api/slots');
      return send(r.status === 200 ? 200 : 502, r.json || { error: 'proxy unreachable' });
    }
    if (req.method === 'POST') {
      const b = await body();
      const r = await proxyReq('POST', '/api/slots', b);
      return send(r.status === 200 ? 200 : 502, r.json || { error: 'proxy unreachable' });
    }
    return send(405, { error: 'method not allowed' });
  }

  if (url.pathname === '/api/layout' && req.method === 'POST') {
    const b = await body();
    const layout = (b.layout || 'auto').trim();
    if (['auto','grid','focus','single','side','stack','pip'].indexOf(layout) < 0) return send(400, { error: '布局无效' });
    await setConfig(getRooms(), getRtmpUrl(), layout);
    return send(200, { ok: true });
  }

  if (url.pathname === '/api/control' && req.method === 'POST') {
    const b = await body();
    // 2026-10-18:容器内 docker 客户端太老(API 1.41),直调 daemon API
    // 2026-10-19:重启类操作不 await(同步 restart 10s+ 必超前端超时误报),fire-and-forget
    const restartBg = () => sh('curl -s --unix-socket /var/run/docker.sock -X POST http://localhost/containers/' + GRID_CONTAINER + '/restart').then(r => { if (r.err) console.error('[control] 重启失败:', r.err.message); });
    if (b.action === 'start') await sh('curl -s --unix-socket /var/run/docker.sock -X POST http://localhost/containers/' + GRID_CONTAINER + '/start');
    if (b.action === 'stop') await sh('curl -s --unix-socket /var/run/docker.sock -X POST http://localhost/containers/' + GRID_CONTAINER + '/stop');
    if (b.action === 'restart') restartBg();
    return send(200, { ok: true });
  }

  send(404, { error: 'not found' });
});

server.listen(PORT, () => console.log('管理页 :' + PORT));
