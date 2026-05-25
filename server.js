// KURSK Rating System — 실시간 동기화 서버
// SSE(Server-Sent Events)로 연결된 모든 클라이언트에 즉시 푸시
//
// 배포: Railway / Render / fly.io 등 무료 클라우드
// 로컬: npm install && node server.js

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'kursk_data.json');

// ── 미들웨어 ──────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── 데이터 영속성 ─────────────────────────────────────────
function readData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return emptyData();
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch { return emptyData(); }
}

function writeData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}

function emptyData() {
  return { players: {}, history: [], totalGames: 0, lastUpdated: Date.now() };
}

// ── SSE 클라이언트 풀 ──────────────────────────────────────
// 연결된 모든 앱에 변경사항을 즉시 브로드캐스트
const clients = new Set();

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch { clients.delete(res); }
  });
}

// ── API 엔드포인트 ────────────────────────────────────────

// 연결 확인
app.get('/ping', (req, res) => {
  res.json({ ok: true, time: Date.now(), clients: clients.size });
});

// 전체 데이터 조회
app.get('/data', (req, res) => {
  res.json(readData());
});

// 게임 결과 등록 — 서버에서 Elo 계산 후 전체 브로드캐스트
app.post('/game', (req, res) => {
  const { soviet, german, result } = req.body;
  // soviet: { west, center, east }
  // german: { west, center, east }
  // result: 'soviet' | 'german' | 'draw'

  if (!soviet || !german || !result) {
    return res.status(400).json({ error: '필드 누락' });
  }

  const data = readData();

  function getPlayer(name) {
    const key = name.trim().toLowerCase();
    if (!data.players[key]) {
      data.players[key] = {
        name: name.trim(), rating: 1000,
        games: 0, wins: 0, losses: 0, draws: 0, lastDelta: 0
      };
    }
    return data.players[key];
  }

  function expectedScore(rA, rB) {
    return 1 / (1 + Math.pow(10, (rB - rA) / 400));
  }

  const K = 32;
  const sovietPlayers = [soviet.west, soviet.center, soviet.east].map(getPlayer);
  const germanPlayers = [german.west, german.center, german.east].map(getPlayer);

  const avgA = sovietPlayers.reduce((s, p) => s + p.rating, 0) / 3;
  const avgB = germanPlayers.reduce((s, p) => s + p.rating, 0) / 3;
  const expA = expectedScore(avgA, avgB);
  const sA   = result === 'soviet' ? 1 : result === 'german' ? 0 : 0.5;

  const dA = Math.round(K * (sA - expA));
  const dB = Math.round(K * ((1 - sA) - (1 - expA)));

  sovietPlayers.forEach(p => {
    p.rating = Math.max(100, p.rating + dA);
    p.games++; p.lastDelta = dA;
    if (result === 'soviet') p.wins++;
    else if (result === 'german') p.losses++;
    else p.draws++;
  });

  germanPlayers.forEach(p => {
    p.rating = Math.max(100, p.rating + dB);
    p.games++; p.lastDelta = dB;
    if (result === 'german') p.wins++;
    else if (result === 'soviet') p.losses++;
    else p.draws++;
  });

  data.totalGames = (data.totalGames || 0) + 1;
  data.lastUpdated = Date.now();
  data.history = [{
    soviet, german, result, dA, dB, time: Date.now()
  }, ...(data.history || [])].slice(0, 200);

  writeData(data);

  // 모든 연결된 클라이언트에 즉시 브로드캐스트
  broadcast({ type: 'update', data });

  res.json({ ok: true, dA, dB });
});

// 히스토리 항목 삭제 + 레이팅 재계산 + 브로드캐스트
app.delete('/history/:idx', (req, res) => {
  const idx = parseInt(req.params.idx);
  const data = readData();

  if (isNaN(idx) || idx < 0 || idx >= data.history.length) {
    return res.status(400).json({ error: '잘못된 인덱스' });
  }

  data.history.splice(idx, 1);
  data.totalGames = Math.max(0, (data.totalGames || 1) - 1);

  // 레이팅 전체 재계산
  data.players = recalcFromHistory(data.history);
  data.lastUpdated = Date.now();

  writeData(data);
  broadcast({ type: 'update', data });
  res.json({ ok: true });
});

// 플레이어 레이팅 직접 수정 + 브로드캐스트
app.patch('/player/:key', (req, res) => {
  const key  = req.params.key;
  const data = readData();

  if (!data.players[key]) return res.status(404).json({ error: '플레이어 없음' });

  const { rating, games, wins, losses, draws } = req.body;
  if (rating !== undefined) data.players[key].rating = Math.max(100, parseInt(rating));
  if (games   !== undefined) data.players[key].games   = parseInt(games);
  if (wins    !== undefined) data.players[key].wins    = parseInt(wins);
  if (losses  !== undefined) data.players[key].losses  = parseInt(losses);
  if (draws   !== undefined) data.players[key].draws   = parseInt(draws);
  data.players[key].lastDelta = 0;
  data.lastUpdated = Date.now();

  writeData(data);
  broadcast({ type: 'update', data });
  res.json({ ok: true });
});

// 플레이어 삭제 + 브로드캐스트
app.delete('/player/:key', (req, res) => {
  const key  = req.params.key;
  const data = readData();

  if (!data.players[key]) return res.status(404).json({ error: '플레이어 없음' });

  delete data.players[key];
  data.lastUpdated = Date.now();

  writeData(data);
  broadcast({ type: 'update', data });
  res.json({ ok: true });
});

// 플레이어 통계 초기화 + 브로드캐스트
app.patch('/player/:key/reset-stats', (req, res) => {
  const key  = req.params.key;
  const data = readData();

  if (!data.players[key]) return res.status(404).json({ error: '플레이어 없음' });

  const p = data.players[key];
  p.games = 0; p.wins = 0; p.losses = 0; p.draws = 0; p.lastDelta = 0;
  data.lastUpdated = Date.now();

  writeData(data);
  broadcast({ type: 'update', data });
  res.json({ ok: true });
});

// SSE — 실시간 푸시 구독 엔드포인트
// 클라이언트가 연결되면 즉시 최신 데이터를 보내고, 이후 변경마다 자동 전송
app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // nginx 버퍼링 방지

  // 연결 즉시 현재 데이터 전송
  res.write(`data: ${JSON.stringify({ type: 'init', data: readData() })}\n\n`);

  // 클라이언트 풀에 등록
  clients.add(res);
  console.log(`[SSE] 클라이언트 연결 (총 ${clients.size}명)`);

  // 30초마다 heartbeat (연결 유지)
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 30000);

  // 연결 종료 처리
  req.on('close', () => {
    clients.delete(res);
    clearInterval(heartbeat);
    console.log(`[SSE] 클라이언트 종료 (총 ${clients.size}명)`);
  });
});

// ── 레이팅 전체 재계산 ────────────────────────────────────
function recalcFromHistory(history) {
  const players = {};
  const K = 32;

  function getP(name) {
    const key = name.trim().toLowerCase();
    if (!players[key]) {
      players[key] = { name: name.trim(), rating: 1000, games: 0, wins: 0, losses: 0, draws: 0, lastDelta: 0 };
    }
    return players[key];
  }

  function exp(rA, rB) { return 1 / (1 + Math.pow(10, (rB - rA) / 400)); }

  const ordered = [...history].reverse(); // 오래된 순
  for (const h of ordered) {
    const sov = [h.soviet.west, h.soviet.center, h.soviet.east].map(getP);
    const ger = [h.german.west, h.german.center, h.german.east].map(getP);
    const avgA = sov.reduce((s, p) => s + p.rating, 0) / 3;
    const avgB = ger.reduce((s, p) => s + p.rating, 0) / 3;
    const expA = exp(avgA, avgB);
    const sA   = h.result === 'soviet' ? 1 : h.result === 'german' ? 0 : 0.5;
    const dA   = Math.round(K * (sA - expA));
    const dB   = Math.round(K * ((1 - sA) - (1 - expA)));

    sov.forEach(p => {
      p.rating = Math.max(100, p.rating + dA); p.games++; p.lastDelta = dA;
      if (h.result === 'soviet') p.wins++; else if (h.result === 'german') p.losses++; else p.draws++;
    });
    ger.forEach(p => {
      p.rating = Math.max(100, p.rating + dB); p.games++; p.lastDelta = dB;
      if (h.result === 'german') p.wins++; else if (h.result === 'soviet') p.losses++; else p.draws++;
    });
  }
  return players;
}

// ── 서버 시작 ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ KURSK 서버 실행 중: http://localhost:${PORT}`);
  console.log(`   실시간 SSE 엔드포인트: http://localhost:${PORT}/events`);
});
