# Steam Lens 🔍

Userscript que marca automaticamente **links da Steam em qualquer página web** com um
pequeno emblema a indicar a tua relação com o jogo:

| Emblema | Significado |
|---------|-------------|
| ✔ (verde) | Já tens o jogo / pacote |
| ♥ (rosa) | Está na tua wishlist |
| ★ (amarelo) | Estás a seguir |
| ∅ (cinzento) | Marcaste como ignorado |
| • (cinzento azulado) | Não tens |

Funciona em fóruns, Reddit, sites de bundles, SteamDB, agregadores de promoções —
qualquer página com links para `store.steampowered.com`, `steamcommunity.com`,
`steamdb.info` ou `s.team`.

## Instalação

1. Instala o [Tampermonkey](https://www.tampermonkey.net/) (ou Violentmonkey).
2. **[Clica aqui para instalar](https://github.com/fabioganga1/steam-lens/raw/master/steam-lens.user.js)**
   — o Tampermonkey abre a instalação automaticamente e mantém o script atualizado.
3. Inicia sessão na [Steam](https://store.steampowered.com/) no browser — é daí que
   o script obtém os teus dados (jogos, wishlist, ignorados, seguidos).

## Como funciona

- Os dados vêm do endpoint `dynamicstore/userdata` da Steam e ficam em **cache local**
  (30 minutos) para não sobrecarregar nem atrasar as páginas.
- Um `MutationObserver` apanha conteúdo carregado dinamicamente (scroll infinito, SPAs).
- Sem dependências: JavaScript puro, sem jQuery.

## Menu do Tampermonkey

- **↻ Atualizar dados da Steam** — força refrescamento imediato da cache.
- **👁 Mostrar/esconder jogos que não tens** — esconde os pontos "não tens" para
  reduzir ruído visual (útil em páginas com centenas de links).
- **🧹 Limpar cache** — apaga os dados guardados localmente.

## Créditos

Projeto original de **Fabio ([fabioganga1](https://github.com/fabioganga1))**.
Inspirado no *conceito* do [Steam Web Integration](https://github.com/Revadike/SteamWebIntegration)
de Revadike — o código deste projeto foi escrito de raiz.

## Licença

[MIT](LICENSE)
