#!/usr/bin/env node
/* MBS 剧本静态检查（FORMAT.md §8 的部分实现）
 * 用法：node tools/lint.js scripts/case1.zh.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const file = process.argv[2];
if (!file) { console.error('用法：node tools/lint.js <剧本.js>'); process.exit(2); }

global.window = {};
(0, eval)(fs.readFileSync(file, 'utf8'));

const engine = fs.readFileSync(path.join(__dirname, '../js/engine.js'), 'utf8');
const head = engine.slice(0, engine.indexOf('/* ---------------- 运行时状态'));
(0, eval)(head.replace(/'use strict';/, '')); // 间接 eval：让 parseScript 落到全局

let pass = 0, fail = 0;
for (const [chId, src] of Object.entries(window.MB_SCRIPTS)) {
  const ch = parseScript(src);
  const errs = [];

  if (!ch.scenes[ch.meta.start]) errs.push(`start 场景不存在: ${ch.meta.start}`);

  const reachable = new Set([ch.meta.start]);
  for (const [sid, sc] of Object.entries(ch.scenes)) {
    const actions = Object.values(sc.blocks).flatMap(b => b.actions)
      .concat(sc.whens.map(w => w.action));
    for (const a of actions) {
      const m = a.match(/goto\s+(\w+)/);
      if (m) {
        if (!ch.scenes[m[1]]) errs.push(`${sid}: goto 目标不存在 ${m[1]}`);
        else reachable.add(m[1]);
      }
      const g = a.match(/^get\s+(\w+)/);
      if (g && !ch.items[g[1]]) errs.push(`${sid}: get 未定义道具 ${g[1]}`);
      if (/^(when|@scene|\+)\s/.test(a)) errs.push(`${sid}: 结构行被吞进块内（检查缩进）→ ${a}`);
    }
    const texts = sc.flow.concat(actions);
    for (const t of texts) {
      for (const m of t.matchAll(/\[([^\]|]+)(?:\|([^\]]+))?\]/g)) {
        if (!m[2]) { errs.push(`${sid}: 互动词省略了 id（i18n 警告）[${m[1]}]`); continue; }
        const id = m[2];
        const has = sc.blocks[id] || Object.keys(sc.blocks).some(k => k.startsWith(id + '@'));
        if (!has) errs.push(`${sid}: 互动词无对应块 [${m[1]}|${id}]`);
      }
    }
    for (const k of Object.keys(sc.blocks)) {
      const at = k.split('@')[1];
      if (at && !ch.items[at]) errs.push(`${sid}: @块引用未定义道具 ${at}`);
    }
  }
  for (const sid of Object.keys(ch.scenes)) {
    if (!reachable.has(sid)) errs.push(`不可达场景: ${sid}`);
  }

  console.log(`[${chId}] 场景 ${ch.order.length} 个：${ch.order.join(' → ')}`);
  console.log(`[${chId}] 道具：${Object.keys(ch.items).join(', ') || '（无）'}`);
  if (errs.length) {
    fail++;
    errs.forEach(e => console.log('  ✗', e));
  } else {
    pass++;
    console.log(`[${chId}] ✓ lint 通过`);
  }
}
process.exit(fail ? 1 : 0);
