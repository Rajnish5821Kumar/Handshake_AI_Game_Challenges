const app = document.querySelector("#app");
const toast = document.querySelector("#toast");
const PLAYER_KEY = "bluff-battle-player";
let roomState = null;
let refreshTimer = null;
let toastTimer = null;
let busy = false;
let syncing = false;
let renderedStateKey = null;

function readSavedPlayer() {
  try {
    return JSON.parse(localStorage.getItem(PLAYER_KEY) || "null");
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 3400);
}

async function request(action, payload = {}) {
  const response = await fetch(`/api/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The game server returned an unreadable response.");
  }
  if (!response.ok) throw new Error(result.error || "Something went wrong.");
  return result;
}

function setPlayer(player) {
  localStorage.setItem(PLAYER_KEY, JSON.stringify(player));
  clearInterval(refreshTimer);
  refreshTimer = setInterval(syncState, 1400);
}

function clearPlayer() {
  localStorage.removeItem(PLAYER_KEY);
  roomState = null;
  clearInterval(refreshTimer);
  renderHome();
}

function topbar() {
  return `<header class="topbar">
    <a class="brand" href="/" aria-label="Bluff Battle home"><span class="brand-mark">♟</span><span>BLUFF BATTLE</span></a>
    <span class="online">Ready to bluff</span>
  </header>`;
}

function renderHome() {
  clearInterval(refreshTimer);
  renderedStateKey = null;
  app.innerHTML = `${topbar()}
    <section class="hero">
      <div class="eyebrow">The party game of questionable truths</div>
      <h1>Bluff your way<br>to <span class="gradient-text">victory.</span></h1>
      <p>Make up a convincing answer. Spot the truth. Try not to laugh when your friends fall for a ridiculous bluff.</p>
    </section>
    <section class="panel">
      <div class="entry-grid">
        <form class="entry-card" id="create-form">
          <h2>Start a new game</h2>
          <p>Create a room and invite 1–7 friends to join.</p>
          <label class="field-label" for="create-name">Your name</label>
          <input class="input" id="create-name" name="name" maxlength="20" placeholder="e.g. Captain Fib" autocomplete="nickname" required>
          <button class="button button-block" type="submit">Create a room <span aria-hidden="true">→</span></button>
        </form>
        <form class="entry-card" id="join-form">
          <h2>Join the fun</h2>
          <p>Got a room code? Jump straight into the game.</p>
          <label class="field-label" for="join-name">Your name</label>
          <input class="input" id="join-name" name="name" maxlength="20" placeholder="What should we call you?" autocomplete="nickname" required>
          <label class="field-label" for="room-code-input">Room code</label>
          <input class="input" id="room-code-input" name="code" maxlength="5" placeholder="ABCDE" autocapitalize="characters" required>
          <button class="button button-block button-secondary" type="submit">Join room <span aria-hidden="true">→</span></button>
        </form>
      </div>
      <div class="rules"><strong>HOW TO PLAY</strong><span>Invent a fake answer, then vote for the real one. Score for spotting the truth or fooling a friend. Three rounds. Biggest score wins—with a fair tie-break if needed.</span></div>
    </section>
    <div class="footer-note">2–8 players · 3 rounds · Maximum mischief</div>`;

  document.querySelector("#create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = new FormData(event.currentTarget).get("name");
    await withBusy(event.currentTarget, async () => {
      const result = await request("create", { name });
      setPlayer(result.player);
      await syncState();
    });
  });
  document.querySelector("#join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    await withBusy(event.currentTarget, async () => {
      const result = await request("join", { name: form.get("name"), code: form.get("code") });
      setPlayer(result.player);
      await syncState();
    });
  });
}

async function withBusy(form, action) {
  if (busy) return;
  busy = true;
  if (form.contains(document.activeElement)) document.activeElement.blur();
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    showToast(error.message);
  } finally {
    busy = false;
    if (button.isConnected) button.disabled = false;
  }
}

async function syncState() {
  if (syncing) return;
  const player = readSavedPlayer();
  if (!player) return renderHome();
  syncing = true;
  try {
    const newState = await request("state", { code: player.code, token: player.token });
    const newStateKey = JSON.stringify(newState);
    const inputIsBeingEdited = app.contains(document.activeElement)
      && document.activeElement.matches("input, textarea");
    roomState = newState;
    if (newStateKey === renderedStateKey || inputIsBeingEdited) return;
    renderGame();
    renderedStateKey = newStateKey;
  } catch (error) {
    if (/reconnect|player session|room not found/i.test(error.message)) {
      clearPlayer();
    } else {
      showToast(error.message);
    }
  } finally {
    syncing = false;
  }
}

function currentPlayer() {
  return roomState.players.find((player) => player.id === roomState.me);
}

function renderGame() {
  const me = currentPlayer();
  if (!me) return clearPlayer();
  const header = `${topbar()}<div class="game-header">
    <div><div class="eyebrow">Your room</div><div class="room-code">${escapeHtml(roomState.code)}</div></div>
    <span class="phase-pill">${escapeHtml(phaseLabel(roomState.phase))}</span>
  </div>`;
  if (roomState.phase === "waiting") return renderWaiting(header, me);
  if (roomState.phase === "answering") return renderAnswering(header, me);
  if (roomState.phase === "voting") return renderVoting(header, me);
  return renderResults(header, me);
}

function phaseLabel(phase) {
  return ({ waiting: "Waiting room", answering: `Round ${roomState.round} · Write`, voting: `Round ${roomState.round} · Vote`, results: `Round ${roomState.round} · Results`, finished: "Game complete" })[phase] || phase;
}

function renderWaiting(header, me) {
  const players = roomState.players.map((player) => `<li class="player-row"><span class="player-name"><span class="avatar">${escapeHtml(player.name.slice(0, 1).toUpperCase())}</span>${escapeHtml(player.name)}${player.id === roomState.host ? '<span class="host-tag">Host</span>' : ""}</span><span class="subtle">${player.id === roomState.me ? "You" : "Ready"}</span></li>`).join("");
  app.innerHTML = `${header}<section class="panel">
    <h2 class="section-title">Waiting for your crew</h2>
    <p class="subtle">Share this code with your friends. The game starts when at least 2 players are here.</p>
    <ul class="player-list">${players}</ul>
    <div class="room-actions">
      ${me.host ? `<button class="button" id="start-game" ${roomState.players.length < 2 ? "disabled" : ""}>Start game <span aria-hidden="true">→</span></button>` : ""}
      <button class="button button-secondary" id="copy-code">Copy room code</button>
      <button class="button button-secondary" id="leave-room">Leave room</button>
    </div>
  </section>`;
  document.querySelector("#start-game")?.addEventListener("click", () => doAction("start", {}));
  document.querySelector("#copy-code").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(roomState.code); showToast("Room code copied!"); }
    catch { showToast(`Share this code: ${roomState.code}`); }
  });
  document.querySelector("#leave-room").addEventListener("click", async () => {
    const player = readSavedPlayer();
    try {
      await request("leave", { code: player.code, token: player.token });
      clearPlayer();
    } catch (error) {
      showToast(error.message);
    }
  });
}

function renderAnswering(header, me) {
  const submitted = roomState.submitted.includes(roomState.me);
  app.innerHTML = `${header}<section class="panel">
    <div class="eyebrow">Round ${roomState.round} of 3</div>
    <div class="question-card"><div class="eyebrow">Question</div><h2 class="question">${escapeHtml(roomState.question)}</h2></div>
    <p class="subtle">Make up a plausible (or hilariously implausible) answer. Other players won't see it until everyone has submitted.</p>
    ${submitted ? `<div class="rules"><strong>BLUFF LOCKED IN</strong><span>Waiting for the rest of the room. Your answer stays hidden until everyone has submitted.</span></div>` : `<form id="answer-form">
      <label class="field-label" for="fake-answer">Your fake answer</label>
      <input class="input" id="fake-answer" name="answer" maxlength="120" placeholder="Be convincing. Or don't." autocomplete="off" required>
      <button class="button button-block" type="submit">Lock in my bluff <span aria-hidden="true">→</span></button>
    </form>`}
    <p class="notice">${roomState.submitted.length} of ${roomState.players.length} players have submitted</p>
  </section>`;
  document.querySelector("#answer-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const answer = new FormData(event.currentTarget).get("answer");
    withBusy(event.currentTarget, () => doAction("answer", { answer }));
  });
}

function renderVoting(header, me) {
  const voted = roomState.voted.includes(roomState.me);
  const choices = roomState.answers.filter((answer) => answer.id !== roomState.me);
  app.innerHTML = `${header}<section class="panel">
    <div class="eyebrow">Round ${roomState.round} of 3</div>
    <div class="question-card"><div class="eyebrow">Which answer is real?</div><h2 class="question">${escapeHtml(roomState.question)}</h2></div>
    <p class="subtle">${voted ? "Your vote is locked. Waiting for everyone else." : "Choose the answer you think is true. You cannot vote for your own bluff."}</p>
    <ul class="answer-list">${choices.map((answer, index) => `<li><button class="answer-card" data-answer="${escapeHtml(answer.id)}" ${voted ? "disabled" : ""}><span class="answer-index">${index + 1}</span>${escapeHtml(answer.text)}</button></li>`).join("")}</ul>
    <p class="notice">${roomState.voted.length} of ${roomState.players.length} players have voted</p>
  </section>`;
  document.querySelectorAll("[data-answer]").forEach((button) => button.addEventListener("click", () => doAction("vote", { answerId: button.dataset.answer })));
}

function renderResults(header, me) {
  const final = roomState.phase === "finished";
  const sorted = [...roomState.players].sort((a, b) => b.score - a.score || b.correct - a.correct || b.fooled - a.fooled || a.name.localeCompare(b.name));
  const winner = sorted[0];
  const winningScore = winner?.score;
  const tied = sorted.filter((player) => player.score === winningScore && player.correct === winner.correct && player.fooled === winner.fooled);
  const answerItems = roomState.answers.map((answer) => {
    const voters = roomState.votes.filter((vote) => vote.answerId === answer.id);
    const author = roomState.players.find((player) => player.id === answer.authorId);
    return `<li class="answer-card ${answer.correct ? "correct-answer" : ""}"><span class="answer-index">${answer.correct ? "✓" : "•"}</span>${escapeHtml(answer.text)}<span class="answer-meta">${answer.correct ? "The real answer" : `Bluffed by ${escapeHtml(author?.name || "a player")}`} · ${voters.length} ${voters.length === 1 ? "vote" : "votes"}${voters.length ? ` · ${voters.map((vote) => escapeHtml(roomState.players.find((player) => player.id === vote.voterId)?.name || "")).join(", ")}` : ""}</span></li>`;
  }).join("");
  app.innerHTML = `${header}<section class="panel">
    ${final ? `<div class="eyebrow">Three rounds. One very questionable champion.</div><h2 class="section-title">${tied.length > 1 ? "It's a tie!" : `${escapeHtml(winner.name)} wins!`}</h2><p class="subtle">${tied.length > 1 ? `A shared win for ${tied.map((player) => escapeHtml(player.name)).join(" and ")}. The score and both tie-breaks were still level.` : "Scores are ranked by total points, then correct guesses, then votes earned by your bluffs."}</p>` : `<div class="eyebrow">Round ${roomState.round} complete</div><h2 class="section-title">The truth comes out</h2><p class="subtle">Here's what everyone chose. Scoreboard updated!</p>`}
    <ul class="answer-list">${answerItems}</ul>
    <h3 class="section-title" style="margin:26px 0 0">${final ? "Final leaderboard" : "Scoreboard"}</h3>
    <ol class="score-list">${sorted.map((player, index) => `<li class="score-row"><span class="player-name"><span class="avatar">${index === 0 ? "★" : index + 1}</span>${escapeHtml(player.name)}${player.id === roomState.me ? '<span class="host-tag">You</span>' : ""}</span><span class="score-value">${player.score} ${player.score === 1 ? "pt" : "pts"}</span></li>`).join("")}</ol>
    ${!final && me.host ? `<div class="room-actions"><button class="button" id="next-round">${roomState.round === 3 ? "Finish game" : "Start next round"} <span aria-hidden="true">→</span></button></div>` : ""}
    ${final ? `<div class="room-actions"><button class="button button-secondary" id="back-home">Back to home</button></div>` : me.host ? "" : `<p class="notice">The host will start the next round shortly.</p>`}
  </section>`;
  document.querySelector("#next-round")?.addEventListener("click", () => doAction("next", {}));
  document.querySelector("#back-home")?.addEventListener("click", clearPlayer);
}

async function doAction(action, payload) {
  if (busy) return;
  busy = true;
  try {
    const player = readSavedPlayer();
    await request(action, { ...payload, code: player.code, token: player.token });
    await syncState();
  } catch (error) {
    showToast(error.message);
  } finally {
    busy = false;
  }
}

if (saved?.code && saved?.token) {
  syncState();
  refreshTimer = setInterval(syncState, 1400);
} else {
  renderHome();
}
