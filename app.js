// ===== Firebase =====
import { db } from "./firebase-init.js";
import {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc, setDoc,
  onSnapshot, query, where, runTransaction, writeBatch
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

// Fotos NÃO passam pelo Firebase Storage (exige plano pago) — vão pro Google
// Drive via este Apps Script (Code.gs), do mesmo jeito que era antes da
// migração pro Firestore.
const PHOTO_UPLOAD_URL = "https://script.google.com/macros/s/AKfycbzXogaLlQ0F_L7uGOKOJcxFIJx-ssx7Lj0DVCPCynPHD549snVT6DhH9qm7Sl1AjCq7ng/exec";

/* =========================
   CONSTANTES
========================= */
const ONLINE_THRESHOLD_MS = 25 * 1000;
const WIN_SCORE = 15;
const HEARTBEAT_INTERVAL_MS = 10000;

const STATUS_LABELS = {
  waiting: "Aguardando início da partida",
  drafting: "Draft em andamento",
  countdown: "Preparando partida oficial",
  official: "Partida oficial em andamento",
  finished: "Partida finalizada"
};

let state = {
  me: null, // { id, name, photo }
  players: [],
  characters: [],
  sessions: [],
  rooms: [],
  roomsRaw: [],
  matchId: localStorage.getItem("smashup_matchId") || null,
  currentTab: "lobby",
  lastMatch: null,
  roundFormKey: null,
  actionInFlight: false,
  heartbeatTimer: null,
  draftTimerInterval: null,
  turnTimerInterval: null,
  officialTimerInterval: null,
  onlineTickInterval: null,
  roomWatchdogInterval: null,
  roomUnsub: {}, // { room, actions, rounds }
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

/* =========================
   ÍCONES (SVG inline, mesmo estilo do ícone de lixeira que já existia)
========================= */
const ICON_PATHS = {
  plus: '<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>',
  arrowRight: '<line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"></path><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path>',
  trash: '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>'
};

function icon(name, size) {
  size = size || 16;
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ""}</svg>`;
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

function characterThumbHtml(character) {
  if (character && character.image) {
    return `<img class="char-thumb" src="${character.image}" alt="${escapeHtml(character.name)}">`;
  }
  return `<span class="char-thumb char-thumb-placeholder">${escapeHtml(getInitials(character && character.name))}</span>`;
}

function toast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2200);
}

// Chama atenção de quem está distraído/em outra aba quando chega a vez dele
// de banir/escolher — pisca o título da aba até a pessoa voltar o foco pra
// cá. Ajuda a evitar que o timer de turno vença sem a pessoa nem perceber.
const ORIGINAL_PAGE_TITLE = document.title;
let titleFlashInterval = null;
function flashPageTitleForMyTurn() {
  if (document.hasFocus()) return;
  clearInterval(titleFlashInterval);
  let on = false;
  titleFlashInterval = setInterval(() => {
    document.title = on ? ORIGINAL_PAGE_TITLE : "🔔 Sua vez!";
    on = !on;
  }, 1000);
  window.addEventListener("focus", stopFlashingPageTitle);
}
function stopFlashingPageTitle() {
  clearInterval(titleFlashInterval);
  titleFlashInterval = null;
  document.title = ORIGINAL_PAGE_TITLE;
  window.removeEventListener("focus", stopFlashingPageTitle);
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
   LÓGICA DE JOGO (pura, roda no cliente)
========================= */
function buildPhases(banCount, pickCount) {
  const phases = [];
  let b = 0, p = 0;
  while (b < banCount || p < pickCount) {
    if (b < banCount) { phases.push("ban" + (b + 1)); b++; }
    if (p < pickCount) { phases.push("pick" + (p + 1)); p++; }
  }
  return phases;
}

function phaseLabelFor(phase) {
  if (!phase) return "";
  const m = String(phase).match(/^(ban|pick)(\d+)$/);
  if (!m) return phase;
  const type = m[1] === "ban" ? "Banimento" : "Escolha";
  return `${m[2]}ª Rodada de ${type}`;
}

function randomRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O e 1/I
  let code = "";
  for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

async function generateUniqueRoomCode() {
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomRoomCode();
    const snap = await getDocs(query(collection(db, "rooms"), where("code", "==", code)));
    if (snap.empty) return code;
  }
  throw new Error("Não foi possível gerar um código de sala único. Tente de novo.");
}

// Calcula {turnIndex, phase, turnDeadline} do próximo turno, ou a transição pra
// contagem regressiva se o draft acabou. Espelha o Code.gs (advanceTurn/transitionToCountdown).
function advanceTurnPatch(room) {
  const phases = buildPhases(room.banCount, room.pickCount);
  let turnIndex = room.turnIndex + 1;
  let phase = room.phase;

  if (turnIndex >= room.playerIds.length) {
    turnIndex = 0;
    const idx = phases.indexOf(phase);
    if (idx === phases.length - 1) return countdownPatch();
    phase = phases[idx + 1];
  }

  return {
    turnIndex,
    phase,
    turnDeadline: room.turnTimerEnabled ? Date.now() + room.turnTimerSeconds * 1000 : null
  };
}

function countdownPatch() {
  return { status: "countdown", turnDeadline: null, countdownStartedAt: Date.now() };
}

// Espelha evaluateMatchResult do Code.gs, mas usando o mapa de placar já
// denormalizado no doc da sala (scores), já que transações não podem consultar
// a subcoleção "rounds".
function evaluateRoundResult(room, scoresMap, roundEntries) {
  if (!room.suddenDeath) {
    let max = -1, leaders = [];
    room.playerIds.forEach(pid => {
      const t = scoresMap[pid] || 0;
      if (t > max) { max = t; leaders = [pid]; }
      else if (t === max) leaders.push(pid);
    });
    if (max >= WIN_SCORE) {
      if (leaders.length === 1) return { status: "finished", winnerPlayerId: leaders[0] };
      return { suddenDeath: true, eligiblePlayerIds: leaders };
    }
    return {};
  }

  let max = -1, leaders = [];
  roundEntries.forEach(e => {
    if (e.points > max) { max = e.points; leaders = [e.playerId]; }
    else if (e.points === max) leaders.push(e.playerId);
  });
  if (leaders.length === 1) return { status: "finished", winnerPlayerId: leaders[0] };
  if (leaders.length > 0) return { eligiblePlayerIds: leaders };
  return {};
}

/* =========================
   FOTO: redimensionar + upload (Google Drive via Apps Script)
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
  const res = await fetch(PHOTO_UPLOAD_URL, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita preflight CORS (Apps Script não trata OPTIONS)
    body: JSON.stringify({
      action: "uploadPhoto",
      base64: pending.base64,
      mimeType: pending.mimeType,
      filename: pending.filename
    })
  });
  const data = await res.json();
  if (data && data.error) throw new Error(data.error);
  return { url: data.url, fileId: data.fileId };
}

setupPhotoPicker("login", "loginPhotoPreview", "loginPhotoInput");
setupPhotoPicker("character", "characterPhotoPreview", "characterImageInput");
setupPhotoPicker("player", "playerPhotoPreview", "playerPhotoInput");

/* =========================
   FIRESTORE: players / characters / sessions / salas (dados gerais)
========================= */
function getOnlinePlayerIds() {
  const now = Date.now();
  return state.sessions
    .filter(s => now - Number(s.lastSeen) < ONLINE_THRESHOLD_MS)
    .map(s => String(s.id));
}

function buildRoomSummary(room) {
  const playerNames = room.playerIds.map(pid => {
    const p = state.players.find(pl => String(pl.id) === String(pid));
    return p ? p.name : "?";
  });
  return {
    matchId: room.id,
    code: room.code,
    status: room.status,
    statusLabel: STATUS_LABELS[room.status] || room.status,
    hostPlayerId: room.hostPlayerId,
    playerIds: room.playerIds,
    playerCount: room.playerIds.length,
    maxPlayers: room.maxPlayers,
    playerNames,
    draftStartedAt: room.draftStartedAt,
    officialStartedAt: room.officialStartedAt,
    createdAt: room.createdAt
  };
}

function recomputeRoomSummaries() {
  state.rooms = state.roomsRaw.filter(r => r.status !== "finished").map(buildRoomSummary);
  if (state.currentTab === "lobby") renderRoomList();
}

function enrichCharacter(characterId) {
  const c = state.characters.find(ch => String(ch.id) === String(characterId));
  return c || { id: characterId, name: "Desconhecido", image: "" };
}

// Monta o mesmo "formato de estado de partida" que o backend antigo (Code.gs)
// devolvia — assim as funções de render (renderDraftBoard, renderOfficialScreen...)
// não precisam mudar nada.
function assembleMatchState(room, actions, rounds) {
  const banPickActions = actions.filter(a => a.type === "ban" || a.type === "pick");
  const bannedMap = {}, pickedMap = {};
  banPickActions.forEach(a => {
    const player = state.players.find(p => String(p.id) === String(a.playerId));
    const entry = Object.assign({}, enrichCharacter(a.characterId), {
      byPlayerId: a.playerId,
      byPlayerName: player ? player.name : "?"
    });
    if (a.type === "ban") bannedMap[String(a.characterId)] = entry;
    else pickedMap[String(a.characterId)] = entry;
  });

  const usedIds = banPickActions.map(a => String(a.characterId));
  const availableCharacters = state.characters.filter(c => !usedIds.includes(String(c.id)));
  const bannedCharacters = Object.values(bannedMap);
  const pickedCharacters = Object.values(pickedMap);

  const onlineIds = getOnlinePlayerIds();
  const currentPlayerId = room.status === "drafting" ? room.playerIds[room.turnIndex] : null;

  // Rodadas anteriores à fase atual já terminaram de verdade pra todo mundo
  // (o turno só avança de fase depois que todos os jogadores agiram nela de
  // alguma forma). Isso serve pra distinguir, no resultado de cada jogador,
  // um banimento/escolha normal de um turno perdido por tempo esgotado — e
  // detectar o caso que NÃO deveria acontecer: a rodada terminou e esse
  // jogador não tem nem ação nem timeout registrado nela (marcado como erro,
  // pra ficar visível em vez de silenciosamente sumir do resultado).
  const phases = buildPhases(room.banCount, room.pickCount);
  const currentPhaseIdx = phases.indexOf(room.phase);
  const completedPhases = currentPhaseIdx === -1 ? phases : phases.slice(0, currentPhaseIdx);

  const results = room.playerIds.map(pid => {
    const player = state.players.find(p => String(p.id) === String(pid));
    const mine = actions.filter(a => String(a.playerId) === String(pid) &&
      (a.type === "ban" || a.type === "pick" || a.type === "timeout"));

    function buildSlots(type) {
      const relevantPhases = phases.filter(ph => ph.indexOf(type) === 0);
      const slots = [];
      relevantPhases.forEach(ph => {
        const action = mine.find(a => a.round === ph);
        if (action && action.type === type) {
          slots.push({ kind: "character", character: enrichCharacter(action.characterId) });
        } else if (action && action.type === "timeout") {
          slots.push({ kind: "timeout" });
        } else if (completedPhases.includes(ph)) {
          slots.push({ kind: "error" });
        }
        // fase futura (ainda não chegou a vez de ninguém nela) — não mostra nada
      });
      return slots;
    }

    return {
      playerId: pid,
      playerName: player ? player.name : "Desconhecido",
      playerPhoto: player ? player.photo : "",
      online: onlineIds.indexOf(String(pid)) !== -1,
      bans: buildSlots("ban"),
      picks: buildSlots("pick")
    };
  });

  const roundsByNumber = {};
  rounds.forEach(r => {
    if (!roundsByNumber[r.roundNumber]) roundsByNumber[r.roundNumber] = [];
    const player = state.players.find(p => String(p.id) === String(r.playerId));
    roundsByNumber[r.roundNumber].push({
      playerId: r.playerId,
      playerName: player ? player.name : "?",
      points: Number(r.points)
    });
  });
  const roundHistory = Object.keys(roundsByNumber)
    .sort((a, b) => Number(a) - Number(b))
    .map(n => ({ roundNumber: Number(n), entries: roundsByNumber[n] }));

  const scoreEligiblePlayerIds = room.suddenDeath ? (room.eligiblePlayerIds || []) : room.playerIds;

  return {
    matchId: room.id,
    code: room.code,
    status: room.status,
    statusLabel: STATUS_LABELS[room.status] || room.status,
    phase: room.phase,
    phaseLabel: phaseLabelFor(room.phase),
    phases: buildPhases(room.banCount, room.pickCount),
    turnIndex: room.turnIndex,
    playerIds: room.playerIds,
    hostPlayerId: room.hostPlayerId,
    rules: {
      banCount: room.banCount,
      pickCount: room.pickCount,
      maxPlayers: room.maxPlayers,
      turnTimerEnabled: room.turnTimerEnabled,
      turnTimerSeconds: room.turnTimerSeconds
    },
    draftStartedAt: room.draftStartedAt,
    officialStartedAt: room.officialStartedAt,
    countdownStartedAt: room.countdownStartedAt,
    currentPlayerId,
    turnDeadline: room.turnDeadline,
    totalCharacters: state.characters.length,
    availableCharacters,
    pickedCharacters,
    bannedCharacters,
    results,
    scores: room.scores || {},
    roundHistory,
    suddenDeath: !!room.suddenDeath,
    eligiblePlayerIds: room.eligiblePlayerIds || [],
    scoreEligiblePlayerIds,
    winnerPlayerId: room.winnerPlayerId || null
  };
}

/* =========================
   LISTENERS GLOBAIS (players, characters, sessions, salas)
========================= */
function startGlobalListeners() {
  onSnapshot(collection(db, "players"), snap => {
    state.players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    onPlayersOrSessionsChanged();
  }, err => toast("Erro ao sincronizar jogadores: " + err.message));

  onSnapshot(collection(db, "characters"), snap => {
    state.characters = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (state.currentTab === "characters") renderCharacterList();
  }, err => toast("Erro ao sincronizar personagens: " + err.message));

  onSnapshot(collection(db, "sessions"), snap => {
    state.sessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    onPlayersOrSessionsChanged();
  }, err => {});

  onSnapshot(collection(db, "rooms"), snap => {
    state.roomsRaw = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    recomputeRoomSummaries();
  }, err => toast("Erro ao sincronizar salas: " + err.message));

  state.onlineTickInterval = setInterval(() => {
    if (state.currentTab === "lobby") renderOnlinePlayerList();
  }, 5000);
}

function onPlayersOrSessionsChanged() {
  recomputeRoomSummaries();
  if (document.getElementById("loginScreen").style.display !== "none") {
    renderLoginScreen();
  }
  if (state.me) {
    if (state.currentTab === "lobby") renderOnlinePlayerList();
    if (state.currentTab === "players") renderPlayerList();
    renderCurrentUserBox();
  }
}

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

    const docRef = await addDoc(collection(db, "players"), {
      name, photo, photoFileId, createdAt: Date.now()
    });
    resetPhotoPicker("login", "loginPhotoPreview", "loginPhotoInput");
    document.getElementById("loginName").value = "";
    await loginAs({ id: docRef.id, name, photo });
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
  detachRoomListeners();
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
    await setDoc(doc(db, "sessions", state.me.id), { lastSeen: Date.now() });
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
   MENU LATERAL (hamburguer, desktop/tablet)
========================= */
const sideNav = document.getElementById("sideNav");
const sideNavBackdrop = document.getElementById("sideNavBackdrop");

function openSideNav() {
  sideNav.classList.add("open");
  sideNavBackdrop.classList.add("open");
}

function closeSideNav() {
  sideNav.classList.remove("open");
  sideNavBackdrop.classList.remove("open");
}

document.getElementById("hamburgerBtn").addEventListener("click", () => {
  sideNav.classList.contains("open") ? closeSideNav() : openSideNav();
});
sideNavBackdrop.addEventListener("click", closeSideNav);

/* =========================
   TABS
========================= */
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    switchTab(btn.dataset.tab);
    closeSideNav();
  });
});

function switchTab(tab) {
  state.currentTab = tab;

  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === `tab-${tab}`));

  if (tab !== "game") {
    detachRoomListeners();
    clearAllTimers();
  }

  if (tab === "lobby") {
    renderRoomList();
    renderOnlinePlayerList();
  } else if (tab === "game") {
    enterMatchView();
  } else if (tab === "characters") {
    renderCharacterList();
  } else if (tab === "players") {
    renderPlayerList();
  } else if (tab === "history") {
    renderHistoryTab();
  }
}

/* =========================
   BOOTSTRAP
========================= */
async function init() {
  try {
    const [playersSnap] = await Promise.all([getDocs(collection(db, "players"))]);
    state.players = playersSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    toast("Erro ao carregar dados: " + err.message);
  }

  startGlobalListeners();

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
function renderRoomList() {
  const list = document.getElementById("roomList");
  list.innerHTML = "";

  if (state.rooms.length === 0) {
    list.innerHTML = `
      <div class="empty-state-box">
        ${icon("inbox", 26)}
        <p>Nenhuma sala aberta no momento.<br>Crie uma pra começar!</p>
      </div>
    `;
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

    const actions = document.createElement("div");
    actions.className = "room-card-actions";

    const btn = document.createElement("button");
    btn.className = isMember ? "secondary-btn" : "primary-btn";
    if (isMember) {
      btn.innerHTML = `${icon("eye")}<span>Ver sala</span>`;
      btn.addEventListener("click", () => enterRoom(room.matchId));
    } else if (room.status === "waiting" && room.playerCount < room.maxPlayers) {
      btn.innerHTML = `${icon("arrowRight")}<span>Entrar</span>`;
      btn.addEventListener("click", () => joinRoomByCode(room.code));
    } else {
      btn.innerHTML = `${icon("lock")}<span>Indisponível</span>`;
      btn.disabled = true;
    }
    actions.appendChild(btn);
    actions.appendChild(buildDeleteRoomButton(room));

    card.appendChild(actions);
    list.appendChild(card);
  });
}

function buildDeleteRoomButton(room) {
  const trashBtn = document.createElement("button");
  trashBtn.className = "trash-btn";
  trashBtn.title = "Excluir sala";
  trashBtn.innerHTML = icon("trash", 18);
  trashBtn.addEventListener("click", async () => {
    if (!confirm(`Excluir a sala ${room.code}? Isso apaga a sala e todo o progresso dela, sem volta.`)) return;
    try {
      await deleteMatch(room.matchId);
      if (String(state.matchId) === String(room.matchId)) {
        state.matchId = null;
        localStorage.removeItem("smashup_matchId");
      }
      toast("Sala excluída");
    } catch (err) {
      toast(err.message);
    }
  });
  return trashBtn;
}

// Um writeBatch do Firestore aceita no máximo 500 operações — uma partida
// bem longa (muitas ações de draft + muitas rodadas registradas) podia
// estourar esse limite e a exclusão simplesmente falhar. Quebra em vários
// batches de 400 (com folga) em vez de um só.
const BATCH_CHUNK_SIZE = 400;

async function deleteMatch(matchId) {
  const actionsSnap = await getDocs(collection(db, "rooms", matchId, "actions"));
  const roundsSnap = await getDocs(collection(db, "rooms", matchId, "rounds"));
  const allRefs = [
    ...actionsSnap.docs.map(d => d.ref),
    ...roundsSnap.docs.map(d => d.ref),
    doc(db, "rooms", matchId)
  ];

  for (let i = 0; i < allRefs.length; i += BATCH_CHUNK_SIZE) {
    const batch = writeBatch(db);
    allRefs.slice(i, i + BATCH_CHUNK_SIZE).forEach(ref => batch.delete(ref));
    await batch.commit();
  }
}

function renderOnlinePlayerList() {
  const list = document.getElementById("onlinePlayerList");
  list.innerHTML = "";
  const onlineIds = getOnlinePlayerIds();
  state.players.forEach(p => {
    const item = document.createElement("div");
    item.className = "online-player-item";
    item.innerHTML = `
      ${avatarHtml(p, "md")}
      <span><span class="status-dot ${onlineIds.indexOf(String(p.id)) !== -1 ? "online" : "offline"}"></span>${escapeHtml(p.name)}</span>
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
    const maxPlayers = Math.min(6, Math.max(2, Number(document.getElementById("ruleMaxPlayers").value) || 4));
    const banCount = Math.min(10, Math.max(1, Number(document.getElementById("ruleBanCount").value) || 2));
    const pickCount = Math.min(10, Math.max(1, Number(document.getElementById("rulePickCount").value) || 2));
    const turnTimerEnabled = document.getElementById("ruleTurnTimer").checked;

    const code = await generateUniqueRoomCode();
    const roomRef = await addDoc(collection(db, "rooms"), {
      code, status: "waiting", phase: "", turnIndex: 0,
      playerIds: [state.me.id], hostPlayerId: state.me.id,
      createdAt: Date.now(), draftStartedAt: null, officialStartedAt: null,
      banCount, pickCount, maxPlayers,
      turnTimerEnabled, turnTimerSeconds: 120,
      turnDeadline: null, countdownStartedAt: null,
      winnerPlayerId: null, suddenDeath: false, eligiblePlayerIds: [],
      bannedCharacterIds: [], pickedCharacterIds: [],
      scores: {}
    });

    document.getElementById("createRoomForm").style.display = "none";
    enterRoom(roomRef.id);
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
    const snap = await getDocs(query(collection(db, "rooms"), where("code", "==", code.toUpperCase())));
    if (snap.empty) throw new Error("Sala não encontrada");
    const roomRef = snap.docs[0].ref;

    await runTransaction(db, async (tx) => {
      const roomSnap = await tx.get(roomRef);
      if (!roomSnap.exists()) throw new Error("Sala não encontrada");
      const room = roomSnap.data();
      if (room.status !== "waiting") throw new Error("Essa sala já começou ou terminou");
      if (room.playerIds.includes(state.me.id)) return;
      if (room.playerIds.length >= room.maxPlayers) throw new Error("Sala cheia");
      tx.update(roomRef, { playerIds: [...room.playerIds, state.me.id] });
    });

    document.getElementById("joinCodeInput").value = "";
    enterRoom(roomRef.id);
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function enterRoom(matchId) {
  state.matchId = String(matchId);
  state.roundFormKey = null;
  localStorage.setItem("smashup_matchId", state.matchId);
  switchTab("game");
}

/* =========================
   SALA — listeners em tempo real (substituem o polling)
========================= */
function detachRoomListeners() {
  Object.values(state.roomUnsub).forEach(unsub => unsub && unsub());
  state.roomUnsub = {};
}

function clearAllTimers() {
  [state.draftTimerInterval, state.turnTimerInterval,
   state.officialTimerInterval, state.roomWatchdogInterval]
    .forEach(t => t && clearInterval(t));
  state.draftTimerInterval = null;
  state.turnTimerInterval = null;
  state.officialTimerInterval = null;
  state.roomWatchdogInterval = null;
  stopFlashingPageTitle();
}

function enterMatchView() {
  if (!state.matchId) { showNoMatch(); return; }

  detachRoomListeners();
  let roomData = null, actionsData = [], roundsData = [];

  const recompute = () => {
    if (!roomData) return;
    const match = assembleMatchState({ id: state.matchId, ...roomData }, actionsData, roundsData);

    const wasMyTurn = state.lastMatch && state.lastMatch.status === "drafting" &&
      String(state.lastMatch.currentPlayerId) === String(state.me.id);
    const isMyTurnNow = match.status === "drafting" && String(match.currentPlayerId) === String(state.me.id);
    if (isMyTurnNow && !wasMyTurn) {
      const acao = match.phase && match.phase.indexOf("ban") === 0 ? "banir" : "escolher";
      toast(`🔔 Sua vez de ${acao}!`);
      flashPageTitleForMyTurn();
    }

    state.lastMatch = match;
    renderMatch(match);
  };

  state.roomUnsub.room = onSnapshot(doc(db, "rooms", state.matchId), snap => {
    if (!snap.exists()) {
      state.matchId = null;
      localStorage.removeItem("smashup_matchId");
      showNoMatch();
      return;
    }
    roomData = snap.data();
    recompute();
  }, err => toast("Erro na sala: " + err.message));

  state.roomUnsub.actions = onSnapshot(collection(db, "rooms", state.matchId, "actions"), snap => {
    actionsData = snap.docs.map(d => d.data());
    recompute();
  }, err => {});

  state.roomUnsub.rounds = onSnapshot(collection(db, "rooms", state.matchId, "rounds"), snap => {
    roundsData = snap.docs.map(d => d.data());
    recompute();
  }, err => {});

  // Watchdog local: qualquer cliente com a sala aberta pode "destravar" um turno
  // vencido — substitui a checagem sob-demanda que o Code.gs fazia a cada chamada.
  // A partida oficial NÃO inicia mais sozinha depois do draft — precisa do host
  // clicar em "Iniciar Partida Oficial" (renderCountdownScreen/startOfficialBtn).
  state.roomWatchdogInterval = setInterval(() => {
    const match = state.lastMatch;
    if (!match || match.matchId !== state.matchId) return;
    if (match.status === "drafting" && match.rules.turnTimerEnabled && match.turnDeadline) {
      if (Date.now() > new Date(match.turnDeadline).getTime()) {
        processTimeoutTx(state.matchId).catch(() => {});
      }
    }
  }, 1000);
}

function showNoMatch() {
  ["noMatch", "waitingRoom", "draftBoard", "countdownScreen", "officialScreen", "finishedScreen"]
    .forEach(id => document.getElementById(id).style.display = "none");
  document.getElementById("noMatch").style.display = "block";
}

function renderMatch(match) {
  // Limpa só os timers de UI (cronômetros/contagem); o watchdog da sala
  // (state.roomWatchdogInterval) precisa continuar rodando entre re-renders.
  [state.draftTimerInterval, state.turnTimerInterval, state.officialTimerInterval]
    .forEach(t => t && clearInterval(t));
  state.draftTimerInterval = null;
  state.turnTimerInterval = null;
  state.officialTimerInterval = null;

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
    const roomRef = doc(db, "rooms", state.matchId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) throw new Error("Sala não encontrada");
      const room = snap.data();
      if (room.status !== "waiting") throw new Error("Sala já foi iniciada");
      if (room.hostPlayerId !== state.me.id) throw new Error("Só o host pode iniciar a partida");
      if (room.playerIds.length !== room.maxPlayers) {
        throw new Error(`A sala precisa ter exatamente ${room.maxPlayers} jogadores para iniciar (atual: ${room.playerIds.length})`);
      }
      const phases = buildPhases(room.banCount, room.pickCount);
      tx.update(roomRef, {
        status: "drafting",
        phase: phases[0],
        turnIndex: 0,
        draftStartedAt: Date.now(),
        turnDeadline: room.turnTimerEnabled ? Date.now() + room.turnTimerSeconds * 1000 : null
      });
    });
  } catch (err) {
    toast(err.message);
  }
});

document.getElementById("leaveRoomBtn").addEventListener("click", async () => {
  try {
    const roomRef = doc(db, "rooms", state.matchId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) return;
      const room = snap.data();
      if (room.status !== "waiting") throw new Error("Não é possível sair de uma partida já iniciada");

      const playerIds = room.playerIds.filter(id => id !== state.me.id);
      if (playerIds.length === 0) {
        tx.delete(roomRef);
        return;
      }
      const updates = { playerIds };
      if (room.hostPlayerId === state.me.id) updates.hostPlayerId = playerIds[0];
      tx.update(roomRef, updates);
    });
  } catch (err) {
    toast(err.message);
  }
  state.matchId = null;
  localStorage.removeItem("smashup_matchId");
  switchTab("lobby");
});

// Excluir a sala de dentro dela mesma (sem precisar voltar pro Lobby pra
// achar o ícone de lixeira) — qualquer jogador da sala pode fazer isso,
// mesmo padrão de permissão do Lobby (sem restrição a host, já que o
// sistema não tem login de verdade pra diferenciar identidade).
document.getElementById("deleteRoomFromInsideBtn").addEventListener("click", async () => {
  if (!confirm("Excluir esta sala? Isso apaga a sala e todo o progresso dela, sem volta.")) return;
  try {
    await deleteMatch(state.matchId);
  } catch (err) {
    toast("Não foi possível excluir: " + err.message);
    return;
  }
  state.matchId = null;
  localStorage.removeItem("smashup_matchId");
  toast("Sala excluída");
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

// Cada item de r.bans/r.picks é um "slot": { kind: "character", character }
// pra um banimento/escolha normal, { kind: "timeout" } pra um turno perdido
// por tempo esgotado, ou { kind: "error" } pro caso (que não deveria
// acontecer) da rodada ter terminado sem ação nem timeout desse jogador —
// mostrar isso explicitamente em vez de simplesmente omitir é o que deixa
// claro pro próprio jogador o que aconteceu naquela rodada.
function renderResultSlotLine(tagClass, tagLabel, slot) {
  const line = document.createElement("div");
  line.className = "result-row";
  if (slot.kind === "character") {
    line.innerHTML = `<span class="${tagClass}">${tagLabel}</span> ${characterThumbHtml(slot.character)} ${escapeHtml(slot.character.name)}`;
  } else if (slot.kind === "timeout") {
    line.className += " result-row-timeout";
    line.innerHTML = `<span class="${tagClass}">${tagLabel}</span> <span class="slot-note">(tempo esgotado)</span>`;
  } else {
    line.className += " result-row-error";
    line.innerHTML = `<span class="${tagClass}">${tagLabel}</span> <span class="slot-note">(Erro)</span>`;
  }
  return line;
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

    r.bans.forEach(slot => card.appendChild(renderResultSlotLine("tag-ban", "✕ ban", slot)));
    r.picks.forEach(slot => card.appendChild(renderResultSlotLine("tag-pick", "✓ pick", slot)));

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
    const slot = { kind: "character", character };
    if (actionType === "ban") r.bans.push(slot);
    else r.picks.push(slot);
  }

  const phases = buildPhases(clone.rules.banCount, clone.rules.pickCount);
  const exhausted = clone.availableCharacters.length === 0;
  let turnIndex = clone.turnIndex + 1;

  const goToCountdown = () => {
    clone.status = "countdown";
    clone.countdownStartedAt = Date.now();
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
      clone.phaseLabel = phaseLabelFor(clone.phase);
      clone.turnIndex = turnIndex;
      clone.currentPlayerId = clone.playerIds[turnIndex];
      clone.turnDeadline = clone.rules.turnTimerEnabled
        ? Date.now() + clone.rules.turnTimerSeconds * 1000 : null;
    }
  } else {
    clone.turnIndex = turnIndex;
    clone.currentPlayerId = clone.playerIds[turnIndex];
    clone.turnDeadline = clone.rules.turnTimerEnabled
      ? Date.now() + clone.rules.turnTimerSeconds * 1000 : null;
  }

  return clone;
}

async function makeActionTx(matchId, playerId, type, characterId) {
  const roomRef = doc(db, "rooms", matchId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Partida não encontrada");
    const room = snap.data();

    if (room.status !== "drafting") throw new Error("O draft não está em andamento");

    const expectedType = room.phase.indexOf("ban") === 0 ? "ban" : "pick";
    if (type !== expectedType) throw new Error(`Ação inválida. Fase atual espera "${expectedType}"`);

    const currentPlayerId = room.playerIds[room.turnIndex];
    if (String(playerId) !== String(currentPlayerId)) throw new Error("Não é a vez deste jogador");

    const bannedIds = room.bannedCharacterIds || [];
    const pickedIds = room.pickedCharacterIds || [];
    if (bannedIds.includes(characterId) || pickedIds.includes(characterId)) {
      throw new Error("Personagem já foi banido ou escolhido");
    }

    const actionRef = doc(collection(db, "rooms", matchId, "actions"));
    tx.set(actionRef, { playerId, type, characterId, round: room.phase, timestamp: Date.now() });

    const updates = {};
    if (type === "ban") updates.bannedCharacterIds = [...bannedIds, characterId];
    else updates.pickedCharacterIds = [...pickedIds, characterId];

    const stillUsedCount = bannedIds.length + pickedIds.length + 1;
    if (stillUsedCount >= state.characters.length) {
      Object.assign(updates, countdownPatch());
    } else {
      Object.assign(updates, advanceTurnPatch(room));
    }

    tx.update(roomRef, updates);
  });
}

async function processTimeoutTx(matchId) {
  const roomRef = doc(db, "rooms", matchId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) return;
    const room = snap.data();
    if (room.status !== "drafting" || !room.turnTimerEnabled || !room.turnDeadline) return;
    if (Number(room.turnDeadline) > Date.now()) return; // checagem fresca: pode já ter sido resolvido

    const currentPlayerId = room.playerIds[room.turnIndex];
    const actionRef = doc(collection(db, "rooms", matchId, "actions"));
    tx.set(actionRef, { playerId: currentPlayerId, type: "timeout", characterId: "", round: room.phase, timestamp: Date.now() });

    tx.update(roomRef, advanceTurnPatch(room));
  });
}

async function confirmAction(match, character, actionType) {
  if (state.actionInFlight) return;
  state.actionInFlight = true;

  const optimistic = buildOptimisticMatch(match, character, actionType);
  renderMatch(optimistic);

  try {
    await makeActionTx(match.matchId, state.me.id, actionType, character.id);
    // o onSnapshot da sala confirma/reconcilia o estado real em seguida
  } catch (err) {
    toast(err.message);
    // reverte pro último estado real conhecido (a próxima atualização do
    // onSnapshot também corrige, mas isso evita ficar preso na visão otimista)
    if (state.lastMatch) renderMatch(state.lastMatch);
  } finally {
    state.actionInFlight = false;
  }
}

/* ---- fim do draft: aguarda o host iniciar a partida oficial manualmente ---- */
function renderCountdownScreen(match) {
  const isHost = String(match.hostPlayerId) === String(state.me.id);
  document.getElementById("startOfficialBtn").style.display = isHost ? "inline-block" : "none";
  document.getElementById("waitingOfficialHint").style.display = isHost ? "none" : "block";
}

document.getElementById("startOfficialBtn").addEventListener("click", async () => {
  try {
    const roomRef = doc(db, "rooms", state.matchId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) throw new Error("Sala não encontrada");
      const room = snap.data();
      if (room.status !== "countdown") throw new Error("O draft ainda não terminou");
      if (room.hostPlayerId !== state.me.id) throw new Error("Só o host pode iniciar a partida oficial");
      tx.update(roomRef, { status: "official", officialStartedAt: Date.now() });
    });
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
    suddenBanner.textContent = `⚔️ Empate em ${WIN_SCORE}+ pontos! Modo decisivo entre: ${names} — quem fizer mais pontos na próxima rodada vence.`;
  } else {
    suddenBanner.style.display = "none";
  }

  renderBannedSummary(document.getElementById("officialBannedSummary"), match);
  renderScoreBoard(document.getElementById("scoreBoard"), match);
  renderRoundForm(match);
  renderRoundHistory(document.getElementById("roundHistory"), match);
}

function renderBannedSummary(container, match) {
  if (!container) return;
  if (!match.bannedCharacters || match.bannedCharacters.length === 0) {
    container.innerHTML = `<span class="hint">Nenhum personagem banido nessa partida.</span>`;
    return;
  }
  container.innerHTML = `
    <span class="banned-summary-label">Banidos:</span>
    ${match.bannedCharacters.map(c => `
      <span class="banned-summary-item">${characterThumbHtml(c)} ${escapeHtml(c.name)}</span>
    `).join("")}
  `;
}

function renderScoreBoard(container, match) {
  container.innerHTML = "";
  const entries = match.playerIds.map(pid => ({ pid, score: match.scores[pid] || 0 }));
  const max = Math.max(0, ...entries.map(e => e.score));

  entries.sort((a, b) => b.score - a.score);
  entries.forEach(e => {
    const player = match.results.find(r => String(r.playerId) === String(e.pid));
    const card = document.createElement("div");
    card.className = "score-card" + (e.score === max && max > 0 ? " leader" : "");
    const realPicks = player ? player.picks.filter(s => s.kind === "character").map(s => s.character) : [];
    const picksHtml = realPicks.length
      ? `<div class="score-card-picks">${realPicks.map(c => characterThumbHtml(c)).join("")}</div>`
      : "";
    card.innerHTML = `
      ${avatarHtml({ name: player ? player.playerName : "?", photo: player ? player.playerPhoto : "" }, "md")}
      <div>${escapeHtml(player ? player.playerName : "?")}</div>
      <div class="score-value">${e.score}</div>
      ${picksHtml}
    `;
    container.appendChild(card);
  });
}

// Só reconstrói os inputs quando o grupo de jogadores elegíveis muda (ex: começo da
// partida oficial, ou entrada em modo decisivo). Do contrário, uma atualização em
// tempo real recriaria os campos e apagaria o que o jogador estivesse digitando.
function renderRoundForm(match) {
  const eligible = match.scoreEligiblePlayerIds;
  const key = eligible.join("|");
  const container = document.getElementById("roundInputs");

  if (state.roundFormKey === key && container.children.length > 0) return;
  state.roundFormKey = key;

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
    await submitRoundScoresTx(state.matchId, scores);
    inputs.forEach(input => { input.value = 0; });
    toast("Rodada registrada!");
  } catch (err) {
    toast(err.message);
  }
});

async function submitRoundScoresTx(matchId, scores) {
  const roomRef = doc(db, "rooms", matchId);

  // roundNumber não é transacional (é uma consulta à subcoleção) — mas o pior caso
  // de corrida aqui é duas rodadas nascerem com o mesmo número, o que não quebra o
  // placar (os pontos ainda somam certo no doc da sala, só o rótulo "Rodada N" no
  // histórico poderia repetir uma vez; extremamente raro pra um grupo de amigos).
  const roundsSnap = await getDocs(collection(db, "rooms", matchId, "rounds"));
  const maxRound = roundsSnap.docs.reduce((m, d) => Math.max(m, Number(d.data().roundNumber)), 0);
  const roundNumber = maxRound + 1;

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(roomRef);
    if (!snap.exists()) throw new Error("Sala não encontrada");
    const room = snap.data();
    if (room.status !== "official") throw new Error("A partida oficial não está em andamento");

    const eligible = room.suddenDeath ? (room.eligiblePlayerIds || []) : room.playerIds;
    const roundEntries = eligible.map(pid => ({ playerId: pid, points: Number(scores[pid] || 0) }));

    roundEntries.forEach(entry => {
      const roundRef = doc(collection(db, "rooms", matchId, "rounds"));
      tx.set(roundRef, { roundNumber, playerId: entry.playerId, points: entry.points, timestamp: Date.now() });
    });

    const scoresMap = Object.assign({}, room.scores || {});
    roundEntries.forEach(entry => {
      scoresMap[entry.playerId] = (scoresMap[entry.playerId] || 0) + entry.points;
    });

    const resultPatch = evaluateRoundResult(room, scoresMap, roundEntries);
    tx.update(roomRef, Object.assign({ scores: scoresMap }, resultPatch));
  });
}

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
    const roomRef = doc(db, "rooms", state.matchId);
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(roomRef);
      if (!snap.exists()) throw new Error("Sala não encontrada");
      const room = snap.data();
      if (room.status !== "official") throw new Error("Só é possível finalizar durante a partida oficial");

      const scoresMap = room.scores || {};
      let max = -1, leaders = [];
      room.playerIds.forEach(pid => {
        const t = scoresMap[pid] || 0;
        if (t > max) { max = t; leaders = [pid]; }
        else if (t === max) leaders.push(pid);
      });

      tx.update(roomRef, {
        status: "finished",
        winnerPlayerId: leaders.length === 1 ? leaders[0] : null
      });
    });
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

  renderBannedSummary(document.getElementById("finalBannedSummary"), match);
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
   HISTÓRICO DE PARTIDAS
========================= */
async function renderHistoryTab() {
  const container = document.getElementById("historyList");
  container.innerHTML = `<p class="hint">Carregando...</p>`;
  try {
    const snap = await getDocs(query(collection(db, "rooms"), where("status", "==", "finished")));
    const rooms = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt - a.createdAt);

    container.innerHTML = "";
    if (rooms.length === 0) {
      container.innerHTML = `<p class="hint">Nenhuma partida finalizada ainda.</p>`;
      return;
    }

    for (const room of rooms) {
      const actionsSnap = await getDocs(collection(db, "rooms", room.id, "actions"));
      const roundsSnap = await getDocs(collection(db, "rooms", room.id, "rounds"));
      const match = assembleMatchState(
        room,
        actionsSnap.docs.map(d => d.data()),
        roundsSnap.docs.map(d => d.data())
      );
      container.appendChild(buildHistoryCard(match));
    }
  } catch (err) {
    container.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function buildHistoryCard(match) {
  const card = document.createElement("div");
  card.className = "history-card";

  const dateStr = match.officialStartedAt
    ? new Date(match.officialStartedAt).toLocaleString("pt-BR")
    : (match.draftStartedAt ? new Date(match.draftStartedAt).toLocaleString("pt-BR") : "");
  const winnerText = match.winnerPlayerId
    ? `🏆 ${escapeHtml(playerNameIn(match, match.winnerPlayerId))}`
    : "🤝 Empate";

  const header = document.createElement("div");
  header.className = "history-card-header";
  header.innerHTML = `
    <div>
      <span class="room-card-code">${escapeHtml(match.code)}</span>
      <span class="hint">${escapeHtml(dateStr)}</span>
    </div>
    <div>${winnerText}</div>
  `;
  card.appendChild(header);

  const bannedSummary = document.createElement("div");
  bannedSummary.className = "banned-summary";
  renderBannedSummary(bannedSummary, match);
  card.appendChild(bannedSummary);

  const scoreBoard = document.createElement("div");
  scoreBoard.className = "score-board";
  renderScoreBoard(scoreBoard, match);
  card.appendChild(scoreBoard);

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "secondary-btn";
  toggleBtn.textContent = "Ver draft e histórico de rodadas";

  const details = document.createElement("div");
  details.style.display = "none";

  const resultsRow = document.createElement("div");
  resultsRow.className = "results-row";
  renderResultsRow(resultsRow, match, true);
  details.appendChild(resultsRow);

  const roundHistory = document.createElement("div");
  renderRoundHistory(roundHistory, match);
  details.appendChild(roundHistory);

  toggleBtn.addEventListener("click", () => {
    const showing = details.style.display !== "none";
    details.style.display = showing ? "none" : "block";
    toggleBtn.textContent = showing ? "Ver draft e histórico de rodadas" : "Ocultar detalhes";
  });

  card.appendChild(toggleBtn);
  card.appendChild(details);

  return card;
}

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
      await updateDoc(doc(db, "characters", id), Object.assign({ name }, photoData));
      toast("Personagem atualizado");
    } else {
      await addDoc(collection(db, "characters"), Object.assign({
        name, image: "", imageFileId: "", createdAt: Date.now()
      }, photoData));
      toast("Personagem adicionado");
    }
    resetCharacterForm();
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
        await deleteDoc(doc(db, "characters", c.id));
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
      await updateDoc(doc(db, "players", id), Object.assign({ name }, photoData));
      toast("Jogador atualizado");
      if (state.me && String(state.me.id) === String(id)) {
        state.me.name = name;
        if (photoData.photo) state.me.photo = photoData.photo;
        renderCurrentUserBox();
      }
    } else {
      await addDoc(collection(db, "players"), Object.assign({
        name, photo: "", photoFileId: "", createdAt: Date.now()
      }, photoData));
      toast("Jogador adicionado");
    }
    resetPlayerForm();
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
  const onlineIds = getOnlinePlayerIds();
  state.players.forEach(p => {
    const item = document.createElement("div");
    item.className = "admin-item";
    item.innerHTML = `
      ${avatarHtml(p, "md")}
      <div class="name"><span class="status-dot ${onlineIds.indexOf(String(p.id)) !== -1 ? "online" : "offline"}"></span>${escapeHtml(p.name)}</div>
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
        await deleteDoc(doc(db, "players", p.id));
        toast("Jogador excluído");
      } catch (err) {
        toast(err.message);
      }
    });
    list.appendChild(item);
  });
}

/* =========================
   PWA: SERVICE WORKER + BANNER DE INSTALAÇÃO
========================= */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

let deferredInstallPrompt = null;
const INSTALL_DISMISS_KEY = "smashup_install_dismissed_at";
const INSTALL_DISMISS_DAYS = 7;

function isStandaloneDisplay() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function wasInstallBannerRecentlyDismissed() {
  const ts = localStorage.getItem(INSTALL_DISMISS_KEY);
  if (!ts) return false;
  const days = (Date.now() - Number(ts)) / (1000 * 60 * 60 * 24);
  return days < INSTALL_DISMISS_DAYS;
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function showInstallBanner(mode) {
  if (isStandaloneDisplay() || wasInstallBannerRecentlyDismissed()) return;

  const banner = document.getElementById("installBanner");
  const text = document.getElementById("installBannerText");
  const btn = document.getElementById("installBannerBtn");

  if (mode === "prompt") {
    text.textContent = "Instale o Smash Up Pick & Ban no seu dispositivo pra acesso rápido, como um app.";
    btn.style.display = "inline-block";
  } else {
    text.textContent = 'Instale este app: toque em Compartilhar e depois em "Adicionar à Tela de Início".';
    btn.style.display = "none";
  }
  banner.style.display = "flex";
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  showInstallBanner("prompt");
});

document.getElementById("installBannerBtn").addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  document.getElementById("installBanner").style.display = "none";
});

document.getElementById("installBannerDismiss").addEventListener("click", () => {
  localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  document.getElementById("installBanner").style.display = "none";
});

window.addEventListener("appinstalled", () => {
  document.getElementById("installBanner").style.display = "none";
});

if (isIosDevice() && !isStandaloneDisplay()) {
  setTimeout(() => showInstallBanner("ios"), 1500);
}
