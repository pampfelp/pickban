// URL do Web App do Apps Script (deploy > Nova implantação > App da Web)
const API_URL = "https://script.google.com/macros/s/AKfycbzXogaLlQ0F_L7uGOKOJcxFIJx-ssx7Lj0DVCPCynPHD549snVT6DhH9qm7Sl1AjCq7ng/exec";

const HEARTBEAT_INTERVAL_MS = 10000;
const LOBBY_POLL_MS = 4000;

const MATCH_POLL_MS_BY_STATUS = {
  waiting: 3000,
  drafting: 1200,
  countdown: 1000,
  official: 2500,
  finished: null // não faz mais polling
};

let state = {
  me: null, // { id, name, photo }
  players: [],
  characters: [],
  rooms: [],
  matchId: localStorage.getItem("smashup_matchId") || null,
  currentTab: "lobby",
  pollGeneration: 0,
  lobbyPollTimeout: null,
  matchPollTimeout: null,
  heartbeatTimer: null,
  draftTimerInterval: null,
  turnTimerInterval: null,
  countdownInterval: null,
  officialTimerInterval: null,
  actionInFlight: false,
  lastMatch: null,
  pendingPhoto: {} // { login: {...}, character: {...}, player: {...} }
};

/* =========================
   HELPERS GERAIS
========================= */
function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function getInitials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  let initials = parts[0] ? parts[0][0] : "?";
  if (parts.length > 1) initials += parts[1][0];
  return initials.toUpperCase();
}

function avatarHtml(person, size) {
  size = size || "md";
  const sizeClass = `avatar-${size}`;
  if (person && person.photo) {
    return `<img class="avatar ${sizeClass}" src="${person.photo}" alt="${escapeHtml(person.name)}">`;
  }
  return `<div class="avatar ${sizeClass}">${escapeHtml(getInitials(person && person.name))}</div>`;
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

function formatElapsed(startedAt) {
  if (!startedAt) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function playerName(id) {
  const p = state.players.find(pl => String(pl.id) === String(id));
  return p ? p.name : "?";
}

/* =========================
   API HELPERS
========================= */
async function api(action, params = {}) {
  const url = new URL(API_URL);
  url.searchParams.set("action", action);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString());
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

// POST em text/plain para evitar preflight CORS (Apps Script não trata OPTIONS).
async function apiPost(body) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return data;
}

/* =========================
   FOTO: redimensionar + upload
========================= */
function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const maxDim = 500;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        resolve({
          base64: dataUrl.split(",")[1],
          mimeType: "image/jpeg",
          filename: (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg",
          previewUrl: dataUrl
        });
      };
      img.onerror = () => reject(new Error("Não foi possível ler a imagem"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo"));
    reader.readAsDataURL(file);
  });
}

function setupPhotoPicker(key, previewElId, inputElId) {
  const preview = document.getElementById(previewElId);
  const input = document.getElementById(inputElId);
  preview.addEventListener("click", () => input.click());
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    try {
      const resized = await resizeImageFile(file);
      state.pendingPhoto[key] = resized;
      preview.innerHTML = "";
      preview.style.backgroundImage = `url(${resized.previewUrl})`;
      preview.style.backgroundSize = "cover";
      preview.style.backgroundPosition = "center";
      preview.classList.remove("avatar-placeholder");
    } catch (err) {
      toast(err.message);
    }
  });
}

function resetPhotoPicker(key, previewElId, inputElId) {
  delete state.pendingPhoto[key];
  const preview = document.getElementById(previewElId);
  preview.innerHTML = "+";
  preview.style.backgroundImage = "";
  preview.classList.add("avatar-placeholder");
  document.getElementById(inputElId).value = "";
}

async function uploadPendingPhoto(key) {
  const pending = state.pendingPhoto[key];
  if (!pending) return null;
  const result = await apiPost({
    action: "uploadPhoto",
    base64: pending.base64,
    mimeType: pending.mimeType,
    filename: pending.filename
  });
  return { url: result.url, fileId: result.fileId };
}

setupPhotoPicker("login", "loginPhotoPreview", "loginPhotoInput");
setupPhotoPicker("character", "characterPhotoPreview", "characterImageInput");
setupPhotoPicker("player", "playerPhotoPreview", "playerPhotoInput");

/* =========================
   LOGIN
========================= */
function renderLoginScreen() {
  const list = document.getElementById("loginPlayerList");
  list.innerHTML = "";
  state.players.forEach(p => {
    const card = document.createElement("div");
    card.className = "login-player-card";
    card.innerHTML = `${avatarHtml(p, "lg")}<span>${escapeHtml(p.name)}</span>`;
    card.addEventListener("click", () => loginAs(p));
    list.appendChild(card);
  });
}

async function loginAs(player) {
  state.me = { id: String(player.id), name: player.name, photo: player.photo };
  localStorage.setItem("smashup_playerId", state.me.id);
  await sendHeartbeat();
  startHeartbeatLoop();
  showApp();
}

document.getElementById("loginCreateForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("loginError");
  errorEl.textContent = "";
  const name = document.getElementById("loginName").value.trim();
  if (!name) return;

  try {
    let photo = "", photoFileId = "";
    const uploaded = await uploadPendingPhoto("login");
    if (uploaded) { photo = uploaded.url; photoFileId = uploaded.fileId; }

    const result = await api("addPlayer", { name, photo, photoFileId });
    await loadData();
    const newPlayer = state.players.find(p => String(p.id) === String(result.id));
    resetPhotoPicker("login", "loginPhotoPreview", "loginPhotoInput");
    document.getElementById("loginName").value = "";
    await loginAs(newPlayer || { id: result.id, name, photo });
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

function showApp() {
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("app").style.display = "block";
  renderCurrentUserBox();
  switchTab("lobby");
}

function logout() {
  localStorage.removeItem("smashup_playerId");
  localStorage.removeItem("smashup_matchId");
  stopHeartbeatLoop();
  stopLobbyPolling();
  stopMatchPolling();
  clearAllTimers();
  state.me = null;
  state.matchId = null;
  document.getElementById("app").style.display = "none";
  document.getElementById("loginScreen").style.display = "flex";
  renderLoginScreen();
}

function renderCurrentUserBox() {
  const box = document.getElementById("currentUserBox");
  box.innerHTML = `${avatarHtml(state.me, "sm")}<span>${escapeHtml(state.me.name)}</span>`;
  const btn = document.createElement("button");
  btn.textContent = "Sair";
  btn.addEventListener("click", logout);
  box.appendChild(btn);
}

/* =========================
   HEARTBEAT (ONLINE/OFFLINE)
========================= */
async function sendHeartbeat() {
  if (!state.me) return;
  try {
    await api("heartbeat", { playerId: state.me.id });
  } catch (err) {
    // silencioso: não incomodar o usuário por falha de heartbeat
  }
}

function startHeartbeatLoop() {
  stopHeartbeatLoop();
  state.heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeatLoop() {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}

/* =========================
   TABS
========================= */
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(tab) {
  state.currentTab = tab;
  state.pollGeneration++;

  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${tab}`));

  stopLobbyPolling();
  stopMatchPolling();
  clearAllTimers();

  if (tab === "lobby") {
    scheduleLobbyPoll(0);
  } else if (tab === "game") {
    scheduleMatchPoll(0);
  } else if (tab === "characters") {
    renderCharacterList();
  } else if (tab === "players") {
    renderPlayerList();
  }
}

/* =========================
   BOOTSTRAP
========================= */
async function loadData() {
  const data = await api("getData");
  state.players = data.players || [];
  state.characters = data.characters || [];
  state.rooms = data.rooms || [];
}

async function init() {
  try {
    await loadData();
  } catch (err) {
    toast("Erro ao carregar dados: " + err.message);
  }

  const savedId = localStorage.getItem("smashup_playerId");
  const savedPlayer = savedId ? state.players.find(p => String(p.id) === String(savedId)) : null;

  if (savedPlayer) {
    state.me = { id: String(savedPlayer.id), name: savedPlayer.name, photo: savedPlayer.photo };
    await sendHeartbeat();
    startHeartbeatLoop();
    showApp();
  } else {
    localStorage.removeItem("smashup_playerId");
    renderLoginScreen();
  }
}
init();

/* =========================
   LOBBY (polling recursivo, sem sobreposição de chamadas)
========================= */
function stopLobbyPolling() {
  if (state.lobbyPollTimeout) clearTimeout(state.lobbyPollTimeout);
  state.lobbyPollTimeout = null;
}

function scheduleLobbyPoll(delay) {
  stopLobbyPolling();
  const gen = state.pollGeneration;
  state.lobbyPollTimeout = setTimeout(async () => {
    if (gen !== state.pollGeneration || state.currentTab !== "lobby") return;
    await refreshLobby();
    if (gen === state.pollGeneration && state.currentTab === "lobby") {
      scheduleLobbyPoll(LOBBY_POLL_MS);
    }
  }, delay);
}

async function refreshLobby() {
  try {
    await loadData();
  } catch (err) {
    document.getElementById("lobbyError").textContent = err.message;
    return;
  }
  document.getElementById("lobbyError").textContent = "";
  renderRoomList();
  renderOnlinePlayerList();
  renderCurrentUserBox();
}

function renderRoomList() {
  const list = document.getElementById("roomList");
  list.innerHTML = "";

  if (state.rooms.length === 0) {
    list.innerHTML = `<p class="hint">Nenhuma sala aberta no momento. Crie uma!</p>`;
    return;
  }

  state.rooms.forEach(room => {
    const isMember = room.playerIds.map(String).includes(state.me.id);
    const startedAt = room.officialStartedAt || room.draftStartedAt;

    const card = document.createElement("div");
    card.className = "room-card";
    card.innerHTML = `
      <div class="room-card-info">
        <span class="room-card-code">${escapeHtml(room.code)}</span>
        <span class="status-badge ${room.status}">${escapeHtml(room.statusLabel)}</span>
        <span class="room-card-meta">${room.playerCount}/${room.maxPlayers} jogadores — ${room.playerNames.map(escapeHtml).join(", ")}</span>
        ${startedAt ? `<span class="room-card-meta">⏱ ${formatElapsed(startedAt)}</span>` : ""}
      </div>
    `;

    const btn = document.createElement("button");
    btn.className = isMember ? "secondary-btn" : "primary-btn";
    if (isMember) {
      btn.textContent = "Ver sala";
      btn.addEventListener("click", () => enterRoom(room.matchId));
    } else if (room.status === "waiting" && room.playerCount < room.maxPlayers) {
      btn.textContent = "Entrar";
      btn.addEventListener("click", () => joinRoomByCode(room.code));
    } else {
      btn.textContent = "Indisponível";
      btn.disabled = true;
    }
    card.appendChild(btn);
    list.appendChild(card);
  });
}

function renderOnlinePlayerList() {
  const list = document.getElementById("onlinePlayerList");
  list.innerHTML = "";
  state.players.forEach(p => {
    const item = document.createElement("div");
    item.className = "online-player-item";
    item.innerHTML = `
      ${avatarHtml(p, "md")}
      <span><span class="status-dot ${p.online ? "online" : "offline"}"></span>${escapeHtml(p.name)}</span>
    `;
    list.appendChild(item);
  });
}

/* ---- criar sala (editor de regras) ---- */
document.getElementById("createRoomBtn").addEventListener("click", () => {
  document.getElementById("createRoomForm").style.display = "block";
});

document.getElementById("cancelCreateRoomBtn").addEventListener("click", () => {
  document.getElementById("createRoomForm").style.display = "none";
});

document.getElementById("confirmCreateRoomBtn").addEventListener("click", async () => {
  const errorEl = document.getElementById("lobbyError");
  errorEl.textContent = "";
  try {
    const room = await api("createRoom", {
      hostPlayerId: state.me.id,
      maxPlayers: document.getElementById("ruleMaxPlayers").value,
      banCount: document.getElementById("ruleBanCount").value,
      pickCount: document.getElementById("rulePickCount").value,
      turnTimerEnabled: document.getElementById("ruleTurnTimer").checked
    });
    document.getElementById("createRoomForm").style.display = "none";
    enterRoom(room.matchId);
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

document.getElementById("joinCodeForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = document.getElementById("joinCodeInput").value.trim();
  if (!code) return;
  await joinRoomByCode(code);
});

async function joinRoomByCode(code) {
  const errorEl = document.getElementById("lobbyError");
  errorEl.textContent = "";
  try {
    const room = await api("joinRoom", { code, playerId: state.me.id });
    document.getElementById("joinCodeInput").value = "";
    enterRoom(room.matchId);
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function enterRoom(matchId) {
  state.matchId = String(matchId);
  localStorage.setItem("smashup_matchId", state.matchId);
  switchTab("game");
}

/* =========================
   FASES DO DRAFT (espelha o backend p/ UI otimista)
========================= */
function buildPhasesJS(banCount, pickCount) {
  const phases = [];
  let b = 0, p = 0;
  while (b < banCount || p < pickCount) {
    if (b < banCount) { phases.push("ban" + (b + 1)); b++; }
    if (p < pickCount) { phases.push("pick" + (p + 1)); p++; }
  }
  return phases;
}

function phaseLabelForJS(phase) {
  if (!phase) return "";
  const m = String(phase).match(/^(ban|pick)(\d+)$/);
  if (!m) return phase;
  const type = m[1] === "ban" ? "Banimento" : "Escolha";
  return `${m[2]}ª Rodada de ${type}`;
}

/* =========================
   SALA: polling recursivo
========================= */
function stopMatchPolling() {
  if (state.matchPollTimeout) clearTimeout(state.matchPollTimeout);
  state.matchPollTimeout = null;
}

function scheduleMatchPoll(delay) {
  stopMatchPolling();
  const gen = state.pollGeneration;
  state.matchPollTimeout = setTimeout(async () => {
    if (gen !== state.pollGeneration || state.currentTab !== "game") return;
    if (state.actionInFlight) { scheduleMatchPoll(400); return; }
    await refreshMatch();
    if (gen !== state.pollGeneration || state.currentTab !== "game") return;
    const status = state.lastMatch ? state.lastMatch.status : "waiting";
    const nextDelay = MATCH_POLL_MS_BY_STATUS[status];
    if (nextDelay) scheduleMatchPoll(nextDelay);
  }, delay);
}

async function refreshMatch() {
  if (!state.matchId) {
    showNoMatch();
    return;
  }
  try {
    const match = await api("getMatchState", { matchId: state.matchId });
    state.lastMatch = match;
    renderMatch(match);
  } catch (err) {
    toast("Erro ao atualizar sala: " + err.message);
    showNoMatch();
  }
}

function clearAllTimers() {
  [state.draftTimerInterval, state.turnTimerInterval, state.countdownInterval, state.officialTimerInterval]
    .forEach(t => t && clearInterval(t));
  state.draftTimerInterval = null;
  state.turnTimerInterval = null;
  state.countdownInterval = null;
  state.officialTimerInterval = null;
}

function showNoMatch() {
  ["noMatch", "waitingRoom", "draftBoard", "countdownScreen", "officialScreen", "finishedScreen"]
    .forEach(id => document.getElementById(id).style.display = "none");
  document.getElementById("noMatch").style.display = "block";
}

function renderMatch(match) {
  clearAllTimers();
  const screens = ["noMatch", "waitingRoom", "draftBoard", "countdownScreen", "officialScreen", "finishedScreen"];
  screens.forEach(id => document.getElementById(id).style.display = "none");

  if (match.status === "waiting") {
    document.getElementById("waitingRoom").style.display = "block";
    renderWaitingRoom(match);
  } else if (match.status === "drafting") {
    document.getElementById("draftBoard").style.display = "block";
    renderDraftBoard(match);
  } else if (match.status === "countdown") {
    document.getElementById("countdownScreen").style.display = "block";
    renderCountdownScreen(match);
  } else if (match.status === "official") {
    document.getElementById("officialScreen").style.display = "block";
    renderOfficialScreen(match);
  } else if (match.status === "finished") {
    document.getElementById("finishedScreen").style.display = "block";
    renderFinishedScreen(match);
  }
}

/* ---- sala de espera ---- */
function renderWaitingRoom(match) {
  document.getElementById("roomCodeDisplay").textContent = match.code;

  const recap = document.getElementById("waitingRules");
  recap.innerHTML = `
    <span>👥 ${match.rules.maxPlayers} jogadores</span>
    <span>🚫 ${match.rules.banCount} banimento(s)</span>
    <span>✅ ${match.rules.pickCount} escolha(s)</span>
    <span>⏱ ${match.rules.turnTimerEnabled ? "Timer de 1min30s por turno" : "Sem timer por turno"}</span>
  `;

  const list = document.getElementById("waitingPlayerList");
  list.innerHTML = "";
  match.results.forEach(r => {
    const card = document.createElement("div");
    card.className = "waiting-player-card";
    card.innerHTML = `
      ${avatarHtml({ name: r.playerName, photo: r.playerPhoto }, "sm")}
      <span><span class="status-dot ${r.online ? "online" : "offline"}"></span>${escapeHtml(r.playerName)}</span>
      ${String(r.playerId) === String(match.hostPlayerId) ? '<span class="host-tag">HOST</span>' : ""}
    `;
    list.appendChild(card);
  });

  const isHost = String(match.hostPlayerId) === String(state.me.id);
  const startBtn = document.getElementById("startRoomBtn");
  const hint = document.getElementById("waitingHint");
  const missing = match.rules.maxPlayers - match.playerIds.length;

  if (isHost) {
    startBtn.style.display = "inline-block";
    startBtn.disabled = missing !== 0;
    hint.textContent = missing > 0 ? `Faltam ${missing} jogador(es) para iniciar (a sala precisa de exatamente ${match.rules.maxPlayers}).` : "";
  } else {
    startBtn.style.display = "none";
    hint.textContent = missing > 0 ? `Aguardando mais ${missing} jogador(es) entrar...` : "Aguardando o host iniciar a partida...";
  }
}

document.getElementById("startRoomBtn").addEventListener("click", async () => {
  try {
    const match = await api("startRoom", { matchId: state.matchId, hostPlayerId: state.me.id });
    state.lastMatch = match;
    renderMatch(match);
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById("leaveRoomBtn").addEventListener("click", async () => {
  try {
    await api("leaveRoom", { matchId: state.matchId, playerId: state.me.id });
  } catch (err) {
    toast(err.message);
  }
  state.matchId = null;
  localStorage.removeItem("smashup_matchId");
  switchTab("lobby");
});

/* ---- draft (ban/pick) ---- */
function renderDraftBoard(match) {
  document.getElementById("phaseLabel").textContent = match.phaseLabel;

  const currentPlayer = match.results.find(r => String(r.playerId) === String(match.currentPlayerId));
  const turnLabel = document.getElementById("turnLabel");
  const actionWord = match.phase && match.phase.indexOf("ban") === 0 ? "banir" : "escolher";
  const isMyTurn = currentPlayer && String(match.currentPlayerId) === String(state.me.id);
  turnLabel.textContent = currentPlayer
    ? (isMyTurn ? `Sua vez de ${actionWord}!` : `Vez de ${currentPlayer.playerName} ${actionWord}`)
    : "";

  const draftTimerEl = document.getElementById("draftTimer");
  if (match.draftStartedAt) {
    draftTimerEl.textContent = "Draft: " + formatElapsed(match.draftStartedAt);
    state.draftTimerInterval = setInterval(() => {
      draftTimerEl.textContent = "Draft: " + formatElapsed(match.draftStartedAt);
    }, 1000);
  }

  const turnTimerEl = document.getElementById("turnTimerDisplay");
  if (match.rules.turnTimerEnabled && match.turnDeadline) {
    turnTimerEl.style.display = "inline-block";
    const tick = () => {
      const secondsLeft = Math.max(0, Math.round((new Date(match.turnDeadline).getTime() - Date.now()) / 1000));
      turnTimerEl.textContent = `⏳ ${secondsLeft}s`;
      turnTimerEl.classList.toggle("urgent", secondsLeft <= 10);
    };
    tick();
    state.turnTimerInterval = setInterval(tick, 1000);
  } else {
    turnTimerEl.style.display = "none";
  }

  renderResultsRow(document.getElementById("resultsRow"), match, true);

  const total = match.totalCharacters;
  const availCount = match.availableCharacters.length;
  const pickedCount = match.pickedCharacters.length;
  const bannedCount = match.bannedCharacters.length;
  document.getElementById("charCounts").innerHTML = `
    <span>Total cadastrados: <b>${total}</b></span>
    <span>Disponíveis: <b>${availCount}</b></span>
    <span>Escolhidos: <b>${pickedCount}</b></span>
    <span>Banidos: <b>${bannedCount}</b></span>
  `;

  renderAvailableGrid(match, isMyTurn, actionWord === "banir" ? "ban" : "pick");
  renderOwnedGrid(document.getElementById("pickedGrid"), match.pickedCharacters);
  renderOwnedGrid(document.getElementById("bannedGrid"), match.bannedCharacters);
  document.getElementById("bannedGrid").classList.add("banned-grid");
}

function renderResultsRow(container, match, showLimits) {
  container.innerHTML = "";
  match.results.forEach(r => {
    const card = document.createElement("div");
    card.className = "result-card" + (String(r.playerId) === String(match.currentPlayerId) ? " active-turn" : "");

    const header = document.createElement("div");
    header.className = "result-card-header";
    const limitTxt = showLimits ? ` <span class="hint">(${r.bans.length}/${match.rules.banCount} ban, ${r.picks.length}/${match.rules.pickCount} pick)</span>` : "";
    header.innerHTML = `${avatarHtml({ name: r.playerName, photo: r.playerPhoto }, "sm")}<h4>${escapeHtml(r.playerName)}${limitTxt}</h4>`;
    card.appendChild(header);

    r.bans.forEach(c => {
      const line = document.createElement("div");
      line.className = "result-row";
      line.innerHTML = `<span class="tag-ban">✕ ban</span> ${escapeHtml(c.name)}`;
      card.appendChild(line);
    });
    r.picks.forEach(c => {
      const line = document.createElement("div");
      line.className = "result-row";
      line.innerHTML = `<span class="tag-pick">✓ pick</span> ${escapeHtml(c.name)}`;
      card.appendChild(line);
    });

    container.appendChild(card);
  });
}

function renderAvailableGrid(match, isMyTurn, actionType) {
  const grid = document.getElementById("availableGrid");
  grid.innerHTML = "";
  match.availableCharacters.forEach(c => {
    const card = document.createElement("div");
    card.className = "character-card";
    card.innerHTML = `
      <img src="${c.image || ''}" onerror="this.style.visibility='hidden'" alt="${escapeHtml(c.name)}">
      <div class="name">${escapeHtml(c.name)}</div>
    `;
    if (isMyTurn) {
      card.addEventListener("click", () => confirmAction(match, c, actionType));
    } else {
      card.style.cursor = "default";
    }
    grid.appendChild(card);
  });
}

function renderOwnedGrid(grid, list) {
  grid.innerHTML = "";
  list.forEach(c => {
    const card = document.createElement("div");
    card.className = "character-card";
    card.innerHTML = `
      <img src="${c.image || ''}" onerror="this.style.visibility='hidden'" alt="${escapeHtml(c.name)}">
      <div class="name">${escapeHtml(c.name)}</div>
      <div class="owner-tag">${escapeHtml(c.byPlayerName)}</div>
    `;
    grid.appendChild(card);
  });
}

/* ---- ação otimista (banir/escolher) ---- */
function buildOptimisticMatch(match, character, actionType) {
  const clone = JSON.parse(JSON.stringify(match));
  const me = state.me;

  clone.availableCharacters = clone.availableCharacters.filter(c => String(c.id) !== String(character.id));
  const entry = Object.assign({}, character, { byPlayerId: me.id, byPlayerName: me.name });
  if (actionType === "ban") clone.bannedCharacters.push(entry);
  else clone.pickedCharacters.push(entry);

  const r = clone.results.find(res => String(res.playerId) === String(me.id));
  if (r) {
    if (actionType === "ban") r.bans.push(character);
    else r.picks.push(character);
  }

  const phases = buildPhasesJS(clone.rules.banCount, clone.rules.pickCount);
  const exhausted = clone.availableCharacters.length === 0;
  let turnIndex = clone.turnIndex + 1;

  const goToCountdown = () => {
    clone.status = "countdown";
    clone.countdownStartedAt = new Date().toISOString();
    clone.currentPlayerId = null;
    clone.turnDeadline = null;
  };

  if (exhausted) {
    goToCountdown();
  } else if (turnIndex >= clone.playerIds.length) {
    turnIndex = 0;
    const idx = phases.indexOf(clone.phase);
    if (idx === phases.length - 1) {
      goToCountdown();
    } else {
      clone.phase = phases[idx + 1];
      clone.phaseLabel = phaseLabelForJS(clone.phase);
      clone.turnIndex = turnIndex;
      clone.currentPlayerId = clone.playerIds[turnIndex];
      clone.turnDeadline = clone.rules.turnTimerEnabled
        ? new Date(Date.now() + clone.rules.turnTimerSeconds * 1000).toISOString() : null;
    }
  } else {
    clone.turnIndex = turnIndex;
    clone.currentPlayerId = clone.playerIds[turnIndex];
    clone.turnDeadline = clone.rules.turnTimerEnabled
      ? new Date(Date.now() + clone.rules.turnTimerSeconds * 1000).toISOString() : null;
  }

  return clone;
}

async function confirmAction(match, character, actionType) {
  if (state.actionInFlight) return;
  state.actionInFlight = true;

  const optimistic = buildOptimisticMatch(match, character, actionType);
  state.lastMatch = optimistic;
  renderMatch(optimistic);

  try {
    const updated = await api("makeAction", {
      matchId: match.matchId,
      playerId: state.me.id,
      type: actionType,
      characterId: character.id
    });
    state.lastMatch = updated;
    renderMatch(updated);
  } catch (err) {
    toast(err.message);
    await refreshMatch();
  } finally {
    state.actionInFlight = false;
    if (state.currentTab === "game") scheduleMatchPoll(300);
  }
}

/* ---- contagem regressiva ---- */
function renderCountdownScreen(match) {
  const isHost = String(match.hostPlayerId) === String(state.me.id);
  document.getElementById("skipCountdownBtn").style.display = isHost ? "inline-block" : "none";

  const numberEl = document.getElementById("countdownNumber");
  const tick = () => {
    const elapsed = Date.now() - new Date(match.countdownStartedAt).getTime();
    const remaining = Math.max(0, Math.ceil((10000 - elapsed) / 1000));
    numberEl.textContent = remaining;
  };
  tick();
  state.countdownInterval = setInterval(tick, 200);
}

document.getElementById("skipCountdownBtn").addEventListener("click", async () => {
  try {
    const match = await api("skipCountdown", { matchId: state.matchId, hostPlayerId: state.me.id });
    state.lastMatch = match;
    renderMatch(match);
  } catch (err) {
    toast(err.message);
  }
});

/* ---- partida oficial (placar) ---- */
function renderOfficialScreen(match) {
  const timerEl = document.getElementById("officialTimer");
  if (match.officialStartedAt) {
    timerEl.textContent = "Tempo de partida: " + formatElapsed(match.officialStartedAt);
    state.officialTimerInterval = setInterval(() => {
      timerEl.textContent = "Tempo de partida: " + formatElapsed(match.officialStartedAt);
    }, 1000);
  }

  const suddenBanner = document.getElementById("suddenDeathBanner");
  if (match.suddenDeath) {
    const names = match.eligiblePlayerIds.map(playerName).join(", ");
    suddenBanner.style.display = "block";
    suddenBanner.textContent = `⚔️ Empate em ${WIN_SCORE_JS}+ pontos! Modo decisivo entre: ${names} — quem fizer mais pontos na próxima rodada vence.`;
  } else {
    suddenBanner.style.display = "none";
  }

  renderScoreBoard(document.getElementById("scoreBoard"), match);
  renderRoundForm(match);
  renderRoundHistory(document.getElementById("roundHistory"), match);
}

const WIN_SCORE_JS = 15;

function renderScoreBoard(container, match) {
  container.innerHTML = "";
  const entries = match.playerIds.map(pid => ({ pid, score: match.scores[pid] || 0 }));
  const max = Math.max(0, ...entries.map(e => e.score));

  entries.sort((a, b) => b.score - a.score);
  entries.forEach(e => {
    const player = match.results.find(r => String(r.playerId) === String(e.pid));
    const card = document.createElement("div");
    card.className = "score-card" + (e.score === max && max > 0 ? " leader" : "");
    card.innerHTML = `
      ${avatarHtml({ name: player ? player.playerName : "?", photo: player ? player.playerPhoto : "" }, "md")}
      <div>${escapeHtml(player ? player.playerName : "?")}</div>
      <div class="score-value">${e.score}</div>
    `;
    container.appendChild(card);
  });
}

function renderRoundForm(match) {
  const eligible = match.scoreEligiblePlayerIds;
  const container = document.getElementById("roundInputs");
  container.innerHTML = "";
  eligible.forEach(pid => {
    const player = match.results.find(r => String(r.playerId) === String(pid));
    const item = document.createElement("div");
    item.className = "round-input-item";
    item.innerHTML = `
      <span>${escapeHtml(player ? player.playerName : "?")}</span>
      <input type="number" min="0" step="1" value="0" data-player-id="${pid}">
    `;
    container.appendChild(item);
  });
}

document.getElementById("roundForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const inputs = document.querySelectorAll("#roundInputs input");
  const scores = {};
  inputs.forEach(input => { scores[input.dataset.playerId] = Number(input.value) || 0; });

  try {
    const updated = await api("submitRoundScores", { matchId: state.matchId, scores: JSON.stringify(scores) });
    state.lastMatch = updated;
    renderMatch(updated);
    toast("Rodada registrada!");
  } catch (err) {
    toast(err.message);
  }
});

function renderRoundHistory(container, match) {
  if (match.roundHistory.length === 0) {
    container.innerHTML = `<p class="hint">Nenhuma rodada registrada ainda.</p>`;
    return;
  }

  const headerCells = match.playerIds.map(pid => `<th>${escapeHtml(playerNameIn(match, pid))}</th>`).join("");
  const rows = match.roundHistory.map(round => {
    const cells = match.playerIds.map(pid => {
      const entry = round.entries.find(e => String(e.playerId) === String(pid));
      return `<td>${entry ? entry.points : "—"}</td>`;
    }).join("");
    return `<tr><td>Rodada ${round.roundNumber}</td>${cells}</tr>`;
  }).join("");

  const totalCells = match.playerIds.map(pid => `<td><b>${match.scores[pid] || 0}</b></td>`).join("");

  container.innerHTML = `
    <table>
      <thead><tr><th></th>${headerCells}</tr></thead>
      <tbody>${rows}<tr><td>Total</td>${totalCells}</tr></tbody>
    </table>
  `;
}

function playerNameIn(match, pid) {
  const r = match.results.find(res => String(res.playerId) === String(pid));
  return r ? r.playerName : "?";
}

document.getElementById("finishMatchBtn").addEventListener("click", async () => {
  if (!confirm("Finalizar a partida agora? Isso encerra a partida com o placar atual.")) return;
  try {
    const updated = await api("finishMatchManually", { matchId: state.matchId });
    state.lastMatch = updated;
    renderMatch(updated);
  } catch (err) {
    toast(err.message);
  }
});

/* ---- resultado final ---- */
function renderFinishedScreen(match) {
  const banner = document.getElementById("winnerBanner");
  if (match.winnerPlayerId) {
    banner.textContent = `🏆 ${playerNameIn(match, match.winnerPlayerId)} venceu a partida!`;
  } else {
    banner.textContent = "🤝 Partida encerrada sem um vencedor único (empate).";
  }

  renderScoreBoard(document.getElementById("finalScoreBoard"), match);
  renderRoundHistory(document.getElementById("finalRoundHistory"), match);
  renderResultsRow(document.getElementById("finalResultsRow"), match, true);
}

document.getElementById("backToLobbyBtn").addEventListener("click", () => {
  state.matchId = null;
  localStorage.removeItem("smashup_matchId");
  switchTab("lobby");
});

/* =========================
   PERSONAGENS (ADMIN)
========================= */
const characterForm = document.getElementById("characterForm");
characterForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("characterId").value;
  const name = document.getElementById("characterName").value.trim();
  if (!name) return;

  try {
    let photoData = {};
    const uploaded = await uploadPendingPhoto("character");
    if (uploaded) photoData = { image: uploaded.url, imageFileId: uploaded.fileId };

    if (id) {
      await api("updateCharacter", { id, name, ...photoData });
      toast("Personagem atualizado");
    } else {
      await api("addCharacter", { name, ...photoData });
      toast("Personagem adicionado");
    }
    resetCharacterForm();
    await loadData();
    renderCharacterList();
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById("cancelCharacterEdit").addEventListener("click", resetCharacterForm);

function resetCharacterForm() {
  document.getElementById("characterId").value = "";
  document.getElementById("characterName").value = "";
  document.getElementById("cancelCharacterEdit").style.display = "none";
  resetPhotoPicker("character", "characterPhotoPreview", "characterImageInput");
}

function renderCharacterList() {
  const list = document.getElementById("characterList");
  list.innerHTML = "";
  state.characters.forEach(c => {
    const item = document.createElement("div");
    item.className = "admin-item";
    item.innerHTML = `
      ${avatarHtml({ name: c.name, photo: c.image }, "md")}
      <div class="name">${escapeHtml(c.name)}</div>
      <button data-action="edit">Editar</button>
      <button data-action="delete" class="danger">Excluir</button>
    `;
    item.querySelector('[data-action="edit"]').addEventListener("click", () => {
      document.getElementById("characterId").value = c.id;
      document.getElementById("characterName").value = c.name;
      document.getElementById("cancelCharacterEdit").style.display = "inline-block";
      const preview = document.getElementById("characterPhotoPreview");
      if (c.image) {
        preview.innerHTML = "";
        preview.style.backgroundImage = `url(${c.image})`;
        preview.style.backgroundSize = "cover";
        preview.style.backgroundPosition = "center";
        preview.classList.remove("avatar-placeholder");
      }
    });
    item.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm(`Excluir "${c.name}"?`)) return;
      try {
        await api("deleteCharacter", { id: c.id });
        await loadData();
        renderCharacterList();
        toast("Personagem excluído");
      } catch (err) {
        toast(err.message);
      }
    });
    list.appendChild(item);
  });
}

/* =========================
   JOGADORES (ADMIN)
========================= */
const playerForm = document.getElementById("playerForm");
playerForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("playerId").value;
  const name = document.getElementById("playerName").value.trim();
  if (!name) return;

  try {
    let photoData = {};
    const uploaded = await uploadPendingPhoto("player");
    if (uploaded) photoData = { photo: uploaded.url, photoFileId: uploaded.fileId };

    if (id) {
      await api("updatePlayer", { id, name, ...photoData });
      toast("Jogador atualizado");
      if (state.me && String(state.me.id) === String(id)) {
        state.me.name = name;
        if (photoData.photo) state.me.photo = photoData.photo;
        renderCurrentUserBox();
      }
    } else {
      await api("addPlayer", { name, ...photoData });
      toast("Jogador adicionado");
    }
    resetPlayerForm();
    await loadData();
    renderPlayerList();
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById("cancelPlayerEdit").addEventListener("click", resetPlayerForm);

function resetPlayerForm() {
  document.getElementById("playerId").value = "";
  document.getElementById("playerName").value = "";
  document.getElementById("cancelPlayerEdit").style.display = "none";
  resetPhotoPicker("player", "playerPhotoPreview", "playerPhotoInput");
}

function renderPlayerList() {
  const list = document.getElementById("playerList");
  list.innerHTML = "";
  state.players.forEach(p => {
    const item = document.createElement("div");
    item.className = "admin-item";
    item.innerHTML = `
      ${avatarHtml(p, "md")}
      <div class="name"><span class="status-dot ${p.online ? "online" : "offline"}"></span>${escapeHtml(p.name)}</div>
      <button data-action="edit">Editar</button>
      <button data-action="delete" class="danger">Excluir</button>
    `;
    item.querySelector('[data-action="edit"]').addEventListener("click", () => {
      document.getElementById("playerId").value = p.id;
      document.getElementById("playerName").value = p.name;
      document.getElementById("cancelPlayerEdit").style.display = "inline-block";
      const preview = document.getElementById("playerPhotoPreview");
      if (p.photo) {
        preview.innerHTML = "";
        preview.style.backgroundImage = `url(${p.photo})`;
        preview.style.backgroundSize = "cover";
        preview.style.backgroundPosition = "center";
        preview.classList.remove("avatar-placeholder");
      }
    });
    item.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm(`Excluir "${p.name}"?`)) return;
      try {
        await api("deletePlayer", { id: p.id });
        await loadData();
        renderPlayerList();
        toast("Jogador excluído");
      } catch (err) {
        toast(err.message);
      }
    });
    list.appendChild(item);
  });
}
