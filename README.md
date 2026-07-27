# Smash Up — Pick & Ban

App de pick/ban para Smash Up. Frontend estático (HTML/CSS/JS puro, sem
framework) hospedado no GitHub Pages, com **Cloud Firestore** (Firebase) como
banco de dados em tempo real, e **Google Drive** (via um Apps Script mínimo)
guardando as fotos — o Firebase Storage passou a exigir plano pago mesmo
dentro da cota gratuita, então as fotos ficaram de fora do Firebase.

## Funcionalidades

- **Login simples por perfil**: escolha seu nome numa lista ou crie um perfil novo (com foto opcional). Sem senha.
- **Avatar**: se o perfil (jogador ou personagem) tem foto, mostra a foto; senão mostra um círculo com as iniciais.
- **Upload de foto direto do dispositivo**: redimensionada no navegador e enviada pro Google Drive.
- **Tempo real de verdade**: banir/escolher, entrar numa sala, registrar rodada — tudo aparece pros outros jogadores quase instantaneamente, via `onSnapshot` do Firestore. Sem polling, sem espera.
- **UI otimista**: sua própria ação aparece na tela na hora, antes mesmo da confirmação do servidor.
- **Editor de regras ao criar sala**: número de jogadores (exato, 2 a 6), quantidade de banimentos, quantidade de escolhas, e se o timer de turno está ativo.
- **Timer por turno (opcional)**: 1min30s pra banir/escolher; se o tempo acabar, a vez passa pro próximo e a oportunidade é perdida. Verificado por qualquer cliente com a sala aberta (transação do Firestore evita duplicidade).
- **Contadores de tempo separados**: cronômetro do draft e cronômetro da partida oficial, independentes.
- **Personagens por categoria**: Disponíveis / Escolhidos / Banidos, com contagem.
- **Transição automática pra partida oficial**: contagem regressiva de 10s quando os personagens acabam ou todos atingem o limite de bans/picks.
- **Placar por rodadas**: primeiro a 15+ pontos (sem empate no topo) vence; empate no topo entra em modo decisivo só entre os empatados.
- **Histórico de partidas**: todas as partidas finalizadas, com draft e rodadas completos.
- **Lobby**: salas com status, jogadores, tempo decorrido; presença online/offline.
- **App instalável (PWA)**.

## Fluxo completo de uma sala

1. **Aguardando início**: host cria a sala com as regras; jogadores entram por código ou pela lista do lobby até bater o número exato definido. Host aperta "Iniciar Partida".
2. **Draft**: jogadores se revezam banindo e escolhendo personagens, alternando conforme as quantidades configuradas.
3. **Contagem regressiva (10s)**: dispara quando os personagens acabam ou todo mundo atinge o limite de bans/picks.
4. **Partida oficial**: cronômetro próprio; jogadores registram pontos rodada a rodada até alguém bater 15, ou até o host finalizar manualmente.
5. **Resultado final**: vencedor (ou empate), placar final e histórico completo.

## 1. Criar o projeto Firebase

1. Acesse o [console do Firebase](https://console.firebase.google.com) e crie um projeto novo (gratuito, plano Spark).
2. Ative o **Firestore**: menu lateral → "Bancos de dados e armazenamento" → **Firestore** → **Criar banco de dados** → escolha uma região (ex: `southamerica-east1`) → **modo de produção**.
   - (Não precisa ativar o **Storage** — as fotos vão pro Google Drive, não pro Firebase.)
3. Publique as regras de segurança do Firestore: **Firestore Database → Regras** → apague o conteúdo → cole o de [`firestore.rules`](firestore.rules) deste projeto → **Publicar**.
4. Registre um app Web: ícone de engrenagem → **Configurações do projeto** → role até "Seus apps" → ícone `</>` (Web) → dê um nome → **não** marque Firebase Hosting → **Registrar app**. Copie o bloco `firebaseConfig = {...}` que aparece.
5. Abra [`firebase-init.js`](firebase-init.js) neste projeto e substitua os valores `"SUBSTITUA_AQUI"` pelos que você copiou.

Essas chaves (`apiKey`, `projectId` etc.) são **públicas por design** no Firebase Web — pode subir pro GitHub sem problema. A segurança de verdade vem das regras do Firestore (passo 3), não de esconder essa config.

## 2. Configurar o Apps Script (só pras fotos)

1. Abra a planilha antiga (ou crie uma nova em branco, não importa mais o conteúdo — só serve de "casa" pro script): [link da planilha](https://docs.google.com/spreadsheets/d/1_E1PQCSlPZtxh2CsvwkLn2KYZD6vztbaa_aXHkpaO1g/edit).
2. Menu **Extensões → Apps Script**.
3. Apague todo o código atual e cole o conteúdo de [`Code.gs`](Code.gs) deste projeto (agora é bem menor — só cuida de receber a foto e salvar no Drive).
4. **Implantar → Gerenciar implantações** → editar (lápis) a implantação existente → **Nova versão** → **Implantar**. Isso mantém a mesma URL (`.../exec`) que já está configurada no `app.js` (constante `PHOTO_UPLOAD_URL`).
   - Se for a primeira vez, rode a função `getPhotosFolder` uma vez direto no editor (▶) pra autorizar o acesso ao Google Drive antes de implantar.

## 3. Migrar os dados que já existiam na planilha (opcional, uma vez só)

Se você já tinha jogadores/personagens/histórico cadastrados na versão antiga, veja [`migrate-node/README.md`](migrate-node/README.md) — um script que roda uma vez, localmente, e copia tudo pro Firestore (as fotos continuam apontando pro Drive, sem precisar mexer nelas).

Se estiver começando do zero, pule esta etapa — cadastre jogadores/personagens direto pelo app depois de publicado.

## 4. Rodar o app

O app é 100% estático — todos os arquivos ficam juntos, sem subpastas (`index.html`, `style.css`, `app.js`, `firebase-init.js`, `manifest.json`, `service-worker.js`, os ícones .png, etc.). Isso é proposital: uploads pela interface web do GitHub não preservam pastas ao arrastar arquivos soltos, então manter tudo "achatado" na raiz evita esse problema.

- Abra `index.html` direto no navegador pra testar, ou
- Suba a pasta em qualquer hospedagem estática (GitHub Pages, Netlify, Vercel) pra jogar com amigos em dispositivos diferentes.

**Importante para o "Instalar app" funcionar**: o service worker só registra em HTTPS ou `localhost` — abrindo o `index.html` direto do disco (`file://`) o app funciona normalmente, mas sem o prompt de instalação. Hospede num serviço com HTTPS (GitHub Pages, Netlify, Vercel são gratuitos).

**Não suba a pasta `migrate-node/` pro GitHub Pages** — ela é só uma ferramenta local, não faz parte do site.

### Trocar os ícones pela logo oficial

Os ícones (favicon, apple-touch-icon, ícones do manifest) ficam na raiz do projeto. Pra trocar, salve a imagem nos tamanhos abaixo (mesmo nome de arquivo, na raiz):

- `favicon-16.png` (16×16)
- `favicon-32.png` (32×32)
- `apple-touch-icon.png` (180×180)
- `icon-192.png` (192×192)
- `icon-512.png` (512×512)

## Estrutura de dados no Firestore

- **players/{id}**: `name`, `photo` (link do Drive), `photoFileId`, `createdAt`
- **characters/{id}**: `name`, `image` (link do Drive), `imageFileId`, `createdAt`
- **sessions/{playerId}**: `lastSeen` (presença online/offline)
- **rooms/{id}** (salas): `code`, `status` (`waiting`/`drafting`/`countdown`/`official`/`finished`), `phase`, `turnIndex`, `playerIds[]`, `hostPlayerId`, `createdAt`, `draftStartedAt`, `officialStartedAt`, `banCount`, `pickCount`, `maxPlayers`, `turnTimerEnabled`, `turnTimerSeconds`, `turnDeadline`, `countdownStartedAt`, `winnerPlayerId`, `suddenDeath`, `eligiblePlayerIds[]`, `bannedCharacterIds[]`, `pickedCharacterIds[]`, `scores` (mapa playerId → total)
  - **rooms/{id}/actions/{autoId}**: `playerId`, `type` (`ban`/`pick`/`timeout`), `characterId`, `round`, `timestamp` — log de tudo que aconteceu na sala
  - **rooms/{id}/rounds/{autoId}**: `roundNumber`, `playerId`, `points`, `timestamp` — log de pontuação por rodada

## Observações

- **Sem servidor "oficial" de verdade**: como não há Cloud Functions (pra não precisar do plano pago), a validação de regras (vez certa, timer, condição de vitória) roda no `app.js`, no navegador de cada jogador, protegida por transações do Firestore (`runTransaction`) contra condições de corrida — mas não contra alguém tecnicamente hábil abrindo o DevTools. Pra um grupo de amigos, isso é um trade-off aceitável.
- **Tempo real de verdade**: cada sala usa `onSnapshot` (Firestore) — qualquer escrita de qualquer jogador aparece pros outros quase instantaneamente, sem precisar de intervalo de verificação.
- **Timer de turno**: qualquer cliente com a sala aberta pode "destravar" um turno vencido (roda um `setInterval` local que dispara uma transação quando percebe o prazo estourado) — não depende de nenhum jogador específico estar com a tela aberta, só que ALGUÉM da sala esteja.
- **Fotos**: o Apps Script (`Code.gs`) é usado só pra receber a foto (base64) e devolver o link do Drive — ele não guarda mais nada de jogo (sem planilha de dados). Se um dia o Firebase Storage voltar a ter cota gratuita sem exigir cartão, dá pra trocar fácil (só mexer em `uploadPendingPhoto` no `app.js`).
- "Voltar ao lobby"/"Sair da sala" só esquece a sala local (`localStorage`); os dados continuam no Firestore.
- Pra excluir uma sala manualmente: use o ícone de lixeira no Lobby.
