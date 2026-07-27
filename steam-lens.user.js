// ==UserScript==
// @name         Steam Lens
// @namespace    fabioganga1
// @version      0.1.0
// @description  Marca automaticamente links da Steam em qualquer página: jogos que já tens, na wishlist, ignorados ou seguidos. Projeto original de Fabio, inspirado no conceito do Steam Web Integration.
// @author       Fabio (fabioganga1)
// @icon         https://store.steampowered.com/favicon.ico
// @match        *://*/*
// @exclude      *://store.steampowered.com/*
// @exclude      *://steamcommunity.com/*
// @connect      store.steampowered.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

/*
 * Steam Lens — vê à lupa os links da Steam em qualquer site.
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

    // ---------------------------------------------------------------- estado

    let data = null; // { owned:Set, wishlist:Set, ignored:Set, followed:Set, packages:Set }

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
                            console.warn("[Steam Lens] Sem dados — inicia sessão na Steam no browser.");
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
                        console.warn("[Steam Lens] Resposta inesperada da Steam.", err);
                        resolve(null);
                    }
                },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
            });
        });
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

    function buildBadge(kinds, id) {
        const box = document.createElement("sup");
        box.className = "steam-lens-badge";
        for (const kind of kinds) {
            const b = BADGES[kind];
            const span = document.createElement("span");
            span.textContent = b.icon;
            span.style.color = b.color;
            span.title = `Steam Lens — ${b.label} (${id})`;
            box.appendChild(span);
        }
        return box;
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
            const kind = data.packages.has(subID) ? "sub" : "subUnowned";
            el.after(buildBadge([kind], `sub ${subID}`));
            return;
        }

        const appID = extractAppID(el);
        if (appID === null) {
            return;
        }

        const kinds = [badgeFor(appID)];
        if (data.followed.has(appID) && !data.owned.has(appID)) {
            kinds.push("followed");
        }
        el.after(buildBadge(kinds, `app ${appID}`));
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
    }

    GM_registerMenuCommand("↻ Atualizar dados da Steam", async () => {
        const ok = await loadData(true);
        if (ok) {
            clearBadges();
            scan();
        }
    });

    GM_registerMenuCommand("🧹 Limpar cache", () => {
        GM_deleteValue(CACHE_KEY);
        GM_deleteValue(CACHE_TIME_KEY);
    });

    start();
})();
