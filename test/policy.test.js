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
  source = `${source.slice(0, end)}globalThis.__policy = { defaultConfig, compilePattern, validateConfig, compileRules, resolvePolicy, parseShortcut, loadConfig };\n${source.slice(end)}`;
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

test('rules use first matching action and fall back to the default', () => {
  const { defaultConfig, compileRules, resolvePolicy, validateConfig } = createPolicy();
  const config = defaultConfig();
  config.defaultAction = 'native';
  config.rules = [
    { id: 'source-deny', name: 'Admin', enabled: true, source: ['https://docs.example.com/**'], action: 'native' },
    { id: 'destination-allow', name: 'GitHub', enabled: true, destination: ['https://github.com/**'], action: 'new-tab' },
  ];
  const valid = validateConfig(config);
  const compiled = compileRules(valid);
  const source = new URL('https://docs.example.com/start');
  assert.equal(resolvePolicy(valid, compiled, source, new URL('https://github.com/project')).action, 'native');

  valid.rules.reverse();
  const reordered = compileRules(valid);
  assert.equal(resolvePolicy(valid, reordered, source, new URL('https://github.com/project')).action, 'new-tab');
  assert.equal(resolvePolicy(valid, reordered, source, new URL('https://elsewhere.test/')).action, 'native');
  assert.equal(resolvePolicy(valid, reordered, source, new URL('https://github.com/'), true).reason, 'paused');
});

test('origin and query conditions are conjunctive', () => {
  const { defaultConfig, compileRules, resolvePolicy, validateConfig } = createPolicy();
  const config = defaultConfig();
  config.defaultAction = 'native';
  config.rules = [{
    id: 'external-docs', name: 'Docs external', enabled: true,
    source: ['https://docs.example.com/**'], linkType: 'cross-origin',
    query: { destination: { ref: 'campaign-*' } }, action: 'new-tab',
  }];
  const valid = validateConfig(config);
  const compiled = compileRules(valid);
  const source = new URL('https://docs.example.com/guide');
  assert.equal(resolvePolicy(valid, compiled, source, new URL('https://other.test/?ref=campaign-x')).action, 'new-tab');
  assert.equal(resolvePolicy(valid, compiled, source, new URL('https://other.test/?ref=other')).action, 'native');
  assert.equal(resolvePolicy(valid, compiled, source, new URL('https://docs.example.com/guide?ref=campaign-x')).action, 'native');
});

test('invalid configs and risky shortcut bindings are rejected', () => {
  const { defaultConfig, validateConfig, parseShortcut } = createPolicy();
  assert.throws(() => parseShortcut('Ctrl+R'));
  assert.equal(parseShortcut('Alt+Shift+o'), 'Alt+Shift+O');
  assert.throws(() => validateConfig({ ...defaultConfig(), extra: true }));
  assert.throws(() => validateConfig({ ...defaultConfig(), shortcuts: {
    toggleCurrentSite: 'Alt+Shift+O', openSettings: 'Alt+Shift+O', toggleSessionPause: 'Alt+Shift+P',
  } }));
});

test('legacy disabled hosts migrate to native-action source rules', () => {
  const { loadConfig, values } = createPolicy();
  values.set('oint_disabled_sites', ['private.example.com']);
  values.delete('oint_config_v1');
  const config = loadConfig();
  assert.equal(config.rules[0].source[0], '*://private.example.com/**');
  assert.equal(config.rules[0].action, 'native');
  assert.equal(values.get('oint_config_v1').defaultAction, 'new-tab');
  assert.deepEqual(values.get('oint_disabled_sites'), ['private.example.com']);
});
