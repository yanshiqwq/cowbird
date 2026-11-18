// 服务安装（systemd / Windows 计划任务）的渲染与落盘。
//
// 从 commands/daemon.js 里搬出来的原因：这是**纯字符串拼装 + 一次写文件**，
// 放在命令层既没法单测，也容易把路径/权限写错。命令层只负责打印。
const fs = require('fs');
const cfg = require('../config');

/** 跑 daemon 的两个绝对路径 */
function defaults() {
  // 延迟 require 避免循环依赖（bin 依赖 lib，命令也依赖 lib）
  const path = require('path');
  return {
    node: process.execPath,
    script: path.join(__dirname, '..', '..', 'bin', 'cowbird-daemon.js'),
    home: cfg.HOME,
  };
}

/** systemd unit 文本（纯函数，可断言） */
function systemdUnit({ node, script, home } = {}) {
  const d = { ...defaults(), ...(node ? { node } : {}), ...(script ? { script } : {}), ...(home ? { home } : {}) };
  return `[Unit]
Description=cowbird daemon (cloud sandbox keep-alive)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${d.node} ${d.script}
Restart=always
RestartSec=10
Environment=COWBIRD_HOME=${d.home}
# 需要用浏览器续期时把 HOME 设成有凭据的用户
# User=youruser

[Install]
WantedBy=multi-user.target
`;
}

/** Windows 计划任务命令（纯函数） */
function schtasksCommand({ node, script } = {}) {
  const d = { ...defaults(), ...(node ? { node } : {}), ...(script ? { script } : {}) };
  return `schtasks /Create /TN "cowbird-daemon" /SC ONLOGON /RL LIMITED /TR "\\"${d.node}\\" \\"${d.script}\\"" /F`;
}

/** Linux unit 的落盘路径 */
const UNIT_PATH = '/etc/systemd/system/cowbird-daemon.service';

/**
 * 生成安装计划：平台 + 文本 + 落盘路径（不写任何东西）。
 * @returns {{platform:'linux'|'win32'|'other', unit?:string, command?:string, path?:string, hint:string}}
 */
function plan(platform = process.platform) {
  if (platform === 'linux') {
    return {
      platform,
      unit: systemdUnit(),
      path: UNIT_PATH,
      hint: 'sudo systemctl daemon-reload && sudo systemctl enable --now cowbird-daemon',
    };
  }
  if (platform === 'win32') {
    return {
      platform,
      command: schtasksCommand(),
      hint: '也可以直接用「启动」文件夹放一个快捷方式；或者干脆 cowbird daemon start --detach 手动起。',
    };
  }
  return { platform: 'other', host: platform, hint: '这台平台没有内置的服务安装方式，用 docker 或前台跑：cowbird-daemon' };
}

/** 真的写进系统（只有 linux 有可写文件；其它平台返回 {written:false}） */
function write(planObj) {
  if (!planObj || !planObj.path) return { written: false, reason: 'no-file' };
  fs.writeFileSync(planObj.path, planObj.unit);
  return { written: true, path: planObj.path };
}

module.exports = { defaults, systemdUnit, schtasksCommand, plan, write, UNIT_PATH };
