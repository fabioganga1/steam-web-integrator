// ==UserScript==
// @name         Steam Web Integrator
// @namespace    fabioganga1
// @version      0.6.0
// @description  Marca automaticamente links da Steam em qualquer página: jogos que já tens, na wishlist, ignorados, seguidos, DLC, removidos da loja, com cartas ou em bundles.
// @author       Fabio (fabioganga1)
// @icon         https://store.steampowered.com/favicon.ico
// @match        *://*/*
// @exclude      *://store.steampowered.com/*
// @exclude      *://steamcommunity.com/*
// @connect      store.steampowered.com
// @connect      bartervg.com
// @connect      steam-tracker.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @run-at       document-idle
// @updateURL    https://github.com/fabioganga1/steam-web-integrator/raw/master/steam-web-integrator.user.js
// @downloadURL  https://github.com/fabioganga1/steam-web-integrator/raw/master/steam-web-integrator.user.js
// @supportURL   https://github.com/fabioganga1/steam-web-integrator/issues
// @homepageURL  https://github.com/fabioganga1/steam-web-integrator
// ==/UserScript==

/*
 * Steam Web Integrator — marca os links da Steam em qualquer site.
 *
 * Como funciona:
 *  1. Vai buscar os teus dados à Steam (jogos, wishlist, ignorados, seguidos)
 *     através do endpoint dynamicstore/userdata (precisas de sessão iniciada
 *     na Steam no browser). Os dados ficam em cache local.
 *  2. Procura na página links para a loja Steam (app/sub) e acrescenta um
 *     pequeno emblema ao lado de cada um.
 *  3. Observa a página com MutationObserver para apanhar conteúdo dinâmico.
 */

(() => {
    "use strict";

    // ---------------------------------------------------------------- config

    const CACHE_KEY = "lens_userdata";
    const CACHE_TIME_KEY = "lens_userdata_time";
    const CACHE_TTL_MIN = 30; // minutos até refrescar os dados da Steam

    const BADGES = {
        owned:    { icon: "✔", color: "#4caf50", label: "Já tens este jogo" },
        wishlist: { icon: "♥", color: "#ff5c8a", label: "Está na tua wishlist" },
        ignored:  { icon: "∅", color: "#9e9e9e", label: "Marcaste como ignorado" },
        followed: { icon: "★", color: "#ffc107", label: "Estás a seguir" },
        unowned:  { icon: "•", color: "#78909c", label: "Não tens este jogo" },
        sub:      { icon: "✔", color: "#4caf50", label: "Já tens este pacote" },
        subUnowned: { icon: "•", color: "#78909c", label: "Não tens este pacote" },
    };

    // Padrões que identificam um appid/subid num link ou imagem.
    // As imagens da Steam vivem em vários caminhos da CDN:
    //   .../steam/apps/440/header.jpg
    //   .../store_item_assets/steam/apps/1091500/header.jpg
    //   steamcdn-a.akamaihd.net/... (domínio antigo, comum em posts de fórum)
    const APP_RE = /(?:store\.steampowered\.com|steamcommunity\.com|steamdb\.info|s\.team)\/(?:a(?:pp)?|agecheck\/app)\/(\d+)/;
    const APP_IMG_RE = /(?:steamstatic\.com|steamcdn-a\.akamaihd\.net)\/(?:[a-z_]+\/)?steam\/apps\/(\d+)\//;
    const SUB_RE = /(?:store\.steampowered\.com|steamdb\.info)\/sub\/(\d+)/;

    const MARKED_ATTR = "data-steam-lens";
    const OVERFLOW_ATTR = "data-steam-lens-overflow";
    const SHOW_UNOWNED_KEY = "lens_show_unowned";
    const EXTRAS_KEY = "lens_extras_enabled";
    const EXTRAS_TTL_MIN = 2880; // 48h — estas listas mudam devagar
    const EXTRAS_RETRY_MIN = 120; // 2h de espera antes de repetir uma fonte que falhou

    // Prefixo da cache dos extras. A versão faz parte da chave: quando o formato
    // guardado muda, as entradas antigas passam a ser ignoradas em vez de partirem.
    const EXTRAS_CACHE_PREFIX = "lens_extra_v2_";
    const EXTRAS_LEGACY_PREFIX = "lens_extra_";

    // Fontes públicas de dados extra (as mesmas usadas pela comunidade Steam).
    // `min` é o número mínimo de entradas que uma resposta tem de ter para ser
    // considerada válida — protege contra respostas truncadas ou páginas de erro.
    const EXTRA_SOURCES = {
        dlc:     { url: "https://bartervg.com/browse/dlc/json/", min: 1000 },
        cards:   { url: "https://bartervg.com/browse/cards/json/", min: 1000 },
        bundles: { url: "https://bartervg.com/browse/bundles/json/", min: 1000 },
        limited: { url: "https://bartervg.com/browse/tag/481/json/", min: 1 },
        removed: { url: "https://steam-tracker.com/api?action=GetAppListV3", min: 100 },
    };

    const EXTRA_KEYS = Object.keys(EXTRA_SOURCES);

    // ---------------------------------------------------------------- estado

    let data = null; // { owned:Set, wishlist:Set, ignored:Set, followed:Set, packages:Set }
    let extras = emptyExtras();
    let extrasInFlight = null;
    let showUnowned = GM_getValue(SHOW_UNOWNED_KEY, true);
    let extrasEnabled = GM_getValue(EXTRAS_KEY, true);

    function emptyExtras() {
        return { dlc: null, cards: null, bundles: null, limited: null, removed: null };
    }

    // ---------------------------------------------------------------- utils

    // Uma cache corrompida não pode matar o script: apaga-se e segue-se em frente.
    function readJSON(key) {
        const raw = GM_getValue(key, null);
        if (!raw) {
            return null;
        }
        try {
            return JSON.parse(raw);
        } catch {
            console.warn(`[Steam Web Integrator] Cache inválida em "${key}" — apagada.`);
            GM_deleteValue(key);
            return null;
        }
    }

    function writeJSON(key, value) {
        try {
            GM_setValue(key, JSON.stringify(value));
            return true;
        } catch (err) {
            console.warn(`[Steam Web Integrator] Não consegui guardar "${key}".`, err);
            return false;
        }
    }

    // As fontes externas devolvem registos completos; só precisamos de um número
    // por jogo. Aceita tanto `{appid: {cards: 5}}` como `{appid: 5}`.
    function numField(entry, ...names) {
        if (entry === null || entry === undefined) {
            return 0;
        }
        if (typeof entry === "number") {
            return entry;
        }
        for (const name of names) {
            const value = Number(entry[name]);
            if (Number.isFinite(value)) {
                return value;
            }
        }
        return 0;
    }

    function mapEntries(json, fn) {
        if (!json || typeof json !== "object") {
            return null;
        }
        const out = {};
        for (const [appID, entry] of Object.entries(json)) {
            const value = fn(entry);
            if (value !== null) {
                out[appID] = value;
            }
        }
        return out;
    }

    function onIdle(fn) {
        if (typeof requestIdleCallback === "function") {
            requestIdleCallback(fn, { timeout: 5000 });
        } else {
            setTimeout(fn, 1000);
        }
    }

    function warnFailure(context) {
        return (err) => console.warn(`[Steam Web Integrator] ${context}`, err);
    }

    // ---------------------------------------------------------------- dados

    function toSet(arr) {
        return new Set((arr || []).map(Number));
    }

    function fetchUserdata() {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: `https://store.steampowered.com/dynamicstore/userdata/?_=${Date.now()}`,
                timeout: 20000,
                onload: (res) => {
                    let json;
                    try {
                        json = JSON.parse(res.responseText);
                    } catch (err) {
                        console.warn("[Steam Web Integrator] Resposta inesperada da Steam.", err);
                        resolve(null);
                        return;
                    }

                    const ownedApps = Array.isArray(json.rgOwnedApps) ? json.rgOwnedApps : null;
                    const ownedPackages = Array.isArray(json.rgOwnedPackages) ? json.rgOwnedPackages : [];

                    if (!ownedApps || (ownedApps.length === 0 && ownedPackages.length === 0)) {
                        console.warn("[Steam Web Integrator] Sem dados — inicia sessão na Steam no browser.");
                        resolve(null);
                        return;
                    }

                    const compact = {
                        owned: ownedApps,
                        wishlist: Array.isArray(json.rgWishlist) ? json.rgWishlist : [],
                        ignored: Object.keys(json.rgIgnoredApps || {}).map(Number),
                        followed: Array.isArray(json.rgFollowedApps) ? json.rgFollowedApps : [],
                        packages: ownedPackages,
                    };
                    writeJSON(CACHE_KEY, compact);
                    GM_setValue(CACHE_TIME_KEY, Date.now());
                    resolve(compact);
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
            });
        });
    }

    function fetchJSON(url) {
        return new Promise((resolve) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                timeout: 30000,
                onload: (res) => {
                    try {
                        resolve(JSON.parse(res.responseText));
                    } catch {
                        resolve(null);
                    }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
            });
        });
    }

    // Compacta cada fonte para o mínimo que os emblemas precisam. As respostas
    // originais têm vários MB; guardar só isto evita um JSON.parse pesado em
    // cada página que abres.
    const EXTRA_TRANSFORMS = {
        dlc: (json) => mapEntries(json, (entry) => numField(entry, "base_appID", "base_appid", "base")),
        cards: (json) => mapEntries(json, (entry) => {
            const cards = numField(entry, "cards");
            if (cards <= 0) {
                return null;
            }
            const marketable = typeof entry === "object" && entry !== null && entry.marketable ? 1 : 0;
            return [cards, marketable];
        }),
        bundles: (json) => mapEntries(json, (entry) => {
            const bundles = numField(entry, "bundles");
            return bundles > 0 ? bundles : null;
        }),
        limited: (json) => mapEntries(json, () => 1),
        removed: (json) => {
            if (!json || !json.success || !Array.isArray(json.removed_apps)) {
                return null;
            }
            const byApp = {};
            for (const app of json.removed_apps) {
                byApp[app.appid] = String(app.category || "delisted").toLowerCase();
            }
            return byApp;
        },
    };

    async function loadExtra(key) {
        const { url, min } = EXTRA_SOURCES[key];
        const cacheKey = `${EXTRAS_CACHE_PREFIX}${key}`;
        const timeKey = `${cacheKey}_time`;
        const failKey = `${cacheKey}_fail`;
        const cached = readJSON(cacheKey);

        if (cached && Date.now() - GM_getValue(timeKey, 0) < EXTRAS_TTL_MIN * 60000) {
            return cached;
        }

        // Sem este travão, uma fonte em baixo (ou que devolve menos entradas do
        // que o mínimo) era refrescada em todas as páginas de todos os sites.
        if (Date.now() - GM_getValue(failKey, 0) < EXTRAS_RETRY_MIN * 60000) {
            return cached;
        }

        const raw = await fetchJSON(url);
        const json = EXTRA_TRANSFORMS[key](raw);

        if (json && Object.keys(json).length >= min) {
            if (writeJSON(cacheKey, json)) {
                GM_setValue(timeKey, Date.now());
                GM_deleteValue(failKey);
            }
            return json;
        }

        GM_setValue(failKey, Date.now());
        return cached;
    }

    function loadExtras() {
        if (!extrasEnabled) {
            return Promise.resolve();
        }
        if (extrasInFlight) {
            return extrasInFlight; // evita duas cargas em paralelo (arranque + menu)
        }

        extrasInFlight = Promise.all(EXTRA_KEYS.map((key) => loadExtra(key)))
            .then((results) => {
                if (!extrasEnabled) {
                    return; // desligado enquanto descarregava
                }
                const loaded = emptyExtras();
                EXTRA_KEYS.forEach((key, i) => {
                    loaded[key] = results[i];
                });
                extras = loaded;

                if (results.some(Boolean)) {
                    redraw();
                }
            })
            .finally(() => {
                extrasInFlight = null;
            });

        return extrasInFlight;
    }

    async function loadData(forceRefresh = false) {
        const cached = readJSON(CACHE_KEY);
        const age = Date.now() - GM_getValue(CACHE_TIME_KEY, 0);
        let raw = null;

        if (!forceRefresh && cached && age < CACHE_TTL_MIN * 60000) {
            raw = cached;
        } else {
            raw = await fetchUserdata();
            if (!raw && cached) {
                raw = cached; // fallback para a cache antiga
            }
        }

        if (!raw) {
            return false;
        }

        data = {
            owned: toSet(raw.owned),
            wishlist: toSet(raw.wishlist),
            ignored: toSet(raw.ignored),
            followed: toSet(raw.followed),
            packages: toSet(raw.packages),
        };
        return true;
    }

    // ---------------------------------------------------------------- badges

    function badgeFor(appID) {
        if (data.owned.has(appID)) {
            return "owned";
        }
        if (data.wishlist.has(appID)) {
            return "wishlist";
        }
        if (data.ignored.has(appID)) {
            return "ignored";
        }
        return "unowned";
    }

    function buildBadge(specs, id) {
        const box = document.createElement("sup");
        box.className = "steam-lens-badge";
        for (const b of specs) {
            const span = document.createElement("span");
            span.textContent = b.icon;
            span.style.color = b.color;
            span.title = `Steam Web Integrator — ${b.label} (${id})`;
            box.appendChild(span);
        }
        return box;
    }

    function extraSpecs(appID) {
        const specs = [];

        if (extras.dlc && appID in extras.dlc) {
            const base = extras.dlc[appID];
            const ownsBase = base > 0 && data.owned.has(base);
            specs.push({
                icon: "⇩",
                color: "#a655b2",
                label: `É DLC${base > 0 ? ` de um jogo base que ${ownsBase ? "tens" : "não tens"} (${base})` : ""}`,
            });
        }

        if (extras.removed && appID in extras.removed) {
            specs.push({
                icon: "☠",
                color: "#eceff1",
                label: `Removido da loja Steam (${extras.removed[appID]})`,
            });
        }

        if (extras.limited && appID in extras.limited) {
            specs.push({ icon: "⚙", color: "#00bcd4", label: "Tem funcionalidades de perfil limitadas" });
        }

        if (extras.cards && appID in extras.cards) {
            const [count, marketable] = extras.cards[appID];
            specs.push({
                icon: "🂡",
                color: "#42a5f5",
                label: `Tem ${count} carta${count === 1 ? "" : "s"} colecionáve${count === 1 ? "l" : "is"}${marketable ? "" : " (não transacionáveis)"}`,
            });
        }

        if (extras.bundles && appID in extras.bundles) {
            const n = extras.bundles[appID];
            specs.push({ icon: "🎁", color: "#ffca28", label: `Já esteve em ${n} bundle${n === 1 ? "" : "s"}` });
        }

        return specs;
    }

    function extractAppID(el) {
        const href = el.getAttribute("href") || "";
        const src = el.getAttribute("src") || "";
        const style = el.getAttribute("style") || "";
        for (const val of [href, src, style]) {
            const m = APP_RE.exec(val) || APP_IMG_RE.exec(val);
            if (m) {
                return Number(m[1]);
            }
        }
        return null;
    }

    function markElement(el) {
        if (el.hasAttribute(MARKED_ATTR)) {
            return;
        }
        el.setAttribute(MARKED_ATTR, "1");

        const href = el.getAttribute("href") || "";
        const subMatch = SUB_RE.exec(href);
        if (subMatch) {
            const subID = Number(subMatch[1]);
            const owned = data.packages.has(subID);
            if (!owned && !showUnowned) {
                return;
            }
            attachBadge(el, buildBadge([BADGES[owned ? "sub" : "subUnowned"]], `sub ${subID}`));
            return;
        }

        const appID = extractAppID(el);
        if (appID === null) {
            return;
        }

        // Um cartão típico é <a href=".../app/440"><img src=".../apps/440/..."></a>:
        // sem isto o mesmo jogo levava dois emblemas.
        if (el.tagName !== "A") {
            const anchor = el.closest("a[href]");
            if (anchor && extractAppID(anchor) === appID) {
                return;
            }
        }

        const ownership = badgeFor(appID);
        const specs = [BADGES[ownership]];
        if (data.followed.has(appID) && !data.owned.has(appID)) {
            specs.push(BADGES.followed);
        }
        specs.push(...extraSpecs(appID));

        if (ownership === "unowned" && specs.length === 1 && !showUnowned) {
            return;
        }
        attachBadge(el, buildBadge(specs, `app ${appID}`));
    }

    // Alguns layouts (cartões com overflow:hidden) cortam o emblema. Ler o estilo
    // calculado no meio das inserções forçava um reflow por emblema, por isso os
    // pais ficam em fila e são tratados de uma vez só.
    const unclipQueue = new Set();

    function attachBadge(el, badge) {
        el.after(badge);
        if (el.parentElement) {
            unclipQueue.add(el.parentElement);
        }
    }

    function flushUnclip() {
        if (unclipQueue.size === 0) {
            return;
        }
        const parents = [...unclipQueue];
        unclipQueue.clear();

        requestAnimationFrame(() => {
            for (const parent of parents) {
                if (!parent.isConnected || parent.hasAttribute(OVERFLOW_ATTR)) {
                    continue;
                }
                const computed = getComputedStyle(parent).overflow;
                if (!computed.includes("hidden")) {
                    continue;
                }
                // Um contentor que realmente faz scroll precisa do overflow que tem —
                // mexer nele partia carrosséis, listas e cabeçalhos sticky.
                if (parent.scrollHeight > parent.clientHeight + 1 || parent.scrollWidth > parent.clientWidth + 1) {
                    continue;
                }
                parent.setAttribute(OVERFLOW_ATTR, parent.style.overflow);
                parent.style.overflow = "visible";
            }
        });
    }

    const SELECTOR = [
        `a[href*="store.steampowered.com/app/"]`,
        `a[href*="store.steampowered.com/agecheck/app/"]`,
        `a[href*="store.steampowered.com/sub/"]`,
        `a[href*="steamcommunity.com/app/"]`,
        `a[href*="steamdb.info/app/"]`,
        `a[href*="steamdb.info/sub/"]`,
        `a[href*="s.team/a/"]`,
        `img[src*="steamstatic.com"][src*="/steam/apps/"]`,
        `img[src*="steamcdn-a.akamaihd.net/steam/apps/"]`,
        `[style*="/steam/apps/"]`,
    ].map((s) => `${s}:not([${MARKED_ATTR}])`).join(", ");

    function scan(root = document.body) {
        if (!root || !data) {
            return;
        }
        if (root.matches && root.matches(SELECTOR)) {
            markElement(root);
        }
        if (root.querySelectorAll) {
            root.querySelectorAll(SELECTOR).forEach(markElement);
        }
    }

    function clearBadges() {
        unclipQueue.clear();
        document.querySelectorAll(".steam-lens-badge").forEach((el) => el.remove());
        document.querySelectorAll(`[${MARKED_ATTR}]`).forEach((el) => el.removeAttribute(MARKED_ATTR));
        document.querySelectorAll(`[${OVERFLOW_ATTR}]`).forEach((el) => {
            el.style.overflow = el.getAttribute(OVERFLOW_ATTR);
            el.removeAttribute(OVERFLOW_ATTR);
        });
    }

    // Refaz tudo do zero (usado quando as opções mudam ou chegam dados novos)
    function redraw() {
        clearBadges();
        scan();
        flushUnclip();
    }

    // ---------------------------------------------------------------- observer

    // Em páginas com scroll infinito, varrer o documento inteiro a cada lote de
    // conteúdo era trabalho quadrático — só se varrem os nós que entraram.
    const MAX_PENDING = 200;

    let scanTimer = null;
    let pendingRoots = new Set();
    let pendingFullScan = false;

    function scheduleScan(root) {
        if (root && !pendingFullScan && pendingRoots.size < MAX_PENDING) {
            pendingRoots.add(root);
        } else {
            pendingFullScan = true;
            pendingRoots.clear();
        }

        if (scanTimer) {
            return;
        }
        scanTimer = setTimeout(() => {
            scanTimer = null;
            const roots = pendingFullScan ? [document.body] : [...pendingRoots];
            pendingRoots = new Set();
            pendingFullScan = false;

            for (const node of roots) {
                if (node && node.isConnected) {
                    scan(node);
                }
            }
            flushUnclip();
        }, 500);
    }

    function observe() {
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const node of m.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE && !node.classList.contains("steam-lens-badge")) {
                        scheduleScan(node);
                    }
                }
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    // ---------------------------------------------------------------- arranque

    GM_addStyle(`
        .steam-lens-badge {
            display: inline-block;
            margin-left: 3px;
            font-size: 0.85em;
            line-height: 1;
            cursor: help;
            user-select: none;
        }
        .steam-lens-badge > span { margin-right: 1px; }
    `);

    async function start() {
        const ok = await loadData();
        if (!ok) {
            return;
        }
        scan();
        flushUnclip();
        observe();
        // Em segundo plano e fora do caminho crítico do carregamento da página.
        onIdle(() => loadExtras().catch(warnFailure("Falha a carregar os extras.")));
    }

    GM_registerMenuCommand("↻ Atualizar dados da Steam", () => {
        loadData(true)
            .then((ok) => ok && redraw())
            .catch(warnFailure("Falha a atualizar os dados da Steam."));
    });

    GM_registerMenuCommand("👁 Mostrar/esconder jogos que não tens", () => {
        showUnowned = !showUnowned;
        GM_setValue(SHOW_UNOWNED_KEY, showUnowned);
        redraw();
    });

    GM_registerMenuCommand("🧩 Ligar/desligar extras (DLC, removidos, cartas, bundles)", () => {
        extrasEnabled = !extrasEnabled;
        GM_setValue(EXTRAS_KEY, extrasEnabled);
        if (extrasEnabled) {
            loadExtras().catch(warnFailure("Falha a carregar os extras."));
        } else {
            extras = emptyExtras();
            redraw();
        }
    });

    GM_registerMenuCommand("🧹 Limpar cache", () => {
        GM_deleteValue(CACHE_KEY);
        GM_deleteValue(CACHE_TIME_KEY);
        for (const key of EXTRA_KEYS) {
            for (const prefix of [EXTRAS_CACHE_PREFIX, EXTRAS_LEGACY_PREFIX]) {
                GM_deleteValue(`${prefix}${key}`);
                GM_deleteValue(`${prefix}${key}_time`);
                GM_deleteValue(`${prefix}${key}_fail`);
            }
        }
        // Sem isto a página ficava na mesma: os dados continuavam em memória.
        data = null;
        extras = emptyExtras();
        clearBadges();
        start().catch(warnFailure("Falha a rearrancar depois de limpar a cache."));
    });

    start().catch(warnFailure("Falha no arranque."));
})();
