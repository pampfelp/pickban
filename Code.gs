const SHEET_ID = "1_E1PQCSlPZtxh2CsvwkLn2KYZD6vztbaa_aXHkpaO1g";
const PHOTOS_FOLDER_NAME = "SmashUpPickBan_Photos";

// Ordem das fases da partida. Cada fase = 1 ação (ban ou pick) por jogador, na ordem de turno.
const PHASES = ["ban1", "pick1", "ban2", "pick2"];

const PHASE_LABELS = {
  ban1: "1ª Rodada de Banimento",
  pick1: "1ª Rodada de Escolha",
  ban2: "2ª Rodada de Banimento",
  pick2: "2ª Rodada de Escolha",
  done: "Partida Finalizada"
};

const ONLINE_THRESHOLD_MS = 25 * 1000; // considera online se houve heartbeat nos últimos 25s

/* =========================
   SETUP INICIAL
========================= */
function setup() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // Dados editoriais/cadastrais: preserva se já existir.
  createSheetIfMissing(ss, "players", ["id", "name", "photo", "photoFileId", "createdAt"]);
  createSheetIfMissing(ss, "characters", ["id", "name", "image", "imageFileId"]);

  // Dados de sessão/partida: recriados do zero para garantir o esquema novo.
  resetSheet(ss, "matches", [
    "id", "code", "status", "phase", "turnIndex", "playerIds", "hostPlayerId", "createdAt", "startedAt"
  ]);
  resetSheet(ss, "actions", ["matchId", "playerId", "type", "characterId", "round", "timestamp"]);
  resetSheet(ss, "sessions", ["playerId", "lastSeen"]);
}

function createSheetIfMissing(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
  }
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
    headers.forEach((h, i) => obj[h] = row[i]);
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

function deleteDriveFileSafe(fileId) {
  if (!fileId) return;
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
  } catch (err) {
    // arquivo já pode não existir mais; ignora
  }
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

  const sheet = getSheet("matches");
  const id = new Date().getTime();
  const code = generateRoomCode();

  sheet.appendRow([
    id,
    code,
    "waiting",
    "",
    0,
    String(data.hostPlayerId),
    String(data.hostPlayerId),
    new Date().toISOString(),
    ""
  ]);

  return getMatchState(id);
}

function joinRoom(data) {
  if (!data.code || !data.playerId) return { error: "code e playerId são obrigatórios" };

  const sheet = getSheet("matches");
  const values = sheet.getDataRange().getValues();
  let rowIndex = -1;
  let rowValues = null;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][1]).toUpperCase() === String(data.code).toUpperCase()) {
      rowIndex = i + 1;
      rowValues = values[i];
      break;
    }
  }

  if (rowIndex === -1) return { error: "Sala não encontrada" };
  if (rowValues[2] !== "waiting") return { error: "Essa sala já começou ou terminou" };

  const playerIds = String(rowValues[5]).split(",").map(s => s.trim()).filter(Boolean);

  if (playerIds.indexOf(String(data.playerId)) !== -1) {
    return getMatchState(rowValues[0]); // já está na sala
  }
  if (playerIds.length >= 6) return { error: "Sala cheia" };

  playerIds.push(String(data.playerId));
  sheet.getRange(rowIndex, 6).setValue(playerIds.join(","));

  return getMatchState(rowValues[0]);
}

function leaveRoom(data) {
  const sheet = getSheet("matches");
  const row = findRowIndexById(sheet, data.matchId);
  if (row === -1) return { error: "Sala não encontrada" };

  const values = sheet.getRange(row, 1, 1, 9).getValues()[0];
  if (values[2] !== "waiting") return { error: "Não é possível sair de uma partida já iniciada" };

  let playerIds = String(values[5]).split(",").map(s => s.trim()).filter(Boolean);
  playerIds = playerIds.filter(id => id !== String(data.playerId));

  if (playerIds.length === 0) {
    sheet.deleteRow(row);
    return { success: true, deleted: true };
  }

  sheet.getRange(row, 6).setValue(playerIds.join(","));

  // Se o host saiu, promove o próximo da lista.
  if (String(values[6]) === String(data.playerId)) {
    sheet.getRange(row, 7).setValue(playerIds[0]);
  }

  return { success: true };
}

function startRoom(data) {
  const sheet = getSheet("matches");
  const row = findRowIndexById(sheet, data.matchId);
  if (row === -1) return { error: "Sala não encontrada" };

  const values = sheet.getRange(row, 1, 1, 9).getValues()[0];
  if (values[2] !== "waiting") return { error: "Sala já foi iniciada" };
  if (String(values[6]) !== String(data.hostPlayerId)) return { error: "Só o host pode iniciar a partida" };

  const playerIds = String(values[5]).split(",").map(s => s.trim()).filter(Boolean);
  if (playerIds.length < 2) return { error: "Precisa de pelo menos 2 jogadores" };

  sheet.getRange(row, 3).setValue("in_progress"); // status
  sheet.getRange(row, 4).setValue(PHASES[0]);      // phase
  sheet.getRange(row, 5).setValue(0);              // turnIndex
  sheet.getRange(row, 9).setValue(new Date().toISOString()); // startedAt

  return getMatchState(values[0]);
}

function deleteMatch(data) {
  const matchesSheet = getSheet("matches");
  const row = findRowIndexById(matchesSheet, data.matchId);
  if (row !== -1) matchesSheet.deleteRow(row);

  const actionsSheet = getSheet("actions");
  const values = actionsSheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) === String(data.matchId)) {
      actionsSheet.deleteRow(i + 1);
    }
  }

  return { success: true };
}

function getMatchRow(matchId) {
  const sheet = getSheet("matches");
  const row = findRowIndexById(sheet, matchId);
  if (row === -1) return null;
  const values = sheet.getRange(row, 1, 1, 9).getValues()[0];
  return {
    row,
    id: values[0],
    code: values[1],
    status: values[2],
    phase: values[3],
    turnIndex: Number(values[4]),
    playerIds: String(values[5]).split(",").map(s => s.trim()).filter(Boolean),
    hostPlayerId: values[6],
    createdAt: values[7],
    startedAt: values[8]
  };
}

/* =========================
   AÇÕES (BAN / PICK)
========================= */
function makeAction(data) {
  const match = getMatchRow(data.matchId);
  if (!match) return { error: "Partida não encontrada" };
  if (match.status !== "in_progress") return { error: "Partida não está em andamento" };

  const expectedType = (match.phase === "ban1" || match.phase === "ban2") ? "ban" : "pick";
  if (data.type !== expectedType) {
    return { error: `Ação inválida. Fase atual espera "${expectedType}"` };
  }

  const currentPlayerId = match.playerIds[match.turnIndex];
  if (String(data.playerId) !== String(currentPlayerId)) {
    return { error: "Não é a vez deste jogador" };
  }

  const usedCharacterIds = getUsedCharacterIds(data.matchId);
  if (usedCharacterIds.indexOf(String(data.characterId)) !== -1) {
    return { error: "Personagem já foi banido ou escolhido" };
  }

  const actionsSheet = getSheet("actions");
  actionsSheet.appendRow([
    data.matchId,
    data.playerId,
    data.type,
    data.characterId,
    match.phase,
    new Date().toISOString()
  ]);

  advanceTurn(match);

  return getMatchState(data.matchId);
}

function getUsedCharacterIds(matchId) {
  const actions = sheetRows("actions").filter(a => String(a.matchId) === String(matchId));
  return actions.map(a => String(a.characterId));
}

function advanceTurn(match) {
  let turnIndex = match.turnIndex + 1;
  let phase = match.phase;
  let status = "in_progress";

  if (turnIndex >= match.playerIds.length) {
    turnIndex = 0;
    const currentPhaseIndex = PHASES.indexOf(phase);
    if (currentPhaseIndex === PHASES.length - 1) {
      phase = "done";
      status = "finished";
    } else {
      phase = PHASES[currentPhaseIndex + 1];
    }
  }

  const sheet = getSheet("matches");
  sheet.getRange(match.row, 3).setValue(status);    // status
  sheet.getRange(match.row, 4).setValue(phase);     // phase
  sheet.getRange(match.row, 5).setValue(turnIndex); // turnIndex
}

/* =========================
   ESTADO DO JOGO
========================= */
function getMatchState(matchId) {
  const match = getMatchRow(matchId);
  if (!match) return { error: "Partida não encontrada" };

  const actions = sheetRows("actions").filter(a => String(a.matchId) === String(matchId));
  const players = sheetRows("players");
  const characters = sheetRows("characters");
  const onlineIds = getOnlinePlayerIds();

  const usedIds = actions.map(a => String(a.characterId));
  const availableCharacters = characters.filter(c => usedIds.indexOf(String(c.id)) === -1);

  const currentPlayerId = match.status === "in_progress" ? match.playerIds[match.turnIndex] : null;

  const results = match.playerIds.map(pid => {
    const player = players.find(p => String(p.id) === String(pid));
    const playerActions = actions.filter(a => String(a.playerId) === String(pid));
    return {
      playerId: pid,
      playerName: player ? player.name : "Desconhecido",
      playerPhoto: player ? player.photo : "",
      online: onlineIds.indexOf(String(pid)) !== -1,
      bans: playerActions.filter(a => a.type === "ban").map(a => enrichCharacter(a.characterId, characters)),
      picks: playerActions.filter(a => a.type === "pick").map(a => enrichCharacter(a.characterId, characters))
    };
  });

  return {
    matchId: match.id,
    code: match.code,
    status: match.status,
    phase: match.phase,
    phaseLabel: PHASE_LABELS[match.phase] || match.phase,
    turnIndex: match.turnIndex,
    playerIds: match.playerIds,
    hostPlayerId: match.hostPlayerId,
    startedAt: match.startedAt,
    currentPlayerId,
    availableCharacters,
    results,
    actions
  };
}

function enrichCharacter(characterId, characters) {
  const c = characters.find(ch => String(ch.id) === String(characterId));
  return c || { id: characterId, name: "Desconhecido", image: "" };
}

/* =========================
   DADOS GERAIS (players + characters + salas + status online)
========================= */
function getAllData() {
  const players = sheetRows("players");
  const characters = sheetRows("characters");
  const onlineIds = getOnlinePlayerIds();
  const matches = sheetRows("matches");

  const playersWithStatus = players.map(p => ({
    ...p,
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
        hostPlayerId: m.hostPlayerId,
        playerIds,
        playerCount: playerIds.length,
        playerNames,
        startedAt: m.startedAt,
        createdAt: m.createdAt
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    players: playersWithStatus,
    characters,
    rooms
  };
}
