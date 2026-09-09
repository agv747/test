const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const boardEl = document.getElementById("board");
const statusEl = document.getElementById("status");
const resetBtn = document.getElementById("resetBtn");
const vsAiCheckbox = document.getElementById("vsAi");
const scoreXEl = document.getElementById("scoreX");
const scoreOEl = document.getElementById("scoreO");
const scoreDEl = document.getElementById("scoreD");

let board = Array(9).fill(null);
let current = "X";
let gameOver = false;
let aiThinking = false;
const score = { X: 0, O: 0, D: 0 };

const cellButtons = [];
for (let i = 0; i < 9; i++) {
  const btn = document.createElement("button");
  btn.className = "cell";
  btn.setAttribute("role", "gridcell");
  btn.setAttribute("aria-label", `Клетка ${i + 1}`);
  btn.addEventListener("click", () => handleMove(i));
  boardEl.appendChild(btn);
  cellButtons.push(btn);
}

resetBtn.addEventListener("click", resetGame);
vsAiCheckbox.addEventListener("change", resetGame);

function checkWinner(b) {
  for (const line of WIN_LINES) {
    const [a, c, d] = line;
    if (b[a] && b[a] === b[c] && b[a] === b[d]) {
      return { player: b[a], line };
    }
  }
  if (b.every((v) => v !== null)) return { player: "D", line: null };
  return null;
}

function handleMove(index) {
  if (gameOver || board[index] || aiThinking) return;
  makeMove(index, current);

  const result = checkWinner(board);
  if (result) {
    endGame(result);
    return;
  }

  current = current === "X" ? "O" : "X";
  updateStatus();

  if (vsAiCheckbox.checked && current === "O" && !gameOver) {
    aiThinking = true;
    statusEl.textContent = "Компьютер думает...";
    setTimeout(aiMove, 350);
  }
}

function makeMove(index, player) {
  board[index] = player;
  const btn = cellButtons[index];
  btn.textContent = player;
  btn.classList.add(player.toLowerCase());
  btn.disabled = true;
}

function aiMove() {
  const best = findBestMove(board);
  aiThinking = false;
  if (best === -1 || gameOver) return;

  makeMove(best, "O");
  const result = checkWinner(board);
  if (result) {
    endGame(result);
    return;
  }
  current = "X";
  updateStatus();
}

function findBestMove(b) {
  let bestScore = -Infinity;
  let move = -1;
  for (let i = 0; i < 9; i++) {
    if (!b[i]) {
      b[i] = "O";
      const s = minimax(b, 0, false);
      b[i] = null;
      if (s > bestScore) {
        bestScore = s;
        move = i;
      }
    }
  }
  return move;
}

function minimax(b, depth, isMaximizing) {
  const result = checkWinner(b);
  if (result) {
    if (result.player === "O") return 10 - depth;
    if (result.player === "X") return depth - 10;
    return 0;
  }

  if (isMaximizing) {
    let best = -Infinity;
    for (let i = 0; i < 9; i++) {
      if (!b[i]) {
        b[i] = "O";
        best = Math.max(best, minimax(b, depth + 1, false));
        b[i] = null;
      }
    }
    return best;
  } else {
    let best = Infinity;
    for (let i = 0; i < 9; i++) {
      if (!b[i]) {
        b[i] = "X";
        best = Math.min(best, minimax(b, depth + 1, true));
        b[i] = null;
      }
    }
    return best;
  }
}

function endGame(result) {
  gameOver = true;
  score[result.player]++;
  scoreXEl.textContent = score.X;
  scoreOEl.textContent = score.O;
  scoreDEl.textContent = score.D;

  if (result.line) {
    for (const i of result.line) {
      cellButtons[i].classList.add("win");
    }
    statusEl.textContent = `Победили: ${result.player}`;
  } else {
    statusEl.textContent = "Ничья!";
  }

  cellButtons.forEach((btn) => (btn.disabled = true));
}

function updateStatus() {
  statusEl.textContent = `Ход: ${current}`;
}

function resetGame() {
  board = Array(9).fill(null);
  current = "X";
  gameOver = false;
  aiThinking = false;
  cellButtons.forEach((btn) => {
    btn.textContent = "";
    btn.disabled = false;
    btn.className = "cell";
  });
  updateStatus();
}

resetGame();
