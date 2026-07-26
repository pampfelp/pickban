# Smash Up — Pick & Ban

App de pick/ban para Smash Up, com Google Sheets + Apps Script como backend e fotos guardadas no Google Drive.

## Funcionalidades

- **Login simples por perfil**: escolha seu nome numa lista ou crie um perfil novo (com foto opcional). Sem senha.
- **Avatar**: se o perfil (jogador ou personagem) tem foto, mostra a foto; senão mostra um círculo com as iniciais (1ª letra do primeiro nome + 1ª letra do segundo nome, se houver).
- **Upload de foto direto do dispositivo**: ao enviar uma foto (jogador ou personagem), ela é redimensionada no navegador e enviada para uma pasta no Google Drive (`SmashUpPickBan_Photos`), que retorna um link público usado como imagem no app.
- **UI otimista / atualização em segundo plano**: ao banir ou escolher um personagem, a tela atualiza na hora (sem esperar o servidor) e a chamada real acontece em paralelo; se o servidor discordar (ex: alguém foi mais rápido), a tela se corrige sozinha. Durante o draft, a sala sincroniza a cada ~1,2s; na contagem regressiva, a cada 1s; na partida oficial, a cada ~2,5s.
- **Editor de regras ao criar sala**: número de jogadores (exato, 2 a 6), quantidade de banimentos por jogador, quantidade de escolhas por jogador, e se o timer de turno está ativo.
- **Timer por turno (opcional)**: cada jogador tem 1min30s para banir ou escolher; se o tempo acabar, a vez passa para o próximo jogador e essa oportunidade de ban/pick é perdida. É verificado automaticamente (não precisa ninguém estar com a tela aberta — qualquer jogador que atualizar a sala "destrava" turnos vencidos).
- **Contadores de tempo separados**: um cronômetro para o draft (banimento/escolha) e outro, independente, para a partida oficial (só começa quando o draft termina).
- **Personagens por categoria**: contagem de quantos estão cadastrados, disponíveis, escolhidos e banidos, com três listas separadas (Disponíveis / Escolhidos / Banidos).
- **Transição automática para a partida oficial**: quando os personagens acabam ou todos os jogadores atingem o limite de bans/picks, roda uma contagem regressiva de 10s (o host pode pular) e a sala vira a tela de "Partida oficial".
- **Placar por rodadas**: a cada rodada, os jogadores registram os pontos que fizeram. Quem chegar a 15+ pontos (sem empate no topo) vence e a partida encerra sozinha. Em caso de empate no topo com 15+, entra em modo decisivo só entre os empatados — na rodada seguinte, quem pontuar mais entre eles vence.
- **Botão de finalizar partida**: encerra manualmente a qualquer momento, mostrando o histórico completo e quem venceu (ou empate, se não houver um vencedor claro).
- **Lobby**: lista de salas com status, contagem de jogadores e tempo decorrido. Mostra todos os jogadores cadastrados com bolinha verde/cinza de online/offline.
- **Entrar por código**: cada sala tem um código de 5 caracteres.
- **Presença online/offline**: heartbeat a cada 10s; considerado offline depois de ~25s sem heartbeat.

## Fluxo completo de uma sala

1. **Aguardando início**: host cria a sala com as regras; jogadores entram por código ou pela lista do lobby até bater o número exato definido. Host aperta "Iniciar Partida".
2. **Draft**: jogadores se revezam banindo e escolhendo personagens, na ordem em que entraram na sala, alternando banimento/escolha conforme as quantidades configuradas (ex: banCount=2, pickCount=2 → ban, pick, ban, pick).
3. **Contagem regressiva (10s)**: dispara quando os personagens acabam ou todo mundo atinge o limite de bans/picks.
4. **Partida oficial**: cronômetro próprio; jogadores registram pontos rodada a rodada até alguém bater 15 (com as regras de empate/desempate acima), ou até o host finalizar manualmente.
5. **Resultado final**: vencedor (ou empate), placar final e histórico completo de rodadas e do draft.

## 1. Configurar o Apps Script

1. Abra a planilha: https://docs.google.com/spreadsheets/d/1_E1PQCSlPZtxh2CsvwkLn2KYZD6vztbaa_aXHkpaO1g/edit
2. Menu **Extensões → Apps Script**.
3. Apague todo o código atual e cole o conteúdo de [`Code.gs`](Code.gs) deste projeto.
4. No topo do editor, selecione a função `setup` no dropdown de funções e clique em **Executar** (▶). Autorize o script quando solicitado (inclui acesso ao **Google Drive**, usado para as fotos). Se dor erro de permissão do Drive, veja a seção de troubleshooting abaixo.
   - Isso **corrige o cabeçalho** das abas `players`/`characters` (sem apagar as linhas já cadastradas) e **recria do zero** as abas `matches`, `actions`, `sessions` e `rounds` com o novo formato — necessário para as regras configuráveis, o timer e o placar.
   - Importante: qualquer sala que já existia (aba `matches`) é apagada nesse reset — é esperado, já que o formato da sala mudou bastante (regras, timer, placar). Jogadores e personagens continuam intactos.
5. Clique em **Implantar → Gerenciar implantações** → editar (lápis) a implantação existente → **Nova versão** → **Implantar**. Isso mantém a mesma URL (`.../exec`) que já está configurada no `app.js`.

### Se der erro de permissão do Drive

Se aparecer algo como `Exception: Você não tem permissão para chamar DriveApp...`:

1. Acesse [myaccount.google.com/permissions](https://myaccount.google.com/permissions), ache o projeto do script e remova o acesso antigo.
2. No editor do Apps Script, selecione `setup` no dropdown e clique em **Executar** (▶) direto no editor.
3. Vai aparecer "Autorização necessária" → **Revisar permissões** → escolha sua conta → se aparecer "o Google não verificou este app", clique em **Avançado** → **Acessar [projeto] (não seguro)** → **Permitir**, aceitando o acesso ao Drive.
4. Reimplante (passo 5 acima) para a versão publicada também rodar com essa autorização.

## 2. Cadastrar jogadores e personagens

- **Jogadores**: crie seu perfil direto na tela de login (nome + foto opcional do dispositivo), ou depois pela aba "Jogadores".
- **Personagens**: cadastre pela aba "Personagens", com nome + foto do dispositivo. A foto é enviada pro Google Drive automaticamente.

## 3. Rodar o app

O app é 100% estático (`index.html`, `style.css`, `app.js`):

- Abra `index.html` direto no navegador, ou
- Suba a pasta em qualquer hospedagem estática (GitHub Pages, Netlify, Vercel) para jogar com amigos em dispositivos diferentes.

## Estrutura de dados na planilha

- **players**: `id`, `name`, `photo`, `photoFileId`, `createdAt`
- **characters**: `id`, `name`, `image`, `imageFileId`
- **matches** (salas): `id`, `code`, `status` (`waiting`/`drafting`/`countdown`/`official`/`finished`), `phase`, `turnIndex`, `playerIds`, `hostPlayerId`, `createdAt`, `draftStartedAt`, `officialStartedAt`, `banCount`, `pickCount`, `maxPlayers`, `turnTimerEnabled`, `turnTimerSeconds`, `turnDeadline`, `countdownStartedAt`, `winnerPlayerId`, `suddenDeath`, `eligiblePlayerIds`
- **actions**: `matchId`, `playerId`, `type` (`ban`/`pick`/`timeout`), `characterId`, `round`, `timestamp`
- **sessions**: `playerId`, `lastSeen`
- **rounds**: `matchId`, `roundNumber`, `playerId`, `points`, `timestamp`

## Observações

- O servidor valida tudo: fase certa, vez do jogador certa, personagem disponível, e o timer de turno é conferido a cada chamada (não depende de nenhum cliente específico estar com a tela aberta).
- Como o Apps Script não tem "empurrão" em tempo real (sem WebSocket), a sincronização é por polling — otimizado para ser rápido no draft (~1,2s) sem sobrecarregar a planilha nos momentos menos críticos (lobby, placar).
- "Voltar ao lobby"/"Sair da sala" só esquece a sala local (`localStorage`); os dados continuam na planilha.
- Para resetar uma sala específica: `SEU_URL/exec?action=deleteMatch&matchId=123`.
