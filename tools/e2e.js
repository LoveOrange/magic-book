#!/usr/bin/env node
/* 端到端冒烟测试：无头 Chrome 走一遍真实点击流程，校验交互模型不回归。
 *
 * 依赖（不入 package.json）：npm i --no-save puppeteer-core
 * 用法：node tools/e2e.js
 * 可用 CHROME 环境变量指定浏览器路径。
 */
'use strict';
const path = require('path');

let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch {
  console.error('缺少依赖：请先运行  npm i --no-save puppeteer-core');
  process.exit(2);
}

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'file://' + path.resolve(__dirname, '../game.html');

let failed = 0;
function check(name, cond, extra = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : '   ' + extra));
  if (!cond) failed++;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 900 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(URL);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  const cur = () => page.evaluate(() => {
    const c = document.querySelector('#log .page.cur');
    return c ? c.dataset.scene + '/' + c.dataset.sp : null;
  });
  const hintText = () => page.evaluate(() =>
    document.getElementById('hintbar').textContent);
  /* 点击阅读区底部的空白（main 内、低于正文、高于道具栏） */
  const clickBlank = () => page.mouse.click(400, 760);

  await page.click('[data-ui="start"]');
  check('开局进入 office 第 1 页', await cur() === 'office/0');

  await page.click('.page.cur .w[data-act="desk"]');
  check('点击互动词就地展开、不翻页', await cur() === 'office/0');

  await clickBlank();
  check('空白点击翻到第 2 页', await cur() === 'office/1');

  await clickBlank();
  check('门槛拦截：未读卷宗停留第 2 页', await cur() === 'office/1');
  check('门槛提示出现', (await hintText()).includes('卷宗'));

  await page.click('.page.cur .w[data-act="file"]');
  await clickBlank();
  check('读卷宗后解锁第 3 页', await cur() === 'office/2');

  /* 回归：页码回跳第 1 页（曾因事件冒泡误判翻到第 2 页） */
  await page.click('#pgrow .pg');
  check('页码回跳第 1 页', await cur() === 'office/0');
  await clickBlank();
  check('旧页空白点击前进一页', await cur() === 'office/1');

  /* 回到前沿，走完教学拿读取弹 */
  const pgs = await page.$$('#pgrow .pg');
  await pgs[pgs.length - 1].click();
  await page.click('.page.cur .w[data-act="go_sys"]');
  check('出口词进入 tutorial', await cur() === 'tutorial/0');
  await page.click('.page.cur .w[data-act="tut1"]');
  await clickBlank();
  check('校准后解锁 tutorial 第 2 页', await cur() === 'tutorial/1');
  await page.click('.page.cur .w[data-act="tut2"]');

  /* 回归：弹仓芯片点击不翻页（曾因芯片重建脱离 DOM 被误判为空白） */
  const before = await cur();
  await page.click('#inv .chip');
  check('弹仓芯片点击不翻页', await cur() === before);
  check('芯片选中提示含道具说明', (await hintText()).includes('读取弹'));
  await page.click('#inv .chip'); // 退弹

  /* 卷宗/检索弹窗开关（注册组件分发） */
  await page.click('[data-ui="finder"]');
  check('检索面板打开', await page.$eval('#finder', el => el.style.display === 'flex'));
  await page.click('[data-ui="finder-close"]');
  check('检索面板关闭', await page.$eval('#finder', el => el.style.display === 'none'));

  check('无页面 JS 错误', errors.length === 0, errors.join(' | '));

  await browser.close();
  console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('E2E 运行失败：', e); process.exit(1); });
