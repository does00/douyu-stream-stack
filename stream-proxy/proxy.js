#!/usr/bin/env node
// stream-proxy: 斗鱼 FLV 代理
// 单房间中途下播时不断开与推流端 ffmpeg 的 HTTP 连接,用黑场填充占位;
// 所有输出(上游流/黑场)经过 FLV 时间戳重基,保证整条流时间戳单调连续,
// 房间恢复开播后无缝续流。黑场模板启动时生成一次,按需重基时间戳复用。
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const fs = require('fs');

const MULTIVIEW = process.env.MULTIVIEW || 'http://douyu-multiview:8787';
const PORT = parseInt(process.env.PORT || '8888');
const FILLER_SEC = 2;
const FILLER_PATH = '/tmp/filler.flv';
const SLOT_COUNT = 9;
const SLOTS_FILE = process.env.SLOTS_FILE || '/app/slots.json';

// ---- slot->rid 映射:热更新,单一写入源为 POST /api/slots ----
let slots = {};           // { slot0: "rid"|null, ... }
let slotsVersion = 0;     // 全局版本(供 API),任一 slot 变更 +1
let slotVer = new Array(SLOT_COUNT).fill(0); // 每 slot 独立版本,只变自己的
function slotsJson() { return JSON.stringify(slots); }
function normRid(v) { return (v === undefined || v === null || v === '') ? null : String(v); }
function loadSlots() {
  try {
    const raw = fs.readFileSync(SLOTS_FILE, 'utf8');
    const j = JSON.parse(raw);
    let changed = false;
    for (let i = 0; i < SLOT_COUNT; i++) {
      const nv = normRid(j['slot' + i]);
      if (slots['slot' + i] !== nv) { slots['slot' + i] = nv; slotVer[i]++; changed = true; }
    }
    if (changed) {
      slotsVersion++;
      console.log(`[slots] 映射已加载 v${slotsVersion}: ${slotsJson()}`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.log(`[slots] 读取失败: ${e.message}`);
  }
}
function slotRid(i) {
  const v = slots['slot' + i];
  return (v === undefined || v === null || v === '') ? null : String(v);
}
function saveSlots() {
  // 注意:SLOTS_FILE 通常是 bind 挂载的单文件,rename 到挂载点会 EBUSY,
  // 因此原地写;读侧 loadSlots 对半截 JSON 有 try/catch 兜底
  fs.writeFileSync(SLOTS_FILE, JSON.stringify(slots, null, 2));
}
loadSlots();
try {
  // 监听目录(文件可能尚不存在),只响应 slots.json 的变化
  fs.watch(require('path').dirname(SLOTS_FILE), (ev, name) => {
    if (name === require('path').basename(SLOTS_FILE)) loadSlots();
  });
} catch (e) { console.log(`[slots] 监听失败: ${e.message}`); }

function getPullRate(){
  try{
    const fs=require('fs');
    const v=fs.readFileSync('/tmp/pull_rate','utf8').trim();
    if(/^[0-3]$/.test(v)) return v;
  }catch(e){}
  return process.env.PULL_RATE || '1';
}
function getStreamUrl(rid) {
  return new Promise((resolve, reject) => {
    const _pr = getPullRate();
    const url = `${MULTIVIEW}/api/stream?rid=${rid}&rate=${_pr}`;
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const s = j.stream || j;
          const u = s.url || s.flv || (s.urls && s.urls[0]);
          if (u) resolve(u);
          else reject(new Error('no url'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('stream api timeout')); });
  });
}

// ---- FLV tag 时间戳读写(FLV 无校验和,可原地改写) ----
// tag: type(1) | dataSize(3) | timestamp(3)+timestampExt(1) | streamId(3) | data | prevTagSize(4)
function parseTs(b, o) {
  return b[o+4]*65536 + b[o+5]*256 + b[o+6] + b[o+7]*16777216;
}
function writeTs(b, o, ts) {
  ts = Math.max(0, Math.floor(ts)) % 4294967296;
  b[o+4] = (ts>>>16)&0xff; b[o+5] = (ts>>>8)&0xff; b[o+6] = ts&0xff;
  b[o+7] = Math.floor(ts/16777216)&0xff;
}
function tagDataSize(b, o) {
  return b[o+1]*65536 + b[o+2]*256 + b[o+3];
}

// ---- 上游时间戳重基器:输出时间线永远单调递增 ----
function makeRebaser() {
  let buf = Buffer.alloc(0);
  let headerDone = false;
  let opaque = false; // 非 FLV 上游则透传,不重基
  let sessStarted = false;
  let sessOffset = 0;
  let sessMaxRaw = -1;
  let outMax = 0;
  let waitKey = false;
  let waitKeySince = 0;
  let headerWritten = false; // 本连接只输出一次 FLV 文件头,后续会话的文件头丢弃

  function newSession() {
    buf = Buffer.alloc(0);
    headerDone = false; opaque = false;
    sessStarted = false; sessMaxRaw = -1;
    waitKey = true; // 2026-10-18:新会话等视频关键帧(序列头)再转发,避免 P 帧开头卡死解码器
    waitKeySince = Date.now();
    // headerWritten 不重置
  }
  // 取 FLV 文件头(每个连接只给一次);filler 先行时调用,上游会话里不再重复输出
  function takeHeader() {
    if (headerWritten) return null;
    headerWritten = true;
    return Buffer.from([0x46,0x4C,0x56,0x01,0x05,0,0,0,9,0,0,0,0]);
  }
  function push(chunk) {
    if (opaque) return chunk;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const parts = [];
    if (!headerDone) {
      if (buf.length < 13) return null;
      if (buf[0]===0x46 && buf[1]===0x4C && buf[2]===0x56) { // 'FLV'
        const h = takeHeader(); // 本连接已输出过文件头则丢弃,避免流中间出现第二个文件头
        if (h) parts.push(h);
        buf = buf.slice(13);
      } else {
        opaque = true;
        const o = buf; buf = Buffer.alloc(0);
        return o;
      }
      headerDone = true;
    }
    while (buf.length >= 11) {
      const ds = tagDataSize(buf, 0);
      if (ds > 32*1024*1024) { buf = Buffer.alloc(0); headerDone = false; break; }
      const total = 11 + ds + 4;
      if (buf.length < total) break;
      // 等关键帧:新会话的视频tag必须等到序列头(H.264 AVCPacketType=0)或关键帧才转发
      // 2026-10-18:加 3s 超时兜底,等不到也放行(有画面总比黑屏强)
      if (waitKey && buf[0] === 9 && ds >= 2) {
        if (Date.now() - waitKeySince > 3000) {
          waitKey = false;
        } else {
          const frameType = buf[11] >> 4;
          const codecId = buf[11] & 0x0f;
          const avcType = buf[12];
          const isSeqHeader = (codecId === 7 && avcType === 0);
          const isKeyframe = (frameType === 1);
          if (!isSeqHeader && !isKeyframe) {
            // 丢弃非关键帧,等序列头
            buf = buf.slice(total);
            continue;
          }
          waitKey = false;
        }
      }
      let raw = parseTs(buf, 0);
      if (!sessStarted) {
        sessStarted = true;
        sessMaxRaw = raw;
        sessOffset = outMax - raw + 40; // 把本会话接到输出时间线末端
      } else {
        // 2026-10-18:钳住向前跳变(>5s)——上游时间戳跳变不污染输出时间线,直接重置偏移
        if (raw > sessMaxRaw + 5000) {
          sessOffset = outMax - raw + 40;
          sessMaxRaw = raw;
        } else if (raw > sessMaxRaw) {
          sessMaxRaw = raw;
        } else {
          raw = sessMaxRaw; // 钳住回退的时间戳
        }
      }
      const nts = raw + sessOffset;
      writeTs(buf, 0, nts);
      if (nts > outMax) outMax = nts;
      parts.push(buf.slice(0, total));
      buf = buf.slice(total);
    }
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : Buffer.concat(parts);
  }
  return {
    newSession, push, takeHeader,
    outMax: () => outMax,
    bump: (ts) => { if (ts > outMax) outMax = ts; },
    advance: (ms) => { outMax += ms; },
    setOutMax: (v) => { outMax = v; },
    isReady: () => !waitKey,
  };
}

// ---- 黑场模板:启动生成一次(5秒黑画面+静音),每次重基时间戳后复用 ----
let fillerBody = null; // 已去掉 13 字节文件头
function genFiller() {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const ff = spawn('ffmpeg', ['-y','-v','error',
      '-f','lavfi','-i',`color=black:s=1280x720:r=25:d=${FILLER_SEC}`,
      '-f','lavfi','-i',`anullsrc=r=44100:cl=stereo:d=${FILLER_SEC}`,
      '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
      '-c:a','aac','-t',String(FILLER_SEC),
      '-f','flv',FILLER_PATH]);
    ff.on('close', () => {
      try {
        const b = fs.readFileSync(FILLER_PATH);
        if (b.length > 13 && b[0]===0x46 && b[1]===0x4C && b[2]===0x56) {
          // 2026-10-18:去掉按时间戳排序——排序曾导致模板时间戳错乱(2.5M 跳变),
          // ffmpeg 生成的交织顺序已足够,尾部几十 ms 回退由 rebaser 钳制
          fillerBody = b.slice(13); // 去掉文件头,只保留 tags
          console.log(`黑场模板已生成 ${b.length} 字节`);
        } else {
          console.error('黑场模板内容异常,走现做现卖兜底');
        }
      } catch (e) { console.error('黑场模板生成失败:', e.message); }
      finish();
    });
    ff.on('error', (e) => { console.error('黑场模板 ffmpeg 起不来:', e.message); finish(); });
    setTimeout(() => { try { ff.kill('SIGKILL'); } catch(e){} finish(); }, 20000);
  });
}

// 用模板拼一段黑场:拷贝后把时间戳接到当前时间线末端(不带文件头,可直接拼流)
function buildFillerChunk(rebaser) {
  if (!fillerBody) return null;
  const out = Buffer.from(fillerBody);
  const base = rebaser.outMax() + 40;
  let off = 0, maxTs = 0;
  while (off + 11 <= out.length) {
    const ds = tagDataSize(out, off);
    const total = 11 + ds + 4;
    if (ds > 32*1024*1024 || off + total > out.length) break;
    const nts = base + parseTs(out, off);
    writeTs(out, off, nts);
    if (nts > maxTs) maxTs = nts;
    off += total;
  }
  rebaser.bump(maxTs);
  return out;
}

// 兜底:模板不可用时现做现卖(带时间戳偏移、去文件头)
function spawnFillerChunk(rebaser) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (b) => {
      if (done) return; done = true;
      rebaser.advance(FILLER_SEC * 1000);
      resolve(b);
    };
    const off = (rebaser.outMax() + 40) / 1000;
    const ff = spawn('ffmpeg', ['-y','-v','error',
      '-f','lavfi','-i',`color=black:s=1280x720:r=25:d=${FILLER_SEC}`,
      '-f','lavfi','-i',`anullsrc=r=44100:cl=stereo:d=${FILLER_SEC}`,
      '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
      '-c:a','aac','-t',String(FILLER_SEC),
      '-output_ts_offset', String(off),
      '-f','flv','pipe:1']);
    const bufs = [];
    ff.stdout.on('data', (c) => bufs.push(c));
    ff.on('close', () => {
      let b = bufs.length ? Buffer.concat(bufs) : null;
      if (b && b.length > 13) b = b.slice(13);
      finish(b);
    });
    ff.on('error', () => finish(null));
    setTimeout(() => { try { ff.kill('SIGKILL'); } catch(e){} finish(null); }, (FILLER_SEC+3)*1000);
  });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  // ---- 管理 API ----
  if (req.url === '/api/slots/sh') {
    // 给 grid.sh 用的 shell 格式:SLOT_0='rid'……(空 slot 为 '')
    const esc = (v) => "'" + String(v == null ? '' : v).replace(/'/g, "'\\''") + "'";
    let out = '';
    for (let i = 0; i < SLOT_COUNT; i++) out += `SLOT_${i}=${esc(slotRid(i))}\n`;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(out);
    return;
  }
  if (req.url === '/api/slots' || req.url.startsWith('/api/slots?')) {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: slotsVersion, slots }));
      return;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      let changed = false;
      const apply = (idx, v) => {
        idx = parseInt(idx);
        if (!(idx >= 0 && idx < SLOT_COUNT)) return;
        const nv = normRid(v);
        if (slots['slot' + idx] !== nv) { slots['slot' + idx] = nv; slotVer[idx]++; changed = true; }
      };
      if (body && typeof body.slot !== 'undefined') apply(body.slot, body.rid);
      if (body && body.slots && typeof body.slots === 'object') {
        for (const k of Object.keys(body.slots)) {
          const mm = String(k).match(/^slot(\d+)$/);
          if (mm) apply(mm[1], body.slots[k]);
        }
      }
      if (changed) {
        try { saveSlots(); } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '写文件失败: ' + e.message })); return; }
        slotsVersion++;
        console.log(`[slots] API 更新 v${slotsVersion}: ${slotsJson()}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, changed, version: slotsVersion, slots }));
      return;
    }
    res.writeHead(405); res.end(); return;
  }

  const mSlot = req.url.match(/^\/live\/slot(\d+)(?:\/|$)/);
  const mRid = req.url.match(/^\/live\/(\d+)(?:\/|$)/);
  if (!mSlot && !mRid) { res.writeHead(404); res.end('use /live/<rid> or /live/slotN'); return; }
  const isSlot = !!mSlot;
  const slotIdx = isSlot ? parseInt(mSlot[1]) : -1;
  if (isSlot && (slotIdx < 0 || slotIdx >= SLOT_COUNT)) { res.writeHead(404); res.end('slot 范围 0-' + (SLOT_COUNT - 1)); return; }
  const fixedRid = isSlot ? null : mRid[1];
  let curRid = isSlot ? slotRid(slotIdx) : fixedRid;   // slot 模式:每次循环重读映射
  let seenVer = isSlot ? slotVer[slotIdx] : 0;         // 本 slot 的独立版本
  const tag = () => isSlot ? `slot${slotIdx}=>${curRid || '空'}` : `房间 ${fixedRid}`;
  const now = () => new Date().toISOString();
  console.log(`[${now()}] ${tag()} 接入`);
  // slot 映射看门狗:本 slot 映射变化时同步新 rid 并杀掉当前上游,强制主循环重估(<=2秒生效)
  // 注意:触发时直接同步 seenVer/curRid,避免黑场等待中的连接重复触发;
  // 用每 slot 独立版本,remap 一个 slot 不误伤其他 slot
  const verTimer = isSlot ? setInterval(() => {
    if (closed) return;
    if (slotVer[slotIdx] !== seenVer) {
      const nr = slotRid(slotIdx);
      console.log(`[${now()}] ${tag()} 映射变化,切换上游`);
      curRid = nr;
      seenVer = slotVer[slotIdx];
      killUpstream();
    }
  }, 2000) : null;
  const headers = { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.douyu.com/' };
  let closed = false;
  let curPr = null, curUpRes = null;
  function killUpstream(){
    try{ if(curUpRes) curUpRes.destroy(); }catch(e){}
    try{ if(curPr) curPr.destroy(); }catch(e){}
    curPr = null; curUpRes = null;
  }
  req.on('close', () => { closed = true; if (verTimer) clearInterval(verTimer); killUpstream(); });
  // 先写头再取流:房间离线也不 502,直接黑场占位,推流端连接不断
  res.writeHead(200, {
    'Content-Type': 'video/x-flv',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  const rebaser = makeRebaser();
  // FLV 文件头每个连接只写一次(先写,后续上游会话/填充都不再带头)
  try { const hh = rebaser.takeHeader(); if (hh) res.write(hh); } catch (e) {}

  function fetchUpstream(url) {
    return new Promise((resolve) => {
      // 注意:stream.destroy() 触发 'close' 而非 'error',必须监听 'close',
      // 否则 killUpstream 后 promise 永不 resolve,主循环卡死
      // (2026-10-18 实测:看门狗 kill 后主循环 60s+ 无响应,根因即此)
      let done = false;
      const finish = (v) => { if (done) return; done = true; curPr = null; curUpRes = null; resolve(v); };
      (function go(u, depth) {
        if (closed || depth > 5) return finish();
        const client = u.startsWith('https') ? https : http;
        let pr;
        try {
          pr = client.get(u, { headers }, (upRes) => {
            if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
              upRes.resume();
              // 旧请求不再参与结算,避免它的 close 误杀重定向后的新请求
              pr.removeAllListeners('close');
              pr.removeAllListeners('error');
              go(upRes.headers.location, depth + 1);
              return;
            }
            if (upRes.statusCode !== 200) { upRes.resume(); finish(); return; }
            curPr = pr; curUpRes = upRes;
            rebaser.newSession();
            let gotData = false;
            // 2026-10-18:数据 idle 超时——上游连接建立后若 10s 无数据,判定断流,
            // 杀掉走 filler/重试,避免半开连接卡死主循环(ffmpeg 输入饿死致卡顿)
            let lastDataAt = Date.now();
            const idleTimer = setInterval(() => {
              if (closed || done) { clearInterval(idleTimer); return; }
              if (Date.now() - lastDataAt > 10000) {
                clearInterval(idleTimer);
                try { pr.destroy(); } catch (e) {}
                try { upRes.destroy(); } catch (e) {}
                finish(gotData);
              }
            }, 2000);
            upRes.on('data', (c) => {
              if (closed) { killUpstream(); return; }
              gotData = true;
              lastDataAt = Date.now();
              let out = null;
              try { out = rebaser.push(c); } catch (e) { out = null; }
              if (out && out.length) { try { res.write(out); } catch (e) {} }
            });
            const fin = () => finish(gotData);
            upRes.on('end', fin);
            upRes.on('error', fin);
            upRes.on('close', fin);
          });
        } catch (e) { finish(); return; }
        pr.on('error', () => finish(false));
        pr.on('close', () => finish(false));
        pr.setTimeout(15000, () => { try { pr.destroy(); } catch (e) {} finish(false); });
      })(url, 0);
    });
  }

  // 2026-10-18 make-before-break:后台预取新上游,等到关键帧就绪后返回连接(不写 res)
  // 调用方负责在就绪后切换 rebaser 并接管连接
  function prepareUpstream(url, tmpRebaser, timeoutMs = 10000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => { if (done) return; done = true; resolve(result); };
      const timer = setTimeout(() => finish(null), timeoutMs);
      (function go(u, depth) {
        if (closed || done || depth > 5) { clearTimeout(timer); return finish(null); }
        const client = u.startsWith('https') ? https : http;
        let pr;
        try {
          pr = client.get(u, { headers }, (upRes) => {
            if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
              upRes.resume();
              pr.removeAllListeners('close'); pr.removeAllListeners('error');
              go(upRes.headers.location, depth + 1);
              return;
            }
            if (upRes.statusCode !== 200) { upRes.resume(); clearTimeout(timer); return finish(null); }
            tmpRebaser.newSession();
            upRes.on('data', (c) => {
              if (closed || done) return;
              try { tmpRebaser.push(c); } catch (e) {}
              // 关键帧就绪:返回连接,调用方接管
              if (tmpRebaser.isReady()) {
                clearTimeout(timer);
                finish({ pr, upRes });
              }
            });
            upRes.on('end', () => { clearTimeout(timer); finish(null); });
            upRes.on('error', () => { clearTimeout(timer); finish(null); });
            upRes.on('close', () => { clearTimeout(timer); finish(null); });
          });
        } catch (e) { clearTimeout(timer); return finish(null); }
        pr.on('error', () => { clearTimeout(timer); finish(null); });
        pr.setTimeout(15000, () => { try { pr.destroy(); } catch (e) {} clearTimeout(timer); finish(null); });
      })(url, 0);
    });
  }

  (async () => {
    let fails = 0;
    let lastSeenVer = isSlot ? slotVer[slotIdx] : 0;
    while (!closed) {
      // slot 模式:每次迭代重读映射(看门狗已杀上游时这里拿到新 rid)
      if (isSlot) {
        curRid = slotRid(slotIdx);
        const newVer = slotVer[slotIdx];
        // 2026-10-18:映射变化时先发一块黑场(5s),覆盖取新上游的间隙,
        // 否则 getStreamUrl+fetchUpstream 的 2-5s 内无数据,ffmpeg 输入饿死致卡顿
        if (newVer !== lastSeenVer) {
          try {
            const _chunk = buildFillerChunk(rebaser);
            if (_chunk && _chunk.length) res.write(_chunk);
          } catch (e) {}
        }
        seenVer = newVer;
        lastSeenVer = newVer;
      }
      let url = null, streamed = false;
      if (curRid) {
        try { url = await getStreamUrl(curRid); }
        catch (e) { console.error(`[${now()}] ${tag()} 取流地址失败: ${e.message}`); }
        // 2026-10-18:取地址期间若映射又变了,丢弃旧地址回主循环(避免连上旧房间又被杀,白白卡几秒)
        if (isSlot && !closed && slotVer[slotIdx] !== lastSeenVer) continue;
        if (url && !closed) streamed = await fetchUpstream(url);
        // 取流期间若映射变了,直接回主循环(不计失败)
        if (isSlot && !closed && slotVer[slotIdx] !== lastSeenVer) continue;
      }
      if (closed) break;
      if (streamed) { fails = 0; continue; }
      fails++;
      if (fails === 1) {
        // 首次失败:快速重试,不黑场
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      // 连续失败:黑场占位+退避(5s起,最高30s),退避期间持续发黑场保活
      const backoff = Math.min(5000 * (fails - 1), 30000);
      console.log(`[${now()}] ${tag()} 上游无流(连续${fails}次),黑场保活${backoff/1000}秒后重试`);
      const endAt = Date.now() + backoff;
      // 按墙钟精确 pacing:每块固定 5s 时间戳,按墙钟 5s 间隔发送,避免时间戳漂移
      // (2026-10-18:固定 sleep 5s 会累积处理耗时,导致填充流时间戳落后墙钟,
      //  多路输入在 ffmpeg 滤镜同步时越差越大,最终卡死)
      let nextChunkAt = Date.now();
      while (!closed && Date.now() < endAt) {
        // slot 映射变化时立即跳出等待,回主循环重估
        if (isSlot && slotVer[slotIdx] !== seenVer) break;
        const chunk = buildFillerChunk(rebaser) || await spawnFillerChunk(rebaser);
        if (chunk && chunk.length) { try { res.write(chunk); } catch (e) { break; } }
        nextChunkAt += FILLER_SEC * 1000;
        const waitMs = nextChunkAt - Date.now();
        if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
        // 落后太多则重置基准,避免追赶式 spam
        if (nextChunkAt < Date.now() - FILLER_SEC * 1000) nextChunkAt = Date.now();
        if (Date.now() >= endAt) break;
      }
    }
    if (verTimer) clearInterval(verTimer);
    try { res.end(); } catch (e) {}
    console.log(`[${now()}] ${tag()} 连接关闭`);
  })();
});

(async () => {
  await genFiller();
  server.listen(PORT, () => console.log(`代理监听 :${PORT}`));
})();
