# Smash Up — Pick & Ban

App de pick/ban para Smash Up (2 a 6 jogadores), com Google Sheets + Apps Script como backend e fotos guardadas no Google Drive.

## Funcionalidades

- **Login simples por perfil**: escolha seu nome numa lista ou crie um perfil novo (com foto opcional). Sem senha.
- **Avatar**: se o perfil (jogador ou personagem) tem foto, mostra a foto; senão mostra um círculo com as iniciais (1ª letra do primeiro nome + 1ª letra do segundo nome, se houver).
- **Upload de foto direto do dispositivo**: ao enviar uma foto (jogador ou personagem), ela é redimensionada no navegador e enviada para uma pasta no Google Drive (`SmashUpPickBan_Photos`), que retorna um link público usado como imagem no app.
- **Lobby**: lista de salas abertas com status ("Aguardando início da partida" / "Partida iniciada"), contagem de jogadores e, se já iniciada, o tempo decorrido. Também mostra todos os jogadores cadastrados com uma bolinha verde/cinza de online/offline.
- **Entrar por código**: cada sala tem um código de 5 caracteres para entrar diretamente, além de poder entrar clicando na lista do lobby.
- **Sala de espera**: depois de criar/entrar numa sala, fica nesse estado até o host (quem criou) apertar "Iniciar Partida" (precisa de pelo menos 2 jogadores).
- **Cronômetro da partida**: conta a partir do momento em que o host inicia a partida.
- **Presença online/offline**: o app manda um "heartbeat" a cada 10s enquanto está aberto; um jogador é considerado online se o último heartbeat foi há menos de 25s.

## Fluxo do jogo (dentro da sala, depois de iniciada)

1. **Banimento 1**: cada jogador, na ordem em que entrou na sala, bane 1 personagem.
2. **Escolha 1**: cada jogador, na mesma ordem, escolhe 1 personagem.
3. **Banimento 2**: cada jogador bane mais 1.
4. **Escolha 2**: cada jogador escolhe mais 1.

No final, cada jogador tem 2 picks e 2 bans.

## 1. Configurar o Apps Script

1. Abra a planilha: https://docs.google.com/spreadsheets/d/1_E1PQCSlPZtxh2CsvwkLn2KYZD6vztbaa_aXHkpaO1g/edit
2. Menu **Extensões → Apps Script**.
3. Apague todo o código atual e cole o conteúdo de [`Code.gs`](Code.gs) deste projeto (essa versão já inclui upload de foto pro Drive, salas/lobby e presença online).
4. No topo do editor, selecione a função `setup` no dropdown de funções e clique em **Executar** (▶). Autorize o script quando solicitado — ele vai pedir permissão de acesso ao **Google Drive** também (usado para guardar as fotos). Se aparecer um erro de permissão do Drive, veja a seção de troubleshooting abaixo.
   - Isso cria/mantém as abas `players` e `characters` (preservando dados existentes) e **recria do zero** as abas `matches`, `actions` e `sessions` com o novo formato.
5. Clique em **Implantar → Gerenciar implantações**.
   - Clique no ícone de lápis (editar) na implantação existente → em "Versão" escolha **Nova versão** → **Implantar**. Isso mantém a mesma URL (`.../exec`) que já está configurada no `app.js`.
   - Se preferir criar uma implantação nova, copie a nova URL gerada e cole em `API_URL` no início de [`app.js`](app.js).

### Se der erro de permissão do Drive

Se aparecer algo como `Exception: Você não tem permissão para chamar DriveApp...`, o script precisa ser reautorizado incluindo o Drive:

1. Acesse [myaccount.google.com/permissions](https://myaccount.google.com/permissions), ache o projeto do script e remova o acesso antigo.
2. No editor do Apps Script, selecione `setup` no dropdown e clique em **Executar** (▶) direto no editor.
3. Vai aparecer "Autorização necessária" → **Revisar permissões** → escolha sua conta → se aparecer "o Google não verificou este app", clique em **Avançado** → **Acessar [projeto] (não seguro)** → **Permitir**, aceitando o acesso ao Drive.
4. Reimplante (passo 5 acima) para a versão publicada também rodar com essa autorização.

## 2. Cadastrar jogadores e personagens

- **Jogadores**: crie seu perfil direto na tela de login (nome + foto opcional tirada/selecionada do dispositivo), ou depois pela aba "Jogadores" do app.
- **Personagens**: cadastre pela aba "Personagens" do app, com nome + foto do dispositivo. A foto é enviada pro Google Drive automaticamente — não precisa mais colar URL.

## 3. Rodar o app

O app é 100% estático (`index.html`, `style.css`, `app.js`), então não precisa de servidor:

- Abra `index.html` direto no navegador, ou
- Suba a pasta em qualquer hospedagem estática (GitHub Pages, Netlify, Vercel) para acessar de vários celulares/computadores ao mesmo tempo — necessário para jogar com amigos em dispositivos diferentes, já que cada um faz login com seu próprio perfil e a sala sincroniza via polling (a cada 3–4s).

## Estrutura de dados na planilha

- **players**: `id`, `name`, `photo` (link do Drive), `photoFileId`, `createdAt`
- **characters**: `id`, `name`, `image` (link do Drive), `imageFileId`
- **matches** (salas): `id`, `code` (código de 5 caracteres), `status` (`waiting`/`in_progress`/`finished`), `phase` (`ban1`/`pick1`/`ban2`/`pick2`/`done`), `turnIndex`, `playerIds` (ordem de turno = ordem em que entraram na sala), `hostPlayerId`, `createdAt`, `startedAt`
- **actions**: `matchId`, `playerId`, `type` (`ban`/`pick`), `characterId`, `round` (fase em que ocorreu), `timestamp`
- **sessions**: `playerId`, `lastSeen` (usado para calcular online/offline)

As fotos ficam guardadas numa pasta separada no seu Google Drive chamada `SmashUpPickBan_Photos` (compartilhadas como "qualquer pessoa com o link pode ver", para poderem ser exibidas no app).

## Observações

- O servidor (Apps Script) valida tudo: fase correta, vez do jogador certa, personagem ainda disponível — então não dá pra "trapacear" clicando fora de ordem. Da mesma forma, só o host pode iniciar a sala, e só é possível entrar em salas com vaga que ainda não começaram.
- "Voltar ao lobby"/"Sair da sala" apenas esquece a sala local (guardada no `localStorage` do navegador); os dados continuam na planilha.
- Se quiser resetar uma sala específica, use a action `deleteMatch` (ex: chamando `SEU_URL/exec?action=deleteMatch&matchId=123`).
- O status online/offline depende do app estar aberto na aba do navegador (ele manda um heartbeat a cada 10s); se a pessoa fechar a aba, some do "online" em até ~25s.
