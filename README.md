# 链接新标签打开 (Open Links in New Tab)

一个 Tampermonkey（油猴）用户脚本：让所有网站的链接点击默认在新标签页打开，并支持按站点禁用。

## 功能

- ✅ 全站链接点击默认在新标签页打开
- ⛔ **站点级禁用**：通过 Tampermonkey 菜单操作
  - 「✅ 新标签打开：已开启 / ❌ 新标签打开：已关闭」——切换当前站点
  - 「📋 查看已禁用的网站列表」——查看已禁用的域名
- 🛡️ **不影响上层操作**：链接卡片内嵌的按钮、下拉、输入框、`role="button"` 等"上层操作"元素点击时自动跳过，交由站点自己的逻辑处理；SPA 自定义路由（`preventDefault`）同样不受影响
- 🌐 **多语言**：菜单与提示按浏览器语言自动切换（中文 / English），默认英文

## 安装

1. 在浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 打开 Tampermonkey 管理面板 → 实用工具 → 导入，选择本目录下的 `open-link-new-tab.user.js`；或直接新建脚本并粘贴文件内容
3. 刷新目标网页即可生效

## 工作原理

脚本在 `document-start` 阶段以**捕获模式**监听 `click` 事件：

1. 点击命中链接时，临时把 `<a>` 的 `target` 设为 `_blank`
2. 事件处理结束后（`setTimeout 0`）立即还原原值

因此站点脚本如果在冒泡阶段 `preventDefault`（SPA 路由、自定义弹层），默认导航不会发生，DOM 也会恢复原样——两边互不干扰。

跳过处理的情形：修饰键/非左键点击、`#`/`javascript:`/非 http(s) 协议链接、`download` 链接、已带 `target` 的链接，以及点击目标是链接内嵌的可交互元素（按钮/下拉/输入框等）。

## 许可证

[MIT](./LICENSE) © 2026 fanghaydn
