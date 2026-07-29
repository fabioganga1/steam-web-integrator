# <img src="docs/steam-icon.svg" width="32" alt="Steam"> Steam Web Integrator

![Versão](https://img.shields.io/badge/vers%C3%A3o-0.5.0-blue)
![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compat%C3%ADvel-00485b?logo=tampermonkey)
![Sem dependências](https://img.shields.io/badge/depend%C3%AAncias-zero-4caf50)

Userscript que marca automaticamente **links da Steam em qualquer página web** com um
pequeno emblema a indicar a tua relação com o jogo — sem precisares de abrir a loja.

![Demonstração](docs/demo.svg)

## Emblemas

| Emblema | Significado |
|---------|-------------|
| ✔ (verde) | Já tens o jogo / pacote |
| ♥ (rosa) | Está na tua wishlist |
| ★ (amarelo) | Estás a seguir |
| ∅ (cinzento) | Marcaste como ignorado |
| • (cinzento azulado) | Não tens |
| ⇩ (roxo) | É DLC (e diz-te se tens o jogo base) |
| ☠ (branco) | Removido da loja Steam |
| ⚙ (ciano) | Funcionalidades de perfil limitadas |
| 🂡 (azul) | Tem cartas colecionáveis |
| 🎁 (amarelo) | Já esteve em bundles |

Funciona em fóruns, Reddit, sites de bundles, SteamDB, agregadores de promoções —
qualquer página com links para `store.steampowered.com`, `steamcommunity.com`,
`steamdb.info` ou `s.team`.

## Instalação

1. Instala o [Tampermonkey](https://www.tampermonkey.net/) (ou Violentmonkey).
2. **[➜ Clica aqui para instalar](https://github.com/fabioganga1/steam-web-integrator/raw/master/steam-web-integrator.user.js)**
   — o Tampermonkey abre a instalação automaticamente e mantém o script atualizado.
3. Inicia sessão na [Steam](https://store.steampowered.com/) no browser — é daí que
   o script obtém os teus dados (jogos, wishlist, ignorados, seguidos).

## Como funciona

- Os teus dados (jogos, wishlist…) vêm do endpoint `dynamicstore/userdata` da Steam e
  ficam em **cache local** (30 minutos) para não sobrecarregar nem atrasar as páginas.
- Os dados extra (DLC, removidos, cartas, bundles, perfis limitados) vêm de fontes
  públicas da comunidade — [Barter.vg](https://bartervg.com) e
  [Steam Tracker](https://steam-tracker.com) — com cache de **48 horas**.
- Um `MutationObserver` apanha conteúdo carregado dinamicamente (scroll infinito, SPAs).
- **Zero dependências**: JavaScript puro, sem jQuery nem bibliotecas externas.

## Menu do Tampermonkey

- **↻ Atualizar dados da Steam** — força refrescamento imediato da cache.
- **👁 Mostrar/esconder jogos que não tens** — esconde os pontos "não tens" para
  reduzir ruído visual (útil em páginas com centenas de links).
- **🧩 Ligar/desligar extras** — desativa os emblemas de DLC, removidos, cartas e
  bundles se só quiseres o essencial.
- **🧹 Limpar cache** — apaga todos os dados guardados localmente.

## Privacidade

Os teus dados **nunca saem do teu browser**: o script fala apenas com a própria Steam
e guarda a cache localmente no Tampermonkey. Não há servidores de terceiros, análises
nem tracking.
