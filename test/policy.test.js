const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function createPolicy() {
  const values = new Map();
  const menus = [];
  const location = new URL('https://docs.example.com/start');
  const context = {
    URL,
    Date,
    Math,
    console,
    setTimeout,
    clearTimeout,
    navigator: { language: 'zh-CN' },
    location: {
      href: location.href,
      hostname: location.hostname,
      protocol: location.protocol,
      search: location.search,
      pathname: location.pathname,
      replace() {},
    },
    document: { addEventListener() {} },
    GM_getValue(key) { return values.get(key); },
    GM_setValue(key, value) { values.set(key, value); },
    GM_registerMenuCommand(label, handler) { menus.push([label, handler]); return menus.length; },
    globalThis: null,
  };
  context.globalThis = context;
  let source = fs.readFileSync(path.join(__dirname, '..', 'open-link-new-tab.user.js'), 'utf8');
  const end = source.lastIndexOf('})();');
  source = `${source.slice(0, end)}globalThis.__policy = { defaultGlobalConfig, defaultProfile, compilePattern, validateGlobalConfig, validateProfile, compileRules, resolvePolicy, parseShortcut, loadPolicy, savePolicy };\n${source.slice(end)}`;
  vm.runInNewContext(source, context, { filename: 'open-link-new-tab.user.js' });
  return { ...context.__policy, values, menus };
}

test('glob patterns match protocol, host boundaries and path depth', () => {
  const { compilePattern } = createPolicy();
  const wildcardProtocol = compilePattern('*://example.com/**');
  assert.equal(wildcardProtocol(new URL('http://example.com/')), true);
  assert.equal(wildcardProtocol(new URL('https://example.com/a/b')), true);
  assert.equal(wildcardProtocol(new URL('https://evil-example.com/a')), false);

  const subdomain = compilePattern('https://*.example.com/docs/*');
  assert.equal(subdomain(new URL('https://api.example.com/docs/start')), true);
  assert.equal(subdomain(new URL('https://example.com/docs/start')), false);
  assert.equal(subdomain(new URL('https://api.example.com/docs/deep/start')), false);
  assert.throws(() => compilePattern('https://example.com/path?x=*'));
});

test('rules use first matching action and fall back to the profile default', () => {
  const { defaultGlobalConfig, defaultProfile, compileRules, resolvePolicy, validateProfile } = createPolicy();
  const global = defaultGlobalConfig();
  const profile = defaultProfile('blocklist');
  profile.rules = [
    { id: 'source-deny', name: 'Admin', enabled: true, source: ['https://docs.example.com/**'], action: 'native' },
    { id: 'destination-allow', name: 'GitHub', enabled: true, destination: ['https://github.com/**'], action: 'new-tab' },
  ];
  const valid = validateProfile(profile, 'blocklist');
  const compiled = compileRules(valid);
  const source = new URL('https://docs.example.com/start');
  assert.equal(resolvePolicy(global, valid, compiled, source, new URL('https://github.com/project')).action, 'native');

  valid.mode = 'allowlist';
  valid.rules.reverse();
  const reordered = compileRules(valid);
  assert.equal(resolvePolicy(global, valid, reordered, source, new URL('https://github.com/project')).action, 'new-tab');
  assert.equal(resolvePolicy(global, valid, reordered, source, new URL('https://elsewhere.test/')).action, 'native');
  assert.equal(resolvePolicy(global, valid, reordered, source, new URL('https://github.com/'), true).reason, 'paused');
});

test('origin and query conditions are conjunctive', () => {
  const { defaultGlobalConfig, defaultProfile, compileRules, resolvePolicy, validateProfile } = createPolicy();
  const global = defaultGlobalConfig();
  const profile = defaultProfile('allowlist');
  profile.rules = [{
    id: 'external-docs', name: 'Docs external', enabled: true,
    source: ['https://docs.example.com/**'], linkType: 'cross-origin',
    query: { destination: { ref: 'campaign-*' } }, action: 'new-tab',
  }];
  const valid = validateProfile(profile, 'allowlist');
  const compiled = compileRules(valid);
  const source = new URL('https://docs.example.com/guide');
  assert.equal(resolvePolicy(global, valid, compiled, source, new URL('https://other.test/?ref=campaign-x')).action, 'new-tab');
  assert.equal(resolvePolicy(global, valid, compiled, source, new URL('https://other.test/?ref=other')).action, 'native');
  assert.equal(resolvePolicy(global, valid, compiled, source, new URL('https://docs.example.com/guide?ref=campaign-x')).action, 'native');
});

test('invalid configs and risky shortcut bindings are rejected', () => {
  const { defaultGlobalConfig, defaultProfile, validateGlobalConfig, validateProfile, parseShortcut } = createPolicy();
  assert.throws(() => parseShortcut('Ctrl+R'));
  assert.equal(parseShortcut('Alt+Shift+o'), 'Alt+Shift+O');
  assert.throws(() => validateGlobalConfig({ ...defaultGlobalConfig(), extra: true }));
  assert.throws(() => validateGlobalConfig({ ...defaultGlobalConfig(), shortcuts: {
    toggleCurrentSite: 'Alt+Shift+O', openSettings: 'Alt+Shift+O', toggleSessionPause: 'Alt+Shift+P',
  } }));
  assert.throws(() => validateProfile(defaultProfile('allowlist'), 'blocklist'));
});

test('legacy config migrates into the matching profile', () => {
  const { loadPolicy, values } = createPolicy();
  values.set('oint_config_v1', {
    version: 1, enabled: true, defaultAction: 'new-tab',
    rules: [{ id: 'legacy', name: 'Legacy', enabled: true, source: ['https://legacy.test/**'], action: 'native' }],
    behavior: { skipSameDocument: true, respectExistingTarget: true, respectSitePreventDefault: true, skipInteractiveChildren: true },
    shortcuts: { toggleCurrentSite: 'Alt+Shift+O', openSettings: 'Alt+Shift+L', toggleSessionPause: 'Alt+Shift+P' },
  });
  const loaded = loadPolicy();
  assert.equal(loaded.global.activeMode, 'blocklist');
  assert.equal(loaded.profiles.blocklist.rules[0].id, 'legacy');
  assert.equal(loaded.profiles.allowlist.rules.length, 0);
});

test('legacy disabled hosts migrate to the independent blocklist profile', () => {
  const { loadPolicy, values } = createPolicy();
  values.set('oint_disabled_sites', ['private.example.com']);
  values.delete('oint_config_v1');
  values.delete('oint_policy_global_v1');
  values.delete('oint_policy_blocklist_v1');
  values.delete('oint_policy_allowlist_v1');
  values.delete('oint_policy_blocklist_migrated_v1');
  const loaded = loadPolicy();
  assert.equal(loaded.profiles.blocklist.rules[0].source[0], '*://private.example.com/**');
  assert.equal(loaded.profiles.blocklist.rules[0].action, 'native');
  assert.equal(values.get('oint_policy_global_v1').activeMode, 'blocklist');
  assert.deepEqual(values.get('oint_disabled_sites'), ['private.example.com']);
});

test('both profiles persist independently and mode switching preserves rules', () => {
  const { defaultGlobalConfig, defaultProfile, savePolicy, loadPolicy } = createPolicy();
  const global = defaultGlobalConfig();
  const blocklist = defaultProfile('blocklist');
  const allowlist = defaultProfile('allowlist');
  blocklist.rules = [{ id: 'blocked', name: 'Blocked', enabled: true, source: ['https://blocked.test/**'], action: 'native' }];
  allowlist.rules = [{ id: 'allowed', name: 'Allowed', enabled: true, destination: ['https://allowed.test/**'], action: 'new-tab' }];
  savePolicy(global, { blocklist, allowlist });
  assert.equal(loadPolicy().profiles.blocklist.rules[0].id, 'blocked');
  assert.equal(loadPolicy().profiles.allowlist.rules[0].id, 'allowed');

  const switched = { ...global, activeMode: 'allowlist' };
  savePolicy(switched, { blocklist, allowlist });
  const loaded = loadPolicy();
  assert.equal(loaded.global.activeMode, 'allowlist');
  assert.equal(loaded.profiles.blocklist.rules[0].id, 'blocked');
  assert.equal(loaded.profiles.allowlist.rules[0].id, 'allowed');
});
