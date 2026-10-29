# 链接新标签打开 (Open Links in New Tab)

一个 Tampermonkey 用户脚本：根据来源页面、目标 URL 和可排序规则决定链接是否在新标签页打开，也包含独立的外链直达功能。

## 功能

- **黑名单模式**：默认普通 HTTP(S) 链接新标签打开；规则可指定例外，让网站按原有方式处理。
- **白名单模式**：默认尊重网站原有行为；命中规则后才新标签打开。
- **地址规则**：分别匹配当前来源页面和点击目标；可设同源／跨源条件，支持按顺序启停和排序。
- **Glob 地址**：安全、可读的通配符规则，不执行用户提供的正则表达式。
- **快捷键**：默认 `Alt+Shift+O` 切换本站策略，`Alt+Shift+L` 打开设置，`Alt+Shift+P` 暂停或恢复当前页面接管。均可修改或清空。
- **配置迁移与备份**：旧版禁用网站自动迁移；设置面板可编辑规则、测试匹配、导入／导出 JSON。
- **外链直达**：保持独立的全局开关和原有检测逻辑，与新标签策略无关。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 从 Tampermonkey 管理面板导入 `open-link-new-tab.user.js`，或新建脚本并粘贴文件内容。
3. 刷新网页；通过 Tampermonkey 菜单或 `Alt+Shift+L` 打开配置面板。

## 策略规则

规则按列表从上到下检查，**第一条匹配规则生效**；无规则匹配时使用默认行为。

- 动作 `new-tab` 是白名单例外（打开新标签），动作 `native` 是黑名单例外（交还网站行为）。
- `source` 匹配当前页面地址，`destination` 匹配点击的链接；两者都配置时必须同时满足。
- `linkType` 可选 `all`、`same-origin` 或 `cross-origin`。同源按协议、主机、端口判定。
- 同一条件中的多个地址模式是“任一匹配”；多个条件之间是“全部匹配”。
- 地址模式只匹配协议、主机、端口和路径；查询参数／锚点用可选 `query` 条件匹配。

### 通配符

| 模式 | 含义 |
| --- | --- |
| `*://example.com/**` | HTTP 或 HTTPS 下的该主机所有路径 |
| `https://*.example.com/**` | HTTPS 子域名（不含根域名） |
| `https://example.com/docs/*` | `/docs/` 下单层路径；`*` 不跨 `/` |
| `https://example.com/docs/**` | `/docs/` 下任意深度；`**` 可跨 `/` |

主机名匹配不区分大小写，路径区分大小写。模式不接受查询字符串或锚点；只允许 HTTP(S)。

### 配置示例

设置面板的“JSON 导入／导出”区域支持编辑完整配置。示例：

```json
{
  "version": 1,
  "enabled": true,
  "defaultAction": "new-tab",
  "rules": [
    {
      "id": "admin-native",
      "name": "后台保持网站原生行为",
      "enabled": true,
      "source": ["https://admin.example.com/**"],
      "action": "native"
    },
    {
      "id": "github-new-tab",
      "name": "GitHub 链接新开",
      "enabled": true,
      "destination": ["https://github.com/**", "https://*.github.com/**"],
      "action": "new-tab"
    },
    {
      "id": "docs-external",
      "name": "文档站仅新开跨源链接",
      "enabled": true,
      "source": ["https://docs.example.com/**"],
      "linkType": "cross-origin",
      "action": "new-tab"
    }
  ],
  "behavior": {
    "skipSameDocument": true,
    "respectExistingTarget": true,
    "respectSitePreventDefault": true,
    "skipInteractiveChildren": true
  },
  "shortcuts": {
    "toggleCurrentSite": "Alt+Shift+O",
    "openSettings": "Alt+Shift+L",
    "toggleSessionPause": "Alt+Shift+P"
  }
}
```

快捷键只接受 `Alt+Shift+字母或数字` 组合，避免抢占浏览器常用的系统快捷键。快捷键在输入框、编辑区域和中文输入法组合输入时不触发；当前标签页暂停不影响外链直达。

## 行为与兼容性

- 只接管普通鼠标左键点击；Ctrl／Cmd／Shift／Alt 点击和非左键交给浏览器。
- 下载链接、非 HTTP(S) 链接、默认同页锚点及链接内按钮、输入框等交互控件不接管。
- 默认尊重站点的 `preventDefault()`。新标签通过点击期间临时设置 `target="_blank"` 实现，事件结束后恢复 DOM 属性；不会强制绕过 SPA 路由。
- 仅适用于用户点击的 `<a href>`；不拦截脚本直接调用 `window.open()`。
- Tampermonkey 菜单包含本站新标签／网站原生／继承、暂停当前页、打开设置和外链直达开关。
- 默认内置 Google 搜索页 `native` 规则；此规则可在设置面板排序、修改或删除。

旧版 `oint_disabled_sites` 禁用名单会在首次启动时迁移成 `native` 来源规则，原名单保留作为备份。现有其他外链直达偏好不受影响。

## 开发测试

```bash
node --check open-link-new-tab.user.js
node --test test/policy.test.js
```

## 许可证

[MIT](./LICENSE) © 2026 fanghaydn
