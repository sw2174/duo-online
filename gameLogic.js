// Oyunun TEK otoriter mantığı — yalnızca sunucuda çalışır. İstemci artık board/tray/skor
// üretmiyor; sadece burada üretilen durumu render eder ve "şu taşı şuraya koy" niyeti gönderir.
// Bu sayede bir istemci konsoldan skor/tahta değerini değiştirse bile rakip veya rekor
// tablosu bunu asla görmez — her şey burada, sunucu tarafında yeniden hesaplanır.

const N = 8;
const SHAPES = [
  [[0,0]],
  [[0,0],[0,1]], [[0,0],[1,0]],
  [[0,0],[0,1],[0,2]], [[0,0],[1,0],[2,0]],
  [[0,0],[0,1],[0,2],[0,3]], [[0,0],[1,0],[2,0],[3,0]],
  [[0,0],[0,1],[0,2],[0,3],[0,4]], [[0,0],[1,0],[2,0],[3,0],[4,0]],
  [[0,0],[0,1],[1,0],[1,1]],
  [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]],
  [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2]], [[0,0],[0,1],[1,0],[1,1],[2,0],[2,1]],
  [[0,0],[1,0],[1,1]], [[0,0],[0,1],[1,0]], [[0,0],[0,1],[1,1]], [[0,1],[1,0],[1,1]],
  [[0,0],[1,0],[2,0],[2,1],[2,2]], [[0,0],[0,1],[0,2],[1,0],[2,0]],
  [[0,0],[0,1],[0,2],[1,2],[2,2]], [[0,2],[1,2],[2,0],[2,1],[2,2]],
  [[0,0],[0,1],[0,2],[1,1]], [[0,1],[1,0],[1,1],[1,2]],
  [[0,0],[1,0],[1,1],[2,0]], [[0,1],[1,0],[1,1],[2,1]],
];

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyBoard() {
  return Array.from({ length: N }, () => Array(N).fill(0));
}

function canPlace(board, shape, r0, c0) {
  return shape.every(([r, c]) => {
    const rr = r0 + r, cc = c0 + c;
    return rr >= 0 && rr < N && cc >= 0 && cc < N && board[rr][cc] === 0;
  });
}

function anyFit(board, shape) {
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (canPlace(board, shape, r, c)) return true;
  return false;
}

function trayHasFit(board, tray) {
  return tray.some(p => !p.used && anyFit(board, p.shape));
}

function newPiece(rng) {
  const shape = SHAPES[Math.floor(rng() * SHAPES.length)];
  const color = 1 + Math.floor(rng() * 8);
  return { shape, color, used: false };
}

function newTray(rng) {
  return [newPiece(rng), newPiece(rng), newPiece(rng)];
}

function findFullLines(board) {
  const fullRows = [], fullCols = [];
  for (let r = 0; r < N; r++) if (board[r].every(v => v)) fullRows.push(r);
  for (let c = 0; c < N; c++) if (board.every(row => row[c])) fullCols.push(c);
  return { fullRows, fullCols };
}

function clearedCellIndices(fullRows, fullCols) {
  const set = new Set();
  fullRows.forEach(r => { for (let c = 0; c < N; c++) set.add(r * N + c); });
  fullCols.forEach(c => { for (let r = 0; r < N; r++) set.add(r * N + c); });
  return [...set];
}

// Bir maçın/solo oturumun TEK oyun durumunu tutan otoriter nesne.
function createGame(seed) {
  const rng = mulberry32(seed);
  let board = emptyBoard();
  let tray = newTray(rng);
  let score = 0;
  let streak = 0;

  function cloneTray() { return tray.map(p => ({ shape: p.shape, color: p.color, used: p.used })); }
  function cloneBoard() { return board.map(row => row.slice()); }
  function snapshot(extra) {
    return Object.assign({ board: cloneBoard(), tray: cloneTray(), score, streak }, extra || {});
  }

  function place(idx, r0, c0) {
    const p = tray[idx];
    if (!p || p.used) return { ok: false, reason: 'invalid-piece' };
    if (typeof r0 !== 'number' || typeof c0 !== 'number' || !canPlace(board, p.shape, r0, c0)) {
      return { ok: false, reason: 'cannot-place' };
    }
    p.shape.forEach(([r, c]) => { board[r0 + r][c0 + c] = p.color; });
    p.used = true;
    score += p.shape.length;
    // Taş yerleşmiş ama satırlar henüz temizlenmemişken ara görüntü — istemci
    // önce bunu gösterip "flash" animasyonunu oynatır, sonra son hali uygular.
    const preClearBoard = cloneBoard();

    const { fullRows, fullCols } = findFullLines(board);
    const lines = fullRows.length + fullCols.length;
    let clearedIdx = [];
    if (lines > 0) {
      // Streak yalnızca bu hamlede temizlenen bloklardan kazanılan bonusa uygulanır.
      streak = Math.min(streak + 1, 5);
      score += lines * 10 * streak;
      clearedIdx = clearedCellIndices(fullRows, fullCols);
      fullRows.forEach(r => board[r].fill(0));
      fullCols.forEach(c => { for (let r = 0; r < N; r++) board[r][c] = 0; });
    } else {
      streak = 0;
    }

    if (tray.every(t => t.used)) tray = newTray(rng);

    const stuck = !trayHasFit(board, tray);
    return snapshot({ ok: true, lines, clearedIdx, stuck, preClearBoard });
  }

  // Devam etme: en dolu 2 satır + 1 sütunu temizler, skor korunur, ekstra puan verilmez;
  // kalan taşlardan hiçbiri sığmıyorsa birini garantili 1x1 ile değiştirir.
  function forceClearForContinue() {
    const rowFill = board.map(row => row.filter(v => v).length);
    const colFill = Array.from({ length: N }, (_, c) => board.reduce((s, row) => s + (row[c] ? 1 : 0), 0));
    const rowsToClear = rowFill.map((f, i) => [f, i]).sort((a, b) => b[0] - a[0]).slice(0, 2).map(x => x[1]);
    const colsToClear = colFill.map((f, i) => [f, i]).sort((a, b) => b[0] - a[0]).slice(0, 1).map(x => x[1]);
    rowsToClear.forEach(r => board[r].fill(0));
    colsToClear.forEach(c => { for (let r = 0; r < N; r++) board[r][c] = 0; });

    const unused = tray.filter(t => !t.used);
    if (unused.length > 0 && !unused.some(t => anyFit(board, t.shape))) {
      const idx = tray.findIndex(t => !t.used);
      if (idx !== -1) tray[idx] = { shape: [[0, 0]], color: 1 + Math.floor(rng() * 8), used: false };
    }
    return snapshot();
  }

  // Solo x1,5 reklam bonusu: skor sunucuda çarpılır, istemci yalnızca sonucu gösterir.
  function applyBonus(multiplier) {
    score = Math.round(score * multiplier);
    return snapshot();
  }

  return { place, forceClearForContinue, applyBonus, snapshot };
}

module.exports = {
  N, SHAPES, mulberry32, emptyBoard, canPlace, anyFit, trayHasFit,
  newPiece, newTray, findFullLines, clearedCellIndices, createGame,
};
