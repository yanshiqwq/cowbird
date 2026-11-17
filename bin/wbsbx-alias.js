#!/usr/bin/env node
// 旧命令名 wbsbx 的兼容入口：转给 cowbird，并提示一次改名。
// 项目在 2026-11 从 wbsbx 改名为 cowbird —— 沙箱是各平台的，工具不该背平台的名字。
console.error('[cowbird] `wbsbx` 已改名为 `cowbird`（旧名会在下个版本移除）');
require('./cowbird.js');
