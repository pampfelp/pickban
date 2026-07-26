const SHEET_ID = "1_E1PQCSlPZtxh2CsvwkLn2KYZD6vztbaa_aXHkpaO1g";
const PHOTOS_FOLDER_NAME = "SmashUpPickBan_Photos";

const COUNTDOWN_MS = 10 * 1000; // contagem regressiva entre fim do draft e início da partida oficial
const ONLINE_THRESHOLD_MS = 25 * 1000; // considera online se houve heartbeat nos últimos 25s
const WIN_SCORE = 15;

const STATUS_LABELS = {
  waiting: "Aguardando início da partida",
  drafting: "Draft em andamento",
  countdown: "Preparando partida oficial",
  official: "Partida oficial em andamento",
  finished: "Partida finalizada"
};

/* =========================
   SETUP INICIAL
========================= */
function setup() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // Dados editoriais/cadastrais: preserva as linhas existentes, mas garante que o
  // cabeçalho (linha 1) tenha os nomes de coluna corretos — sem isso, colunas novas
  // ficam sem nome e a leitura via sheetRows() quebra (colunas em branco colidem).
  ensureSheetHeaders(ss, "players", ["id", "name", "photo", "photoFileId", "createdAt"]);
  ensureSheetHeaders(ss, "characters", ["id", "name", "image", "imageFileId"]);

  // Dados de sessão/partida: recriados do zero para garantir o esquema novo.
  resetSheet(ss, "matches", [
    "id", "code", "status", "phase", "turnIndex", "playerIds", "hostPlayerId", "createdAt",
    "draftStartedAt", "officialStartedAt", "banCount", "pickCount", "maxPlayers",
    "turnTimerEnabled", "turnTimerSeconds", "turnDeadline", "countdownStartedAt",
    "winnerPlayerId", "suddenDeath", "eligiblePlayerIds"
  ]);
  resetSheet(ss, "actions", ["matchId", "playerId", "type", "characterId", "round", "timestamp"]);
  resetSheet(ss, "sessions", ["playerId", "lastSeen"]);
  resetSheet(ss, "rounds", ["matchId", "roundNumber", "playerId", "points", "timestamp"]);
}

function ensureSheetHeaders(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
}

function resetSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (sheet) {
    sheet.clear();
  } else {
    sheet = ss.insertSheet(name);
  }
  sheet.appendRow(headers);
}

/* =========================
   API PRINCIPAL (GET)
========================= */
function doGet(e) {
  const action = e.parameter.action;

  try {
    switch (action) {
      case "getData":
        return json(getAllData());

      case "addCharacter":
        return json(addCharacter(e.parameter));
      case "updateCharacter":
        return json(updateCharacter(e.parameter));
      case "deleteCharacter":
        return json(deleteCharacter(e.parameter));

      case "addPlayer":
        return json(addPlayer(e.parameter));
      case "updatePlayer":
        return json(updatePlayer(e.parameter));
      case "deletePlayer":
        return json(deletePlayer(e.parameter));

      case "heartbeat":
        return json(heartbeat(e.parameter));

      case "createRoom":
        return json(createRoom(e.parameter));
      case "joinRoom":
        return json(joinRoom(e.parameter));
      case "startRoom":
        return json(startRoom(e.parameter));
      case "leaveRoom":
        return json(leaveRoom(e.parameter));
      case "deleteMatch":
        return json(deleteMatch(e.parameter));

      case "makeAction":
        return json(makeAction(e.parameter));
      case "getMatchState":
        return json(getMatchState(e.parameter.matchId));

      case "skipCountdown":
        return json(skipCountdown(e.parameter));
      case "submitRoundScores":
        return json(submitRoundScores(e.parameter));
      case "finishMatchManually":
        return json(finishMatchManually(e.parameter));

      default:
        return json({ error: "Ação inválida" });
    }
  } catch (err) {
    return json({ error: String(err) });
  }
}

/* =========================
   API PRINCIPAL (POST) — usado só para upload de foto (payload grande em base64)
========================= */
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    switch (body.action) {
      case "uploadPhoto":
        return json(uploadPhoto(body));
      default:
        return json({ error: "Ação inválida" });
    }
  } catch (err) {
    return json({ error: String(err) });
  }
}

/* =========================
   UTIL
========================= */
// Apps Script não serializa chamadas concorrentes à planilha por padrão — sem isso,
// duas ações quase simultâneas podem ler o mesmo estado "antigo" antes de qualquer
// uma escrever de volta, e ambas passam pela validação (condição de corrida).
// withLock() serializa a seção crítica para eliminar esse tipo de brecha.
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSheet(name) {
  return SpreadsheetApp.openById(SHEET_ID).getSheetByName(name);
}

function sheetRows(name) {
  const values = getSheet(name).getDataRange().getValues();
  const headers = values[0];
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
    return obj;
  });
}

function findRowIndexById(sheet, id, col) {
  col = col || 0;
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col]) === String(id)) return i + 1; // linha real na planilha (1-based)
  }
  return -1;
}

/* =========================
   FOTOS (GOOGLE DRIVE)
========================= */
function getPhotosFolder() {
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty("PHOTOS_FOLDER_ID");

  if (savedId) {
    try {
      return DriveApp.getFolderById(savedId);
    } catch (err) {
      // pasta salva não existe mais (ex: apagada manualmente); recria abaixo.
    }
  }

  const folder = DriveApp.createFolder(PHOTOS_FOLDER_NAME);
  props.setProperty("PHOTOS_FOLDER_ID", folder.getId());
  return folder;
}

// body: { base64, mimeType, filename }
function uploadPhoto(body) {
  if (!body.base64) return { error: "Nenhuma imagem enviada" };

  const folder = getPhotosFolder();
  const bytes = Utilities.base64Decode(body.base64);
  const blob = Utilities.newBlob(bytes, body.mimeType || "image/jpeg", body.filename || "photo.jpg");
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const fileId = file.getId();
  const url = `https://drive.google.com/thumbnail?id=${fileId}&sz=w500`;

  return { success: true, url, fileId };
}

/* =========================
   PLAYERS
========================= */
function addPlayer(data) {
  if (!data.name) return { error: "Nome é obrigatório" };
  const sheet = getSheet("players");
  const id = new Date().getTime();
  sheet.appendRow([id, data.name, data.photo || "", data.photoFileId || "", new Date().toISOString()]);
  return { success: true, id };
}

function updatePlayer(data) {
  const sheet = getSheet("players");
  const row = findRowIndexById(sheet, data.id);
  if (row === -1) return { error: "Jogador não encontrado" };
  if (data.name !== undefined) sheet.getRange(row, 2).setValue(data.name);
  if (data.photo !== undefined) sheet.getRange(row, 3).setValue(data.photo);
  if (data.photoFileId !== undefined) sheet.getRange(row, 4).setValue(data.photoFileId);
  return { success: true };
}

function deletePlayer(data) {
  const sheet = getSheet("players");
  const row = findRowIndexById(sheet, data.id);
  if (row === -1) return { error: "Jogador não encontrado" };
  sheet.deleteRow(row);
  return { success: true };
}

/* =========================
   SESSÕES (ONLINE/OFFLINE)
========================= */
function heartbeat(data) {
  if (!data.playerId) return { error: "playerId é obrigatório" };
  const sheet = getSheet("sessions");
  const row = findRowIndexById(sheet, data.playerId);
  const now = new Date().toISOString();
  if (row === -1) {
    sheet.appendRow([data.playerId, now]);
  } else {
    sheet.getRange(row, 2).setValue(now);
  }
  return { success: true };
}

function getOnlinePlayerIds() {
  const now = new Date().getTime();
  return sheetRows("sessions")
    .filter(s => now - new Date(s.lastSeen).getTime() < ONLINE_THRESHOLD_MS)
    .map(s => String(s.playerId));
}

/* =========================
   CHARACTERS
========================= */
function addCharacter(data) {
  if (!data.name) return { error: "Nome é obrigatório" };
  const sheet = getSheet("characters");
  const id = new Date().getTime();
  sheet.appendRow([id, data.name, data.image || "", data.imageFileId || ""]);
  return { success: true, id };
}

function updateCharacter(data) {
  const sheet = getSheet("characters");
  const row = findRowIndexById(sheet, data.id);
  if (row === -1) return { error: "Personagem não encontrado" };
  if (data.name !== undefined) sheet.getRange(row, 2).setValue(data.name);
  if (data.image !== undefined) sheet.getRange(row, 3).setValue(data.image);
  if (data.imageFileId !== undefined) sheet.getRange(row, 4).setValue(data.imageFileId);
  return { success: true };
}

function deleteCharacter(data) {
  const sheet = getSheet("characters");
  const row = findRowIndexById(sheet, data.id);
  if (row === -1) return { error: "Personagem não encontrado" };
  sheet.deleteRow(row);
  return { success: true };
}

/* =========================
   FASES DO DRAFT
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

/* =========================
   SALAS (ROOMS / MATCHES)
========================= */
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O e 1/I para evitar confusão
  const existingCodes = sheetRows("matches").map(m => String(m.code));
  let code;
  do {
    code = "";
    for (let i = 0; i < 5; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (existingCodes.indexOf(code) !== -1);
  return code;
}

function createRoom(data) {
  if (!data.hostPlayerId) return { error: "hostPlayerId é obrigatório" };

  const maxPlayers = Math.min(6, Math.max(2, Number(data.maxPlayers) || 4));
  const banCount = Math.min(10, Math.max(1, Number(data.banCount) || 2));
  const pickCount = Math.min(10, Math.max(1, Number(data.pickCount) || 2));
  const turnTimerEnabled = data.turnTimerEnabled === "true" || data.turnTimerEnabled === true;
  const turnTimerSeconds = 90;

  const sheet = getSheet("matches");
  const id = new Date().getTime();
  const code = generateRoomCode();

  sheet.appendRow([
    id, code, "waiting", "", 0,
    String(data.hostPlayerId), String(data.hostPlayerId),
    new Date().toISOString(), "", "",
    banCount, pickCount, maxPlayers,
    turnTimerEnabled, turnTimerSeconds,
    "", "", "", false, ""
  ]);

  return getMatchState(id);
}

function joinRoom(data) {
  return withLock(() => {
    if (!data.code || !data.playerId) return { error: "code e playerId são obrigatórios" };

    const sheet = getSheet("matches");
    const values = sheet.getDataRange().getValues();
    let rowIndex = -1, matchId = null;

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][1]).toUpperCase() === String(data.code).toUpperCase()) {
        rowIndex = i + 1;
        matchId = values[i][0];
        break;
      }
    }

    if (rowIndex === -1) return { error: "Sala não encontrada" };

    const match = getMatchRow(matchId);
    if (match.status !== "waiting") return { error: "Essa sala já começou ou terminou" };
    if (match.playerIds.indexOf(String(data.playerId)) !== -1) return getMatchState(matchId);
    if (match.playerIds.length >= match.maxPlayers) return { error: "Sala cheia" };

    const newPlayerIds = match.playerIds.concat([String(data.playerId)]);
    sheet.getRange(rowIndex, 6).setValue(newPlayerIds.join(","));

    return getMatchState(matchId);
  });
}

function leaveRoom(data) {
  const match = getMatchRow(data.matchId);
  if (!match) return { error: "Sala não encontrada" };
  if (match.status !== "waiting") return { error: "Não é possível sair de uma partida já iniciada" };

  const sheet = getSheet("matches");
  let playerIds = match.playerIds.filter(id => id !== String(data.playerId));

  if (playerIds.length === 0) {
    sheet.deleteRow(match.row);
    return { success: true, deleted: true };
  }

  sheet.getRange(match.row, 6).setValue(playerIds.join(","));

  if (String(match.hostPlayerId) === String(data.playerId)) {
    sheet.getRange(match.row, 7).setValue(playerIds[0]);
  }

  return { success: true };
}

function startRoom(data) {
  return withLock(() => {
    const match = getMatchRow(data.matchId);
    if (!match) return { error: "Sala não encontrada" };
    if (match.status !== "waiting") return { error: "Sala já foi iniciada" };
    if (String(match.hostPlayerId) !== String(data.hostPlayerId)) return { error: "Só o host pode iniciar a partida" };
    if (match.playerIds.length !== match.maxPlayers) {
      return { error: `A sala precisa ter exatamente ${match.maxPlayers} jogadores para iniciar (atual: ${match.playerIds.length})` };
    }

    const phases = buildPhases(match.banCount, match.pickCount);
    const sheet = getSheet("matches");
    sheet.getRange(match.row, 3).setValue("drafting");
    sheet.getRange(match.row, 4).setValue(phases[0]);
    sheet.getRange(match.row, 5).setValue(0);
    sheet.getRange(match.row, 9).setValue(new Date().toISOString()); // draftStartedAt
    sheet.getRange(match.row, 16).setValue(
      match.turnTimerEnabled ? new Date(Date.now() + match.turnTimerSeconds * 1000).toISOString() : ""
    );

    return getMatchState(match.id);
  });
}

function skipCountdown(data) {
  const match = getMatchRow(data.matchId);
  if (!match) return { error: "Sala não encontrada" };
  if (match.status !== "countdown") return { error: "Não está na contagem regressiva" };
  if (String(match.hostPlayerId) !== String(data.hostPlayerId)) return { error: "Só o host pode pular a contagem" };

  const sheet = getSheet("matches");
  sheet.getRange(match.row, 3).setValue("official");
  sheet.getRange(match.row, 10).setValue(new Date().toISOString());

  return getMatchState(match.id);
}

function deleteMatch(data) {
  const matchesSheet = getSheet("matches");
  const row = findRowIndexById(matchesSheet, data.matchId);
  if (row !== -1) matchesSheet.deleteRow(row);

  [["actions", 0], ["rounds", 0]].forEach(([name]) => {
    const sheet = getSheet(name);
    const values = sheet.getDataRange().getValues();
    for (let i = values.length - 1; i >= 1; i--) {
      if (String(values[i][0]) === String(data.matchId)) {
        sheet.deleteRow(i + 1);
      }
    }
  });

  return { success: true };
}

function getMatchRow(matchId) {
  const sheet = getSheet("matches");
  const row = findRowIndexById(sheet, matchId);
  if (row === -1) return null;
  const v = sheet.getRange(row, 1, 1, 20).getValues()[0];
  return {
    row,
    id: v[0],
    code: v[1],
    status: v[2],
    phase: v[3],
    turnIndex: Number(v[4]),
    playerIds: String(v[5]).split(",").map(s => s.trim()).filter(Boolean),
    hostPlayerId: v[6],
    createdAt: v[7],
    draftStartedAt: v[8],
    officialStartedAt: v[9],
    banCount: Number(v[10]),
    pickCount: Number(v[11]),
    maxPlayers: Number(v[12]),
    turnTimerEnabled: v[13] === true || v[13] === "TRUE",
    turnTimerSeconds: Number(v[14]) || 90,
    turnDeadline: v[15],
    countdownStartedAt: v[16],
    winnerPlayerId: v[17],
    suddenDeath: v[18] === true || v[18] === "TRUE",
    eligiblePlayerIds: String(v[19] || "").split(",").map(s => s.trim()).filter(Boolean)
  };
}

/* =========================
   TIMERS "PREGUIÇOSOS" (checados a cada chamada)
========================= */
function maybeProcessTimeouts(match) {
  if (match.status !== "drafting" || !match.turnTimerEnabled || !match.turnDeadline) return match;

  let safety = 0;
  while (match.status === "drafting" && match.turnDeadline &&
         new Date(match.turnDeadline).getTime() < Date.now() && safety < 100) {
    const currentPlayerId = match.playerIds[match.turnIndex];
    getSheet("actions").appendRow([match.id, currentPlayerId, "timeout", "", match.phase, new Date().toISOString()]);
    advanceTurn(match);
    match = getMatchRow(match.id);
    safety++;
  }
  return match;
}

function maybeAdvanceCountdown(match) {
  if (match.status === "countdown" && match.countdownStartedAt) {
    if (Date.now() - new Date(match.countdownStartedAt).getTime() >= COUNTDOWN_MS) {
      const sheet = getSheet("matches");
      sheet.getRange(match.row, 3).setValue("official");
      sheet.getRange(match.row, 10).setValue(new Date().toISOString());
      match = getMatchRow(match.id);
    }
  }
  return match;
}

/* =========================
   AÇÕES (BAN / PICK)
========================= */
function makeAction(data) {
  return withLock(() => {
    let match = getMatchRow(data.matchId);
    if (!match) return { error: "Partida não encontrada" };

    match = maybeProcessTimeouts(match);
    match = maybeAdvanceCountdown(match);

    if (match.status !== "drafting") {
      return { error: "O draft não está em andamento", refresh: true };
    }

    const expectedType = match.phase.indexOf("ban") === 0 ? "ban" : "pick";
    if (data.type !== expectedType) {
      return { error: `Ação inválida. Fase atual espera "${expectedType}"`, refresh: true };
    }

    const currentPlayerId = match.playerIds[match.turnIndex];
    if (String(data.playerId) !== String(currentPlayerId)) {
      return { error: "Não é a vez deste jogador", refresh: true };
    }

    const usedCharacterIds = getUsedCharacterIds(data.matchId);
    if (usedCharacterIds.indexOf(String(data.characterId)) !== -1) {
      return { error: "Personagem já foi banido ou escolhido", refresh: true };
    }

    getSheet("actions").appendRow([
      data.matchId, data.playerId, data.type, data.characterId, match.phase, new Date().toISOString()
    ]);

    const characters = sheetRows("characters");
    const stillUsedIds = getUsedCharacterIds(data.matchId);

    if (stillUsedIds.length >= characters.length) {
      transitionToCountdown(match);
    } else {
      advanceTurn(match);
    }

    return getMatchState(data.matchId);
  });
}

function getUsedCharacterIds(matchId) {
  const actions = sheetRows("actions").filter(a =>
    String(a.matchId) === String(matchId) && (a.type === "ban" || a.type === "pick")
  );
  return actions.map(a => String(a.characterId));
}

function advanceTurn(match) {
  const phases = buildPhases(match.banCount, match.pickCount);
  let turnIndex = match.turnIndex + 1;
  let phase = match.phase;

  if (turnIndex >= match.playerIds.length) {
    turnIndex = 0;
    const idx = phases.indexOf(phase);
    if (idx === phases.length - 1) {
      transitionToCountdown(match);
      return;
    }
    phase = phases[idx + 1];
  }

  const sheet = getSheet("matches");
  sheet.getRange(match.row, 4).setValue(phase);
  sheet.getRange(match.row, 5).setValue(turnIndex);
  sheet.getRange(match.row, 16).setValue(
    match.turnTimerEnabled ? new Date(Date.now() + match.turnTimerSeconds * 1000).toISOString() : ""
  );
}

function transitionToCountdown(match) {
  const sheet = getSheet("matches");
  sheet.getRange(match.row, 3).setValue("countdown");
  sheet.getRange(match.row, 16).setValue(""); // turnDeadline
  sheet.getRange(match.row, 17).setValue(new Date().toISOString()); // countdownStartedAt
}

function enrichCharacter(characterId, characters) {
  const c = characters.find(ch => String(ch.id) === String(characterId));
  return c || { id: characterId, name: "Desconhecido", image: "" };
}

/* =========================
   PLACAR (RODADAS)
========================= */
function submitRoundScores(data) {
  return withLock(() => {
    const match = getMatchRow(data.matchId);
    if (!match) return { error: "Sala não encontrada" };
    if (match.status !== "official") return { error: "A partida oficial não está em andamento" };

    let scores;
    try {
      scores = JSON.parse(data.scores);
    } catch (err) {
      return { error: "Pontuação inválida" };
    }

    const eligible = match.suddenDeath ? match.eligiblePlayerIds : match.playerIds;
    const rounds = sheetRows("rounds").filter(r => String(r.matchId) === String(match.id));
    const maxRound = rounds.reduce((m, r) => Math.max(m, Number(r.roundNumber)), 0);
    const roundNumber = maxRound + 1;
    const sheet = getSheet("rounds");
    const now = new Date().toISOString();

    eligible.forEach(pid => {
      const pts = Number(scores[pid] || 0);
      sheet.appendRow([match.id, roundNumber, pid, pts, now]);
    });

    evaluateMatchResult(match.id);
    return getMatchState(match.id);
  });
}

function evaluateMatchResult(matchId) {
  const match = getMatchRow(matchId);
  const rounds = sheetRows("rounds").filter(r => String(r.matchId) === String(matchId));
  const maxRoundNumber = rounds.reduce((m, r) => Math.max(m, Number(r.roundNumber)), 0);
  if (maxRoundNumber === 0) return;

  const sheet = getSheet("matches");

  if (!match.suddenDeath) {
    const totals = {};
    match.playerIds.forEach(pid => totals[pid] = 0);
    rounds.forEach(r => { totals[String(r.playerId)] = (totals[String(r.playerId)] || 0) + Number(r.points); });

    let max = -1, leaders = [];
    match.playerIds.forEach(pid => {
      const t = totals[pid];
      if (t > max) { max = t; leaders = [pid]; }
      else if (t === max) { leaders.push(pid); }
    });

    if (max >= WIN_SCORE) {
      if (leaders.length === 1) {
        sheet.getRange(match.row, 3).setValue("finished");
        sheet.getRange(match.row, 18).setValue(leaders[0]);
      } else {
        sheet.getRange(match.row, 19).setValue(true);
        sheet.getRange(match.row, 20).setValue(leaders.join(","));
      }
    }
  } else {
    const lastRoundEntries = rounds.filter(r => Number(r.roundNumber) === maxRoundNumber);
    let max = -1, leaders = [];
    lastRoundEntries.forEach(r => {
      const pts = Number(r.points);
      if (pts > max) { max = pts; leaders = [String(r.playerId)]; }
      else if (pts === max) { leaders.push(String(r.playerId)); }
    });

    if (leaders.length === 1) {
      sheet.getRange(match.row, 3).setValue("finished");
      sheet.getRange(match.row, 18).setValue(leaders[0]);
    } else if (leaders.length > 0) {
      sheet.getRange(match.row, 20).setValue(leaders.join(","));
    }
  }
}

function finishMatchManually(data) {
  const match = getMatchRow(data.matchId);
  if (!match) return { error: "Sala não encontrada" };
  if (match.status !== "official") return { error: "Só é possível finalizar durante a partida oficial" };

  const rounds = sheetRows("rounds").filter(r => String(r.matchId) === String(match.id));
  const totals = {};
  match.playerIds.forEach(pid => totals[pid] = 0);
  rounds.forEach(r => { totals[String(r.playerId)] = (totals[String(r.playerId)] || 0) + Number(r.points); });

  let max = -1, leaders = [];
  match.playerIds.forEach(pid => {
    const t = totals[pid];
    if (t > max) { max = t; leaders = [pid]; }
    else if (t === max) { leaders.push(pid); }
  });

  const sheet = getSheet("matches");
  sheet.getRange(match.row, 3).setValue("finished");
  sheet.getRange(match.row, 18).setValue(leaders.length === 1 ? leaders[0] : "");

  return getMatchState(match.id);
}

/* =========================
   ESTADO DO JOGO
========================= */
function getMatchState(matchId) {
  let match = getMatchRow(matchId);
  if (!match) return { error: "Partida não encontrada" };

  match = maybeProcessTimeouts(match);
  match = maybeAdvanceCountdown(match);

  const actions = sheetRows("actions").filter(a => String(a.matchId) === String(matchId));
  const players = sheetRows("players");
  const characters = sheetRows("characters");
  const onlineIds = getOnlinePlayerIds();
  const rounds = sheetRows("rounds").filter(r => String(r.matchId) === String(matchId));

  const banPickActions = actions.filter(a => a.type === "ban" || a.type === "pick");
  const usedIds = banPickActions.map(a => String(a.characterId));

  const bannedMap = {}, pickedMap = {};
  banPickActions.forEach(a => {
    const player = players.find(p => String(p.id) === String(a.playerId));
    const entry = Object.assign({}, enrichCharacter(a.characterId, characters), {
      byPlayerId: a.playerId,
      byPlayerName: player ? player.name : "?"
    });
    if (a.type === "ban") bannedMap[String(a.characterId)] = entry;
    else pickedMap[String(a.characterId)] = entry;
  });

  const availableCharacters = characters.filter(c => usedIds.indexOf(String(c.id)) === -1);
  const bannedCharacters = Object.keys(bannedMap).map(k => bannedMap[k]);
  const pickedCharacters = Object.keys(pickedMap).map(k => pickedMap[k]);

  const currentPlayerId = match.status === "drafting" ? match.playerIds[match.turnIndex] : null;
  const secondsLeftInTurn = (match.status === "drafting" && match.turnDeadline)
    ? Math.max(0, Math.round((new Date(match.turnDeadline).getTime() - Date.now()) / 1000))
    : null;

  const results = match.playerIds.map(pid => {
    const player = players.find(p => String(p.id) === String(pid));
    const mine = banPickActions.filter(a => String(a.playerId) === String(pid));
    return {
      playerId: pid,
      playerName: player ? player.name : "Desconhecido",
      playerPhoto: player ? player.photo : "",
      online: onlineIds.indexOf(String(pid)) !== -1,
      bans: mine.filter(a => a.type === "ban").map(a => enrichCharacter(a.characterId, characters)),
      picks: mine.filter(a => a.type === "pick").map(a => enrichCharacter(a.characterId, characters))
    };
  });

  const totals = {};
  match.playerIds.forEach(pid => totals[pid] = 0);
  rounds.forEach(r => { totals[String(r.playerId)] = (totals[String(r.playerId)] || 0) + Number(r.points); });

  const maxRoundNumber = rounds.reduce((m, r) => Math.max(m, Number(r.roundNumber)), 0);
  const roundsByNumber = {};
  rounds.forEach(r => {
    if (!roundsByNumber[r.roundNumber]) roundsByNumber[r.roundNumber] = [];
    const player = players.find(p => String(p.id) === String(r.playerId));
    roundsByNumber[r.roundNumber].push({
      playerId: r.playerId,
      playerName: player ? player.name : "?",
      points: Number(r.points)
    });
  });
  const roundHistory = Object.keys(roundsByNumber)
    .sort((a, b) => Number(a) - Number(b))
    .map(n => ({ roundNumber: Number(n), entries: roundsByNumber[n] }));

  const scoreEligiblePlayerIds = match.suddenDeath ? match.eligiblePlayerIds : match.playerIds;

  return {
    matchId: match.id,
    code: match.code,
    status: match.status,
    statusLabel: STATUS_LABELS[match.status] || match.status,
    phase: match.phase,
    phaseLabel: phaseLabelFor(match.phase),
    phases: buildPhases(match.banCount, match.pickCount),
    turnIndex: match.turnIndex,
    playerIds: match.playerIds,
    hostPlayerId: match.hostPlayerId,
    rules: {
      banCount: match.banCount,
      pickCount: match.pickCount,
      maxPlayers: match.maxPlayers,
      turnTimerEnabled: match.turnTimerEnabled,
      turnTimerSeconds: match.turnTimerSeconds
    },
    draftStartedAt: match.draftStartedAt,
    officialStartedAt: match.officialStartedAt,
    countdownStartedAt: match.countdownStartedAt,
    currentPlayerId,
    turnDeadline: match.turnDeadline,
    secondsLeftInTurn,
    totalCharacters: characters.length,
    availableCharacters,
    pickedCharacters,
    bannedCharacters,
    results,
    scores: totals,
    roundHistory,
    currentRoundNumber: maxRoundNumber + 1,
    suddenDeath: match.suddenDeath,
    eligiblePlayerIds: match.eligiblePlayerIds,
    scoreEligiblePlayerIds,
    winnerPlayerId: match.winnerPlayerId,
    actions
  };
}

/* =========================
   DADOS GERAIS (players + characters + salas + status online)
========================= */
function getAllData() {
  const players = sheetRows("players");
  const characters = sheetRows("characters");
  const onlineIds = getOnlinePlayerIds();
  const matches = sheetRows("matches");

  const playersWithStatus = players.map(p => Object.assign({}, p, {
    online: onlineIds.indexOf(String(p.id)) !== -1
  }));

  const rooms = matches
    .filter(m => m.status !== "finished")
    .map(m => {
      const playerIds = String(m.playerIds).split(",").map(s => s.trim()).filter(Boolean);
      const playerNames = playerIds.map(pid => {
        const p = players.find(pl => String(pl.id) === pid);
        return p ? p.name : "?";
      });
      return {
        matchId: m.id,
        code: m.code,
        status: m.status,
        statusLabel: STATUS_LABELS[m.status] || m.status,
        hostPlayerId: m.hostPlayerId,
        playerIds,
        playerCount: playerIds.length,
        maxPlayers: Number(m.maxPlayers),
        playerNames,
        draftStartedAt: m.draftStartedAt,
        officialStartedAt: m.officialStartedAt,
        createdAt: m.createdAt
      };
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  return {
    players: playersWithStatus,
    characters,
    rooms
  };
}
