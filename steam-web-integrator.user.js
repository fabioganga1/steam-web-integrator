// ==UserScript==
// @name         Steam Web Integrator
// @namespace    fabioganga1
// @version      0.5.0
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

    // Padrões que identificam um appid/subid num link ou imagem
    const APP_RE = /(?:store\.steampowered\.com|steamcommunity\.com|steamdb\.info|s\.team)\/(?:a(?:pp)?|agecheck\/app)\/(\d+)/;
    const APP_IMG_RE = /steamstatic\.com\/steam\/apps\/(\d+)\//;
    const SUB_RE = /(?:store\.steampowered\.com|steamdb\.info)\/sub\/(\d+)/;

    const MARKED_ATTR = "data-steam-lens";
    const SHOW_UNOWNED_KEY = "lens_show_unowned";
    const EXTRAS_KEY = "lens_extras_enabled";
    const EXTRAS_TTL_MIN = 2880; // 48h — estas listas mudam devagar

    // Fontes públicas de dados extra (as mesmas usadas pela comunidade Steam)
    const EXTRA_SOURCES = {
        dlc:     "https://bartervg.com/browse/dlc/json/",
        cards:   "https://bartervg.com/browse/cards/json/",
        bundles: "https://bartervg.com/browse/bundles/json/",
        limited: "https://bartervg.com/browse/tag/481/json/",
    };

    // ---------------------------------------------------------------- estado

    let data = null; // { owned:Set, wishlist:Set, ignored:Set, followed:Set, packages:Set }
    let extras = { dlc: null, cards: null, bundles: null, limited: null, removed: null };
    let showUnowned = GM_getValue(SHOW_UNOWNED_KEY, true);
    let extrasEnabled = GM_getValue(EXTRAS_KEY, true);

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
                    try {
                        const json = JSON.parse(res.responseText);
                        if (!json.rgOwnedApps || (json.rgOwnedApps.length === 0 && json.rgOwnedPackages.length === 0)) {
                            console.warn("[Steam Web Integrator] Sem dados — inicia sessão na Steam no browser.");
                            resolve(null);
                            return;
                        }
                        const compact = {
                            owned: json.rgOwnedApps,
                            wishlist: json.rgWishlist,
                            ignored: Object.keys(json.rgIgnoredApps || {}).map(Number),
                            followed: json.rgFollowedApps,
                            packages: json.rgOwnedPackages,
                        };
                        GM_setValue(CACHE_KEY, JSON.stringify(compact));
                        GM_setValue(CACHE_TIME_KEY, Date.now());
                        resolve(compact);
                    } catch (err) {
                        console.warn("[Steam Web Integrator] Resposta inesperada da Steam.", err);
                        resolve(null);
                    }
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

    async function loadExtra(key, url, transform) {
        const cacheKey = `lens_extra_${key}`;
        const timeKey = `${cacheKey}_time`;
        const cached = GM_getValue(cacheKey, null);
        const age = Date.now() - GM_getValue(timeKey, 0);

        if (cached && age < EXTRAS_TTL_MIN * 60000) {
            return JSON.parse(cached);
        }

        let json = await fetchJSON(url);
        if (json && transform) {
            json = transform(json);
        }

        // sanity check: estas listas têm sempre milhares de entradas
        if (json && Object.keys(json).length > 1000) {
            GM_setValue(cacheKey, JSON.stringify(json));
            GM_setValue(timeKey, Date.now());
            return json;
        }

        return cached ? JSON.parse(cached) : null;
    }

    async function loadExtras() {
        if (!extrasEnabled) {
            return;
        }

        const [dlc, cards, bundles, limited, removed] = await Promise.all([
            loadExtra("dlc", EXTRA_SOURCES.dlc),
            loadExtra("cards", EXTRA_SOURCES.cards),
            loadExtra("bundles", EXTRA_SOURCES.bundles),
            loadExtra("limited", EXTRA_SOURCES.limited),
            loadExtra("removed", "https://steam-tracker.com/api?action=GetAppListV3", (json) => {
                if (!json || !json.success || !Array.isArray(json.removed_apps)) {
                    return null;
                }
                const byApp = {};
                json.removed_apps.forEach((app) => {
                    byApp[app.appid] = app;
                });
                return byApp;
            }),
        ]);

        extras = { dlc, cards, bundles, limited, removed };

        if (dlc || cards || bundles || limited || removed) {
            clearBadges();
            scan();
        }
    }

    async function loadData(forceRefresh = false) {
        const cached = GM_getValue(CACHE_KEY, null);
        const age = Date.now() - GM_getValue(CACHE_TIME_KEY, 0);
        let raw = null;

        if (!forceRefresh && cached && age < CACHE_TTL_MIN * 60000) {
            raw = JSON.parse(cached);
        } else {
            raw = await fetchUserdata();
            if (!raw && cached) {
                raw = JSON.parse(cached); // fallback para a cache antiga
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

        if (extras.dlc && extras.dlc[appID]) {
            const base = Number(extras.dlc[appID].base_appID);
            const ownsBase = base && data.owned.has(base);
            specs.push({
                icon: "⇩",
                color: "#a655b2",
                label: `É DLC${base ? ` de um jogo base que ${ownsBase ? "tens" : "não tens"} (${base})` : ""}`,
            });
        }

        if (extras.removed && extras.removed[appID]) {
            const app = extras.removed[appID];
            specs.push({
                icon: "☠",
                color: "#eceff1",
                label: `Removido da loja Steam (${(app.category || "delisted").toLowerCase()})`,
            });
        }

        if (extras.limited && extras.limited[appID]) {
            specs.push({ icon: "⚙", color: "#00bcd4", label: "Tem funcionalidades de perfil limitadas" });
        }

        if (extras.cards && extras.cards[appID] && extras.cards[appID].cards > 0) {
            const c = extras.cards[appID];
            specs.push({
                icon: "🂡",
                color: "#42a5f5",
                label: `Tem ${c.cards} carta${c.cards === 1 ? "" : "s"} colecionáve${c.cards === 1 ? "l" : "is"}${c.marketable ? "" : " (não transacionáveis)"}`,
            });
        }

        if (extras.bundles && extras.bundles[appID] && extras.bundles[appID].bundles > 0) {
            const n = extras.bundles[appID].bundles;
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

    function attachBadge(el, badge) {
        el.after(badge);
        // Alguns layouts (cartões com overflow:hidden) cortam o emblema
        const parent = el.parentElement;
        if (parent && getComputedStyle(parent).overflow === "hidden") {
            parent.style.overflow = "visible";
        }
    }

    function scan(root = document.body) {
        if (!root || !data) {
            return;
        }
        const selector = [
            `a[href*="store.steampowered.com/app/"]`,
            `a[href*="store.steampowered.com/agecheck/app/"]`,
            `a[href*="store.steampowered.com/sub/"]`,
            `a[href*="steamcommunity.com/app/"]`,
            `a[href*="steamdb.info/app/"]`,
            `a[href*="steamdb.info/sub/"]`,
            `a[href*="s.team/a/"]`,
            `img[src*="steamstatic.com/steam/apps/"]`,
        ].map((s) => `${s}:not([${MARKED_ATTR}])`).join(", ");

        if (root.matches && root.matches(selector)) {
            markElement(root);
        }
        root.querySelectorAll(selector).forEach(markElement);
    }

    function clearBadges() {
        document.querySelectorAll(".steam-lens-badge").forEach((el) => el.remove());
        document.querySelectorAll(`[${MARKED_ATTR}]`).forEach((el) => el.removeAttribute(MARKED_ATTR));
    }

    // ---------------------------------------------------------------- observer

    let scanTimer = null;

    function scheduleScan() {
        if (scanTimer) {
            return;
        }
        scanTimer = setTimeout(() => {
            scanTimer = null;
            scan();
        }, 500);
    }

    function observe() {
        const observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.addedNodes.length > 0) {
                    scheduleScan();
                    return;
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
        observe();
        loadExtras(); // em segundo plano; quando chegar, refaz os emblemas
    }

    GM_registerMenuCommand("↻ Atualizar dados da Steam", async () => {
        const ok = await loadData(true);
        if (ok) {
            clearBadges();
            scan();
        }
    });

    GM_registerMenuCommand("👁 Mostrar/esconder jogos que não tens", () => {
        showUnowned = !showUnowned;
        GM_setValue(SHOW_UNOWNED_KEY, showUnowned);
        clearBadges();
        scan();
    });

    GM_registerMenuCommand("🧩 Ligar/desligar extras (DLC, removidos, cartas, bundles)", () => {
        extrasEnabled = !extrasEnabled;
        GM_setValue(EXTRAS_KEY, extrasEnabled);
        if (extrasEnabled) {
            loadExtras();
        } else {
            extras = { dlc: null, cards: null, bundles: null, limited: null, removed: null };
            clearBadges();
            scan();
        }
    });

    GM_registerMenuCommand("🧹 Limpar cache", () => {
        GM_deleteValue(CACHE_KEY);
        GM_deleteValue(CACHE_TIME_KEY);
        ["dlc", "cards", "bundles", "limited", "removed"].forEach((key) => {
            GM_deleteValue(`lens_extra_${key}`);
            GM_deleteValue(`lens_extra_${key}_time`);
        });
    });

    start();
})();
