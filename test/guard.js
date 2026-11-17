#!/usr/bin/env node
// 解耦守卫：内核（lib/ 与 commands/，排除 lib/platform）不许再出现平台词汇与实现依赖。
//
// 为什么要有它：这次改造的全部价值就是「以后加平台不用动内核」。
// 没有这道闸，下一个人图省事在 lib/exec 里写一句 workbuddy 的接口，一切就回去了。
//
// 做法是**棘轮（ratchet）**：当前还残留的 WorkBuddy 实现列在 BASELINE 里，
// 只有「新增」违规才算失败；等这些文件被搬进 lib/platform/workbuddy/ 后，
// 把对应条目从 BASELINE 删掉即可（删多了也会失败，防止漏搬还假报干净）。
//   node test/guard.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOTS = ['lib', 'commands', 'bin'];
const EXCLUDE_DIRS = new Set(['node_modules', '.git']);
const EXCLUDE_PREFIX = ['lib/platform/'];

// 平台主机名（硬编码端点）
const RULE_HOSTS = /https?:\/\/[a-z0-9.-]*(?:workbuddy|devcloud|qoder|minimax|hailuoai|agentos-worker|qoderwork)[a-z0-9./-]*/i;
// 对 WorkBuddy 实现的直接依赖（正确做法是让它只出现在 lib/platform/workbuddy 里）
const RULE_IMPORTS = /require\(['"]\.{1,2}\/(?:lib\/)?(?:cloud|session|e2b|acp|browser)['"]\)/;

// 已知残留（迁移完成后应逐条删除）
const BASELINE = {
  // 归零了：内核（lib/ 与 commands/，排除 lib/platform）里不再有任何平台主机名，
  // 也不再有对平台实现的直接 require。以后再加平台只该动 lib/platform/<id>/。
  hosts: [],
  imports: [],
};

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name).split(path.sep).join('/');
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      if (EXCLUDE_PREFIX.some((x) => p === x.replace(/\/$/, '') || p.startsWith(x))) continue;
      walk(p, out);
    } else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

function main() {
  const files = ROOTS.flatMap((r) => (fs.existsSync(r) ? walk(r) : []));
  const violations = { hosts: [], imports: [] };

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (RULE_HOSTS.test(line) && !BASELINE.hosts.includes(f)) {
        violations.hosts.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
      }
      if (RULE_IMPORTS.test(line) && !BASELINE.imports.includes(f)) {
        violations.imports.push(`${f}:${i + 1}  ${line.trim().slice(0, 100)}`);
      }
    }
  }

  const bad = violations.hosts.length + violations.imports.length;
  if (bad) {
    console.error('\n✗ 内核里出现了平台相关代码（应该只存在于 lib/platform/ 下）：\n');
    for (const [kind, list] of Object.entries(violations)) {
      for (const v of list) console.error(`  [${kind}] ${v}`);
    }
    console.error('\n修法：把它挪进 lib/platform/<id>/，或改成经 lib/platform 门面调用。\n');
    process.exit(1);
  }

  // 干净时也报一下「还欠多少」，让棘轮看得见
  const left = BASELINE.hosts.length + BASELINE.imports.length;
  console.log(`✓ 没有新增的平台耦合（扫描 ${files.length} 个文件）`);
  if (left) console.log(`  · 待迁移的已知残留：${left} 处（hosts ${BASELINE.hosts.length} / imports ${BASELINE.imports.length}）`);

  // 反向检查：baseline 里写的文件如果已经不违规了，说明可以删条目 —— 提示但不失败
  const stale = [];
  for (const f of BASELINE.hosts) {
    if (!fs.existsSync(f) || !RULE_HOSTS.test(fs.readFileSync(f, 'utf8'))) stale.push('hosts:' + f);
  }
  for (const f of BASELINE.imports) {
    if (!fs.existsSync(f) || !RULE_IMPORTS.test(fs.readFileSync(f, 'utf8'))) stale.push('imports:' + f);
  }
  if (stale.length) console.log(`  · 可以把这些从 BASELINE 删掉了：${stale.join(', ')}`);
  process.exit(0);
}

main();
