// Inicialização do Firebase — via CDN (ESM), sem bundler, mantendo o padrão do
// projeto de "sem etapa de build".
//
// Só usa Firestore. As fotos NÃO passam pelo Firebase Storage (ele passou a
// exigir o plano pago Blaze mesmo dentro da cota gratuita) — continuam indo
// pro Google Drive via Apps Script (veja Code.gs e uploadPendingPhoto no app.js).
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import { getFirestore, connectFirestoreEmulator } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";

// TODO: troque pela config do SEU projeto (Firebase Console → Configurações do
// projeto → seus apps → app Web → "Config"). Essas chaves são públicas por
// design no Firebase Web — a segurança vem das regras (firestore.rules),
// não de esconder essa config.
const firebaseConfig = {
  apiKey: "AIzaSyCpNmjBE-GrVgGjufcfeQyq2vaAY_B8HPM",
  authDomain: "smashup-pickban.firebaseapp.com",
  projectId: "smashup-pickban",
  storageBucket: "smashup-pickban.firebasestorage.app",
  messagingSenderId: "733723648710",
  appId: "1:733723648710:web:feaee6a6ccdba13e56edc7"
};

export const firebaseApp = initializeApp(firebaseConfig);
export const db = getFirestore(firebaseApp);

// Por padrão, sempre conecta no projeto Firestore REAL (mesmo testando local
// ou pelo GitHub Pages) — assim dá pra testar sem precisar rodar nenhum
// emulador. Só usa o emulador local se você abrir a página com
// "?emulator=1" na URL (ex: http://localhost:8000/?emulator=1).
if (new URLSearchParams(location.search).has("emulator")) {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  console.log("[firebase] usando emulador local do Firestore (:8080)");
}
