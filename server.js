// KURSK Rating System — 실시간 동기화 서버 v2
// 진영별(소련/독일) 레이팅 + 포지션별 통계 지원

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
const DATA_FILE = path.join(__dirname, 'kursk_data.json');
const K_OVERALL = 16;  // 전체 레이팅 K값 (느리게 변동)
const K_FACTION = 32;  // 소련/독일 진영 레이팅 K값

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── 데이터 ───────────────────────────────────────────────────
function emptyData() {
  return { players: {}, history: [], totalGames: 0, lastUpdated: Date.now() };
}
function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyData();
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch { return emptyData(); }
}
function writeData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

// ── 플레이어 기본 구조 ────────────────────────────────────────
function emptyPlayer(name) {
  return {
    name,
    // 전체
    rating: 1200, games: 0, wins: 0, losses: 0, draws: 0, lastDelta: 0,
    // 소련
    sovRating: 1200, sovGames: 0, sovWins: 0, sovLosses: 0, sovDraws: 0, sovLastDelta: 0,
    // 독일
    gerRating: 1200, gerGames: 0, gerWins: 0, gerLosses: 0, gerDraws: 0, gerLastDelta: 0,
    // 포지션별 (소서/소중/소동/독서/독중/독동)
    pos: { sw:0, sc:0, se:0, gw:0, gc:0, ge:0 }
  };
}

function getPlayer(data, name) {
  const key = name.trim().toLowerCase();
  if (!data.players[key]) data.players[key] = emptyPlayer(name.trim());
  // 구버전 데이터 마이그레이션
  const p = data.players[key];
  if (!p.sovRating) { p.sovRating=1000; p.sovGames=0; p.sovWins=0; p.sovLosses=0; p.sovDraws=0; p.sovLastDelta=0; }
  if (!p.gerRating) { p.gerRating=1000; p.gerGames=0; p.gerWins=0; p.gerLosses=0; p.gerDraws=0; p.gerLastDelta=0; }
  if (!p.pos) p.pos = { sw:0, sc:0, se:0, gw:0, gc:0, ge:0 };
  return p;
}

function exp(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }

// ── SSE ──────────────────────────────────────────────────────
const clients = new Set();
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(payload); } catch { clients.delete(res); } });
}

// ── 티어별 패배 차감 감소 (전체 레이팅 전용) ─────────────────
// 브론즈:-8 / 실버:-7 / 골드:-7 / 다이아:-6 / 마스터:-6 / 그랜드마스터:-5
function getTierPenaltyReduction(rating, rank) {
  if (rating >= 2000 && rank <= 3) return 3;  // 그랜드마스터: -5
  if (rating >= 1800 && rank <= 5) return 2;  // 마스터: -6
  if (rating >= 1600)              return 2;  // 다이아몬드: -6
  if (rating >= 1400)              return 1;  // 골드: -7
  if (rating >= 1200)              return 1;  // 실버: -7
  return 0;                                   // 브론즈: -8
}

// 전체 순위 계산 (패널티 감소에 사용)
function getRank(data, playerKey) {
  const sorted = Object.entries(data.players)
    .sort(([,a],[,b]) => b.rating - a.rating);
  const idx = sorted.findIndex(([k]) => k === playerKey);
  return idx === -1 ? 999 : idx + 1;
}

// ── 게임 계산 로직 ────────────────────────────────────────────
function applyGame(data, soviet, german, result) {
  const sovPlayers = [
    { p: getPlayer(data, soviet.west),   pos: 'sw', key: soviet.west.trim().toLowerCase() },
    { p: getPlayer(data, soviet.center), pos: 'sc', key: soviet.center.trim().toLowerCase() },
    { p: getPlayer(data, soviet.east),   pos: 'se', key: soviet.east.trim().toLowerCase() },
  ];
  const gerPlayers = [
    { p: getPlayer(data, german.west),   pos: 'gw', key: german.west.trim().toLowerCase() },
    { p: getPlayer(data, german.center), pos: 'gc', key: german.center.trim().toLowerCase() },
    { p: getPlayer(data, german.east),   pos: 'ge', key: german.east.trim().toLowerCase() },
  ];

  // 전체 레이팅 기준 Elo (K=16)
  const avgA = sovPlayers.reduce((s,x)=>s+x.p.rating,0)/3;
  const avgB = gerPlayers.reduce((s,x)=>s+x.p.rating,0)/3;
  const expA = exp(avgA, avgB);
  const sA   = result==='soviet'?1:result==='german'?0:0.5;
  const rawDA = Math.round(K_OVERALL*(sA-expA));
  const rawDB = Math.round(K_OVERALL*((1-sA)-(1-expA)));

  // 소련/독일 진영 레이팅 기준 Elo (K=32, 패널티 감소 없음)
  const sovAvgA = sovPlayers.reduce((s,x)=>s+x.p.sovRating,0)/3;
  const gerAvgB = gerPlayers.reduce((s,x)=>s+x.p.gerRating,0)/3;
  const sovExpA = exp(sovAvgA, gerAvgB);
  const sovDA   = Math.round(K_FACTION*(sA-sovExpA));
  const gerDB   = Math.round(K_FACTION*((1-sA)-(1-sovExpA)));

  // 소련팀: 전체 레이팅 변동에 티어 패널티 감소 적용
  sovPlayers.forEach(({p, pos, key}) => {
    // 전체 레이팅 — 패배 시만 감소량 줄임
    const rank = getRank(data, key);
    const reduction = getTierPenaltyReduction(p.rating, rank);
    const dA = rawDA < 0 ? Math.min(0, rawDA + reduction) : rawDA;
    p.rating = Math.max(100, p.rating+dA); p.games++; p.lastDelta=dA;
    if (result==='soviet') p.wins++; else if (result==='german') p.losses++; else p.draws++;
    // 소련 진영 (패널티 감소 없음)
    p.sovRating = Math.max(100, p.sovRating+sovDA); p.sovGames++; p.sovLastDelta=sovDA;
    if (result==='soviet') p.sovWins++; else if (result==='german') p.sovLosses++; else p.sovDraws++;
    p.pos[pos]++;
  });

  // 독일팀: 전체 레이팅 변동에 티어 패널티 감소 적용
  gerPlayers.forEach(({p, pos, key}) => {
    const rank = getRank(data, key);
    const reduction = getTierPenaltyReduction(p.rating, rank);
    const dB = rawDB < 0 ? Math.min(0, rawDB + reduction) : rawDB;
    p.rating = Math.max(100, p.rating+dB); p.games++; p.lastDelta=dB;
    if (result==='german') p.wins++; else if (result==='soviet') p.losses++; else p.draws++;
    // 독일 진영 (패널티 감소 없음)
    p.gerRating = Math.max(100, p.gerRating+gerDB); p.gerGames++; p.gerLastDelta=gerDB;
    if (result==='german') p.gerWins++; else if (result==='soviet') p.gerLosses++; else p.gerDraws++;
    p.pos[pos]++;
  });

  return { dA: rawDA, dB: rawDB };
}

// ── 전체 재계산 ───────────────────────────────────────────────
function recalcFromHistory(history) {
  const data = { players: {} };
  for (const h of [...history].reverse()) {
    applyGame(data, h.soviet, h.german, h.result);
  }
  return data.players;
}

// ── API ──────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok:true, time:Date.now(), clients:clients.size }));
app.get('/data', (req, res) => res.json(readData()));

// 기존 데이터 전체 재계산 (구버전 → 신버전 마이그레이션)
app.post('/migrate', (req, res) => {
  const data = readData();
  data.players = recalcFromHistory(data.history);
  data.lastUpdated = Date.now();
  writeData(data);
  broadcast({ type:'update', data });
  res.json({ ok:true, players: Object.keys(data.players).length });
});

app.post('/game', (req, res) => {
  const { soviet, german, result } = req.body;
  if (!soviet||!german||!result) return res.status(400).json({ error:'필드 누락' });

  const data = readData();
  const { dA, dB } = applyGame(data, soviet, german, result);

  data.totalGames = (data.totalGames||0)+1;
  data.lastUpdated = Date.now();
  data.history = [{ soviet, german, result, dA, dB, time:Date.now(), memo: req.body.memo||null }, ...(data.history||[])].slice(0,200);

  writeData(data);
  broadcast({ type:'update', data });
  res.json({ ok:true, dA, dB });
});

app.delete('/history/:idx', (req, res) => {
  const idx = parseInt(req.params.idx);
  const data = readData();
  if (isNaN(idx)||idx<0||idx>=data.history.length) return res.status(400).json({ error:'잘못된 인덱스' });

  data.history.splice(idx, 1);
  data.totalGames = Math.max(0,(data.totalGames||1)-1);
  data.players = recalcFromHistory(data.history);
  data.lastUpdated = Date.now();

  writeData(data);
  broadcast({ type:'update', data });
  res.json({ ok:true });
});

app.patch('/player/:key', (req, res) => {
  const data = readData();
  const p = data.players[req.params.key];
  if (!p) return res.status(404).json({ error:'플레이어 없음' });

  const fields = ['rating','sovRating','gerRating','games','wins','losses','draws'];
  fields.forEach(f => { if (req.body[f]!==undefined) p[f]=parseInt(req.body[f]); });
  p.lastDelta=0; p.sovLastDelta=0; p.gerLastDelta=0;
  data.lastUpdated = Date.now();

  writeData(data);
  broadcast({ type:'update', data });
  res.json({ ok:true });
});

app.delete('/player/:key', (req, res) => {
  const data = readData();
  if (!data.players[req.params.key]) return res.status(404).json({ error:'플레이어 없음' });
  delete data.players[req.params.key];
  data.lastUpdated = Date.now();
  writeData(data);
  broadcast({ type:'update', data });
  res.json({ ok:true });
});

app.patch('/player/:key/reset-stats', (req, res) => {
  const data = readData();
  const p = data.players[req.params.key];
  if (!p) return res.status(404).json({ error:'플레이어 없음' });
  p.games=0;p.wins=0;p.losses=0;p.draws=0;p.lastDelta=0;
  p.sovGames=0;p.sovWins=0;p.sovLosses=0;p.sovDraws=0;p.sovLastDelta=0;
  p.gerGames=0;p.gerWins=0;p.gerLosses=0;p.gerDraws=0;p.gerLastDelta=0;
  p.pos={sw:0,sc:0,se:0,gw:0,gc:0,ge:0};
  data.lastUpdated = Date.now();
  writeData(data);
  broadcast({ type:'update', data });
  res.json({ ok:true });
});

app.get('/events', (req, res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.write(`data: ${JSON.stringify({ type:'init', data:readData() })}\n\n`);
  clients.add(res);
  console.log(`[SSE] 연결 (총 ${clients.size}명)`);
  const hb = setInterval(()=>{ try{res.write(': heartbeat\n\n');}catch{clearInterval(hb);} },30000);
  req.on('close',()=>{ clients.delete(res); clearInterval(hb); console.log(`[SSE] 종료 (총 ${clients.size}명)`); });
});

app.listen(PORT, HOST, () => {
  console.log(`✅ KURSK 서버 v2 실행 중: http://${HOST}:${PORT}`);
  // 시작 시 자동 마이그레이션 (구버전 데이터 → 진영별 레이팅)
  const data = readData();
  const needsMigration = Object.values(data.players).some(p => !p.sovRating || !p.pos);
  if (needsMigration && data.history.length > 0) {
    console.log('⚙️  구버전 데이터 감지 — 자동 마이그레이션 실행...');
    data.players = recalcFromHistory(data.history);
    data.lastUpdated = Date.now();
    writeData(data);
    console.log(`✅ 마이그레이션 완료 — ${Object.keys(data.players).length}명`);
  }
});
