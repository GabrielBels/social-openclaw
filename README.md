# Social OpenClaw

Um Gateway do OpenClaw para mídias sociais (`openclaw --profile social`), com dois agentes, cada um com o seu bot dedicado no Telegram:

- **Pauta** (`linkedin`) cuida do LinkedIn do Gabriel. Pesquisa notícias de IA e engenharia de software, escolhe a melhor e escreve em inglês, na voz do Gabriel, uma nota de engenharia curta. A imagem é um SVG que ele desenha num dos formatos fixos (diagrama, ilustração ou tela), todos na mesma identidade escura das capas de artigo do Gabriel, e o `render.mjs` transforma em PNG. Quando o Gabriel pede, ele desenha também a capa de um artigo, que o Gabriel sobe no LinkedIn por conta própria. O objetivo é autoridade técnica em quatro pilares (engenharia assistida por IA, backend/.NET/arquitetura, LLMs em produção e carreira global em engenharia) que abra portas nos EUA.
- **Vitrine** (`instagram`) cuida do Instagram de uma marca. Escolhe um tema dos pilares da marca, lê a fonte primária, gera os slides de um carrossel (ou uma imagem única) nas cores da marca e escreve a legenda em português. A marca, o público, os pilares e a chamada para ação ficam em `instagram/workspace/USER.md`, um template a preencher antes do deploy; o logo e a imagem de referência ficam em `instagram/publisher/brand/` e `instagram/workspace/brand/`.

Os dois mandam o post pronto. O Gabriel só aprova ou pede ajustes, e o post sai pela API oficial da rede depois de uma aprovação que o próprio OpenClaw exige.

O Gateway tem perfil, store de secrets e serviço próprios, isolado de qualquer outro Gateway do OpenClaw na mesma máquina. Nenhum dos agentes tem acesso a dados de clientes ou de dentro de um produto.

## Como um post anda

1. **Post pronto.** No horário agendado de cada agente (store do OpenClaw), ou quando você manda "novo post" ao bot dele, o agente escolhe o tema, gera as imagens e escreve o texto. Você recebe o texto exatamente como vai sair, com pilar, formato, fonte e arquivo, e em seguida as imagens. No Instagram, recebe também as palavras de cada slide, para conferir os acentos. No LinkedIn, a imagem é um SVG que o `render.mjs` transforma em PNG depois que você aprova o comando; o post agendado não roda comandos, então a imagem vem quando você responde "imagem". No Instagram, se o `image_generate` falhar (OpenAI fora do ar ou no limite de uso), o agente escreve os slides em SVG na identidade da marca, e você os vê ao responder "imagem" e aprovar o `render.mjs` do Instagram.
2. **Ajustes.** "mais curto", "outra imagem", "troca o slide 3" ou qualquer mudança gera a versão seguinte, num arquivo novo `content/drafts/AAAA-MM-DD-<slug>-v<n>.md` que nunca é sobrescrito, com imagens novas só para o que mudou.
3. **Publicação.** Você responde "ok". O agente roda o publisher da rede com o arquivo exato, e o OpenClaw pede sua aprovação no Telegram com o caminho do arquivo. Você responde `/approve <id> allow-once`. Negar ou não responder não publica nada.
   - **LinkedIn:** o publisher envia a imagem pela Images API e publica o post com ela.
   - **Instagram:** o publisher confere que o token é da conta esperada (`INSTAGRAM_USERNAME`), envia cada slide a um bucket privado do Backblaze B2 e gera um link de leitura válido por uma hora, restrito ao nome aleatório da imagem. O Instagram busca as imagens por esses links, e o publisher cria os containers, publica e apaga as versões enviadas ao bucket.
4. **Registro.** O agente devolve a URL do post e anota data, pilar, formato, tema, fonte e URL no `content/ledger.md` do workspace dele.

## Segurança

- As credenciais permanentes são secrets protegidos do OpenClaw, cada uma vinculada aos hosts da sua API: LinkedIn a `api.linkedin.com` e `www.linkedin.com`, Instagram a `graph.instagram.com`, B2 a `api.backblazeb2.com`. O código recebe o sentinel `oc-sent-v2…`, e o proxy de saída do Gateway troca pelo valor real só nesses hosts. Os tokens temporários emitidos pelo B2 ficam apenas na memória do publisher, que valida os destinos e recusa redirecionamentos. Somente o acesso temporário de leitura da imagem é enviado à Meta; credenciais refletidas em erros são ocultadas antes de chegar ao chat. Os tokens não aparecem no chat, em arquivos ou em logs locais. Os dois agentes dividem o store, então todo comando aprovado recebe os sentinels de todas as credenciais; o vínculo de host e o `/approve` são as barreiras.
- Nenhum parâmetro operacional fica no código: os IDs, o horário de cada agente, os modelos, o provedor de busca, o modelo de imagem, a versão da API do Instagram, a conta esperada e o bucket do B2 são entradas `env` do store.
- **LinkedIn:** a cada 60 dias você renova o token. Primeiro roda `linkedin/scripts/auth.mjs url` no seu terminal, abre o link e cola ali o endereço de retorno. Depois manda "renova o token" ao bot do LinkedIn e aprova a troca. O link e o código nunca passam pelo agente nem pelo chat.
- **Instagram:** o primeiro token é gerado no app da Meta e guardado com `instagram/scripts/token.mjs store` no seu terminal. Depois, mande "renova o token" ao bot do Instagram (antes dos 60 dias) e aprove o `token.mjs refresh`, que troca o token sem passar pelo chat.
- Os agentes só têm busca e leitura na web, arquivos do próprio workspace, `exec` e, no Instagram, geração de imagem. **Todo** comando pede sua aprovação (`allow-once` ou `deny`; não existe aprovação permanente). Cada agente tem só os comandos previstos: o publisher dele com um arquivo de `content/drafts/`, o comando de token dele sem argumentos e o `render.mjs` dele: no LinkedIn com um SVG de `content/drafts/`, no Instagram com uma lista de slides (`.slides.txt`) de `content/drafts/`. Negue qualquer outro.
- Os publishers e scripts ficam fora dos workspaces dos agentes, então os agentes não conseguem alterá-los.
- Os agentes rodam no runtime do próprio OpenClaw, com o Code Mode desligado. O harness do Codex fica desligado, porque as ferramentas nativas dele não passariam pelo `/approve`.
- O registro de aprovações tem pisos (`security`, `ask: always`, `askFallback: deny`) que nem uma mensagem `/exec security=full ask=off` consegue afrouxar.
- Os jobs agendados não têm `exec`, e aprovações de automação nunca chegam ao chat. Por isso a publicação começa sempre por um "ok" seu na conversa.
- Agentes sem navegador. Sem skills não oficiais das redes.

## Documentos

- Design: [LinkedIn](docs/plans/2026-10-07-linkedin-social-agent-design.md), [armazenamento B2](docs/plans/2026-10-15-instagram-backblaze-design.md) e [slides em SVG do Instagram](docs/plans/2026-11-05-instagram-svg-fallback-design.md)
- [Guia de operação](docs/operations.md): setup, migração do perfil `linkedin`, deploy, tokens e solução de problemas

## Testes

```bash
node --test
```

Sem dependências npm. Precisa de Node ≥ 22.
