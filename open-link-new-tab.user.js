// ==UserScript==
// @name         链接新标签打开 (Open Links in New Tab)
// @namespace    https://github.com/fanghaydn
// @version      3.0.2
// @description  按白名单/黑名单规则控制链接新标签打开，支持 URL 通配符、快捷键、配置导入导出；并提供独立外链直达。
// @author       fanghaydn
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addValueChangeListener
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

  const host = location.hostname;
  const KEY_CONFIG = 'oint_config_v1';
  const KEY_GLOBAL = 'oint_policy_global_v1';
  const KEY_LEGACY_MIGRATED = 'oint_policy_legacy_migrated_v1';
  const KEY_DISABLED_MIGRATED = 'oint_policy_blocklist_migrated_v1';
  const PROFILE_KEYS = {
    blocklist: 'oint_policy_blocklist_v1',
    allowlist: 'oint_policy_allowlist_v1',
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));
  const text = (zh, en) => String(navigator.language || 'en').toLowerCase().startsWith('zh') ? zh : en;

  function defaultGlobalConfig() {
    return {
      version: 1,
      enabled: true,
      activeMode: 'blocklist',
      shortcuts: {
        toggleCurrentSite: 'Alt+Shift+O', openSettings: 'Alt+Shift+L',
        toggleSessionPause: 'Alt+Shift+P',
      },
    };
  }

  function defaultProfile(mode) {
    const blocklist = mode === 'blocklist';
    return {
      version: 1,
      mode,
      rules: blocklist ? [{
        id: 'google-search', name: 'Google search', enabled: true,
        source: ['https://www.google.com/search*', 'https://*.google.com/search*'],
        action: 'native',
      }] : [],
      behavior: {
        skipSameDocument: true, respectExistingTarget: true,
        respectSitePreventDefault: true, skipInteractiveChildren: true,
      },
    };
  }

  // Compile only our small glob language, never user-supplied regular expressions.
  function globRegex(glob, wildcard, deepWildcard = wildcard, flags = '') {
    let result = '^';
    for (let i = 0; i < glob.length; i++) {
      if (glob[i] === '*') {
        if (glob[i + 1] === '*') { result += deepWildcard; i++; }
        else result += wildcard;
      } else result += glob[i].replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
    return new RegExp(result + '$', flags);
  }

  function compilePattern(pattern) {
    if (typeof pattern !== 'string' || pattern.length > 2048) throw new Error('Invalid URL pattern');
    const parts = /^(https?|\*):\/\/(\[[a-f\d:]+\]|[^/:?#]+)(?::(\d+))?(\/[^?#]*)$/i.exec(pattern);
    if (!parts) throw new Error(`Invalid pattern: ${pattern}. Use https://example.com/** (no query/hash).`);
    const [, scheme, hostname, port, path] = parts;
    if (port && (+port < 1 || +port > 65535)) throw new Error(`Invalid port: ${pattern}`);
    if (hostname.includes('**') || /[^a-z\d.*\-[\]:]/i.test(hostname)) throw new Error(`Invalid host: ${pattern}`);
    const hostRegex = hostname === '*' ? /^.+$/ : globRegex(hostname, '[^.]+', '[^.]+', 'i');
    const pathRegex = globRegex(path, '[^/]*', '.*');
    return (url) => (scheme === '*' || url.protocol === scheme.toLowerCase() + ':') &&
      hostRegex.test(url.hostname) && (!port || +port === +(url.port || (url.protocol === 'https:' ? 443 : 80))) &&
      pathRegex.test(url.pathname);
  }

  function parseShortcut(value) {
    if (value === '') return '';
    if (typeof value !== 'string') throw new Error('Shortcut must be a string');
    const parts = value.split('+');
    const key = parts.pop();
    if (!/^[a-z\d]$/i.test(key) || !parts.includes('Alt') || !parts.includes('Shift') ||
        parts.some((p) => !['Alt', 'Shift'].includes(p)) || new Set(parts).size !== parts.length) {
      throw new Error(`Invalid shortcut: ${value}. Use Alt+Shift+letter/number, or empty to disable.`);
    }
    return ['Ctrl', 'Alt', 'Shift', 'Meta'].filter((p) => parts.includes(p)).concat(key.toUpperCase()).join('+');
  }

  function validateGlobalConfig(input) {
    const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const keys = (v, allowed, path) => {
      if (!object(v)) throw new Error(`${path} must be an object`);
      for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new Error(`Unknown field: ${path}.${key}`);
    };
    keys(input, ['version', 'enabled', 'activeMode', 'shortcuts'], 'global');
    if (input.version !== 1 || typeof input.enabled !== 'boolean' || !['blocklist', 'allowlist'].includes(input.activeMode)) {
      throw new Error('Invalid global policy configuration');
    }
    const defaults = defaultGlobalConfig();
    keys(input.shortcuts, Object.keys(defaults.shortcuts), 'shortcuts');
    const shortcuts = new Set();
    const result = clone(input);
    for (const key of Object.keys(defaults.shortcuts)) {
      const binding = parseShortcut(input.shortcuts[key]);
      if (binding && shortcuts.has(binding)) throw new Error(`Shortcut conflict: ${binding}`);
      if (binding) shortcuts.add(binding);
      result.shortcuts[key] = binding;
    }
    return result;
  }

  function validateProfile(input, mode) {
    const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    const keys = (v, allowed, path) => {
      if (!object(v)) throw new Error(`${path} must be an object`);
      for (const key of Object.keys(v)) if (!allowed.includes(key)) throw new Error(`Unknown field: ${path}.${key}`);
    };
    keys(input, ['version', 'mode', 'rules', 'behavior'], 'profile');
    if (input.version !== 1 || input.mode !== mode) throw new Error(`Invalid ${mode} profile`);
    const actions = ['new-tab', 'native'];
    if (!Array.isArray(input.rules) || input.rules.length > 500) throw new Error('rules must be an array (max 500)');
    const result = clone(input);
    const ids = new Set();
    result.rules.forEach((rule, index) => {
      const path = `rules[${index}]`;
      keys(rule, ['id', 'name', 'enabled', 'source', 'destination', 'linkType', 'query', 'action'], path);
      if (typeof rule.id !== 'string' || !rule.id || rule.id.length > 200 || ids.has(rule.id)) throw new Error(`${path}: invalid/duplicate id`);
      ids.add(rule.id);
      if (typeof rule.name !== 'string' || rule.name.length > 200 || typeof rule.enabled !== 'boolean' || !actions.includes(rule.action)) {
        throw new Error(`${path}: invalid name, enabled or action`);
      }
      for (const side of ['source', 'destination']) {
        if (rule[side] !== undefined) {
          if (!Array.isArray(rule[side]) || !rule[side].length || rule[side].length > 100) throw new Error(`${path}.${side}: expected 1-100 patterns`);
          rule[side].forEach(compilePattern);
        }
      }
      if (rule.linkType !== undefined && !['all', 'same-origin', 'cross-origin'].includes(rule.linkType)) throw new Error(`${path}: invalid linkType`);
      if (rule.query !== undefined) {
        keys(rule.query, ['source', 'destination'], `${path}.query`);
        for (const side of Object.keys(rule.query)) {
          if (!object(rule.query[side]) || Object.keys(rule.query[side]).length > 100) throw new Error(`${path}.query.${side}: expected parameter map (max 100)`);
          for (const value of Object.values(rule.query[side])) {
            if (typeof value !== 'string' || value.length > 2048) throw new Error(`${path}.query: invalid value glob`);
          }
        }
      }
    });
    const defaults = defaultProfile(mode);
    keys(input.behavior, Object.keys(defaults.behavior), 'behavior');
    for (const key of Object.keys(defaults.behavior)) if (typeof input.behavior[key] !== 'boolean') throw new Error(`behavior.${key} must be boolean`);
    if (!input.behavior.respectSitePreventDefault) throw new Error('respectSitePreventDefault must remain true; forced SPA navigation is not supported');
    return result;
  }

  function compileRules(profile) {
    return profile.rules.map((rule) => {
      const matchers = {};
      for (const side of ['source', 'destination']) {
        if (rule[side]) matchers[side] = rule[side].map(compilePattern);
      }
      const queries = {};
      for (const [side, params] of Object.entries(rule.query || {})) {
        queries[side] = Object.entries(params).map(([name, value]) => [name, globRegex(value, '.*')]);
      }
      return { rule, matchers, queries };
    });
  }

  function resolvePolicy(global, profile, compiled, source, destination, paused = false) {
    if (!global.enabled || paused) return { action: 'native', reason: paused ? 'paused' : 'disabled' };
    for (const { rule, matchers, queries } of compiled) {
      if (!rule.enabled) continue;
      const urls = { source, destination };
      if (Object.entries(matchers).some(([side, patterns]) => !patterns.some((match) => match(urls[side])))) continue;
      const same = source.origin === destination.origin;
      if (rule.linkType === 'same-origin' && !same || rule.linkType === 'cross-origin' && same) continue;
      if (Object.entries(queries).some(([side, params]) => params.some(([name, re]) => !urls[side].searchParams.getAll(name).some((v) => re.test(v))))) continue;
      return { action: rule.action, reason: rule.name || rule.id, ruleId: rule.id };
    }
    return { action: profile.mode === 'blocklist' ? 'new-tab' : 'native', reason: 'default' };
  }

  function migrateLegacyConfig() {
    const saved = storage.get(KEY_CONFIG, null);
    if (saved === null) return null;
    try {
      if (!saved || saved.version !== 1 || !['new-tab', 'native'].includes(saved.defaultAction)) throw new Error('Unsupported legacy config');
      const mode = saved.defaultAction === 'new-tab' ? 'blocklist' : 'allowlist';
      return {
        global: {
          version: 1, enabled: saved.enabled === true, activeMode: mode,
          shortcuts: saved.shortcuts || defaultGlobalConfig().shortcuts,
        },
        profiles: {
          [mode]: {
            version: 1, mode, rules: saved.rules,
            behavior: saved.behavior || defaultProfile(mode).behavior,
          },
        },
      };
    } catch (error) {
      console.warn('[Open Links] Legacy config could not be migrated.', error);
      return null;
    }
  }

  function loadPolicy() {
    const legacy = migrateLegacyConfig();
    const legacyPending = legacy && storage.get(KEY_LEGACY_MIGRATED, false) !== true;
    if (legacyPending) for (const mode of Object.keys(legacy.profiles)) storage.set(PROFILE_KEYS[mode], legacy.profiles[mode]);
    let global = storage.get(KEY_GLOBAL, null);
    if (global === null) {
      global = legacyPending ? legacy.global : defaultGlobalConfig();
      storage.set(KEY_GLOBAL, global);
    } else if (legacyPending) {
      global = legacy.global;
      storage.set(KEY_GLOBAL, global);
    }
    try { global = validateGlobalConfig(global); }
    catch (error) {
      console.warn('[Open Links] Invalid global policy config; link handling paused. Open settings to repair.', error);
      global = { ...defaultGlobalConfig(), enabled: false };
    }

    const profiles = {};
    for (const mode of Object.keys(PROFILE_KEYS)) {
      let profile = storage.get(PROFILE_KEYS[mode], null);
      if (profile === null && legacy && legacy.profiles[mode]) profile = legacy.profiles[mode];
      if (profile === null) profile = defaultProfile(mode);
      try { profile = validateProfile(profile, mode); }
      catch (error) {
        console.warn(`[Open Links] Invalid ${mode} profile; new-tab handling paused. Open settings to repair.`, error);
        profile = { ...defaultProfile(mode), rules: [] };
        global.enabled = false;
      }
      storage.set(PROFILE_KEYS[mode], profile);
      profiles[mode] = profile;
    }
    if (legacyPending) storage.set(KEY_LEGACY_MIGRATED, true);
    if (storage.get(KEY_DISABLED_MIGRATED, false) !== true) {
      profiles.blocklist = validateProfile(loadLegacyDisabledSites(), 'blocklist');
      storage.set(PROFILE_KEYS.blocklist, profiles.blocklist);
      storage.set(KEY_DISABLED_MIGRATED, true);
    }
    return { global, profiles };
  }

  let policy = loadPolicy();
  let config = policy.global;
  let profile = policy.profiles[config.activeMode];

  function activeProfile() { return policy.profiles[config.activeMode]; }

  function loadLegacyDisabledSites() {
    const blocklist = defaultProfile('blocklist');
    // Keep hostname semantics (both schemes, any port), without deleting the legacy backup.
    for (const hostname of getDisabledSites()) {
      try {
        compilePattern(`*://${hostname}/**`);
        blocklist.rules.unshift({ id: `site:${hostname}`, name: hostname, enabled: true, source: [`*://${hostname}/**`], action: 'native' });
      } catch (_) { /* Skip malformed legacy hosts. */ }
    }
    return blocklist;
  }

  let compiledRules = compileRules(activeProfile());
  let sessionPaused = false;
  let settingsHost = null;
  const menuIds = [];

  function savePolicy(nextGlobal, nextProfiles) {
    const validatedGlobal = validateGlobalConfig(nextGlobal);
    const validatedProfiles = Object.fromEntries(Object.keys(PROFILE_KEYS).map((mode) => [mode, validateProfile(nextProfiles[mode], mode)]));
    storage.set(KEY_GLOBAL, validatedGlobal);
    for (const mode of Object.keys(PROFILE_KEYS)) storage.set(PROFILE_KEYS[mode], validatedProfiles[mode]);
    // Read back before replacing the in-memory policy, including localStorage fallback failures.
    if (JSON.stringify(storage.get(KEY_GLOBAL, null)) !== JSON.stringify(validatedGlobal) ||
        Object.keys(PROFILE_KEYS).some((mode) => JSON.stringify(storage.get(PROFILE_KEYS[mode], null)) !== JSON.stringify(validatedProfiles[mode]))) {
      throw new Error('Could not save configuration');
    }
    policy = { global: validatedGlobal, profiles: validatedProfiles };
    config = policy.global;
    profile = activeProfile();
    compiledRules = compileRules(profile);
    registerMenus();
  }

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
    if (!href || !href.trim() || href.trim().toLowerCase().startsWith('javascript:')) return false;

    // 仅处理 http(s) 链接，mailto/tel 等交给浏览器原生行为
    let url;
    try {
      url = new URL(href, location.href);
    } catch (_) {
      return false;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const source = new URL(location.href);
    if (profile.behavior.skipSameDocument && sameDocument(source, url)) return false;

    if (anchor.hasAttribute('download')) return false;
    if (profile.behavior.respectExistingTarget && anchor.target && anchor.target !== '_self') return false;

    return resolvePolicy(config, profile, compiledRules, source, url, sessionPaused).action === 'new-tab';
  }

  function sameDocument(source, destination) {
    return source.origin === destination.origin && source.pathname === destination.pathname && source.search === destination.search;
  }

  const pendingTargets = new WeakMap();

  function handleClick(event) {
    if (!config.enabled || sessionPaused) return;

    // 修饰键/非左键点击时浏览器原生已能新标签打开或新窗口，不干预
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    if (event.defaultPrevented) return;
    if (!(event.target instanceof Element)) return;

    const anchor = event.target.closest('a[href]');
    if (!anchor) return;

    // 关键：点击命中的是链接内嵌的"上层操作"元素（按钮/下拉/输入等）时跳过，
    // 不改变 target，避免影响站点的卡片式交互。
    const overlay = event.target.closest(OVERLAY_SELECTOR);
    if (profile.behavior.skipInteractiveChildren && overlay && overlay !== anchor && anchor.contains(overlay)) return;

    if (!shouldOpenInNewTab(anchor)) return;

    // 捕获阶段先把 target 设为 _blank，再在事件结束后还原。
    // 若站点脚本在冒泡阶段 preventDefault（SPA 路由、自定义弹层），
    // 默认导航不会发生，还原后 DOM 恢复原样，互不影响。
    const pending = pendingTargets.get(anchor);
    const originalTarget = pending ? pending.originalTarget : anchor.getAttribute('target');
    if (pending) clearTimeout(pending.timer);
    anchor.target = '_blank';

    const timer = setTimeout(() => {
      // Do not overwrite a target changed by the site's own event handler.
      if (anchor.getAttribute('target') === '_blank') {
        if (originalTarget === null) anchor.removeAttribute('target');
        else anchor.setAttribute('target', originalTarget);
      }
      pendingTargets.delete(anchor);
    }, 0);
    pendingTargets.set(anchor, { originalTarget, timer });
  }

  // document-start + 捕获阶段，保证在站点自己的处理器之前拿到事件
  document.addEventListener('click', handleClick, true);

  // ============================ 站点覆盖与快捷键 ============================

  function setSiteAction(action) {
    try {
      const hostname = location.hostname;
      const nextProfiles = clone(policy.profiles);
      const next = nextProfiles[config.activeMode];
      next.rules = next.rules.filter((rule) => rule.id !== `site:${hostname}`);
      if (action !== 'inherit') next.rules.unshift({
        id: `site:${hostname}`, name: hostname, enabled: true, source: [`*://${hostname}/**`], action,
      });
      savePolicy(clone(config), nextProfiles);
      toast(`${hostname}: ${actionLabel(action)}`);
    } catch (error) { toast(error.message); }
  }

  function actionLabel(action) {
    return action === 'new-tab' ? text('新标签打开（白名单）', 'New tab (allow)') :
      action === 'native' ? text('网站原生（黑名单）', 'Website default (deny)') : text('继承规则', 'Inherit rules');
  }

  function toggleThisSite() {
    const source = new URL(location.href);
    const result = resolvePolicy({ ...config, enabled: true }, profile, compiledRules, source, source);
    setSiteAction(result.action === 'new-tab' ? 'native' : 'new-tab');
  }

  function toggleSessionPause() {
    sessionPaused = !sessionPaused;
    registerMenus();
    toast(sessionPaused ? text('当前页面已暂停接管（外链直达不受影响）', 'Paused on this page (redirect bypass is separate)') : text('当前页面已恢复接管', 'Resumed on this page'));
  }

  function shortcutFromEvent(event) {
    // Physical letter keys keep Option shortcuts usable on macOS (event.key may be a symbol).
    const match = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code || '');
    const key = match ? match[1] || match[2] : /^[a-z\d]$/i.test(event.key) ? event.key.toUpperCase() : '';
    if (!key) return '';
    return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+');
  }

  function handleShortcut(event) {
    if (event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229) return;
    const path = event.composedPath();
    if (path.some((node) => node instanceof Element && (node.matches('input,textarea,select,[contenteditable]:not([contenteditable="false"])') || node.isContentEditable))) return;
    if (settingsHost) return;
    const binding = shortcutFromEvent(event);
    const command = Object.keys(config.shortcuts).find((key) => binding && config.shortcuts[key] === binding);
    if (!command) return;
    event.preventDefault();
    if (command === 'openSettings') openSettings();
    else if (command === 'toggleCurrentSite') toggleThisSite();
    else toggleSessionPause();
  }

  document.addEventListener('keydown', handleShortcut, true);

  if (typeof GM_addValueChangeListener === 'function') {
    for (const key of [KEY_GLOBAL, ...Object.values(PROFILE_KEYS)]) GM_addValueChangeListener(key, (_key, _old, value, remote) => {
      if (!remote) return;
      try {
        policy = loadPolicy();
        config = policy.global;
        profile = activeProfile();
        compiledRules = compileRules(profile);
        registerMenus();
      } catch (_) { /* Keep the last valid policy on invalid remote writes. */ }
    });
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    if (menuIds.length && typeof GM_unregisterMenuCommand !== 'function') return;
    menuIds.splice(0).forEach((id) => GM_unregisterMenuCommand(id));
    const add = (label, handler) => menuIds.push(GM_registerMenuCommand(label, handler));
    add(text('设置 / 白黑名单 / 配置导入导出', 'Settings / Rules / Import & Export'), openSettings);
    const site = profile.rules.find((rule) => rule.id === `site:${location.hostname}` && rule.enabled);
    for (const action of ['new-tab', 'native', 'inherit']) {
      const selected = site ? site.action === action : action === 'inherit';
      add(`${selected ? '●' : '○'} ${text('本站', 'This site')}: ${actionLabel(action)}`, () => setSiteAction(action));
    }
    add(sessionPaused ? text('恢复当前页面接管', 'Resume this page') : text('暂停当前页面接管', 'Pause this page'), toggleSessionPause);
    add(redirectEnabled() ? t.redirectToggleOn : t.redirectToggleOff, toggleRedirectGlobal);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }

  function patternText(values) { return (values || []).join('\n'); }

  function renderSettings(hostNode) {
    const isZh = String(navigator.language || 'en').toLowerCase().startsWith('zh');
    const words = isZh ? {
      title: '链接策略', subtitle: '按规则决定链接留在当前标签还是新开标签。规则从上到下匹配，第一条命中优先。',
      enabled: '启用链接策略', mode: '当前模式', blocklist: '黑名单模式', allowlist: '白名单模式',
      blocklistHelp: '默认新标签，规则放行网站原生', allowlistHelp: '默认网站原生，规则放行新标签',
      default: '无规则命中时', newTab: '新标签打开', native: '网站原生',
      add: '+ 添加规则', save: '保存策略', close: '关闭', rules: '规则（拖动按钮调整顺序）',
      name: '名称', action: '命中时', source: '来源页面 URL（可留空）', dest: '目标链接 URL（可留空）', type: '链接关系',
      all: '所有链接', same: '同源', cross: '跨源', remove: '删除', up: '上移', down: '下移',
      shortcuts: '快捷键', site: '切换本站策略', settings: '打开设置', pause: '暂停本页', record: '按键录制：点击后按组合键',
      behavior: '兼容选项', anchor: '忽略同页锚点', target: '保留已有 target', controls: '跳过嵌入控件点击',
      advanced: 'JSON 导入 / 导出', copy: '复制当前配置', validate: '导入并校验 JSON',
      test: '规则测试器', srcTest: '来源页面地址', dstTest: '目标链接地址', run: '测试匹配',
      none: '没有规则。新建一条或使用默认行为。', saved: '配置已保存。', importOk: '配置导入成功。',
      sourceHelp: '例如 https://docs.example.com/**', glob: '* 匹配单层；** 匹配任意层级。不含查询参数和锚点。',
    } : {
      title: 'Link policy', subtitle: 'Rules decide whether links stay native or open in a new tab. First match wins.',
      enabled: 'Enable link policy', mode: 'Active mode', blocklist: 'Blocklist mode', allowlist: 'Allowlist mode',
      blocklistHelp: 'New tab by default; rules opt into native', allowlistHelp: 'Native by default; rules opt into new tab',
      default: 'When no rule matches', newTab: 'Open in new tab', native: 'Website default',
      add: '+ Add rule', save: 'Save policy', close: 'Close', rules: 'Rules (use arrows to reorder)',
      name: 'Name', action: 'On match', source: 'Source page URL (optional)', dest: 'Destination URL (optional)', type: 'Link relation',
      all: 'Any link', same: 'Same origin', cross: 'Cross origin', remove: 'Delete', up: 'Move up', down: 'Move down',
      shortcuts: 'Shortcuts', site: 'Toggle this site', settings: 'Open settings', pause: 'Pause this page', record: 'Record: click then press a chord',
      behavior: 'Compatibility', anchor: 'Skip same-page anchors', target: 'Respect existing target', controls: 'Skip interactive children',
      advanced: 'JSON import / export', copy: 'Copy current config', validate: 'Import and validate JSON',
      test: 'Rule tester', srcTest: 'Source page URL', dstTest: 'Destination URL', run: 'Test policy',
      none: 'No rules. Add one or use the default action.', saved: 'Configuration saved.', importOk: 'Configuration imported.',
      sourceHelp: 'Example: https://docs.example.com/**', glob: '* matches one path segment; ** matches any depth. Query/hash excluded.',
    };
    const actionOptions = (selected) => ['new-tab', 'native'].map((action) => `<option value="${action}" ${selected === action ? 'selected' : ''}>${action === 'new-tab' ? escapeHtml(words.newTab) : escapeHtml(words.native)}</option>`).join('');
    const rulesHtml = profile.rules.map((rule, index) => `<article class="oint-rule" data-rule="${index}" data-id="${escapeHtml(rule.id)}" data-query="${escapeHtml(JSON.stringify(rule.query || {}))}">
      <header><strong>#${index + 1}</strong><button type="button" data-move="-1" aria-label="${words.up}" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move="1" aria-label="${words.down}" ${index === profile.rules.length - 1 ? 'disabled' : ''}>↓</button><label><input data-field="enabled" type="checkbox" ${rule.enabled ? 'checked' : ''}> ${escapeHtml(words.enabled)}</label><button type="button" data-remove>${escapeHtml(words.remove)}</button></header>
      <div class="oint-grid"><label>${escapeHtml(words.name)}<input data-field="name" value="${escapeHtml(rule.name)}"></label><label>${escapeHtml(words.action)}<select data-field="action">${actionOptions(rule.action)}</select></label>
      <label>${escapeHtml(words.source)}<textarea data-field="source" placeholder="https://admin.example.com/**">${escapeHtml(patternText(rule.source))}</textarea></label>
      <label>${escapeHtml(words.dest)}<textarea data-field="destination" placeholder="https://github.com/**">${escapeHtml(patternText(rule.destination))}</textarea></label>
      <label>${escapeHtml(words.type)}<select data-field="linkType"><option value="all" ${!rule.linkType || rule.linkType === 'all' ? 'selected' : ''}>${escapeHtml(words.all)}</option><option value="same-origin" ${rule.linkType === 'same-origin' ? 'selected' : ''}>${escapeHtml(words.same)}</option><option value="cross-origin" ${rule.linkType === 'cross-origin' ? 'selected' : ''}>${escapeHtml(words.cross)}</option></select></label></div></article>`).join('');

    hostNode.innerHTML = `<div class="oint-backdrop"><section class="oint-panel" role="dialog" aria-modal="true" aria-labelledby="oint-title" tabindex="-1">
      <header class="oint-head"><div><span class="oint-kicker">OPEN LINK CONTROL / 03</span><h1 id="oint-title">${escapeHtml(words.title)}</h1><p>${escapeHtml(words.subtitle)}</p></div><button type="button" class="oint-close" data-close aria-label="${words.close}">×</button></header>
      <div class="oint-content"><section class="oint-section"><label class="oint-switch"><input id="oint-enabled" type="checkbox" ${config.enabled ? 'checked' : ''}> ${escapeHtml(words.enabled)}</label>
      <div class="oint-mode" role="group" aria-label="${escapeHtml(words.mode)}"><button type="button" data-mode="blocklist" class="${config.activeMode === 'blocklist' ? 'active' : ''}">${escapeHtml(words.blocklist)}<small>${escapeHtml(words.blocklistHelp)}</small></button><button type="button" data-mode="allowlist" class="${config.activeMode === 'allowlist' ? 'active' : ''}">${escapeHtml(words.allowlist)}<small>${escapeHtml(words.allowlistHelp)}</small></button></div>
      <h2>${escapeHtml(words.rules)}</h2><p class="oint-help">${escapeHtml(words.glob)}</p><div id="oint-rules">${rulesHtml || `<p class="oint-empty">${escapeHtml(words.none)}</p>`}</div><button type="button" id="oint-add" class="oint-secondary">${escapeHtml(words.add)}</button></section>
      <section class="oint-section"><h2>${escapeHtml(words.shortcuts)}</h2><p class="oint-help">${escapeHtml(words.record)}</p><div class="oint-shortcuts">${[['toggleCurrentSite', words.site], ['openSettings', words.settings], ['toggleSessionPause', words.pause]].map(([key, label]) => `<label>${escapeHtml(label)}<input data-shortcut="${key}" value="${escapeHtml(config.shortcuts[key])}" placeholder="Disabled"></label>`).join('')}</div></section>
      <section class="oint-section"><h2>${escapeHtml(words.behavior)}</h2><div class="oint-checks">${[['skipSameDocument', words.anchor], ['respectExistingTarget', words.target], ['skipInteractiveChildren', words.controls]].map(([key, label]) => `<label><input data-behavior="${key}" type="checkbox" ${profile.behavior[key] ? 'checked' : ''}> ${escapeHtml(label)}</label>`).join('')}</div></section>
      <section class="oint-section"><h2>${escapeHtml(words.test)}</h2><div class="oint-test"><label>${escapeHtml(words.srcTest)}<input id="oint-test-source" value="${escapeHtml(location.href)}"></label><label>${escapeHtml(words.dstTest)}<input id="oint-test-dest" placeholder="https://example.com/page"></label><button type="button" id="oint-test" class="oint-secondary">${escapeHtml(words.run)}</button></div><output id="oint-test-result" aria-live="polite"></output></section>
      <details class="oint-section"><summary>${escapeHtml(words.advanced)}</summary><p class="oint-help">Versioned JSON. Invalid imports leave the current policy unchanged.</p><textarea id="oint-json" spellcheck="false"></textarea><div class="oint-actions"><button type="button" id="oint-copy" class="oint-secondary">${escapeHtml(words.copy)}</button><button type="button" id="oint-import" class="oint-secondary">${escapeHtml(words.validate)}</button></div></details>
      </div><footer class="oint-foot"><span id="oint-status" role="status"></span><div><button type="button" class="oint-secondary" data-close>${escapeHtml(words.close)}</button><button type="button" id="oint-save" class="oint-primary">${escapeHtml(words.save)}</button></div></footer>
      </section></div>`;
    hostNode.querySelector('#oint-json').value = JSON.stringify({ global: config, profiles: policy.profiles }, null, 2);
    hostNode._words = words;
    // Reattach the persistent stylesheet after replacing the panel markup.
    if (hostNode._style) hostNode.prepend(hostNode._style);
  }

  function openSettings() {
    if (settingsHost) return;
    settingsHost = document.createElement('div');
    settingsHost.id = 'oint-settings';
    // Do not use `all: initial`: inline custom-property reset would override the
    // theme variables below and make the panel/backdrop backgrounds transparent.
    settingsHost.style.cssText = 'position: fixed; inset: 0; z-index: 2147483647; color-scheme: light;';
    const style = document.createElement('style');
    style.textContent = `#oint-settings *{box-sizing:border-box}#oint-settings{--ink:#18201e;--muted:#66736e;--line:#dce3dc;--paper:#f3f4ec;--card:#fffef9;--teal:#176b5b;--rust:#ae512e;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);isolation:isolate}#oint-settings button,#oint-settings input,#oint-settings select,#oint-settings textarea{font:inherit}#oint-settings button{cursor:pointer}#oint-settings .oint-backdrop{position:fixed;inset:0;background-color:#18201e;background-color:rgba(18,29,26,.56);display:grid;place-items:center;padding:18px}#oint-settings .oint-panel{width:min(920px,100%);max-height:min(92vh,1000px);display:flex;flex-direction:column;background-color:#f3f4ec;background-color:var(--paper);border:1px solid rgba(255,255,255,.4);border-radius:18px;box-shadow:0 24px 90px #081b1680;overflow:hidden}#oint-settings .oint-head{display:flex;justify-content:space-between;gap:18px;padding:24px 30px 18px;border-bottom:1px solid var(--line);background:linear-gradient(110deg,#f8f6eb,#e4eee6)}#oint-settings .oint-kicker{font:600 11px/1.4 ui-monospace,monospace;letter-spacing:.12em;color:var(--teal)}#oint-settings h1{font:600 34px/1.1 Georgia,serif;margin:8px 0}#oint-settings h2{font:600 20px/1.2 Georgia,serif;margin:22px 0 8px}#oint-settings p{margin:0;color:var(--muted)}#oint-settings .oint-close{align-self:flex-start;border:0;background:none;font-size:28px;color:var(--muted)}#oint-settings .oint-content{overflow:auto;padding:6px 30px 24px}#oint-settings .oint-section{padding:18px 0;border-bottom:1px solid var(--line)}#oint-settings label{display:grid;gap:5px;font-size:13px;font-weight:600}#oint-settings input:not([type=checkbox]),#oint-settings select,#oint-settings textarea{width:100%;min-width:0;padding:9px 10px;border:1px solid #cbd5cd;border-radius:8px;background-color:#fffef9;background-color:var(--card);color:var(--ink);outline:none}#oint-settings input:focus,#oint-settings select:focus,#oint-settings textarea:focus{border-color:var(--teal);box-shadow:0 0 0 3px #176b5b25}#oint-settings textarea{min-height:76px;resize:vertical;font:12px/1.5 ui-monospace,monospace}#oint-settings .oint-switch{display:flex;align-items:center;gap:8px;font-size:15px}#oint-settings .oint-switch input,#oint-settings input[type=checkbox]{accent-color:var(--teal)}#oint-settings .oint-rule{margin:12px 0;padding:15px;background-color:#fffef9;background-color:var(--card);border:1px solid var(--line);border-radius:12px}#oint-settings .oint-rule header{display:flex;align-items:center;gap:8px;margin-bottom:12px}#oint-settings .oint-rule header strong{margin-right:auto;font:13px ui-monospace,monospace;color:var(--teal)}#oint-settings .oint-rule header button,#oint-settings .oint-secondary{padding:7px 11px;border:1px solid var(--line);border-radius:7px;background:transparent;color:var(--ink)}#oint-settings button:hover{filter:brightness(.94)}#oint-settings button:focus-visible{outline:3px solid #23887580;outline-offset:2px}#oint-settings button:disabled{opacity:.4;cursor:not-allowed}#oint-settings .oint-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}#oint-settings .oint-help{font-size:12px;margin:5px 0 10px}#oint-settings .oint-empty{padding:18px;border:1px dashed var(--line);border-radius:10px}#oint-settings .oint-shortcuts{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}#oint-settings .oint-checks{display:flex;gap:18px;flex-wrap:wrap}#oint-settings .oint-checks label{display:flex;align-items:center}#oint-settings .oint-test{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:end}#oint-settings #oint-test-result{display:block;margin-top:10px;font-weight:600;color:var(--teal)}#oint-settings details summary{cursor:pointer;font-weight:600}#oint-settings #oint-json{margin-top:12px;min-height:220px}#oint-settings .oint-actions{display:flex;gap:8px;margin-top:8px}#oint-settings .oint-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 30px;border-top:1px solid var(--line);background:#faf9f2}#oint-settings .oint-foot>div{display:flex;gap:8px}#oint-settings .oint-primary{padding:9px 16px;border:0;border-radius:8px;background:var(--teal);color:white;font-weight:600}#oint-settings #oint-status{color:var(--rust);font-size:13px}@media(max-width:640px){#oint-settings .oint-backdrop{padding:0}#oint-settings .oint-panel{max-height:100vh;height:100vh;border-radius:0}#oint-settings .oint-head,#oint-settings .oint-content,#oint-settings .oint-foot{padding-left:18px;padding-right:18px}#oint-settings .oint-grid,#oint-settings .oint-shortcuts{grid-template-columns:1fr}#oint-settings .oint-test{grid-template-columns:1fr}#oint-settings .oint-rule header{flex-wrap:wrap}}`;
    style.textContent += `#oint-settings .oint-mode{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:14px 0 4px;padding:4px;border:1px solid var(--line);border-radius:11px;background:#e9ece4}#oint-settings .oint-mode button{display:grid;gap:2px;padding:10px 12px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);text-align:left;font-weight:600}#oint-settings .oint-mode button small{font-size:11px;font-weight:400;line-height:1.35}#oint-settings .oint-mode button.active{border-color:#c9d5cb;background:var(--card);color:var(--ink);box-shadow:0 2px 8px #18201e12}`;
    settingsHost._style = style;
    renderSettings(settingsHost);
    document.documentElement.appendChild(settingsHost);
    settingsHost.addEventListener('click', handleSettingsClick);
    settingsHost.addEventListener('keydown', handleSettingsKeydown);
    settingsHost.querySelector('.oint-panel').focus({ preventScroll: true });
  }

  function closeSettings() {
    if (!settingsHost) return;
    settingsHost.remove();
    settingsHost = null;
  }

  function handleSettingsKeydown(event) {
    if (event.key === 'Escape') { closeSettings(); return; }
    const input = event.target.closest('[data-shortcut]');
    if (!input) return;
    if (event.key === 'Backspace' || event.key === 'Delete') { event.preventDefault(); input.value = ''; return; }
    const binding = shortcutFromEvent(event);
    if (binding && event.code && !event.repeat) { event.preventDefault(); input.value = binding; }
  }

  function readSettingsForm() {
    const nextGlobal = clone(config);
    const nextProfiles = clone(policy.profiles);
    const next = nextProfiles[config.activeMode];
    nextGlobal.enabled = settingsHost.querySelector('#oint-enabled').checked;
    nextGlobal.shortcuts = Object.fromEntries(Array.from(settingsHost.querySelectorAll('[data-shortcut]'), (el) => [el.dataset.shortcut, el.value.trim()]));
    next.behavior.skipSameDocument = settingsHost.querySelector('[data-behavior="skipSameDocument"]').checked;
    next.behavior.respectExistingTarget = settingsHost.querySelector('[data-behavior="respectExistingTarget"]').checked;
    next.behavior.skipInteractiveChildren = settingsHost.querySelector('[data-behavior="skipInteractiveChildren"]').checked;
    next.rules = Array.from(settingsHost.querySelectorAll('.oint-rule'), (card) => {
      const field = (name) => card.querySelector(`[data-field="${name}"]`);
      const patterns = (name) => field(name).value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      const old = next.rules.find((rule) => rule.id === card.dataset.id) || {};
      const rule = {
        id: old.id || `rule:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        name: field('name').value.trim(), enabled: field('enabled').checked,
        action: field('action').value, linkType: field('linkType').value,
      };
      const source = patterns('source'); const destination = patterns('destination');
      if (source.length) rule.source = source;
      if (destination.length) rule.destination = destination;
      const query = JSON.parse(card.dataset.query || '{}');
      if (Object.keys(query).length) rule.query = query;
      return rule;
    });
    return { global: validateGlobalConfig(nextGlobal), profiles: nextProfiles };
  }

  function showPolicyResult(sourceValue, destinationValue, output) {
    try {
      const source = new URL(sourceValue);
      const destination = new URL(destinationValue, source);
      if (!['http:', 'https:'].includes(source.protocol) || !['http:', 'https:'].includes(destination.protocol)) throw new Error('Only HTTP(S) URLs can be tested.');
      const result = resolvePolicy(config, profile, compiledRules, source, destination, sessionPaused);
      output.textContent = `${result.action === 'new-tab' ? text('新标签打开', 'Open in new tab') : text('网站原生行为', 'Website default')} — ${result.reason}`;
    } catch (error) { output.textContent = error.message; }
  }

  function handleSettingsClick(event) {
    if (event.target.classList.contains('oint-backdrop')) { closeSettings(); return; }
    const target = event.target.closest('button');
    if (!target) return;
    if (target.hasAttribute('data-close')) { closeSettings(); return; }
    if (target.dataset.move) {
      const card = target.closest('.oint-rule');
      const cards = Array.from(settingsHost.querySelectorAll('.oint-rule'));
      const index = cards.indexOf(card), other = cards[index + Number(target.dataset.move)];
      if (other) target.dataset.move === '-1' ? other.before(card) : other.after(card);
      Array.from(settingsHost.querySelectorAll('.oint-rule')).forEach((item, i) => { item.dataset.rule = String(i); item.querySelector('header strong').textContent = `#${i + 1}`; });
      return;
    }
    if (target.hasAttribute('data-remove')) {
      target.closest('.oint-rule').remove();
      Array.from(settingsHost.querySelectorAll('.oint-rule')).forEach((item, i) => { item.dataset.rule = String(i); item.querySelector('header strong').textContent = `#${i + 1}`; });
      return;
    }
    if (target.id === 'oint-add') {
      const rule = { id: `rule:${Date.now()}`, name: '', enabled: true, action: 'new-tab' };
      try {
        const draft = readSettingsForm();
        draft.profiles[config.activeMode].rules.push(rule);
        savePolicy(draft.global, draft.profiles);
        renderSettings(settingsHost);
      } catch (error) { settingsHost.querySelector('#oint-status').textContent = error.message; }
      return;
    }
    if (target.dataset.mode) {
      try {
        const draft = readSettingsForm();
        draft.global.activeMode = target.dataset.mode;
        savePolicy(draft.global, draft.profiles);
        renderSettings(settingsHost);
        settingsHost.querySelector('#oint-status').textContent = text('已切换到另一套独立配置。', 'Switched to the other independent profile.');
      } catch (error) { settingsHost.querySelector('#oint-status').textContent = error.message; }
      return;
    }
    if (target.id === 'oint-save') {
      try {
        const draft = readSettingsForm();
        savePolicy(draft.global, draft.profiles);
        settingsHost.querySelector('#oint-json').value = JSON.stringify({ global: config, profiles: policy.profiles }, null, 2);
        settingsHost.querySelector('#oint-status').textContent = settingsHost._words.saved;
      } catch (error) { settingsHost.querySelector('#oint-status').textContent = error.message; }
      return;
    }
    if (target.id === 'oint-import') {
      try {
        const imported = JSON.parse(settingsHost.querySelector('#oint-json').value);
        if (!imported || !imported.global || !imported.profiles) throw new Error('Expected {"global": ..., "profiles": ...}');
        savePolicy(imported.global, imported.profiles);
        renderSettings(settingsHost);
        settingsHost.querySelector('#oint-status').textContent = settingsHost._words.importOk;
      } catch (error) { settingsHost.querySelector('#oint-status').textContent = error.message; }
      return;
    }
    if (target.id === 'oint-copy') {
      const area = settingsHost.querySelector('#oint-json');
      area.value = JSON.stringify({ global: config, profiles: policy.profiles }, null, 2); area.focus(); area.select();
      try { document.execCommand('copy'); settingsHost.querySelector('#oint-status').textContent = text('已复制；也可以直接从文本框复制。', 'Copied; you can also copy directly from the editor.'); }
      catch (_) { settingsHost.querySelector('#oint-status').textContent = text('请从文本框手动复制。', 'Copy from the editor manually.'); }
      return;
    }
    if (target.id === 'oint-test') showPolicyResult(settingsHost.querySelector('#oint-test-source').value, settingsHost.querySelector('#oint-test-dest').value, settingsHost.querySelector('#oint-test-result'));
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
  registerMenus();
})();
