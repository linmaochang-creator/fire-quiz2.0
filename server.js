#!/usr/bin/env node
/* 防火安全互動搶答：主機程式
   只用 Node.js 內建模組，不需要 npm install，也不需要網際網路。
   啟動：node server.js */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST_PIN = process.env.HOST_PIN || String(crypto.randomInt(100000, 1000000));
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const MAX_PLAYERS = 500;
const BASE_POINTS = 1000; // 答對基本分
const SPEED_POINTS = 500; // 越快答對，最多再加這麼多
const STREAK_POINTS = 50; // 連續答對加分：第 2 題起每多連對一題 +50
const STREAK_MAX = 4; // 最多加 4 次（+200）
const GRACE_MS = 800; // 網路延遲寬限

/* ---------- 題庫 ---------- */
function loadQuestions() {
  const file = path.join(__dirname, 'questions.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.questions) || data.questions.length === 0) {
    throw new Error('questions.json 裡沒有題目');
  }
  data.questions.forEach((q, i) => {
    const n = i + 1;
    if (!q.text || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      throw new Error(`第 ${n} 題：text 必填，options 需要 2～4 個選項`);
    }
    if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.options.length) {
      throw new Error(`第 ${n} 題：answer 必須是 0～${q.options.length - 1} 的整數（0 代表第一個選項）`);
    }
  });
  return data;
}

let QDATA;
try {
  QDATA = loadQuestions();
} catch (e) {
  console.error('\n  題庫 questions.json 有問題：' + e.message + '\n');
  process.exit(1);
}
const QUESTIONS = QDATA.questions; // 題庫（全部題目）
const TITLE = QDATA.title || '防火安全互動搶答';
const ORGANIZER = QDATA.organizer || '';
const AVATAR_COUNT = 16; // 頭像圖案數量，圖案本身由手機畫面決定
const DEFAULT_COUNT = Math.min(
  QUESTIONS.length,
  Number.isInteger(QDATA.defaultCount) && QDATA.defaultCount >= 1 ? QDATA.defaultCount : 10
);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 每場遊戲從題庫隨機抽題，並把選項順序打亂（正確答案位置同步換算）
function buildDeck(count) {
  return shuffle(QUESTIONS)
    .slice(0, count)
    .map((q) => {
      const order = shuffle(q.options.map((_, i) => i));
      return {
        topic: q.topic || '',
        text: q.text,
        explanation: q.explanation || '',
        options: order.map((i) => q.options[i]),
        answer: order.indexOf(q.answer),
      };
    });
}

/* ---------- 遊戲狀態 ---------- */
const game = {
  phase: 'lobby', // lobby 等待加入 | question 作答中 | reveal 公布答案 | final 最終排名
  count: DEFAULT_COUNT, // 這一場要出幾題
  deck: [], // 這一場實際使用的題目（開始時才抽）
  q: -1,
  timeLimit: 20,
  qStart: 0,
  qEnd: 0,
  seq: 0,
  players: new Map(), // pid -> { pid, token, name, score, correct, totalMs, answers, joinedAt }
};

const playerClients = new Set(); // { res, pid, token }
const hostClients = new Set(); // res

function cleanName(raw) {
  let s = String(raw || '')
    .replace(/[\u0000-\u001f\u007f<>&"'`\\​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  s = Array.from(s).slice(0, 10).join('').trim();
  return s;
}

function uniqueName(base) {
  const taken = new Set([...game.players.values()].map((p) => p.name));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const cand = base + i;
    if (!taken.has(cand)) return cand;
  }
}

function ranked() {
  return [...game.players.values()].sort(
    (a, b) => b.score - a.score || b.correct - a.correct || a.totalMs - b.totalMs || a.joinedAt - b.joinedAt
  );
}

function answeredCount() {
  let n = 0;
  for (const p of game.players.values()) if (p.answers[game.q]) n++;
  return n;
}

function topList(ranking, n) {
  return ranking.slice(0, n).map((p, i) => ({
    rank: i + 1,
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    correct: p.correct,
    best: p.bestStreak,
  }));
}

/* ---------- 狀態快照與推播（SSE） ---------- */
function buildSnapshot() {
  const ranking = ranked();
  const rankOf = new Map(ranking.map((p, i) => [p.pid, i + 1]));
  const Q = game.q >= 0 ? game.deck[game.q] : null;
  const base = {
    title: TITLE,
    organizer: ORGANIZER,
    phase: game.phase,
    total: game.phase === 'lobby' ? game.count : game.deck.length,
    bank: QUESTIONS.length,
    qIndex: game.q,
    seq: game.seq,
    playerCount: game.players.size,
    timeLimit: game.timeLimit,
  };
  // 題目與選項在作答中就會送出；正確答案只在公布後才送出
  if (game.phase === 'question' || game.phase === 'reveal') {
    base.question = { text: Q.text, options: Q.options, topic: Q.topic || '' };
  }
  if (game.phase === 'question') {
    base.remainingMs = Math.max(0, game.qEnd - Date.now());
    base.answered = answeredCount();
  }
  if (game.phase === 'reveal') {
    const counts = Q.options.map(() => 0);
    let none = 0;
    for (const p of game.players.values()) {
      const a = p.answers[game.q];
      if (a) counts[a.choice]++;
      else none++;
    }
    base.reveal = { answer: Q.answer, explanation: Q.explanation || '', counts, none };
    base.top = topList(ranking, 5);
  }
  if (game.phase === 'final') base.top = topList(ranking, 10);
  return { base, ranking, rankOf };
}

function meOf(p, rankOf) {
  const me = {
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    correct: p.correct,
    rank: rankOf.get(p.pid),
    streak: p.streak,
    best: p.bestStreak,
  };
  const a = p.answers[game.q];
  if (game.phase === 'question') me.choice = a ? a.choice : null;
  if (game.phase === 'reveal') {
    me.choice = a ? a.choice : null;
    me.gained = a ? a.gained || 0 : 0;
    me.bonus = a ? a.bonus || 0 : 0;
    me.isCorrect = !!a && a.choice === game.deck[game.q].answer;
    me.rankDelta = p.prevRank ? p.prevRank - me.rank : 0; // 正數＝名次上升
  }
  return me;
}

function sseWrite(res, obj) {
  try {
    res.write('data: ' + JSON.stringify(obj) + '\n\n');
  } catch (e) {
    /* 連線已斷，close 事件會清掉 */
  }
}

function hostMessage(snap) {
  const msg = Object.assign({}, snap.base);
  if (game.phase === 'lobby') {
    msg.players = [...game.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ pid: p.pid, name: p.name, avatar: p.avatar }));
  }
  if (game.phase === 'final') msg.top = topList(snap.ranking, 100);
  return msg;
}

// 有人加入：全部人都要更新（在線人數）
let pendingTimer = null;
function scheduleBroadcast() {
  if (pendingTimer) return;
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    broadcast();
  }, 150);
}

// 有人作答：只需要更新主持人的「已作答人數」，不必吵醒所有手機
let hostTimer = null;
function scheduleHostBroadcast() {
  if (hostTimer || pendingTimer) return;
  hostTimer = setTimeout(() => {
    hostTimer = null;
    const msg = hostMessage(buildSnapshot());
    for (const res of hostClients) sseWrite(res, msg);
  }, 150);
}

function sendToPlayer(pid) {
  const pl = game.players.get(pid);
  if (!pl) return;
  const snap = buildSnapshot();
  for (const c of playerClients) {
    if (c.pid === pid) sseWrite(c.res, Object.assign({}, snap.base, { me: meOf(pl, snap.rankOf) }));
  }
}

function broadcast() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  if (hostTimer) {
    clearTimeout(hostTimer);
    hostTimer = null;
  }
  const snap = buildSnapshot();
  const hostMsg = hostMessage(snap);
  for (const res of hostClients) sseWrite(res, hostMsg);

  for (const c of [...playerClients]) {
    const p = game.players.get(c.pid);
    if (p && p.token === c.token) {
      sseWrite(c.res, Object.assign({}, snap.base, { me: meOf(p, snap.rankOf) }));
    } else {
      sseWrite(c.res, { kicked: true });
      playerClients.delete(c);
      try { c.res.end(); } catch (e) { /* ignore */ }
    }
  }
}

setInterval(() => {
  for (const res of hostClients) { try { res.write(': ping\n\n'); } catch (e) { /* ignore */ } }
  for (const c of playerClients) { try { c.res.write(': ping\n\n'); } catch (e) { /* ignore */ } }
}, 15000);

/* ---------- 遊戲動作 ---------- */
function startQuestion(i) {
  game.q = i;
  game.phase = 'question';
  game.qStart = Date.now();
  game.qEnd = game.qStart + game.timeLimit * 1000;
  game.seq++;
}

function revealAnswer() {
  const Q = game.deck[game.q];
  // 先記下這題計分前的名次，之後算「名次上升／下降」
  ranked().forEach((p, i) => { p.prevRank = i + 1; });
  for (const p of game.players.values()) {
    const a = p.answers[game.q];
    if (a && a.choice === Q.answer) {
      const ratio = Math.max(0, 1 - a.ms / (game.timeLimit * 1000));
      p.streak += 1;
      p.bestStreak = Math.max(p.bestStreak, p.streak);
      a.bonus = Math.min(p.streak - 1, STREAK_MAX) * STREAK_POINTS; // 連對加分
      a.gained = BASE_POINTS + Math.round(SPEED_POINTS * ratio) + a.bonus;
      p.score += a.gained;
      p.correct += 1;
      p.totalMs += a.ms;
    } else {
      p.streak = 0;
      if (a) { a.gained = 0; a.bonus = 0; }
    }
  }
  game.phase = 'reveal';
  game.seq++;
}

function resetScores() {
  for (const p of game.players.values()) {
    p.score = 0;
    p.correct = 0;
    p.totalMs = 0;
    p.streak = 0;
    p.bestStreak = 0;
    p.prevRank = 0;
    p.answers = {};
  }
  game.phase = 'lobby';
  game.deck = [];
  game.q = -1;
  game.seq++;
}

function hostAction(body) {
  const action = String(body.action || '');
  switch (action) {
    case 'start':
      if (game.phase !== 'lobby') return '目前不是等待開始的狀態';
      game.deck = buildDeck(Math.min(game.count, QUESTIONS.length));
      startQuestion(0);
      break;
    case 'reveal':
      if (game.phase !== 'question') return '目前不在作答中';
      revealAnswer();
      break;
    case 'next':
      if (game.phase !== 'reveal') return '請先公布答案';
      if (game.q + 1 < game.deck.length) startQuestion(game.q + 1);
      else {
        game.phase = 'final';
        game.seq++;
      }
      break;
    case 'reset':
      resetScores();
      break;
    case 'clear':
      game.players.clear();
      game.phase = 'lobby';
      game.deck = [];
      game.q = -1;
      game.seq++;
      break;
    case 'setCount': {
      if (game.phase !== 'lobby') return '只能在等待加入時調整題數';
      const n = Math.round(Number(body.count));
      if (!(n >= 1 && n <= QUESTIONS.length)) return `題數需介於 1～${QUESTIONS.length}`;
      game.count = n;
      break;
    }
    case 'kick':
      game.players.delete(String(body.pid || ''));
      break;
    case 'setTime': {
      const t = Math.round(Number(body.seconds));
      if (!(t >= 5 && t <= 120)) return '作答時間需介於 5～120 秒';
      game.timeLimit = t;
      break;
    }
    default:
      return '未知的動作';
  }
  broadcast();
  return null;
}

/* ---------- HTTP ---------- */
const failedPins = new Map(); // ip -> { n, until }
function pinOk(req, pin) {
  const ip = req.socket.remoteAddress || '';
  const rec = failedPins.get(ip);
  if (rec && rec.n >= 10 && Date.now() < rec.until) return false;
  const a = Buffer.from(String(pin || ''));
  const b = Buffer.from(HOST_PIN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    const r = rec && Date.now() < rec.until ? rec : { n: 0, until: Date.now() + 60000 };
    r.n++;
    failedPins.set(ip, r);
  }
  return ok;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4096) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(obj));
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/host': ['host.html', 'text/html; charset=utf-8'],
  '/qr.js': ['qr.js', 'application/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
};

function sendStatic(res, entry) {
  fs.readFile(path.join(__dirname, 'public', entry[0]), (err, buf) => {
    if (err) return json(res, 500, { error: '找不到頁面檔案 ' + entry[0] });
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(buf);
  });
}

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
}

function lanUrls() {
  const list = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if ((n.family === 'IPv4' || n.family === 4) && !n.internal) list.push(`http://${n.address}:${PORT}/`);
    }
  }
  const pref = (u) => (/\/\/(192\.168|10\.)/.test(u) ? 0 : /\/\/172\.(1[6-9]|2\d|3[01])\./.test(u) ? 1 : 2);
  return list.sort((a, b) => pref(a) - pref(b));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const isGet = req.method === 'GET';
    const isPost = req.method === 'POST';

    if (isGet && STATIC[p]) return sendStatic(res, STATIC[p]);
    if (isGet && p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    /* --- 民眾 --- */
    if (isPost && p === '/api/join') {
      const body = await readJson(req);
      const token = String(body.token || '');
      const pid = String(body.pid || '');
      const existing = game.players.get(pid);
      if (existing && token && existing.token === token) {
        return json(res, 200, { pid: existing.pid, token: existing.token, name: existing.name });
      }
      const name = cleanName(body.name);
      if (!name) return json(res, 400, { error: '請輸入暱稱' });
      if (game.players.size >= MAX_PLAYERS) return json(res, 403, { error: '人數已滿' });
      const player = {
        pid: crypto.randomBytes(6).toString('hex'),
        token: crypto.randomBytes(12).toString('hex'),
        name: uniqueName(name),
        avatar: Number.isInteger(body.avatar) && body.avatar >= 0 && body.avatar < AVATAR_COUNT
          ? body.avatar
          : crypto.randomInt(AVATAR_COUNT),
        score: 0,
        correct: 0,
        totalMs: 0,
        streak: 0,
        bestStreak: 0,
        prevRank: 0,
        answers: {},
        joinedAt: Date.now(),
      };
      game.players.set(player.pid, player);
      scheduleBroadcast();
      return json(res, 200, { pid: player.pid, token: player.token, name: player.name });
    }

    if (isGet && p === '/api/events') {
      const pid = url.searchParams.get('pid') || '';
      const token = url.searchParams.get('token') || '';
      openSse(res);
      const pl = game.players.get(pid);
      if (!pl || pl.token !== token) {
        sseWrite(res, { kicked: true });
        return res.end();
      }
      const client = { res, pid, token };
      playerClients.add(client);
      req.on('close', () => playerClients.delete(client));
      const snap = buildSnapshot();
      sseWrite(res, Object.assign({}, snap.base, { me: meOf(pl, snap.rankOf) }));
      return;
    }

    if (isPost && p === '/api/answer') {
      const body = await readJson(req);
      const pl = game.players.get(String(body.pid || ''));
      if (!pl || pl.token !== String(body.token || '')) return json(res, 401, { error: '請重新加入' });
      if (game.phase !== 'question') return json(res, 409, { error: '現在不能作答' });
      const now = Date.now();
      if (now > game.qEnd + GRACE_MS) return json(res, 409, { error: '時間到了' });
      if (Number(body.q) !== game.q) return json(res, 409, { error: '題目已更新' });
      const Q = game.deck[game.q];
      const choice = Number(body.choice);
      if (!Number.isInteger(choice) || choice < 0 || choice >= Q.options.length) {
        return json(res, 400, { error: '選項不正確' });
      }
      if (pl.answers[game.q]) return json(res, 409, { error: '這題已經作答' });
      pl.answers[game.q] = { choice, ms: Math.min(now - game.qStart, game.timeLimit * 1000) };
      scheduleHostBroadcast();
      sendToPlayer(pl.pid);
      return json(res, 200, { ok: true });
    }

    /* --- 主持人 --- */
    if (isGet && p === '/api/host/info') {
      if (!pinOk(req, url.searchParams.get('pin'))) return json(res, 401, { error: 'PIN 不正確' });
      return json(res, 200, {
        title: TITLE,
        organizer: ORGANIZER,
        total: QUESTIONS.length,
        bank: QUESTIONS.length,
        joinUrls: PUBLIC_URL ? [PUBLIC_URL + '/'] : lanUrls(),
        publicUrl: !!PUBLIC_URL,
      });
    }

    if (isGet && p === '/api/host/events') {
      if (!pinOk(req, url.searchParams.get('pin'))) return json(res, 401, { error: 'PIN 不正確' });
      openSse(res);
      hostClients.add(res);
      req.on('close', () => hostClients.delete(res));
      sseWrite(res, hostMessage(buildSnapshot()));
      return;
    }

    if (isPost && p === '/api/host/action') {
      const body = await readJson(req);
      if (!pinOk(req, body.pin)) return json(res, 401, { error: 'PIN 不正確' });
      const err = hostAction(body);
      return err ? json(res, 409, { error: err }) : json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: '請求格式不正確' });
    else res.end();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const urls = PUBLIC_URL ? [PUBLIC_URL + '/'] : lanUrls();
  const join = urls[0] || `http://localhost:${PORT}/`;
  const hostBase = PUBLIC_URL ? PUBLIC_URL : `http://localhost:${PORT}`;
  console.log('');
  console.log(`  ${TITLE}${ORGANIZER ? '｜' + ORGANIZER : ''}`);
  console.log('  ────────────────────────────────────────');
  console.log(`  主持人頁面（請用這個網址開啟）：`);
  console.log(`    ${hostBase}/host?pin=${HOST_PIN}`);
  console.log(`  民眾加入網址（主持人頁面會自動產生 QR code）：`);
  urls.forEach((u) => console.log(`    ${u}`));
  if (!urls.length) console.log(`    ${join}（找不到區域網路位址，請確認已連上 Wi-Fi）`);
  console.log(`  題庫：${QUESTIONS.length} 題｜每場預設抽 ${DEFAULT_COUNT} 題（主持人頁面可調整）｜按 Ctrl+C 結束`);
  console.log('');
});

process.on('SIGINT', () => process.exit(0));
