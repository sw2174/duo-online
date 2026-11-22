const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const GameLogic = require('./gameLogic');

const PORT = process.env.PORT || 3131;
const PUBLIC = path.join(__dirname, 'public');

// --- Stripe (gerçek ödeme) — anahtar .env.local'den okunur, koda yazılmaz ---
function loadEnvLocal() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '.env.local'), 'utf8');
    raw.split('\n').forEach(line => {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) process.env[m[1]] = m[2].trim();
    });
  } catch { /* .env.local yoksa test modunda çalışmaya devam eder */ }
}
loadEnvLocal();
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;
if (!stripe) console.log('Stripe anahtarı yok — Coin paketleri test modunda (gerçek ödeme alınmaz) çalışacak.');

// Test/placeholder ekonomi — Stripe anahtarı yoksa coin paketleri test modunda kalır.
const START_COINS = 1000;
const STUCK_DECISION_MS = 30000;
const MOVE_TIME_MS = 15000; // her hamle için süre — dolarsa oyuncu maçı/oturumu kaybeder
const SOLO_BONUS_MULTIPLIER = 1.5;
const REFERRAL_REWARD = 100; // davet kodunla kayıt olan arkadaş üye olunca davet edene verilir

// Mağazadaki Coin paketleri: id -> {coins, price, priceCents}. priceCents, Stripe
// Checkout'ta gerçek tahsilat için kullanılır (EUR cinsinden kuruş). Miktar her
// zaman buradan okunur, istemciden/Stripe metadata'sından gelen değere güvenilmez.
const COIN_PACKAGES = {
  p100: { coins: 100, price: '0,50 €', priceCents: 50 }, // Stripe EUR için minimum 0,50 € şartı var
  p250: { coins: 250, price: '0,99 €', priceCents: 99 },
  p600: { coins: 600, price: '1,99 €', priceCents: 199 },
  p1200: { coins: 1200, price: '3,49 €', priceCents: 349 },
  p2000: { coins: 2000, price: '4,99 €', priceCents: 499 },
};

// Günlük ödül çarkı: her 24 saatte bir ücretsiz çevirme hakkı. Kazanan dilim
// (segmentIndex) ve miktar HER ZAMAN sunucuda belirlenir — istemci sadece
// görsel olarak hangi dilimde durduğunu animasyonla gösterir.
const WHEEL_SEGMENTS = [50, 100, 75, 150, 100, 250, 75, 500];
const WHEEL_WEIGHTS = [22, 16, 18, 10, 16, 4, 12, 2];
function pickWheelSegment() {
  const total = WHEEL_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < WHEEL_WEIGHTS.length; i++) {
    r -= WHEEL_WEIGHTS[i];
    if (r <= 0) return i;
  }
  return WHEEL_SEGMENTS.length - 1;
}
function todayStr() { return new Date().toISOString().slice(0, 10); }
function yesterdayStr() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Günlük giriş ödülü: uygulamaya girer girmez (tıklama gerekmeden) otomatik verilir ve
// bir pop-up ile gösterilir. Reklam izlenirse toplam 60'a çıkar. 7 gün üst üste girilirse
// (her 7. günde tekrar) ayrıca +100 coin'lik haftalık bonus eklenir. Çark bundan tamamen
// ayrı, isteğe bağlı bir bonustur (aşağıda spinWheel).
const LOGIN_REWARD_BASE = 20;
const LOGIN_REWARD_AD_BONUS = 40; // reklam izleyince eklenir: 20 + 40 = 60
const LOGIN_REWARD_WEEKLY_BONUS = 100;
const LOGIN_REWARD_WEEKLY_INTERVAL = 7;

// Kozmetik mağaza kataloğu: id -> {name, price, cat}. cat aynı kategori içindeki
// ürünlerin birbirini dışladığı (tek seferde tek ekipli) grubu belirler.
const COSMETICS = {
  skin_neon: { name: 'Neon Blok', price: 200, cat: 'skin' },
  skin_gold: { name: 'Altın Blok', price: 400, cat: 'skin' },
  skin_ice: { name: 'Buz Blok', price: 350, cat: 'skin' },
  skin_galaxy: { name: 'Galaksi Blok', price: 600, cat: 'skin' },
  skin_fire: { name: 'Ateş Blok', price: 500, cat: 'skin' },
  skin_legend: { name: 'Efsanevi Blok', price: 1000, cat: 'skin' },
  frame_classic: { name: 'Profil Çerçevesi', price: 150, cat: 'frame' },
  victory_classic: { name: 'Zafer Animasyonu', price: 300, cat: 'victory' },
  theme_classic: { name: 'Tahta Teması', price: 450, cat: 'theme' },
  emoji_classic: { name: 'Emoji Paketi', price: 200, cat: 'emoji' },
};

// --- kalıcı oyuncu profilleri (coin, rekor, envanter) + hesaplar — basit dosya tabanlı "db" ---
// DATA_DIR env ile değiştirilebilir: Render/Railway gibi platformlarda kalıcı disk,
// kalıcı bir yola bağlanır (yoksa her deploy'da coin/hesap verisi silinir).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROFILES_PATH = path.join(DATA_DIR, 'profiles.json');
let profiles = {};   // pid -> {coins, highScore, ...}
let accounts = {};   // kullanıcı adı (küçük harf) -> {displayName, salt, hash, pid}
let sessions = {};   // oturum token'ı -> pid (farklı cihazdan giriş yapınca kalıcı kalsın diye diske yazılır)
let processedSessions = {}; // Stripe Checkout session id -> true (aynı ödemeden iki kez coin verilmesini engeller)
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const raw = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
  if (raw && typeof raw === 'object' && raw.profiles) {
    profiles = raw.profiles || {};
    accounts = raw.accounts || {};
    sessions = raw.sessions || {};
    processedSessions = raw.processedSessions || {};
  } else {
    profiles = raw || {}; // eski dosya biçimi: tamamı doğrudan profiles map'iydi
  }
} catch {
  profiles = {};
}

function defaultProfile() {
  return {
    coins: START_COINS,
    highScore: 0,
    highScoreBonus: 0,
    inventory: [],
    equipped: { skin: null, frame: null, victory: null, theme: null, emoji: null },
    friends: [],
    friendRequests: [],
    lastSpinDate: null,
    dailyStreak: 0,
    lastLoginRewardDate: null,
    referredBy: null,
  };
}

function getProfile(pid) {
  if (!profiles[pid]) profiles[pid] = defaultProfile();
  const p = profiles[pid];
  if (typeof p.coins !== 'number') p.coins = START_COINS;
  if (typeof p.highScore !== 'number') p.highScore = 0;
  if (typeof p.highScoreBonus !== 'number') p.highScoreBonus = 0;
  if (!Array.isArray(p.inventory)) p.inventory = [];
  if (!p.equipped || typeof p.equipped !== 'object') {
    p.equipped = { skin: null, frame: null, victory: null, theme: null, emoji: null };
  }
  if (!Array.isArray(p.friends)) p.friends = [];
  if (!Array.isArray(p.friendRequests)) p.friendRequests = [];
  if (typeof p.lastSpinDate === 'undefined') p.lastSpinDate = null;
  if (typeof p.dailyStreak !== 'number') p.dailyStreak = 0;
  if (typeof p.lastLoginRewardDate === 'undefined') p.lastLoginRewardDate = null;
  if (typeof p.referredBy === 'undefined') p.referredBy = null;
  return p;
}

// Bağlı/bağlı olmayan fark etmeksizin bir profile coin ekler; o pid şu an bağlıysa
// canlı ws.coins'i de senkron tutar (yoksa sıradaki bağlantıda profilden okunur).
function addCoinsToProfile(pid, amount) {
  const p = getProfile(pid);
  p.coins = (p.coins || 0) + amount;
  const liveWs = pidToWs.get(pid);
  if (liveWs) liveWs.coins = p.coins;
  saveAll();
  return p.coins;
}

let saveTimer = null;
function saveAll() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(PROFILES_PATH, JSON.stringify({ profiles, accounts, sessions, processedSessions })); }
    catch (e) { console.error('veri kaydedilemedi', e); }
  }, 200);
}

function setCoins(ws, val) {
  ws.coins = val;
  if (ws.profile) { ws.profile.coins = val; saveAll(); }
}

// --- basit kullanıcı adı/şifre hesap sistemi (gerçek, tek-sunuculu demo amaçlı) ---
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makeSalt() { return crypto.randomBytes(16).toString('hex'); }
function makeToken() { return crypto.randomBytes(24).toString('hex'); }
function passwordsMatch(candidateHash, storedHash) {
  const a = Buffer.from(candidateHash, 'hex'), b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Oyuncu bağlanır bağlanmaz (tıklama gerekmeden) günlük giriş ödülünü otomatik verir.
// Her gün en fazla bir kez; seri art arda giriş yapıldıkça büyür, bir gün atlanırsa sıfırlanır.
function grantLoginRewardIfDue(ws) {
  const p = ws.profile;
  if (!p) return null;
  const today = todayStr();
  if (p.lastLoginRewardDate === today) return null;
  p.dailyStreak = (p.lastLoginRewardDate === yesterdayStr()) ? p.dailyStreak + 1 : 1;
  p.lastLoginRewardDate = today;
  const weeklyBonus = (p.dailyStreak % LOGIN_REWARD_WEEKLY_INTERVAL === 0) ? LOGIN_REWARD_WEEKLY_BONUS : 0;
  const amount = LOGIN_REWARD_BASE + weeklyBonus;
  setCoins(ws, (ws.coins || 0) + amount);
  saveAll();
  ws.lastLoginAdAmount = LOGIN_REWARD_AD_BONUS;
  ws.lastLoginAdUsed = false;
  ws.lastLoginAdPending = false;
  return { amount: LOGIN_REWARD_BASE, weeklyBonus, streak: p.dailyStreak, adBonus: LOGIN_REWARD_AD_BONUS };
}

function sendProfile(ws) {
  const reward = grantLoginRewardIfDue(ws);
  const p = ws.profile;
  send(ws, {
    t: 'profile',
    coins: ws.coins,
    highScore: p.highScore,
    highScoreBonus: p.highScoreBonus,
    inventory: p.inventory,
    equipped: p.equipped,
  });
  send(ws, { t: 'dailyStatus', canSpin: p.lastSpinDate !== todayStr(), streak: p.dailyStreak });
  if (reward) {
    send(ws, {
      t: 'loginReward',
      amount: reward.amount,
      weeklyBonus: reward.weeklyBonus,
      streak: reward.streak,
      adBonus: reward.adBonus,
      coins: ws.coins,
    });
  }
}

// --- arkadaşlar ve çevrimiçi durum ---
const pidToWs = new Map(); // pid -> o an bağlı olan ws (çevrimiçi durumu + meydan okuma hedefini bulmak için)

function findAccountByPid(pid) {
  return Object.values(accounts).find(a => a.pid === pid) || null;
}
function resolveUsername(username) {
  return accounts[String(username || '').trim().toLowerCase()] || null;
}
function sendFriendsList(ws) {
  if (!ws.profile) return;
  const friends = ws.profile.friends.map(pid => {
    const acc = findAccountByPid(pid);
    return { username: acc ? acc.displayName : 'Bilinmeyen', online: pidToWs.has(pid) };
  });
  const requests = ws.profile.friendRequests.map(pid => {
    const acc = findAccountByPid(pid);
    return { username: acc ? acc.displayName : 'Bilinmeyen' };
  });
  send(ws, { t: 'friendsList', friends, requests });
}

const server = http.createServer((req, res) => {
  const cleanPath = req.url.split('?')[0];
  // Stripe Checkout dönüşü gibi sorgu dizeli kök istekleri (/?checkout=success&...)
  // de index.html'e düşmeli — tek sayfalık uygulamada yol her zaman '/' ile başlar.
  const urlPath = cleanPath === '/' ? '/index.html' : cleanPath;
  const file = path.join(PUBLIC, path.normalize(urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
let queue = [];

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

function coinCostFor(continueCount) {
  return 100 * (continueCount + 1);
}

// --- hamle süresi: her taş yerleştirmeden sonra sıfırlanan ~15sn'lik saat.
// Süre dolarsa oyuncu (çözüm ekranı beklemeden) doğrudan kaybeder. "Karar
// ekranı" (hamlesiz kalma) açıkken bu saat durur — ikisi ayrı zaman dilimleri. ---
function clearMoveTimer(ws) {
  if (ws.moveTimer) { clearTimeout(ws.moveTimer); ws.moveTimer = null; }
}
function startMoveTimer(ws, onExpire) {
  clearMoveTimer(ws);
  const deadline = Date.now() + MOVE_TIME_MS;
  send(ws, { t: 'moveTimer', deadline });
  ws.moveTimer = setTimeout(onExpire, MOVE_TIME_MS);
}

// --- multiplayer: maç yönetimi ---

// Maçı kesin olarak bitirir. Sonraki herhangi bir mesaj (match.ended === true
// olduğu için) yok sayılır — bağlantı kopması + gecikmiş mesaj gibi durumlarda
// aynı işlemin iki kez uygulanmasını engeller.
function endMatch(match, reason, winnerWs, loserWs) {
  if (!match || match.ended) return;
  match.ended = true;
  if (match.stuckTimer) { clearTimeout(match.stuckTimer); match.stuckTimer = null; }
  match.stuckPlayer = null;
  match.players.forEach(clearMoveTimer);
  if (reason === 'draw') {
    match.players.forEach(p => send(p, { t: 'matchOver', result: 'draw', reason }));
    return;
  }
  send(winnerWs, { t: 'matchOver', result: 'win', reason });
  send(loserWs, { t: 'matchOver', result: 'lose', reason });
}

function startStuck(ws) {
  clearMoveTimer(ws); // karar ekranı açıkken hamle saati işlemez
  const match = ws.match;
  if (!match || match.ended) return;
  if (match.stuckPlayer && match.stuckPlayer !== ws) {
    // Rakip de aynı anda (hâlâ karar verirken) hamlesiz kaldı — beraberlik yok,
    // skoru yüksek olan kazanır. Yalnızca skorlar tam eşitse gerçek beraberlik olur.
    const other = match.stuckPlayer;
    const myScore = ws.game ? ws.game.snapshot().score : 0;
    const otherScore = other.game ? other.game.snapshot().score : 0;
    if (myScore === otherScore) endMatch(match, 'draw', null, null);
    else if (myScore > otherScore) endMatch(match, 'simultaneous', ws, other);
    else endMatch(match, 'simultaneous', other, ws);
    return;
  }
  if (match.stuckPlayer === ws) return; // zaten karar bekleniyor
  match.stuckPlayer = ws;
  const cost = coinCostFor(match.continueCount.get(ws));
  const adAvailable = !match.adUsed.get(ws);
  const coins = ws.coins;
  const deadline = Date.now() + STUCK_DECISION_MS;
  send(ws, { t: 'stuckOptions', coinCost: cost, adAvailable, coins, deadline });
  send(ws.opp, { t: 'oppStuck' });
  match.stuckTimer = setTimeout(() => {
    if (match.ended || match.stuckPlayer !== ws) return;
    endMatch(match, 'timeout', ws.opp, ws);
  }, STUCK_DECISION_MS);
}

// İki oyuncu arasında maç başlatır — hem rastgele eşleşme kuyruğu hem de bir
// arkadaşın meydan okumayı kabul etmesi bu TEK fonksiyonu kullanır.
function startMatchBetween(a, b) {
  a.opp = b; b.opp = a;
  // İki oyuncu da aynı taş sırasını almak için aynı seed'i kullanır, ama her biri
  // KENDİ bağımsız oyun motoruna (board/tray/skor) sahiptir — tahtaları ayrıdır.
  const seed = randomSeed();
  a.game = GameLogic.createGame(seed);
  b.game = GameLogic.createGame(seed);
  const match = {
    players: [a, b],
    continueCount: new Map([[a, 0], [b, 0]]),
    adUsed: new Map([[a, false], [b, false]]),
    adPending: new Map([[a, false], [b, false]]),
    stuckPlayer: null,
    stuckTimer: null,
    ended: false,
  };
  a.match = match; b.match = match;
  const aSnap = a.game.snapshot(), bSnap = b.game.snapshot();
  send(a, { t: 'start', opp: b.playerName, coins: a.coins, board: aSnap.board, tray: aSnap.tray, score: aSnap.score });
  send(b, { t: 'start', opp: a.playerName, coins: b.coins, board: bSnap.board, tray: bSnap.tray, score: bSnap.score });
  startMoveTimer(a, () => { if (!a.match || a.match.ended || a.match.stuckPlayer === a) return; endMatch(a.match, 'moveTimeout', a.opp, a); });
  startMoveTimer(b, () => { if (!b.match || b.match.ended || b.match.stuckPlayer === b) return; endMatch(b.match, 'moveTimeout', b.opp, b); });
}

function tryMatch() {
  queue = queue.filter(w => w.readyState === WebSocket.OPEN);
  while (queue.length >= 2) {
    startMatchBetween(queue.shift(), queue.shift());
  }
}

wss.on('connection', (ws) => {
  ws.coins = START_COINS; // 'hello' ile profil yüklenene kadar geçici varsayılan

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'hello') {
      const pid = (typeof msg.pid === 'string' && msg.pid.length > 0 && msg.pid.length <= 80) ? msg.pid : null;
      ws.pid = pid || ('p_' + Math.random().toString(36).slice(2) + Date.now().toString(36));
      ws.profile = getProfile(ws.pid);
      ws.coins = ws.profile.coins;
      pidToWs.set(ws.pid, ws);
      sendProfile(ws);

      // --- hesap sistemi: kullanıcı adı/şifre ile kayıt, giriş, oturum devam ettirme ---
      // Kayıt olurken o anki (misafir) pid hesaba bağlanır, böylece mevcut coin/rekor/
      // envanter kaybolmaz. Giriş yapınca ise HESABIN pid'i yüklenir — böylece aynı
      // hesaba başka bir cihaz/tarayıcıdan girildiğinde aynı ilerleme görünür.
    } else if (msg.t === 'register') {
      const usernameRaw = String(msg.username || '').trim();
      const password = String(msg.password || '');
      const key = usernameRaw.toLowerCase();
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(usernameRaw)) { send(ws, { t: 'authError', reason: 'invalid-username' }); return; }
      if (password.length < 4) { send(ws, { t: 'authError', reason: 'invalid-password' }); return; }
      if (accounts[key]) { send(ws, { t: 'authError', reason: 'taken' }); return; }
      const pid = ws.pid || ('p_' + crypto.randomBytes(8).toString('hex'));
      const salt = makeSalt();
      accounts[key] = { displayName: usernameRaw, salt, hash: hashPassword(password, salt), pid };
      const token = makeToken();
      sessions[token] = pid;
      ws.pid = pid; ws.token = token; ws.username = usernameRaw;
      ws.profile = getProfile(pid);
      ws.coins = ws.profile.coins;
      pidToWs.set(ws.pid, ws);

      // --- davet ödülü: geçerli bir davet koduyla (arkadaşın kullanıcı adı) kayıt
      // olunursa davet eden, davet edilen üye olduğu an otomatik 100 coin kazanır ---
      const refKey = String(msg.refCode || '').trim().toLowerCase();
      if (refKey && refKey !== key && accounts[refKey]) {
        const refAcc = accounts[refKey];
        ws.profile.referredBy = refAcc.displayName;
        const refCoins = addCoinsToProfile(refAcc.pid, REFERRAL_REWARD);
        const refWs = pidToWs.get(refAcc.pid);
        if (refWs) send(refWs, { t: 'referralReward', amount: REFERRAL_REWARD, friend: usernameRaw, coins: refCoins });
      }

      saveAll();
      send(ws, { t: 'authOk', username: usernameRaw, token });
      sendProfile(ws);

    } else if (msg.t === 'login') {
      const usernameRaw = String(msg.username || '').trim();
      const password = String(msg.password || '');
      const acc = accounts[usernameRaw.toLowerCase()];
      if (!acc) { send(ws, { t: 'authError', reason: 'not-found' }); return; }
      if (!passwordsMatch(hashPassword(password, acc.salt), acc.hash)) {
        send(ws, { t: 'authError', reason: 'wrong-password' }); return;
      }
      const token = makeToken();
      sessions[token] = acc.pid;
      ws.pid = acc.pid; ws.token = token; ws.username = acc.displayName;
      ws.profile = getProfile(acc.pid);
      ws.coins = ws.profile.coins;
      pidToWs.set(ws.pid, ws);
      saveAll();
      send(ws, { t: 'authOk', username: acc.displayName, token });
      sendProfile(ws);

    } else if (msg.t === 'authResume') {
      const pid = sessions[msg.token];
      if (!pid) { send(ws, { t: 'authExpired' }); return; }
      const found = findAccountByPid(pid);
      ws.pid = pid; ws.token = msg.token; ws.username = found ? found.displayName : null;
      ws.profile = getProfile(pid);
      ws.coins = ws.profile.coins;
      pidToWs.set(ws.pid, ws);
      send(ws, { t: 'authOk', username: ws.username, token: msg.token });
      sendProfile(ws);

    } else if (msg.t === 'logout') {
      if (ws.token) { delete sessions[ws.token]; saveAll(); }
      ws.token = null; ws.username = null;
      send(ws, { t: 'loggedOut' });

    } else if (msg.t === 'join') {
      ws.playerName = String(msg.name || 'Oyuncu').slice(0, 20);
      if (ws.match && !ws.match.ended) endMatch(ws.match, 'leave', ws.opp, ws);
      if (ws.opp) { ws.opp.opp = null; ws.opp = null; }
      ws.match = null; ws.game = null;
      if (!queue.includes(ws)) queue.push(ws);
      send(ws, { t: 'queued' });
      tryMatch();

      // --- multiplayer: yerleştirme artık sunucuda doğrulanıp hesaplanıyor ---
    } else if (msg.t === 'place') {
      const match = ws.match;
      if (!match || match.ended || !ws.game || match.stuckPlayer === ws) return;
      const res = ws.game.place(msg.idx, msg.row, msg.col);
      if (!res.ok) { send(ws, { t: 'placeRejected', reason: res.reason }); return; }
      send(ws, { t: 'placed', board: res.board, preClearBoard: res.preClearBoard, tray: res.tray, score: res.score, streak: res.streak, lines: res.lines, clearedIdx: res.clearedIdx });
      if (ws.opp) send(ws.opp, { t: 'opp', score: res.score, board: res.board.flat(), streak: res.streak });
      if (res.stuck) startStuck(ws);
      else startMoveTimer(ws, () => { if (!match || match.ended || match.stuckPlayer === ws) return; endMatch(match, 'moveTimeout', ws.opp, ws); });

    } else if (msg.t === 'stuck') {
      // Eski istemciler için uyumluluk: sunucu artık hamlesiz kalmayı kendi tespit
      // ediyor, ayrıca bu mesaja ihtiyaç yok; zararsızca yok sayılır.

    } else if (msg.t === 'continueCoin') {
      const match = ws.match;
      if (!match || match.ended || match.stuckPlayer !== ws || !ws.game) return;
      const count = match.continueCount.get(ws);
      const cost = coinCostFor(count);
      const bal = ws.coins;
      if (bal < cost) { send(ws, { t: 'continueDenied', reason: 'coins', coins: bal, coinCost: cost }); return; }
      setCoins(ws, bal - cost);
      match.continueCount.set(ws, count + 1);
      clearTimeout(match.stuckTimer); match.stuckTimer = null;
      match.stuckPlayer = null;
      const res = ws.game.forceClearForContinue();
      send(ws, { t: 'continueOk', method: 'coin', amount: cost, coins: ws.coins, board: res.board, tray: res.tray });
      send(ws.opp, { t: 'oppContinued', method: 'coin', amount: cost });
      if (ws.opp) send(ws.opp, { t: 'opp', score: res.score, board: res.board.flat(), streak: res.streak });
      startMoveTimer(ws, () => { if (!match || match.ended || match.stuckPlayer === ws) return; endMatch(match, 'moveTimeout', ws.opp, ws); });

    } else if (msg.t === 'watchAd') {
      const match = ws.match;
      if (!match || match.ended || match.stuckPlayer !== ws) return;
      if (match.adUsed.get(ws)) { send(ws, { t: 'continueDenied', reason: 'adUsed' }); return; }
      if (match.adPending.get(ws)) return;
      match.adPending.set(ws, true);
      send(ws, { t: 'adStart' });

    } else if (msg.t === 'adComplete') {
      const match = ws.match;
      if (!match || match.ended || match.stuckPlayer !== ws || !ws.game) return;
      if (!match.adPending.get(ws)) return; // 'adStart' olmadan sahte tamamlama kabul edilmez
      match.adPending.set(ws, false);
      match.adUsed.set(ws, true);
      clearTimeout(match.stuckTimer); match.stuckTimer = null;
      match.stuckPlayer = null;
      const res = ws.game.forceClearForContinue();
      send(ws, { t: 'continueOk', method: 'ad', amount: 0, coins: ws.coins, board: res.board, tray: res.tray });
      send(ws.opp, { t: 'oppContinued', method: 'ad' });
      if (ws.opp) send(ws.opp, { t: 'opp', score: res.score, board: res.board.flat(), streak: res.streak });
      startMoveTimer(ws, () => { if (!match || match.ended || match.stuckPlayer === ws) return; endMatch(match, 'moveTimeout', ws.opp, ws); });

    } else if (msg.t === 'adFailed') {
      // Reklam yüklenemedi/yarıda kesildi — hak kaybolmaz, 'adUsed' işaretlenmez,
      // oyuncu tekrar reklam izleyebilir veya coin/pes et seçeneğine geçebilir.
      const match = ws.match;
      if (!match || match.ended || match.stuckPlayer !== ws) return;
      match.adPending.set(ws, false);

    } else if (msg.t === 'giveUp') {
      const match = ws.match;
      if (!match || match.ended || match.stuckPlayer !== ws) return;
      endMatch(match, 'giveup', ws.opp, ws);

    } else if (msg.t === 'buyCoins') {
      // Stripe anahtarı yoksa test modu: tıklayınca anında coin eklenir, gerçek
      // ödeme alınmaz. Anahtar varsa gerçek akış 'createCheckout' üzerinden işler.
      if (stripe) { send(ws, { t: 'checkoutError', message: 'Gerçek ödeme aktif — mağazayı yeniden aç.' }); return; }
      const pkg = COIN_PACKAGES[msg.package];
      if (!pkg) return;
      setCoins(ws, (ws.coins || 0) + pkg.coins);
      send(ws, { t: 'coinsUpdated', coins: ws.coins, added: pkg.coins });

    // --- gerçek ödeme: Stripe Checkout (test modu anahtarıyla, gerçek test kartlarıyla çalışır) ---
    } else if (msg.t === 'createCheckout') {
      const pkg = COIN_PACKAGES[msg.package];
      if (!pkg) return;
      if (!stripe) { send(ws, { t: 'checkoutError', message: 'Ödeme sistemi yapılandırılmamış.' }); return; }
      if (!ws.pid) { send(ws, { t: 'checkoutError', message: 'Profil yüklenmedi, sayfayı yenile.' }); return; }
      const baseUrl = `http://localhost:${PORT}`;
      stripe.checkout.sessions.create({
        mode: 'payment',
        // payment_method_types artık burada belirtilmiyor — Stripe Dashboard'daki
        // "Payment methods" ayarına göre otomatik seçiliyor (yeni API davranışı).
        line_items: [{
          price_data: {
            currency: 'eur',
            product_data: { name: `${pkg.coins} Blok Coin` },
            unit_amount: pkg.priceCents,
          },
          quantity: 1,
        }],
        success_url: `${baseUrl}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/?checkout=cancel`,
        metadata: { pid: ws.pid, package: msg.package },
      }).then(session => {
        send(ws, { t: 'checkoutUrl', url: session.url });
      }).catch(err => {
        console.error('Stripe checkout oluşturulamadı', err.message);
        send(ws, { t: 'checkoutError', message: 'Ödeme başlatılamadı: ' + err.message });
      });

    } else if (msg.t === 'confirmPurchase') {
      const sessionId = String(msg.sessionId || '');
      if (!stripe || !sessionId) return;
      if (processedSessions[sessionId]) { send(ws, { t: 'checkoutError', message: 'Bu ödeme zaten işlendi.' }); return; }
      stripe.checkout.sessions.retrieve(sessionId).then(session => {
        if (session.payment_status !== 'paid') {
          send(ws, { t: 'checkoutError', message: 'Ödeme tamamlanmadı.' });
          return;
        }
        const pkg = COIN_PACKAGES[session.metadata && session.metadata.package];
        const targetPid = session.metadata && session.metadata.pid;
        if (!pkg || !targetPid) { send(ws, { t: 'checkoutError', message: 'Sipariş bilgisi okunamadı.' }); return; }
        processedSessions[sessionId] = true;
        const profile = getProfile(targetPid);
        profile.coins += pkg.coins; // gerçek miktar her zaman COIN_PACKAGES'tan okunur
        saveAll();
        if (ws.pid === targetPid) {
          ws.coins = profile.coins;
          send(ws, { t: 'coinsUpdated', coins: ws.coins, added: pkg.coins, real: true });
        } else {
          send(ws, { t: 'checkoutError', message: 'Ödeme başka bir profile ait.' });
        }
      }).catch(err => {
        console.error('Stripe session doğrulanamadı', err.message);
        send(ws, { t: 'checkoutError', message: 'Ödeme doğrulanamadı: ' + err.message });
      });

    } else if (msg.t === 'buyCosmetic') {
      const item = COSMETICS[msg.id];
      if (!item || !ws.profile) return;
      if (ws.profile.inventory.includes(msg.id)) { send(ws, { t: 'purchaseDenied', reason: 'owned' }); return; }
      if (ws.coins < item.price) { send(ws, { t: 'purchaseDenied', reason: 'coins' }); return; }
      setCoins(ws, ws.coins - item.price);
      ws.profile.inventory.push(msg.id);
      ws.profile.equipped[item.cat] = msg.id; // satın alınca otomatik ekiplenir
      saveAll();
      send(ws, {
        t: 'cosmeticBought',
        id: msg.id,
        coins: ws.coins,
        inventory: ws.profile.inventory,
        equipped: ws.profile.equipped,
      });

    } else if (msg.t === 'equipCosmetic') {
      const item = COSMETICS[msg.id];
      if (!item || !ws.profile || !ws.profile.inventory.includes(msg.id)) return;
      ws.profile.equipped[item.cat] = msg.id;
      saveAll();
      send(ws, { t: 'equipped', cat: item.cat, id: msg.id });

    } else if (msg.t === 'unequipCosmetic') {
      const cat = msg.cat;
      if (!ws.profile || !ws.profile.equipped || !(cat in ws.profile.equipped)) return;
      ws.profile.equipped[cat] = null;
      saveAll();
      send(ws, { t: 'equipped', cat, id: null });

    // --- bonus çark: günlük giriş ödülünden tamamen ayrı, isteğe bağlı ekstra kazanç.
    // 24 saatte bir ücretsiz çevirme hakkı, sonucu reklamla x2 yapma hakkı ---
    } else if (msg.t === 'getDailyStatus') {
      if (!ws.profile) return;
      send(ws, { t: 'dailyStatus', canSpin: ws.profile.lastSpinDate !== todayStr(), streak: ws.profile.dailyStreak });

    } else if (msg.t === 'spinWheel') {
      if (!ws.profile) return;
      const today = todayStr();
      if (ws.profile.lastSpinDate === today) { send(ws, { t: 'spinDenied', reason: 'already' }); return; }
      ws.profile.lastSpinDate = today;
      const idx = pickWheelSegment();
      const base = WHEEL_SEGMENTS[idx];
      const streakBonus = Math.min(ws.profile.dailyStreak - 1, 6) * 10;
      const amount = base + streakBonus;
      setCoins(ws, (ws.coins || 0) + amount);
      saveAll();
      ws.lastSpinAmount = amount;
      ws.lastSpinAdUsed = false;
      ws.lastSpinAdPending = false;
      send(ws, { t: 'spinResult', segmentIndex: idx, amount, streak: ws.profile.dailyStreak, coins: ws.coins });

    } else if (msg.t === 'watchDailyAd') {
      if (!ws.lastSpinAmount || ws.lastSpinAdUsed) {
        send(ws, { t: 'dailyAdDenied', reason: ws.lastSpinAdUsed ? 'used' : 'none' }); return;
      }
      if (ws.lastSpinAdPending) return;
      ws.lastSpinAdPending = true;
      send(ws, { t: 'dailyAdStart' });

    } else if (msg.t === 'dailyAdComplete') {
      if (!ws.lastSpinAdPending || !ws.lastSpinAmount || ws.lastSpinAdUsed) return;
      ws.lastSpinAdPending = false;
      ws.lastSpinAdUsed = true;
      setCoins(ws, (ws.coins || 0) + ws.lastSpinAmount); // ikinci kez eklenince toplamda x2 olur
      saveAll();
      send(ws, { t: 'dailyAdDoubled', added: ws.lastSpinAmount, coins: ws.coins });

    } else if (msg.t === 'dailyAdFailed') {
      ws.lastSpinAdPending = false; // hak kaybolmaz, tekrar denenebilir

    // --- günlük giriş ödülü reklamı: pop-up'ta gösterilen 20 coin'i reklam izleyince
    // 60'a çıkarır (haftalık 100 coin bonusu buna dahil değil, ayrıca otomatik verilir) ---
    } else if (msg.t === 'watchLoginAd') {
      if (!ws.lastLoginAdAmount || ws.lastLoginAdUsed) {
        send(ws, { t: 'loginAdDenied', reason: ws.lastLoginAdUsed ? 'used' : 'none' }); return;
      }
      if (ws.lastLoginAdPending) return;
      ws.lastLoginAdPending = true;
      send(ws, { t: 'loginAdStart' });

    } else if (msg.t === 'loginAdComplete') {
      if (!ws.lastLoginAdPending || !ws.lastLoginAdAmount || ws.lastLoginAdUsed) return;
      ws.lastLoginAdPending = false;
      ws.lastLoginAdUsed = true;
      setCoins(ws, (ws.coins || 0) + ws.lastLoginAdAmount);
      saveAll();
      send(ws, { t: 'loginAdDoubled', added: ws.lastLoginAdAmount, coins: ws.coins });

    } else if (msg.t === 'loginAdFailed') {
      ws.lastLoginAdPending = false; // hak kaybolmaz, tekrar denenebilir

    // --- arkadaşlar: istek gönder/kabul/reddet/kaldır, liste + çevrimiçi durumu ---
    } else if (msg.t === 'addFriend') {
      if (!ws.username || !ws.profile) { send(ws, { t: 'friendError', reason: 'needLogin' }); return; }
      const acc = resolveUsername(msg.username);
      if (!acc) { send(ws, { t: 'friendError', reason: 'not-found' }); return; }
      if (acc.pid === ws.pid) { send(ws, { t: 'friendError', reason: 'self' }); return; }
      if (ws.profile.friends.includes(acc.pid)) { send(ws, { t: 'friendError', reason: 'already' }); return; }
      const targetProfile = getProfile(acc.pid);
      if (!targetProfile.friendRequests.includes(ws.pid)) targetProfile.friendRequests.push(ws.pid);
      saveAll();
      send(ws, { t: 'friendRequestSent', username: acc.displayName });
      const targetWs = pidToWs.get(acc.pid);
      if (targetWs) send(targetWs, { t: 'friendRequestReceived', username: ws.username });

    } else if (msg.t === 'acceptFriend') {
      if (!ws.profile) return;
      const acc = resolveUsername(msg.username);
      if (!acc || !ws.profile.friendRequests.includes(acc.pid)) return;
      ws.profile.friendRequests = ws.profile.friendRequests.filter(p => p !== acc.pid);
      if (!ws.profile.friends.includes(acc.pid)) ws.profile.friends.push(acc.pid);
      const otherProfile = getProfile(acc.pid);
      if (!otherProfile.friends.includes(ws.pid)) otherProfile.friends.push(ws.pid);
      saveAll();
      sendFriendsList(ws);
      const targetWs = pidToWs.get(acc.pid);
      if (targetWs) { send(targetWs, { t: 'friendAccepted', username: ws.username }); sendFriendsList(targetWs); }

    } else if (msg.t === 'declineFriend') {
      if (!ws.profile) return;
      const acc = resolveUsername(msg.username);
      if (!acc) return;
      ws.profile.friendRequests = ws.profile.friendRequests.filter(p => p !== acc.pid);
      saveAll();
      sendFriendsList(ws);

    } else if (msg.t === 'removeFriend') {
      if (!ws.profile) return;
      const acc = resolveUsername(msg.username);
      if (!acc) return;
      ws.profile.friends = ws.profile.friends.filter(p => p !== acc.pid);
      const otherProfile = profiles[acc.pid];
      if (otherProfile && Array.isArray(otherProfile.friends)) {
        otherProfile.friends = otherProfile.friends.filter(p => p !== ws.pid);
      }
      saveAll();
      sendFriendsList(ws);

    } else if (msg.t === 'getFriends') {
      sendFriendsList(ws);

    // --- meydan okuma: bir arkadaşı doğrudan maça davet eder (kuyruk yok) ---
    } else if (msg.t === 'challengeFriend') {
      if (!ws.profile) return;
      const acc = resolveUsername(msg.username);
      if (!acc || !ws.profile.friends.includes(acc.pid)) { send(ws, { t: 'challengeError', reason: 'not-friend' }); return; }
      if (ws.match && !ws.match.ended) { send(ws, { t: 'challengeError', reason: 'you-busy' }); return; }
      const targetWs = pidToWs.get(acc.pid);
      if (!targetWs) { send(ws, { t: 'challengeError', reason: 'offline' }); return; }
      if ((targetWs.match && !targetWs.match.ended) || targetWs.pendingChallengeFrom) {
        send(ws, { t: 'challengeError', reason: 'busy' }); return;
      }
      ws.pendingChallengeTo = targetWs;
      targetWs.pendingChallengeFrom = ws;
      send(ws, { t: 'challengeSent', username: acc.displayName });
      send(targetWs, { t: 'challengeReceived', username: ws.username || ws.playerName || 'Oyuncu' });

    } else if (msg.t === 'acceptChallenge') {
      const from = ws.pendingChallengeFrom;
      if (!from || from.pendingChallengeTo !== ws || from.readyState !== WebSocket.OPEN) {
        ws.pendingChallengeFrom = null;
        return;
      }
      ws.pendingChallengeFrom = null; from.pendingChallengeTo = null;
      queue = queue.filter(w => w !== ws && w !== from); // kuyrukta bekliyorlarsa çıkar
      ws.playerName = ws.username || ws.playerName || 'Oyuncu';
      from.playerName = from.username || from.playerName || 'Oyuncu';
      startMatchBetween(from, ws);

    } else if (msg.t === 'declineChallenge') {
      const from = ws.pendingChallengeFrom;
      ws.pendingChallengeFrom = null;
      if (from) {
        if (from.pendingChallengeTo === ws) from.pendingChallengeTo = null;
        send(from, { t: 'challengeDeclined', username: ws.username || ws.playerName || 'Oyuncu' });
      }

    // --- Solo (tek kişilik, sınırsız) mod: oyun motoru da burada, tamamen
    // sunucu tarafında; istemci yalnızca niyet gönderir, sonucu sunucudan alır. ---
    } else if (msg.t === 'soloStart') {
      ws.soloGame = GameLogic.createGame(randomSeed());
      ws.solo = { continueCount: 0, adContinueUsed: false, adBonusUsed: false, adPending: null, deciding: false };
      const snap = ws.soloGame.snapshot();
      send(ws, { t: 'soloStarted', board: snap.board, tray: snap.tray, score: snap.score, streak: snap.streak });
      startMoveTimer(ws, () => finalizeSolo(ws, false, true));

    } else if (msg.t === 'soloPlace') {
      if (!ws.solo || !ws.soloGame || ws.solo.deciding) return;
      const res = ws.soloGame.place(msg.idx, msg.row, msg.col);
      if (!res.ok) { send(ws, { t: 'placeRejected', reason: res.reason }); return; }
      send(ws, { t: 'soloPlaced', board: res.board, preClearBoard: res.preClearBoard, tray: res.tray, score: res.score, streak: res.streak, lines: res.lines, clearedIdx: res.clearedIdx });
      if (res.stuck) {
        clearMoveTimer(ws); // karar ekranı açıkken hamle saati işlemez
        ws.solo.deciding = true;
        send(ws, {
          t: 'soloStuckOptions',
          coinCost: coinCostFor(ws.solo.continueCount),
          coins: ws.coins,
          adContinueAvailable: !ws.solo.adContinueUsed,
          adBonusAvailable: !ws.solo.adBonusUsed,
        });
      } else {
        startMoveTimer(ws, () => finalizeSolo(ws, false, true));
      }

    } else if (msg.t === 'soloStuck') {
      // Uyumluluk için yok sayılır (bkz. 'stuck'); sunucu hamlesiz kalmayı kendisi tespit eder.

    } else if (msg.t === 'soloContinueCoin') {
      if (!ws.solo || !ws.solo.deciding || !ws.soloGame) return;
      const cost = coinCostFor(ws.solo.continueCount);
      if (ws.coins < cost) { send(ws, { t: 'soloContinueDenied', reason: 'coins', coins: ws.coins, coinCost: cost }); return; }
      setCoins(ws, ws.coins - cost);
      ws.solo.continueCount++;
      ws.solo.deciding = false;
      const res = ws.soloGame.forceClearForContinue();
      send(ws, { t: 'soloContinueOk', method: 'coin', amount: cost, coins: ws.coins, board: res.board, tray: res.tray });
      startMoveTimer(ws, () => finalizeSolo(ws, false, true));

    } else if (msg.t === 'soloWatchAdContinue') {
      if (!ws.solo || !ws.solo.deciding) return;
      if (ws.solo.adContinueUsed) { send(ws, { t: 'soloContinueDenied', reason: 'adUsed' }); return; }
      if (ws.solo.adPending) return;
      ws.solo.adPending = 'continue';
      send(ws, { t: 'soloAdStart', purpose: 'continue' });

    } else if (msg.t === 'soloWatchAdBonus') {
      if (!ws.solo || !ws.solo.deciding) return;
      if (ws.solo.adBonusUsed) { send(ws, { t: 'soloContinueDenied', reason: 'bonusAdUsed' }); return; }
      if (ws.solo.adPending) return;
      ws.solo.adPending = 'bonus';
      send(ws, { t: 'soloAdStart', purpose: 'bonus' });

    } else if (msg.t === 'soloAdComplete') {
      if (!ws.solo || !ws.solo.deciding || !ws.solo.adPending || !ws.soloGame) return;
      const purpose = ws.solo.adPending;
      ws.solo.adPending = null;
      if (purpose === 'continue') {
        ws.solo.adContinueUsed = true;
        ws.solo.deciding = false;
        const res = ws.soloGame.forceClearForContinue();
        send(ws, { t: 'soloContinueOk', method: 'ad', amount: 0, coins: ws.coins, board: res.board, tray: res.tray });
        startMoveTimer(ws, () => finalizeSolo(ws, false, true));
      } else if (purpose === 'bonus') {
        ws.solo.adBonusUsed = true;
        ws.solo.deciding = false;
        const res = ws.soloGame.applyBonus(SOLO_BONUS_MULTIPLIER);
        send(ws, { t: 'soloBonusOk', score: res.score });
      }

    } else if (msg.t === 'soloAdFailed') {
      // Reklam yüklenemedi/yarıda kesildi — hak kaybolmaz, tekrar denenebilir.
      if (!ws.solo) return;
      ws.solo.adPending = null;

    } else if (msg.t === 'soloEnd') {
      if (!ws.solo) return;
      finalizeSolo(ws, !!msg.bonusApplied, false);
    }
  });

  ws.on('close', () => {
    queue = queue.filter(w => w !== ws);
    clearMoveTimer(ws);
    if (ws.pid && pidToWs.get(ws.pid) === ws) pidToWs.delete(ws.pid);
    if (ws.pendingChallengeTo) { ws.pendingChallengeTo.pendingChallengeFrom = null; ws.pendingChallengeTo = null; }
    if (ws.pendingChallengeFrom) { ws.pendingChallengeFrom.pendingChallengeTo = null; ws.pendingChallengeFrom = null; }
    if (ws.match && !ws.match.ended) endMatch(ws.match, 'disconnect', ws.opp, ws);
    if (ws.opp) ws.opp.opp = null;
  });
});

// Solo oturumu kesin olarak bitirir: rekor sunucunun kendi oyun motorundaki
// skordan okunur (istemciden gelen değere hiç güvenilmez), hem normal "Oyunu
// Bitir" akışından hem de hamle süresi dolduğunda (timedOut) buradan geçilir.
function finalizeSolo(ws, bonusApplied, timedOut) {
  if (!ws.solo) return;
  clearMoveTimer(ws);
  const scoreVal = ws.soloGame ? ws.soloGame.snapshot().score : 0;
  if (ws.profile) {
    if (bonusApplied) ws.profile.highScoreBonus = Math.max(ws.profile.highScoreBonus, scoreVal);
    else ws.profile.highScore = Math.max(ws.profile.highScore, scoreVal);
    saveAll();
  }
  ws.solo = null; ws.soloGame = null;
  send(ws, {
    t: 'soloFinal',
    score: scoreVal,
    timedOut,
    highScore: ws.profile ? ws.profile.highScore : 0,
    highScoreBonus: ws.profile ? ws.profile.highScoreBonus : 0,
  });
}

server.listen(PORT, () => console.log(`Block Blast Online: http://localhost:${PORT}`));
