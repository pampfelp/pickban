// Apps Script mínimo — só existe pra receber upload de foto (base64) e salvar
// no Google Drive, devolvendo um link público. Todo o resto do app (salas,
// jogadores, personagens, placar, histórico) mora no Firestore agora; isso
// aqui é usado só porque o Firebase Storage passou a exigir plano pago
// (Blaze) mesmo dentro da cota gratuita, e o Drive continua de graça.

const PHOTOS_FOLDER_NAME = "SmashUpPickBan_Photos";

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

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

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
