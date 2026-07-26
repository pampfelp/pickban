// URL do Web App do Apps Script (deploy > Nova implantação > App da Web)
const API_URL = "https://script.google.com/macros/s/AKfycbzXogaLlQ0F_L7uGOKOJcxFIJx-ssx7Lj0DVCPCynPHD549snVT6DhH9qm7Sl1AjCq7ng/exec";

const HEARTBEAT_INTERVAL_MS = 10000;
const LOBBY_POLL_MS = 4000;
const MATCH_POLL_MS = 3000;

let state = {
  me: null, // { id, name, photo }
  players: [],
  characters: [],
  rooms: [],
  matchId: localStorage.getItem("smashup_matchId") || null,
  pollTimer: null,
  heartbeatTimer: null,
  timerInterval: null,
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
  stopPolling();
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
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${tab}`));

  stopPolling();
  clearMatchTimer();

  if (tab === "lobby") {
    refreshLobby();
    state.pollTimer = setInterval(refreshLobby, LOBBY_POLL_MS);
  } else if (tab === "game") {
    refreshMatch();
    state.pollTimer = setInterval(refreshMatch, MATCH_POLL_MS);
  } else if (tab === "characters") {
    renderCharacterList();
  } else if (tab === "players") {
    renderPlayerList();
  }
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
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
   LOBBY
========================= */
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
    const statusLabel = room.status === "waiting" ? "Aguardando início da partida" : "Partida iniciada";

    const card = document.createElement("div");
    card.className = "room-card";
    card.innerHTML = `
      <div class="room-card-info">
        <span class="room-card-code">${escapeHtml(room.code)}</span>
        <span class="status-badge ${room.status}">${statusLabel}</span>
        <span class="room-card-meta">${room.playerCount}/6 jogadores — ${room.playerNames.map(escapeHtml).join(", ")}</span>
        ${room.status === "in_progress" ? `<span class="room-card-meta">⏱ ${formatElapsed(room.startedAt)}</span>` : ""}
      </div>
    `;

    const btn = document.createElement("button");
    btn.className = isMember ? "secondary-btn" : "primary-btn";
    if (isMember) {
      btn.textContent = "Ver sala";
      btn.addEventListener("click", () => enterRoom(room.matchId));
    } else if (room.status === "waiting" && room.playerCount < 6) {
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

document.getElementById("createRoomBtn").addEventListener("click", async () => {
  try {
    const room = await api("createRoom", { hostPlayerId: state.me.id });
    enterRoom(room.matchId);
  } catch (err) {
    document.getElementById("lobbyError").textContent = err.message;
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
   SALA (ESPERA + TABULEIRO)
========================= */
function clearMatchTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  state.timerInterval = null;
}

async function refreshMatch() {
  if (!state.matchId) {
    showNoMatch();
    return;
  }
  try {
    const match = await api("getMatchState", { matchId: state.matchId });
    renderMatch(match);
  } catch (err) {
    toast("Erro ao atualizar sala: " + err.message);
    showNoMatch();
  }
}

function showNoMatch() {
  document.getElementById("noMatch").style.display = "block";
  document.getElementById("waitingRoom").style.display = "none";
  document.getElementById("matchBoard").style.display = "none";
}

function renderMatch(match) {
  document.getElementById("noMatch").style.display = "none";

  if (match.status === "waiting") {
    document.getElementById("waitingRoom").style.display = "block";
    document.getElementById("matchBoard").style.display = "none";
    renderWaitingRoom(match);
  } else {
    document.getElementById("waitingRoom").style.display = "none";
    document.getElementById("matchBoard").style.display = "block";
    renderBoard(match);
  }
}

function renderWaitingRoom(match) {
  document.getElementById("roomCodeDisplay").textContent = match.code;

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

  if (isHost) {
    startBtn.style.display = "inline-block";
    startBtn.disabled = match.playerIds.length < 2;
    hint.textContent = match.playerIds.length < 2 ? "Espere pelo menos mais 1 jogador entrar." : "";
  } else {
    startBtn.style.display = "none";
    hint.textContent = "Aguardando o host iniciar a partida...";
  }
}

document.getElementById("startRoomBtn").addEventListener("click", async () => {
  try {
    const match = await api("startRoom", { matchId: state.matchId, hostPlayerId: state.me.id });
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

function renderBoard(match) {
  document.getElementById("phaseLabel").textContent = match.phaseLabel;

  const currentPlayer = match.results.find(r => String(r.playerId) === String(match.currentPlayerId));
  const turnLabel = document.getElementById("turnLabel");
  const finishedBanner = document.getElementById("finishedBanner");
  const grid = document.getElementById("characterGrid");
  const heading = document.getElementById("charactersHeading");

  clearMatchTimer();
  const timerEl = document.getElementById("matchTimer");
  if (match.startedAt) {
    timerEl.textContent = "⏱ " + formatElapsed(match.startedAt);
    state.timerInterval = setInterval(() => {
      timerEl.textContent = "⏱ " + formatElapsed(match.startedAt);
    }, 1000);
  }

  if (match.status === "finished") {
    turnLabel.textContent = "";
    finishedBanner.style.display = "block";
    finishedBanner.textContent = `🏆 Partida finalizada! Tempo total: ${formatElapsed(match.startedAt)}`;
    heading.style.display = "none";
    grid.style.display = "none";
  } else {
    finishedBanner.style.display = "none";
    heading.style.display = "block";
    grid.style.display = "grid";
    const actionWord = (match.phase === "ban1" || match.phase === "ban2") ? "banir" : "escolher";
    turnLabel.textContent = currentPlayer ? `Vez de ${currentPlayer.playerName} ${actionWord}` : "";
  }

  renderResultsRow(match);
  renderCharacterGrid(match);
}

function renderResultsRow(match) {
  const row = document.getElementById("resultsRow");
  row.innerHTML = "";
  match.results.forEach(r => {
    const card = document.createElement("div");
    card.className = "result-card" + (String(r.playerId) === String(match.currentPlayerId) ? " active-turn" : "");

    const header = document.createElement("div");
    header.className = "result-card-header";
    header.innerHTML = `${avatarHtml({ name: r.playerName, photo: r.playerPhoto }, "sm")}<h4>${escapeHtml(r.playerName)}</h4>`;
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

    row.appendChild(card);
  });
}

function renderCharacterGrid(match) {
  const grid = document.getElementById("characterGrid");
  grid.innerHTML = "";
  if (match.status === "finished") return;

  const actionType = (match.phase === "ban1" || match.phase === "ban2") ? "ban" : "pick";

  match.availableCharacters.forEach(c => {
    const card = document.createElement("div");
    card.className = "character-card";
    card.innerHTML = `
      <img src="${c.image || ''}" onerror="this.style.visibility='hidden'" alt="${escapeHtml(c.name)}">
      <div class="name">${escapeHtml(c.name)}</div>
    `;
    card.addEventListener("click", () => confirmAction(match, c, actionType));
    grid.appendChild(card);
  });
}

async function confirmAction(match, character, actionType) {
  const playerName = match.results.find(r => String(r.playerId) === String(match.currentPlayerId))?.playerName || "";
  const verb = actionType === "ban" ? "banir" : "escolher";
  const ok = confirm(`${playerName} vai ${verb} "${character.name}"?`);
  if (!ok) return;

  try {
    const updated = await api("makeAction", {
      matchId: match.matchId,
      playerId: match.currentPlayerId,
      type: actionType,
      characterId: character.id
    });
    renderMatch(updated);
  } catch (err) {
    toast(err.message);
  }
}

document.getElementById("newMatchBtn").addEventListener("click", () => {
  state.matchId = null;
  localStorage.removeItem("smashup_matchId");
  clearMatchTimer();
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
