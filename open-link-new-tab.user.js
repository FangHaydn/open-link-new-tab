// ==UserScript==
// @name         链接新标签打开 (Open Links in New Tab)
// @namespace    https://github.com/fanghaydn
// @version      2.1.0
// @description  ① 外链直达：自动识别外链跳转中间页（link.csdn.net 等安全提示页/中转页），提取目标地址并直达，可在菜单全局启停；② 新标签打开：让所有链接点击默认在新标签页打开，支持站点级开关；不影响链接卡片内嵌的上层操作（按钮/下拉等）。
// @author       fanghaydn
// @match        *://*/*
// @exclude      https://*.google.com/search*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * MIT License
 *
 * Copyright (c) 2026 fanghaydn
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

(function () {
  'use strict';

  // ============================ 配置与存储 ============================

  const KEY_DISABLED_SITES = 'oint_disabled_sites';       // 「新标签打开」禁用名单（hostname 数组）
  const KEY_REDIRECT_ENABLED = 'oint_redirect_enabled';   // 「外链直达」全局开关（boolean，默认 true）
  const KEY_REDIRECT_DECISIONS = 'oint_redirect_decisions'; // 「外链直达」灰区站点记忆 { [hostname]: 'auto' | 'never' }
  const KEY_BOUNCE_GUARD = 'oint_bounce_guard';           // 回跳防护（防 A→B→A 循环）

  // 优先使用 GM 存储（跨域共享、不随站点数据清除），不可用时回退 localStorage
  const storage = {
    get(key, fallback) {
      try {
        if (typeof GM_getValue === 'function') {
          const v = GM_getValue(key);
          return v === undefined ? fallback : v;
        }
      } catch (_) { /* ignore */ }
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (_) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        if (typeof GM_setValue === 'function') {
          GM_setValue(key, value);
          return;
        }
      } catch (_) { /* ignore */ }
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (_) { /* ignore */ }
    },
  };

  const getDisabledSites = () => {
    const list = storage.get(KEY_DISABLED_SITES, []);
    return Array.isArray(list) ? list.filter((h) => typeof h === 'string') : [];
  };

  const setDisabledSites = (list) => storage.set(KEY_DISABLED_SITES, list);

  const host = location.hostname;

  // ============================ 多语言（i18n） ============================
  // 按浏览器语言（navigator.language）自动切换，默认英文。
  // 菜单按钮统一风格：✅ 开启 / ❌ 关闭，括号内注明点击后的动作。

  const MESSAGES = {
    en: {
      redirectToggleOn: '✅ Redirect Bypass: ON (click to turn OFF)',
      redirectToggleOff: '❌ Redirect Bypass: OFF (click to turn ON)',
      newTabToggleOn: '✅ Open in New Tab: ON (click to turn OFF)',
      newTabToggleOff: '❌ Open in New Tab: OFF (click to turn ON)',
      viewDisabledSites: '📋 View disabled site list',
      toastRedirectOn: '✅ "Redirect Bypass" enabled globally (already-loaded pages are not affected)',
      toastRedirectOff: '❌ "Redirect Bypass" disabled globally (takes effect on newly opened pages)',
      toastNewTabOn: '✅ "Open in New Tab" enabled on this site',
      toastNewTabOff: '❌ "Open in New Tab" disabled on this site',
      disabledSitesHeader: 'Disabled sites:',
      noDisabledSites: 'No disabled sites yet.',
      confirmLabel: (url) => `🚀 External link detected: ${url}`,
      confirmJump: 'Go now',
      confirmStay: 'Stay here',
      confirmRemember: 'Remember for this site',
    },
    zh: {
      redirectToggleOn: '✅ 外链直达：已开启（点击停用）',
      redirectToggleOff: '❌ 外链直达：已关闭（点击开启）',
      newTabToggleOn: '✅ 新标签打开：已开启（点击停用）',
      newTabToggleOff: '❌ 新标签打开：已关闭（点击开启）',
      viewDisabledSites: '📋 查看已禁用的网站列表',
      toastRedirectOn: '✅ 「外链直达」已全局启用（已加载的页面不受影响）',
      toastRedirectOff: '❌ 「外链直达」已全局停用（新打开的页面立即生效）',
      toastNewTabOn: '✅ 本站已启用「新标签打开」',
      toastNewTabOff: '❌ 本站已禁用「新标签打开」',
      disabledSitesHeader: '当前禁用的网站：',
      noDisabledSites: '当前没有禁用的网站。',
      confirmLabel: (url) => `🚀 检测到外链：${url}`,
      confirmJump: '立即直达',
      confirmStay: '留在此页',
      confirmRemember: '记住本站',
    },
  };

  const pageLang = String(navigator.language || 'en').toLowerCase();
  const t = MESSAGES[pageLang.startsWith('zh') ? 'zh' : 'en'];

  // ============================ 外链直达（Redirect Detection） ============================
  // 方案：.plans/link-redirect-interstitial-detection.plan.md
  // 对当前页所有 query 参数跑「解码链 → 校验 → 打分」，命中跳转中间页特征即 location.replace 直达。
  // 分级：score ≥ 6 自动跳；score = 5 灰区弹确认条（可记住本站选择）；score < 5 忽略。

  const redirectEnabled = () => storage.get(KEY_REDIRECT_ENABLED, true) !== false;

  const getDecisions = () => {
    const d = storage.get(KEY_REDIRECT_DECISIONS, {});
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  };

  const setDecision = (site, value) => {
    const d = getDecisions();
    d[site] = value;
    storage.set(KEY_REDIRECT_DECISIONS, d);
  };

  /**
   * 有界 percent-decode：仅当值以编码形式的 scheme 开头（https%(25)*3a 式多重编码）才解码，最多 3 层。
   * 只解码"明显是编码过的 URL"，避免把普通参数值里的 % 序列误当编码。
   */
  function percentDecodeBounded(value) {
    let target = value;
    for (let i = 0; i < 3 && /^https?%(?:25)*3a/i.test(target); i++) {
      try {
        target = decodeURIComponent(target);
      } catch (_) {
        return null;
      }
    }
    return target;
  }

  /**
   * 前置门禁：值必须"长得像 URL"才允许进入协议补全，
   * 防止任意字符串（base64 文本、普通参数值）被补全成 https:// 而误判。
   * 合法形态：完整 scheme、//host 开头、或 host[.host][:port] 点分域名。
   */
  function looksLikeUrl(value) {
    if (/^https?:\/\//i.test(value)) return true;
    if (value.startsWith('//')) return true;
    return /^[a-z\d-]+(?:\.[a-z\d-]+)+(:\d+)?(?:[/?#]|$)/i.test(value);
  }

  /**
   * 解码链核心：归一化候选目标地址。
   * 输入已通过 looksLikeUrl 门禁；协议补全（//host、host:port、裸域名）→ 合法性校验。
   * 非法（非 http/https、解析失败）返回 null。
   */
  function normalizeDestination(value) {
    let target = value;
    if (target.startsWith('//')) target = `https:${target}`;
    const hostWithPort = /^(?:localhost|(?:[a-z\d-]+\.)+[a-z\d-]+):\d+(?:[/?#]|$)/i.test(target);
    if (!/^[a-z][a-z\d+.-]*:/i.test(target) || hostWithPort) target = `https://${target}`;
    try {
      const url = new URL(target);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? target : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * 取参数值的候选目标，按解码链依次尝试：
   * ① 有界 percent-decode 后形如 URL → 归一化；
   * ② 值形如纯 base64（含 URL-safe 变体）→ atob 解码，再走 ①。
   */
  function decodeCandidates(raw) {
    const decoded = percentDecodeBounded(raw);
    if (decoded && looksLikeUrl(decoded)) {
      const direct = normalizeDestination(decoded);
      if (direct) return [direct];
    }
    if (!/^[A-Za-z0-9+/_-]{8,}={0,2}$/.test(raw)) return [];
    try {
      const b64 = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
      const fromBase64 = percentDecodeBounded(b64);
      if (fromBase64 && looksLikeUrl(fromBase64)) {
        const target = normalizeDestination(fromBase64);
        if (target) return [target];
      }
    } catch (_) { /* ignore */ }
    return [];
  }

  // 打分用的语义特征（源自对 60+ 站点规则的提炼，见方案文档）
  const REDIRECT_PARAM_NAMES = new Set([
    'url', 'target', 'q', 'goto', 'href', 'uri', 'jump', 'redirect',
    'link', 'u', 'gourl', 'pfurl', 'remoteurl', 'toasturl',
  ]);
  const REDIRECT_PATH_RE = /\/(?:url|link|jump|redirect|redir|goto|outlink|safetip|safety|linkfilter|transfer|forward|middlepage|safecheck|uriconfirm)(?:[-./]|$)/i;
  const REDIRECT_BLOCK_PATH_RE = /oauth|authorize|login|signin|log-?in|sso|auth\b/i; // 登录/授权流程不干预
  const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i;

  /**
   * 评估单个 query 参数。
   * 硬校验（不通过直接否决）：目标为合法 http(s) URL、host ≠ 当前页、非本机地址、不等于当前 URL。
   * 打分：完整 URL 且跨站 +5（中间页的定义性特征）；参数名/路径命中跳转语义各 +1；搜索结果页 -2。
   */
  function evaluateParam(name, raw, currentUrl, isSearchPage) {
    const [target] = decodeCandidates(raw);
    if (!target) return null;

    let dest;
    try {
      dest = new URL(target);
    } catch (_) {
      return null;
    }
    if (dest.hostname === currentUrl.hostname) return null;
    if (LOCAL_HOST_RE.test(dest.hostname)) return null;
    if (dest.href === currentUrl.href) return null;

    let score = 5;
    if (REDIRECT_PARAM_NAMES.has(name.toLowerCase())) score += 1;
    if (REDIRECT_PATH_RE.test(currentUrl.pathname)) score += 1;
    if (isSearchPage) score -= 2;
    return { target, score };
  }

  function jumpTo(target) {
    // 记录本次跳转供回跳防护判断（A→B 后 B 又要跳回 A 时放弃）
    storage.set(KEY_BOUNCE_GUARD, { from: location.href, to: target, t: Date.now() });
    location.replace(target);
  }

  /** 灰区确认条：score = 5 时弹出，用户可选择直达或留下，并记住本站决定 */
  function showRedirectConfirm(targetUrl) {
    const box = document.createElement('div');
    box.style.cssText = [
      'position: fixed',
      'left: 50%',
      'top: 24px',
      'transform: translateX(-50%)',
      'z-index: 2147483647',
      'display: flex',
      'align-items: center',
      'gap: 10px',
      'font: 13px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      'padding: 10px 14px',
      'border-radius: 10px',
      'background: rgba(30, 30, 30, 0.92)',
      'color: #fff',
      'box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35)',
      'max-width: 86vw',
    ].join(';');

    const label = document.createElement('span');
    label.style.cssText = 'white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 44vw;';
    label.title = targetUrl;
    label.textContent = t.confirmLabel(targetUrl);

    const makeBtn = (text, primary) => {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.style.cssText = [
        'flex: none',
        'padding: 4px 10px',
        'border: none',
        'border-radius: 6px',
        'cursor: pointer',
        'font: inherit',
        primary ? 'background: #4f8cff' : 'background: rgba(255, 255, 255, 0.16)',
        'color: #fff',
      ].join(';');
      return btn;
    };

    const chkWrap = document.createElement('label');
    chkWrap.style.cssText = 'flex: none; display: flex; align-items: center; gap: 4px; cursor: pointer;';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    const chkText = document.createElement('span');
    chkText.textContent = t.confirmRemember;
    chkWrap.append(chk, chkText);

    const btnJump = makeBtn(t.confirmJump, true);
    const btnStay = makeBtn(t.confirmStay, false);

    btnJump.addEventListener('click', () => {
      if (chk.checked) setDecision(host, 'auto');
      jumpTo(targetUrl);
    });
    btnStay.addEventListener('click', () => {
      if (chk.checked) setDecision(host, 'never');
      box.remove();
    });

    box.append(label, btnJump, btnStay, chkWrap);
    (document.body || document.documentElement).appendChild(box);
  }

  function runRedirectDetection() {
    if (!redirectEnabled()) return;
    if (!location.search) return;

    const url = new URL(location.href);

    // 登录/授权页不干预（其 ?redirect_uri= 之类参数是正常业务）
    if (REDIRECT_BLOCK_PATH_RE.test(url.pathname)) return;

    // 搜索结果页降权：URL 形态的搜索词不应触发跳转
    const isSearchPage = url.pathname === '/s' || url.pathname === '/so' || /search|results|query/i.test(url.pathname);

    let best = null;
    for (const [name, raw] of url.searchParams.entries()) {
      const result = evaluateParam(name, raw, url, isSearchPage);
      if (result && (!best || result.score > best.score)) best = result;
    }
    if (!best) return;

    // 回跳防护：刚从 B 跳来、B 又要跳回去，且间隔很短 → 判定为循环，放弃
    const guard = storage.get(KEY_BOUNCE_GUARD, null);
    if (
      guard && typeof guard === 'object' &&
      Date.now() - guard.t < 10000 &&
      location.href === guard.to &&
      best.target === guard.from
    ) return;

    // 已记住的本站决定优先于打分
    const decision = getDecisions()[host];
    if (decision === 'never') return;
    if (decision === 'auto' || best.score >= 6) {
      jumpTo(best.target);
      return;
    }
    if (best.score === 5) showRedirectConfirm(best.target);
    // score < 5：证据不足，保持原样
  }

  // document-start 同步执行：渲染前完成跳转，用户无感
  runRedirectDetection();

  // ============================ 核心逻辑（新标签打开） ============================

  let enabledOnThisSite = !getDisabledSites().includes(host);

  /**
   * 链接卡片内可能存在的"上层操作"元素选择器。
   * 命中这些元素时，说明用户点的是卡片内嵌的按钮/下拉/输入框等，
   * 而不是链接本身 —— 此时必须跳过，交由站点自己的逻辑处理。
   */
  const OVERLAY_SELECTOR = [
    'button',
    'input',
    'select',
    'textarea',
    'summary',
    'label',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="menu"]',
    '[role="option"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[contenteditable]',
    '[onclick]',
    '[jsaction]',
    '[data-toggle]',
    '[data-action]',
    '[data-bs-toggle]',
  ].join(',');

  function shouldOpenInNewTab(anchor) {
    const href = anchor.getAttribute('href');
    if (!href || href === '#' || href.toLowerCase().startsWith('javascript:')) return false;

    // 仅处理 http(s) 链接，mailto/tel 等交给浏览器原生行为
    let url;
    try {
      url = new URL(href, location.href);
    } catch (_) {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

    // 下载链接、已有 target 的链接、rel 含 opener 语义的不再干预
    if (anchor.hasAttribute('download')) return false;
    if (anchor.target && anchor.target !== '_self') return false;

    return true;
  }

  function handleClick(event) {
    if (!enabledOnThisSite) return;

    // 修饰键/非左键点击时浏览器原生已能新标签打开或新窗口，不干预
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (event.defaultPrevented) return;
    if (!(event.target instanceof Element)) return;

    const anchor = event.target.closest('a[href]');
    if (!anchor) return;

    // 关键：点击命中的是链接内嵌的"上层操作"元素（按钮/下拉/输入等）时跳过，
    // 不改变 target，避免影响站点的卡片式交互。
    const overlay = event.target.closest(OVERLAY_SELECTOR);
    if (overlay && overlay !== anchor && anchor.contains(overlay)) return;

    if (!shouldOpenInNewTab(anchor)) return;

    // 捕获阶段先把 target 设为 _blank，再在事件结束后还原。
    // 若站点脚本在冒泡阶段 preventDefault（SPA 路由、自定义弹层），
    // 默认导航不会发生，还原后 DOM 恢复原样，互不影响。
    const originalTarget = anchor.getAttribute('target');
    anchor.target = '_blank';

    setTimeout(() => {
      if (originalTarget === null) {
        anchor.removeAttribute('target');
      } else {
        anchor.setAttribute('target', originalTarget);
      }
    }, 0);
  }

  // document-start + 捕获阶段，保证在站点自己的处理器之前拿到事件
  document.addEventListener('click', handleClick, true);

  // ============================ 站点禁用开关（新标签打开） ============================

  function toggleThisSite() {
    const list = getDisabledSites();
    if (enabledOnThisSite) {
      if (!list.includes(host)) list.push(host);
      enabledOnThisSite = false;
    } else {
      const idx = list.indexOf(host);
      if (idx !== -1) list.splice(idx, 1);
      enabledOnThisSite = true;
    }
    setDisabledSites(list);
    toast(enabledOnThisSite ? t.toastNewTabOn : t.toastNewTabOff);
  }

  function showSiteList() {
    const list = getDisabledSites();
    const msg = list.length
      ? t.disabledSitesHeader + '\n' + list.map((h) => '  • ' + h).join('\n')
      : t.noDisabledSites;
    alert(msg);
  }

  // ============================ 全局开关（外链直达） ============================

  function toggleRedirectGlobal() {
    const next = !redirectEnabled();
    storage.set(KEY_REDIRECT_ENABLED, next);
    toast(next ? t.toastRedirectOn : t.toastRedirectOff);
  }

  // ============================ 轻提示 ============================

  function toast(text) {
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = [
      'position: fixed',
      'left: 50%',
      'top: 24px',
      'transform: translateX(-50%)',
      'z-index: 2147483647',
      'font: 13px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      'padding: 8px 16px',
      'border-radius: 8px',
      'background: rgba(30, 30, 30, 0.88)',
      'color: #fff',
      'box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3)',
      'pointer-events: none',
      'opacity: 0',
      'transition: opacity 0.2s ease',
    ].join(';');
    document.documentElement.appendChild(el);
    requestAnimationFrame(() => (el.style.opacity = '1'));
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 250);
    }, 1600);
  }

  // ============================ 菜单命令 ============================

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand(
      redirectEnabled() ? t.redirectToggleOn : t.redirectToggleOff,
      toggleRedirectGlobal
    );
    GM_registerMenuCommand(
      enabledOnThisSite ? t.newTabToggleOn : t.newTabToggleOff,
      toggleThisSite
    );
    GM_registerMenuCommand(t.viewDisabledSites, showSiteList);
  }
})();
