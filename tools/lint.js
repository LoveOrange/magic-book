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
  const errs = lintChapter(ch); // 检查逻辑在 js/engine.js，与编辑器共用

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
