/* ====================================================================
 *  魔法书剧本引擎 v0 —— 解析并运行 MBS 格式剧本（规范见 FORMAT.md）
 *  章节文本注册在 window.MB_SCRIPTS，由 game.html 选择加载。
 *
 *  展现模型（作者控制节奏）：
 *  - 幕（@act）＞场景（@scene）＞页（@page）＞语句：页封装一系列语句，
 *    由剧本作者手动划分，是叙事节拍单位；@page 可设门槛（need 条件 | 提示）。
 *  - 开页即全显；点高亮词在本页就地展开内容，点阅读区空白翻页。
 *
 *  分层约定（防止组件逻辑逃逸出引擎）：
 *  - 流程层：advance / enterScene / nextPage / execBlock 是仅有的推进入口。
 *  - 事件层：全站只有一个点击分发器（见「点击分发」节）。任何可点组件
 *    必须声明 data-ui 身份并在 UI_ACTIONS 注册，禁止自挂 onclick；
 *    「翻页」只对阅读区 main 内的空白点击生效——页码条、幕标签、
 *    弹仓等组件天然在翻页范围之外，无需排除名单。
 * ==================================================================== */
'use strict';

/* ---------------- 解析器 ---------------- */

const SCENE_PROPS = ['label', 'bg', 'amb', 'music', 'fx', 'mode', 'style', 'art'];

function parseScript(src) {
  const ch = { meta: {}, items: {}, cast: {}, scenes: {}, order: [], acts: [] };
  let mode = null, scene = null, block = null, blockIndent = 0;

  for (const raw of src.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('//')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const t = line.trim();
    let m;

    if (t === '@meta')  { mode = 'meta';  continue; }
    if (t === '@items') { mode = 'items'; continue; }
    if (t === '@cast')  { mode = 'cast';  continue; }
    if ((m = t.match(/^@act\s+(.+)$/))) { ch.acts.push(m[1].trim()); continue; }
    if ((m = t.match(/^@scene\s+(\S+)/))) {
      scene = {
        id: m[1], props: {}, blocks: {}, whens: [],
        pages: [{ gate: null, lines: [] }],
        act: Math.max(0, ch.acts.length - 1),
      };
      ch.scenes[m[1]] = scene;
      ch.order.push(m[1]);
      mode = 'scene'; block = null;
      continue;
    }

    if (mode === 'meta') {
      const i = t.indexOf(':');
      if (i > 0) ch.meta[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      continue;
    }
    if (mode === 'items') {
      const i = t.indexOf(':');
      if (i > 0) {
        const id = t.slice(0, i).trim();
        const [head, desc = ''] = t.slice(i + 1).split('|').map(s => s.trim());
        const sp = head.indexOf(' ');
        ch.items[id] = { icon: head.slice(0, sp), name: head.slice(sp + 1).trim(), desc };
      }
      continue;
    }
    if (mode === 'cast') {
      /* 人物表：名字: 头像字符 | 颜色（缺省头像取名字首字） */
      const i = t.indexOf(':');
      if (i > 0) {
        const name = t.slice(0, i).trim();
        const [icon, color = ''] = t.slice(i + 1).split('|').map(s => s.trim());
        ch.cast[name] = { icon: icon || name[0], color: color || '' };
      }
      continue;
    }
    if (mode !== 'scene') continue;

    /* 手动分页：@page ／ @page need 条件 | 提示文本 */
    if ((m = t.match(/^@page(?:\s+need\s+([^|]+?)\s*(?:\|\s*(.+))?)?$/))) {
      scene.pages.push({
        gate: m[1] ? { cond: m[1].trim(), msg: (m[2] || '').trim() } : null,
        lines: [],
      });
      block = null;
      continue;
    }
    /* 反应块头：+ id: ／ + id (once): ／ + id @ item: */
    if ((m = t.match(/^\+\s*(\w+)(?:\s*@\s*(\w+))?\s*(\(once\))?\s*:$/))) {
      block = { word: m[1], item: m[2] || null, once: !!m[3], actions: [] };
      blockIndent = indent;
      scene.blocks[m[1] + (m[2] ? '@' + m[2] : '')] = block;
      continue;
    }
    /* 块内动作：必须比块头缩进更深，否则视为块已结束 */
    if (block && indent > blockIndent) { block.actions.push(t); continue; }
    block = null;

    if ((m = t.match(/^when\s+(.+?)\s*:\s*(.+)$/))) {
      scene.whens.push({ cond: m[1], action: m[2], fired: false });
      continue;
    }
    /* 场景属性（仅允许出现在正文之前） */
    const noText = scene.pages.length === 1 && scene.pages[0].lines.length === 0;
    if (noText && (m = t.match(/^(\w+)\s*:\s*(.*)$/)) && SCENE_PROPS.includes(m[1])) {
      scene.props[m[1]] = m[2];
      continue;
    }
    scene.pages[scene.pages.length - 1].lines.push(t);
  }
  if (!ch.acts.length) ch.acts.push('');
  return ch;
}

/* 剧本静态检查（FORMAT.md §8 的部分实现）；返回问题列表，空数组为通过 */
function lintChapter(ch) {
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
      if (/^(when|@scene|@act|@page|\+)\s/.test(a)) errs.push(`${sid}: 结构行被吞进块内（检查缩进）→ ${a}`);
    }
    sc.pages.forEach((p, i) => {
      if (!p.lines.length) errs.push(`${sid}: 第 ${i + 1} 页没有内容`);
    });
    const texts = sc.pages.flatMap(p => p.lines).concat(actions);
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
  return errs;
}

/* ---------------- 运行时状态 ---------------- */

let CH = null;
const STATE = {
  scene: null,        // 推进前沿所在场景
  sp: 0,              // 前沿场景内已解锁到第几页（authored page index）
  flags: new Set(),
  items: [],
  clues: [],
  archive: [],        // {title, body}
  seen: {},           // sceneId -> [点击过的词 id]
  bookmarks: [],      // 页索引
  whensFired: {},     // sceneId -> [已触发的 when 序号]
  log: [],            // 结构化日志：[{scene,sp,act,items:[{text,cls}]}]，与 PAGES 同序
  used: [],           // 已置灰的词：['pageIdx:wordId']
};
const PAGES = [];     // {scene, sp, act, el}，与 #log / STATE.log 一一对应（运行时视图）
let viewIdx = -1;     // 当前查看的页
let curScene = null;  // 当前正在写入的场景（pump 执行期间）
let curPageIdx = -1;  // 当前正在写入的页（pump 执行期间）
let selected = null;
let IS_DRAFT = false;

const $ = id => document.getElementById(id);

const SAVE_FMT = 5;   // 5：存档改为结构化 log（不再快照 innerHTML）
const GATE_HINT = '（总觉得……还有什么没查清的。）';

/* ---------------- 效果总线（VM 产出 → 渲染端消费） ----------------
 * VM 层的逻辑只「改 STATE + emit 效果」，绝不直接碰 DOM/音频；
 * flush() 把缓冲的效果交给 applyEffects() 统一作画。这就是 Phase 2 的边界。
 */
let EFFECTS = [];
function emit(e) { EFFECTS.push(e); }

function flush() {
  const es = EFFECTS; EFFECTS = [];
  applyEffects(es);
  updateMore(); updatePagebar();
}
function commit() { flush(); saveGame(); }   // 一次命令完成：作画 + 存档

function applyEffects(list) {
  for (const e of list) {
    switch (e.k) {
      case 'page':    mountPage(e.scene, e.sp, e.act, STATE.bookmarks.includes(e.idx)); break;
      case 'view':    showPage(e.idx); break;
      case 'log':     renderStatement(e.item.text, e.item.cls, e.pi, true); break;
      case 'wordoff': greyWord(e.pi, e.id); break;
      case 'scroll':  scrollNew(e.pi); break;
      case 'item':    renderItems(); FX.sfx('get'); break;
      case 'items':   renderItems(); break;
      case 'clue':    FX.sfx('clue'); break;
      case 'sfx':     FX.sfx(e.name); break;
      case 'amb':     FX.amb(e.name); break;
      case 'fx':      runFx(e.name, e.arg); break;
      case 'hint':    hint(e.text, e.flash); break;
      case 'gate':    FX.sfx('knock'); hint(e.msg, true); break;
      case 'nav':     location.href = e.url; break;
    }
  }
}
function greyWord(pi, id) {
  if (PAGES[pi]) PAGES[pi].el.querySelectorAll(`.w[data-act="${id}"]`)
    .forEach(el => el.classList.add('used'));
}
function scrollNew(pi) {
  const el = PAGES[pi] && PAGES[pi].el.lastElementChild;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------------- 命令层（输入 → VM 的唯一入口） ----------------
 * 改变叙事状态只能经 dispatch(command)：清空效果缓冲 → reduce 改 STATE+emit →
 * commit 落地（作画+存档）。纯视图操作（翻已读页/页码跳转/选弹仓）不改 STATE，
 * 不走这里。这就是 VM 的对外契约：命令进、效果出、单一漏斗。
 */
const Cmd = {
  start:       ()             => ({ t: 'start' }),
  turnForward: ()             => ({ t: 'turnForward' }),
  clickWord:   (pi, wordId)   => ({ t: 'clickWord', pi, wordId }),
  useItem:     (item, pi, wordId) => ({ t: 'useItem', item, pi, wordId }),
};

/* reduce：把一个 command 落到 STATE（并 emit 效果）。无 DOM。
 * 注：当前实现在单一被引擎拥有的 STATE 上就地变更（非不可变线程化），
 * 但对外契约——「命令进、效果出、dispatch 单漏斗」——已成立。 */
function reduce(cmd) {
  switch (cmd.t) {
    case 'start':
      enterScene(CH.meta.start || CH.order[0]);
      break;
    case 'turnForward':
      nextPage();
      break;
    case 'clickWord': {
      const sid = STATE.log[cmd.pi].scene;
      const block = CH.scenes[sid].blocks[cmd.wordId];
      if (block) execBlock(block, sid, cmd.pi);
      break;
    }
    case 'useItem': {
      const sid = STATE.log[cmd.pi].scene;
      const block = CH.scenes[sid].blocks[cmd.wordId + '@' + cmd.item];
      if (block) execBlock(block, sid, cmd.pi);
      break;
    }
  }
}

function dispatch(cmd) {
  EFFECTS = [];
  reduce(cmd);
  commit();   // flush（作画+刷新页码/状态灯）+ 存档
}

function saveKey() { return 'mb-save-' + (IS_DRAFT ? 'draft-' : '') + CH.meta.id; }

function saveGame() {
  try {
    localStorage.setItem(saveKey(), JSON.stringify({
      fmt: SAVE_FMT,
      v: CH.meta.version,
      scene: STATE.scene,
      sp: STATE.sp,
      log: STATE.log,             // 结构化日志（呈现中立，读档时 renderFull 重画）
      used: STATE.used,
      flags: [...STATE.flags],
      items: STATE.items,
      clues: STATE.clues,
      archive: STATE.archive,
      seen: STATE.seen,
      bookmarks: STATE.bookmarks,
      whensFired: STATE.whensFired,
    }));
  } catch (e) { console.warn('存档失败', e); return; }
  const tag = $('savetag');
  tag.textContent = '◈ 记忆已同步';
  tag.classList.add('on');
  setTimeout(() => tag.classList.remove('on'), 1600);
}

function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(saveKey()));
    return s && s.fmt === SAVE_FMT ? s : null;
  } catch { return null; }
}

/* ---------------- 页 ---------------- */

/* 仅建 DOM 页（不写日志）：play 与 restore 共用 */
function mountPage(scene, sp, act, bookmarked) {
  const sc = CH.scenes[scene];
  const sec = document.createElement('section');
  sec.className = 'page';
  sec.dataset.scene = scene;
  sec.dataset.sp = sp;
  sec.dataset.act = act;
  const bk = document.createElement('span');
  bk.className = 'bk' + (bookmarked ? ' on' : '');
  bk.dataset.ui = 'bk';
  bk.textContent = '🔖';
  bk.title = '书签';
  sec.appendChild(bk);
  if (sp === 0 && sc.props.label) {
    const h = document.createElement('h2');
    h.className = 'page-title';
    h.textContent = sc.props.label;
    sec.appendChild(h);
  }
  $('log').appendChild(sec);
  PAGES.push({ scene, sp, act, el: sec });
  return PAGES.length - 1;
}

/* play 路径（VM）：新开一页 = 记日志 + emit page 效果（渲染端 mountPage） */
function newPage(sid, sp) {
  const sc = CH.scenes[sid];
  STATE.log.push({ scene: sid, sp, act: sc.act, items: [] });
  const idx = STATE.log.length - 1;
  emit({ k: 'page', scene: sid, sp, act: sc.act, idx });
  return idx;
}

function lastPageIdxOf(sid) {
  for (let j = STATE.log.length - 1; j >= 0; j--) {
    if (STATE.log[j].scene === sid) return j;
  }
  return STATE.log.length - 1;
}

function showPage(i) {
  if (i < 0 || i >= PAGES.length) return;
  viewIdx = i;
  PAGES.forEach((p, j) => p.el.classList.toggle('cur', j === i));
  const sc = CH.scenes[PAGES[i].scene];
  /* 页的氛围跟随视图 */
  if (sc.props.bg) document.body.style.backgroundColor = sc.props.bg;
  if (sc.props.amb) FX.amb(sc.props.amb);
  if (sc.props.fx) runFx(sc.props.fx === 'off' ? 'fxoff' : sc.props.fx);
  BGART.show(sc.props.art);
  document.body.classList.toggle('memory', sc.props.mode === 'memory');
  updatePagebar();
  updateMore();
  const el = PAGES[i].el;
  if (i === PAGES.length - 1) {
    (el.lastElementChild || el).scrollIntoView({ behavior: 'smooth', block: 'end' });
  } else {
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function markSeen(sid, wordId) {
  (STATE.seen[sid] = STATE.seen[sid] || []).includes(wordId) ||
    STATE.seen[sid].push(wordId);
}

/* 该页是否还有从未点过的可互动元素 */
function pageUnseen(p) {
  const sc = CH.scenes[p.scene];
  const seen = STATE.seen[p.scene] || [];
  return [...p.el.querySelectorAll('.w[data-act]')].some(el => {
    if (el.classList.contains('used')) return false;
    const id = el.dataset.act;
    if (seen.includes(id)) return false;
    return sc.blocks[id] || Object.keys(sc.blocks).some(k => k.startsWith(id + '@'));
  });
}

function updatePagebar() {
  const actrow = $('actrow'), pgrow = $('pgrow');
  if (!actrow) return;
  const viewAct = viewIdx >= 0 ? PAGES[viewIdx].act : 0;

  /* 幕标签（只有一幕时隐藏） */
  actrow.innerHTML = '';
  const unlockedActs = [...new Set(PAGES.map(p => p.act))];
  if (unlockedActs.length > 1 || (CH.acts[0] && CH.acts.length > 1)) {
    for (const a of unlockedActs) {
      const tab = document.createElement('span');
      tab.className = 'acttab'
        + (a === viewAct ? ' cur' : '')
        + (PAGES.some(p => p.act === a && pageUnseen(p)) ? ' unseen' : '');
      tab.textContent = CH.acts[a] || ('第 ' + (a + 1) + ' 幕');
      tab.dataset.ui = 'act';
      tab.dataset.act = a;
      actrow.appendChild(tab);
    }
  }

  /* 当前幕的页码 */
  pgrow.innerHTML = '';
  let no = 0;
  PAGES.forEach((p, j) => {
    if (p.act !== viewAct) return;
    no++;
    const b = document.createElement('span');
    b.className = 'pg'
      + (j === viewIdx ? ' cur' : '')
      + (pageUnseen(p) ? ' unseen' : '');
    b.textContent = no;
    b.title = CH.scenes[p.scene].props.label || p.scene;
    b.dataset.ui = 'pg';
    b.dataset.idx = j;
    pgrow.appendChild(b);
  });
}

/* ---------------- 书签与检索 ---------------- */

function toggleBookmark(idx) {
  const at = STATE.bookmarks.indexOf(idx);
  if (at >= 0) STATE.bookmarks.splice(at, 1);
  else STATE.bookmarks.push(idx);
  PAGES[idx].el.querySelector('.bk').classList.toggle('on', at < 0);
  saveGame();
}

function pageLabel(idx) {
  const p = PAGES[idx];
  let no = 0;
  for (let j = 0; j <= idx; j++) if (PAGES[j].act === p.act) no++;
  const act = CH.acts[p.act] ? CH.acts[p.act] + ' · ' : '';
  return act + '第 ' + no + ' 页';
}

function pageExcerpt(idx, kw) {
  const text = PAGES[idx].el.textContent.replace(/🔖/g, '').replace(/\s+/g, ' ').trim();
  if (!kw) return text.slice(0, 24) + (text.length > 24 ? '……' : '');
  const at = text.indexOf(kw);
  if (at < 0) return '';
  const s = Math.max(0, at - 10);
  return (s > 0 ? '……' : '') + text.slice(s, at) +
    '【' + kw + '】' + text.slice(at + kw.length, at + kw.length + 14) + '……';
}

function renderFinder(kw) {
  const box = $('fd-res');
  box.innerHTML = '';
  const mk = (idx, excerpt) => {
    const d = document.createElement('div');
    d.className = 'fd-item';
    d.dataset.ui = 'fd-item';
    d.dataset.idx = idx;
    d.innerHTML = `<span class="fd-loc">${pageLabel(idx)}</span>${excerpt}`;
    box.appendChild(d);
  };
  if (kw) {
    let found = 0;
    PAGES.forEach((p, idx) => {
      const ex = pageExcerpt(idx, kw);
      if (ex) { mk(idx, ex); found++; }
    });
    if (!found) box.innerHTML = '<p class="arc-empty">（没有找到）</p>';
  } else if (STATE.bookmarks.length) {
    const h = document.createElement('div');
    h.className = 'fd-head';
    h.textContent = '书签';
    box.appendChild(h);
    [...STATE.bookmarks].sort((a, b) => a - b).forEach(idx => mk(idx, pageExcerpt(idx)));
  } else {
    box.innerHTML = '<p class="arc-empty">（输入关键词搜索全文，或点击页面右上角的 🔖 添加书签）</p>';
  }
}

/* ---------------- 文本输出 ---------------- */

function fmt(s) {
  return s.replace(/\[([^\]|]+)(?:\|([^\]]+))?\]/g,
    (_, w, id) => `<span class="w" data-act="${id || w}">${w}</span>`);
}

/* 把一条日志项渲染成 <p> 追加到第 pi 页（animate=false 用于读档重画） */
function renderStatement(text, extraCls, pi, animate) {
  const page = PAGES[pi];
  if (!page) return { textContent: '' };
  let t = text, narr = false;
  if (t.startsWith(': ')) { t = t.slice(2); narr = true; } // `: ` 前缀＝强制旁白
  const p = document.createElement('p');
  let cls = extraCls || '', m;
  if (t.startsWith('! ')) { cls += ' obj'; t = t.slice(2); }
  // 仅非旁白行才尝试「说话人: 台词」解析（旁白里可含全角冒号，不应误判为对话）
  else if (!narr && (m = t.match(/^([一-龥A-Za-z0-9·]{1,8})(（内心）|\(内心\))?\s*[:：]\s*(.+)$/))) {
    if (m[2]) { cls += ' think'; t = m[3]; }
    else {
      cls += ' speech';
      if (m[1] === '系统') cls += ' sysv'; // 记忆侦查辅助系统的语音
      const cast = (CH.cast || {})[m[1]] || {};
      const color = cast.color || '#8a93ad';
      const glyph = cast.icon || m[1][0];
      let body = m[3];
      if (!/^[「『]/.test(body)) body = '「' + body + '」'; // 台词自动加引号
      p.innerHTML =
        `<span class="ava" style="color:${color};border-color:${color}">${glyph}</span>` +
        `<span class="spb"><b style="color:${color}">${m[1]}</b>${fmt(body)}</span>`;
    }
    if (!p.innerHTML) t = fmt(t);
  }
  const sc = CH.scenes[page.scene];
  if (sc && sc.props.mode === 'memory') cls += ' mem';
  p.className = cls.trim();
  if (!p.innerHTML) p.innerHTML = fmt(t);
  if (animate) {
    p.style.animationDelay = Math.min(sayDelay, 480) + 'ms'; // 同批段落级联入场
    sayDelay += 60;
  } else {
    p.style.animation = 'none'; // 读档整本重画，不逐条入场
  }
  p.querySelectorAll('.w[data-act]').forEach(el => {        // 还原已置灰的词
    if (STATE.used.includes(pi + ':' + el.dataset.act)) el.classList.add('used');
  });
  page.el.appendChild(p);
  return p;
}

/* 输出一行（VM）：记入结构化日志（存档的源）+ emit log 效果 */
function logStatement(text, cls) {
  const pi = curPageIdx >= 0 ? curPageIdx : STATE.log.length - 1;
  if (pi < 0 || !STATE.log[pi]) return;
  const item = { text, cls: cls || '' };
  STATE.log[pi].items.push(item);
  emit({ k: 'log', pi, item });
}

/* ---------------- 推进：页级节奏（一页文字一次性全显） ---------------- */

let currentWord = null;  // off 不带参数时置灰的目标
let sayDelay = 0;        // 同批段落的级联入场延迟

function updateMore() {
  const more = $('more');
  if (!more || !CH) return;
  /* 三态状态灯：呼吸=可翻页；静止暗点=有下一页但条件未满足；隐藏=没有下一页 */
  let state = 'hide';
  if (viewIdx >= 0 && viewIdx < PAGES.length - 1) state = 'go';
  else {
    const sc = CH.scenes[STATE.scene];
    const np = sc && sc.pages[STATE.sp + 1];
    if (np) state = (!np.gate || evalCond(np.gate.cond)) ? 'go' : 'wait';
  }
  more.style.display = state === 'hide' ? 'none' : 'block';
  more.classList.toggle('ready', state === 'go');
}

/* 顺序执行一组动作行（同步、一次性全显）；遇 goto 中止并透传 */
function runLines(lines, sid, pageIdx, word, cls) {
  sayDelay = 0;
  for (const line of lines) {
    currentWord = word || null;
    curScene = sid;
    curPageIdx = pageIdx;
    const r = execAction(line, cls);
    currentWord = null;
    if (r === 'goto') {
      if (word) offWord(word, pageIdx); // 出口词用毕置灰
      curScene = null; curPageIdx = -1;
      return 'goto';
    }
  }
  curScene = null; curPageIdx = -1;
}

function pageCls(sc) { return sc.props.style === 'coda' ? 'coda' : ''; }

/* 解锁场景内的下一页（VM，检查门槛） */
function nextPage() {
  const sc = CH.scenes[STATE.scene];
  const np = sc.pages[STATE.sp + 1];
  if (!np) return;
  if (np.gate && !evalCond(np.gate.cond)) {
    emit({ k: 'gate', msg: np.gate.msg || GATE_HINT });
    return;
  }
  STATE.sp++;
  const idx = newPage(STATE.scene, STATE.sp);
  emit({ k: 'view', idx });
  if (runLines(np.lines, STATE.scene, idx, null, pageCls(sc)) !== 'goto') checkWhens();
}

/* 「前进」：回翻时向后翻已读页（纯视图）→ 前沿解锁下一页（命令 turnForward） */
function advance() {
  if (viewIdx >= 0 && viewIdx < PAGES.length - 1) { showPage(viewIdx + 1); return; }
  dispatch(Cmd.turnForward());
}

/* 「后退」：回看上一页（已解锁页之间自由翻动） */
function pageBack() {
  if (viewIdx > 0) showPage(viewIdx - 1);
}

/* 正文列的半宽（CSS px）：此宽度内为不翻页的阅读/选词区，两侧为翻页边栏。
 * 背景画的留白遮罩也用它，使「能翻页的地方」与「画出现的地方」视觉一致。 */
function textHalfPx() {
  const W = innerWidth;
  if (W < 680) return W * 0.34;        // 窄屏：中间 68% 可选，两侧各 16% 翻页
  return Math.min(330, W / 2 - 40);    // 宽屏：中间≈正文列，两侧留白翻页
}

/* ---------------- 道具 / 线索 / 卷宗 ---------------- */

function hasItem(id) { return STATE.items.includes(id); }

function addItem(id) {
  if (hasItem(id) || !CH.items[id]) return;
  STATE.items.push(id);
  emit({ k: 'item', id });
  logStatement('【获得：' + CH.items[id].name + '】', 'get');
}

function removeItem(id) {
  STATE.items = STATE.items.filter(x => x !== id);
  if (selected === id) select(null);
  emit({ k: 'items' });
}

function renderItems() {
  const inv = $('inv');
  inv.querySelectorAll('.chip').forEach(c => c.remove());
  for (const id of STATE.items) {
    const it = CH.items[id];
    const chip = document.createElement('span');
    chip.className = 'chip' + (selected === id ? ' sel' : '');
    chip.dataset.item = id;
    chip.title = it.desc;
    chip.textContent = it.icon + ' ' + it.name;
    chip.dataset.ui = 'chip';
    inv.appendChild(chip);
  }
}

function select(id) {
  selected = id;
  renderItems();
  const it = id && CH.items[id];
  hint(it ? '已装填：' + it.name + '——' + it.desc + '（点击文中的目标使用，再点一次退弹）' : '');
}

function addClue(text) {
  if (STATE.clues.includes(text)) return;
  STATE.clues.push(text);
  emit({ k: 'clue' });
  logStatement('【线索：' + text + '】', 'clue');
}

let hintTimer = null;
function hint(t, flashIt) {
  const bar = $('hintbar');
  bar.textContent = t;
  bar.classList.toggle('flash', !!flashIt);
  clearTimeout(hintTimer);
  if (flashIt) hintTimer = setTimeout(() => {
    bar.classList.remove('flash');
    bar.textContent = selected ? '已装填：' + CH.items[selected].name : '';
  }, 2800);
}

/* ---------------- 条件与动作 ---------------- */

function evalCond(expr) {
  return expr.split('&&').every(term => {
    term = term.trim();
    const neg = term.startsWith('!');
    if (neg) term = term.slice(1).trim();
    const val = STATE.flags.has(term) || hasItem(term);
    return neg ? !val : val;
  });
}

/* 执行单行动作；返回 'goto' 表示流程已转移，返回数字表示输出的字数 */
function execAction(t, cls) {
  let m;
  if ((m = t.match(/^if\s+(.+?)\s*:\s*(.+)$/))) {
    if (!evalCond(m[1])) return;
    t = m[2];
  }
  if ((m = t.match(/^get\s+(\w+)/)))       { addItem(m[1]); return; }
  if ((m = t.match(/^take\s+(\w+)/)))      { removeItem(m[1]); return; }
  if ((m = t.match(/^set\s+(\w+)/)))       { STATE.flags.add(m[1]); return; }
  if ((m = t.match(/^unset\s+(\w+)/)))     { STATE.flags.delete(m[1]); return; }
  if ((m = t.match(/^clue\s+(.+)/)))       { addClue(m[1]); return; }
  if ((m = t.match(/^hint\s+(.+)/)))       { emit({ k: 'hint', text: m[1], flash: true }); return; }
  if ((m = t.match(/^sfx\s+(\w+)/)))       { emit({ k: 'sfx', name: m[1] }); return; }
  if ((m = t.match(/^amb\s+(\w+)/)))       { emit({ k: 'amb', name: m[1] }); return; }
  if ((m = t.match(/^fx\s+(\w+)\s*(.*)/))) { emit({ k: 'fx', name: m[1], arg: m[2] }); return; }
  if ((m = t.match(/^off\s*(\w*)/)))       { offWord(m[1] || currentWord); return; }
  if ((m = t.match(/^archive\s+(.+)/))) {
    const [title, body = ''] = m[1].split('|').map(s => s.trim());
    STATE.archive.push({ title, body });
    return;
  }
  if ((m = t.match(/^goto\s+(\w+)/)))      { enterScene(m[1]); return 'goto'; }
  if ((m = t.match(/^nav\s+(\S+)/)))       { emit({ k: 'nav', url: m[1] }); return; }
  logStatement(t, cls); return;
}

/* 置灰一个词（VM）：记入 STATE.used + emit wordoff（以页为范围，便于读档还原） */
function offWord(id, pi) {
  if (!id) return;
  if (pi == null) pi = curPageIdx;
  if (pi < 0) return;
  const key = pi + ':' + id;
  if (!STATE.used.includes(key)) STATE.used.push(key);
  emit({ k: 'wordoff', pi, id });
}

/* 执行一个互动块（VM）：置灰 → 跑动作 → 非跳转则巡检触发器、滚动展开内容 */
function execBlock(block, sid, pi) {
  if (block.once) offWord(block.word, pi); // 立即置灰，防止重复触发
  if (runLines(block.actions, sid, pi, block.word) !== 'goto') {
    checkWhens();
    emit({ k: 'scroll', pi });
  }
}

/* 检查所有已解锁场景的自动触发（同步执行，可链式）；返回是否触发过 */
function checkWhens() {
  const unlocked = new Set(STATE.log.map(p => p.scene));
  for (const sid of unlocked) {
    const sc = CH.scenes[sid];
    for (let i = 0; i < sc.whens.length; i++) {
      const w = sc.whens[i];
      if (!w.fired && evalCond(w.cond)) {
        w.fired = true;
        (STATE.whensFired[sid] = STATE.whensFired[sid] || []).push(i);
        if (runLines([w.action], sid, lastPageIdxOf(sid), null) !== 'goto') {
          checkWhens(); // 链式触发
        }
        return true;
      }
    }
  }
  return false;
}

/* ---------------- 场景 ---------------- */

/* 进入场景（VM）：新开首页 + emit view/hint + 跑首页动作；调用方负责 commit() */
function enterScene(id) {
  const sc = CH.scenes[id];
  if (!sc) { console.error('场景不存在：' + id); return; }
  STATE.scene = id;
  STATE.sp = 0;
  const idx = newPage(id, 0);
  emit({ k: 'view', idx });
  if (idx === 0) emit({ k: 'hint', flash: true,
    text: '点击发亮的词互动；点屏幕右侧翻下一页，左侧回上一页（正文区可自由划选）。' });
  if (runLines(sc.pages[0].lines, id, idx, null, pageCls(sc)) !== 'goto') checkWhens();
}

/* ---------------- 点击分发（全站唯一的点击监听器） ----------------
 * 组件以 data-ui 声明身份并在 UI_ACTIONS 注册；阅读区互动词其次；
 * 「翻页」只对阅读区 main 内的空白点击生效。
 */

function jumpToAct(a) {
  for (let j = PAGES.length - 1; j >= 0; j--) {
    if (PAGES[j].act === a) { showPage(j); break; }
  }
}

const UI_ACTIONS = {
  start()          { startNewGame(); },
  continue()       { continueGame(); },
  mute()           { FX.toggle(); syncMute(); },
  archive()        { openArchive(); },
  'archive-close'() { $('archive').style.display = 'none'; },
  finder()         { openFinder(); },
  'finder-close'() { $('finder').style.display = 'none'; },
  pg(el)           { showPage(+el.dataset.idx); },
  act(el)          { jumpToAct(+el.dataset.act); },
  chip(el)         { const id = el.dataset.item; select(selected === id ? null : id); },
  'fd-item'(el)    { $('finder').style.display = 'none'; showPage(+el.dataset.idx); },
  bk(el) {
    const idx = PAGES.findIndex(p => p.el === el.closest('.page'));
    if (idx >= 0) toggleBookmark(idx);
  },
};

/* 点击互动词（命令）：定位页 → 跑块（VM）→ commit；空操作分支直接给提示 */
function wordClick(el) {
  const pageEl = el.closest('.page');
  const pi = pageEl ? PAGES.findIndex(p => p.el === pageEl) : PAGES.length - 1;
  const sid = pageEl ? pageEl.dataset.scene : STATE.scene;
  const sc = CH.scenes[sid];
  if (!sc) return;
  const id = el.dataset.act;
  markSeen(sid, id);
  if (selected) {
    if (sc.blocks[id + '@' + selected]) {
      const item = selected; select(null);
      dispatch(Cmd.useItem(item, pi, id)); return;
    }
    el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake');
    hint('（' + CH.items[selected].name + '对它没有反应。）', true);
    updatePagebar(); return;
  }
  if (sc.blocks[id]) { dispatch(Cmd.clickWord(pi, id)); return; }
  if (Object.keys(sc.blocks).some(k => k.startsWith(id + '@'))) {
    hint('（直接点没有用，似乎需要装填什么。）', true);
  }
  updatePagebar();
}

document.addEventListener('click', e => {
  if (!e.target.isConnected) return; // 防御：目标已被重建拆离 DOM
  /* 1. 注册组件 */
  const ui = e.target.closest('[data-ui]');
  if (ui) {
    const fn = UI_ACTIONS[ui.dataset.ui];
    if (fn) fn(ui);
    return;
  }
  if (!CH) return;
  /* 2. 阅读区互动词 */
  const el = e.target.closest('main .w[data-act]');
  if (el && !el.classList.contains('used')) { wordClick(el); return; }
  /* 3. 翻页手势：只有正文两侧的边栏触发；正文区可自由划选、不翻页 */
  if (e.target.closest('footer, header, #hud, #pagebar, #archive, #finder, #cover')) return;
  const sel = window.getSelection && String(window.getSelection());
  if (sel && sel.trim()) return;       // 正在/刚划选文字：吞掉本次点击，绝不翻页
  const half = textHalfPx();
  if (e.clientX < innerWidth / 2 - half) pageBack();
  else if (e.clientX > innerWidth / 2 + half) advance();
  /* 中间正文区：什么都不做（留给阅读与选词） */
});

/* 键盘：空格/回车/→ 前进，← 后退 */
document.addEventListener('keydown', e => {
  if (!CH || e.target.closest('input, textarea') ||
      document.querySelector('#cover:not(.hide)')) return;
  if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') {
    e.preventDefault(); advance();
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault(); pageBack();
  }
});

/* ---------------- 具名特效 ---------------- */

function runFx(name, arg) {
  switch (name) {
    case 'rain':     RAINFX.start(); break;
    case 'fxoff':    RAINFX.stop(); break;
    case 'flash':    flash(.8); break;
    case 'shake':
      document.body.classList.remove('quake'); void document.body.offsetWidth;
      document.body.classList.add('quake'); break;
    case 'dissolve': fxDissolve(); break;
    case 'stamp':    fxStamp(arg || '归档'); break;
  }
}

function flash(strength = 1) {
  const f = $('flash');
  f.style.transition = 'none';
  f.style.opacity = strength;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    f.style.transition = 'opacity .6s';
    f.style.opacity = 0;
  }));
}

/* 文字溃散：取当前页最近的正文字符抛散整屏 */
function fxDissolve() {
  const text = [...document.querySelectorAll('#log .page.cur p')].slice(-4)
    .map(p => p.textContent).join('').replace(/\s/g, '');
  const ov = document.createElement('div');
  ov.className = 'dissolve-ov';
  for (let i = 0; i < 60; i++) {
    const s = document.createElement('span');
    s.textContent = text[Math.floor(Math.random() * text.length)] || '丶';
    s.style.left = Math.random() * 100 + 'vw';
    s.style.top = Math.random() * 100 + 'vh';
    s.style.setProperty('--dx', (Math.random() * 240 - 120) + 'px');
    s.style.setProperty('--dy', (Math.random() * 240 - 60) + 'px');
    s.style.setProperty('--rot', (Math.random() * 540 - 270) + 'deg');
    s.style.animationDelay = Math.random() * .25 + 's';
    ov.appendChild(s);
  }
  document.body.appendChild(ov);
  flash(.5);
  setTimeout(() => ov.remove(), 1600);
}

function fxStamp(text) {
  const st = document.createElement('div');
  st.className = 'stamp';
  st.textContent = text;
  document.body.appendChild(st);
  FX.sfx('stamp');
  setTimeout(() => st.classList.add('fade'), 2600);
  setTimeout(() => st.remove(), 3400);
}

/* ---------------- 卷宗库 ---------------- */

function openArchive() {
  const box = $('arc-list');
  box.innerHTML = '';
  if (!STATE.archive.length && !STATE.clues.length) {
    box.innerHTML = '<p class="arc-empty">（暂无归档案卷）</p>';
  }
  for (const a of STATE.archive) {
    const d = document.createElement('div');
    d.className = 'arc-entry';
    d.innerHTML = `<div class="arc-title">${a.title}</div><div class="arc-body">${a.body}</div>`;
    box.appendChild(d);
  }
  if (STATE.clues.length) {
    const d = document.createElement('div');
    d.className = 'arc-entry';
    d.innerHTML = '<div class="arc-title">当前案件 · 线索</div>' +
      STATE.clues.map(c => `<div class="arc-body">· ${c}</div>`).join('');
    box.appendChild(d);
  }
  $('archive').style.display = 'flex';
}

/* ---------------- 合成音效（三轨：amb / sfx / voice 预留） ---------------- */

const FX = (() => {
  let ctx = null, master = null, ambGain = null, ambName = '';
  let muted = localStorage.getItem('mb-muted') === '1';

  function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }
  function noiseBuffer(sec) {
    const buf = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  function tone(type, freq, dur, vol, freqEnd) {
    ensure();
    const o = ctx.createOscillator(), g = ctx.createGain();
    const t = ctx.currentTime;
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(.001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur);
  }
  function rustle(dur, freq, vol, type = 'highpass') {
    ensure();
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(dur);
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(.001, t + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start();
  }

  const SFX = {
    paper()     { rustle(.16, 3200, .1); },
    knock()     { [0, 220].forEach(d => setTimeout(() => tone('sine', 95, .12, .4, 60), d)); },
    get()       { tone('sine', 880, .12, .16); setTimeout(() => tone('sine', 1318, .25, .14), 110); },
    clue()      { tone('sine', 1560, .3, .1); },
    stab()      { tone('sawtooth', 520, .25, .22, 130); },
    unlock()    { tone('square', 1100, .05, .12); setTimeout(() => tone('square', 700, .09, .15), 90); },
    dive()      { tone('sine', 220, 1.1, .2, 880); rustle(.9, 600, .06, 'lowpass'); },
    interrupt() { tone('sawtooth', 1400, .4, .25, 90); rustle(.35, 2000, .25); },
    stamp()     { tone('sine', 70, .22, .6, 45); rustle(.08, 1200, .2); },
    slam()      { tone('sine', 70, .22, .6, 45); rustle(.1, 1200, .2); },
    buzz()      { [0, 260].forEach(d => setTimeout(() => { tone('square', 55, .18, .18); tone('sine', 180, .18, .06); }, d)); },
  };

  function startAmb(name) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(3);
    src.loop = true;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    g.gain.value = 0;
    if (name === 'rain') {
      f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = .5;
      g.gain.linearRampToValueAtTime(.05, ctx.currentTime + 2);
    } else { // office：空调低鸣
      f.type = 'lowpass'; f.frequency.value = 220;
      g.gain.linearRampToValueAtTime(.04, ctx.currentTime + 2);
    }
    src.connect(f); f.connect(g); g.connect(master);
    src.start();
    ambGain = g;
  }

  return {
    unlockAudio() { ensure(); },
    sfx(name) { ensure(); (SFX[name] || (() => {}))(); },
    amb(name) {
      ensure();
      if (name === ambName) return;
      if (ambGain) ambGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.5);
      ambName = name;
      if (name !== 'off') startAmb(name);
    },
    toggle() {
      muted = !muted;
      localStorage.setItem('mb-muted', muted ? '1' : '0');
      if (master) master.gain.value = muted ? 0 : 1;
      return muted;
    },
    isMuted() { return muted; },
  };
})();

/* ---------------- 背景画层：1-bit 抖动（真实素材，奥布拉丁风） ----------------
 * 场景属性 art:<名字> 在 ART_IMAGES 里查一张真实插画素材；有图则载入 →
 * 8×8 Bayer 有序抖动转 1-bit → 中间留白遮罩裁进正文两侧边栏；无图则留空
 * （当前即此：背景保持干净）。程序化几何画法已弃用——细节不足到不了目标质感，
 * 真正的 1-bit 场景靠这里喂真实素材（画师手绘 / AI 生成后入库）。
 */

const BAYER8 = [
   0,32, 8,40, 2,34,10,42, 48,16,56,24,50,18,58,26,
  12,44, 4,36,14,46, 6,38, 60,28,52,20,62,30,54,22,
   3,35,11,43, 1,33, 9,41, 51,19,59,27,49,17,57,25,
  15,47, 7,39,13,45, 5,37, 63,31,55,23,61,29,53,21,
];

/* 素材登记表：art:<名> → 图片 URL。放进真实 1-bit 插画即自动生效。 */
const ART_IMAGES = {
  // office:   'art/office.png',
  // interro:  'art/interro.png',
  // alley:    'art/alley.png',
};

const BGART = (() => {
  const cv = $('bgart');
  if (!cv) return { show() {} };                  // 无画布环境（编辑器等）
  const cx = cv.getContext('2d');
  const off = document.createElement('canvas');
  const octx = off.getContext('2d', { willReadFrequently: true });
  let cur = null, curImg = null;

  function clear() { cx.clearRect(0, 0, cv.width, cv.height); cv.style.opacity = 0; }

  /* 把一张图抖成 1-bit、裁进两侧边栏 */
  function dither(img) {
    const W = cv.width, H = cv.height;
    const w = Math.max(2, Math.ceil(W / 2)), h = Math.max(2, Math.ceil(H / 2));
    off.width = w; off.height = h;
    octx.clearRect(0, 0, w, h);
    const s = Math.max(w / img.width, h / img.height);          // 等比铺满
    octx.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2,
      img.width * s, img.height * s);
    const src = octx.getImageData(0, 0, w, h).data;
    const out = octx.createImageData(w, h), o = out.data;
    const half = textHalfPx() / 2, cxc = w / 2, ramp = 36;      // 半分辨率坐标
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = (src[i] * .299 + src[i + 1] * .587 + src[i + 2] * .114) * (src[i + 3] / 255);
      const thr = (BAYER8[(y & 7) * 8 + (x & 7)] + 0.5) / 64 * 255;
      if (lum <= thr) { o[i + 3] = 0; continue; }
      const d = Math.abs(x - cxc) - half;                       // 中间留白
      const m = d <= 0 ? 0 : Math.min(1, d / ramp);
      if (m <= 0) { o[i + 3] = 0; continue; }
      o[i] = 210; o[i + 1] = 218; o[i + 2] = 232; o[i + 3] = Math.round(150 * m);
    }
    octx.putImageData(out, 0, 0);
    cx.imageSmoothingEnabled = false;
    cx.clearRect(0, 0, W, H);
    cx.drawImage(off, 0, 0, w, h, 0, 0, W, H);
    cv.style.opacity = 1;
  }

  function resize() { cv.width = innerWidth; cv.height = innerHeight; if (curImg) dither(curImg); }
  addEventListener('resize', resize);
  resize();

  return {
    show(name) {
      name = name || null;
      if (name === cur) return;
      cur = name; curImg = null;
      const url = ART_IMAGES[name];
      if (!url) { clear(); return; }              // 无素材 → 背景干净
      const img = new Image();
      img.onload = () => { if (cur === name) { curImg = img; dither(img); } };
      img.src = url;
    },
  };
})();

/* ---------------- 背景效果层：文字雨 ---------------- */

const RAINFX = (() => {
  const cv = $('rainfx');
  if (!cv) return { start() {}, stop() {} }; // 无画布环境（剧本编辑器等）
  const cx = cv.getContext('2d');
  const CHARS = ['丶', '丨', '丿'];
  let raf = null, on = false, drops = [];

  function resize() { cv.width = innerWidth; cv.height = innerHeight; }
  resize(); addEventListener('resize', resize);

  function make(top) {
    const far = Math.random() < .6;
    return {
      x: Math.random() * (innerWidth + 60),
      y: top ? -20 : Math.random() * innerHeight,
      v: far ? 2.2 + Math.random() * 1.5 : 4.5 + Math.random() * 2.5,
      size: far ? 10 : 15, a: far ? .10 : .20,
      ch: CHARS[Math.floor(Math.random() * CHARS.length)],
    };
  }
  function step() {
    cx.clearRect(0, 0, cv.width, cv.height);
    cx.fillStyle = '#aebadb';
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      d.y += d.v; d.x -= d.v * .25;
      if (d.y > cv.height + 20 || d.x < -20) drops[i] = make(true);
      cx.globalAlpha = d.a;
      cx.font = d.size + 'px serif';
      cx.fillText(d.ch, d.x, d.y);
    }
    if (on) raf = requestAnimationFrame(step);
  }
  return {
    start() {
      if (on) return;
      on = true;
      cv.style.opacity = 1;
      drops = Array.from({ length: Math.min(90, innerWidth / 7) }, () => make(false));
      raf = requestAnimationFrame(step);
    },
    stop() {
      if (!on) return;
      cv.style.transition = 'opacity 3s';
      cv.style.opacity = 0;
      setTimeout(() => { on = false; cancelAnimationFrame(raf); }, 3100);
    },
  };
})();

/* ---------------- 启动 ---------------- */

/* 读档：从结构化 State 重画整本（renderFull） */
function restoreGame(save) {
  STATE.flags = new Set(save.flags);
  STATE.items = save.items;
  STATE.clues = save.clues || [];
  STATE.archive = save.archive || [];
  STATE.seen = save.seen || {};
  STATE.bookmarks = save.bookmarks || [];
  STATE.whensFired = save.whensFired || {};
  STATE.used = save.used || [];
  STATE.log = save.log || [];
  STATE.scene = save.scene;
  STATE.sp = save.sp || 0;

  $('log').innerHTML = '';
  PAGES.length = 0;
  for (const sc of Object.values(CH.scenes)) sc.whens.forEach(w => w.fired = false);
  for (let i = 0; i < STATE.log.length; i++) {                // 从日志重建每一页
    const lp = STATE.log[i];
    mountPage(lp.scene, lp.sp, lp.act, STATE.bookmarks.includes(i));
    for (const it of lp.items) renderStatement(it.text, it.cls, i, false);
  }
  for (const [sid, idxs] of Object.entries(STATE.whensFired)) {
    const sc = CH.scenes[sid];
    if (sc) idxs.forEach(i => { if (sc.whens[i]) sc.whens[i].fired = true; });
  }
  renderItems();
  showPage(PAGES.length - 1);
  checkWhens();   // 读档后可能补触发；其 emit 由 flush 落地
  flush();
}

/* 全量重置运行时（重新开始，免依赖刷新页面） */
function resetState() {
  STATE.flags = new Set();
  STATE.items = []; STATE.clues = []; STATE.archive = [];
  STATE.seen = {}; STATE.bookmarks = []; STATE.whensFired = {};
  STATE.log = []; STATE.used = [];
  STATE.scene = null; STATE.sp = 0;
  PAGES.length = 0; viewIdx = -1; selected = null;
  $('log').innerHTML = '';
  for (const sc of Object.values(CH.scenes)) sc.whens.forEach(w => w.fired = false);
  renderItems();
}

let pendingSave = null;

function startNewGame() {
  FX.unlockAudio();
  localStorage.removeItem(saveKey());
  resetState();
  $('cover').classList.add('hide');
  dispatch(Cmd.start());
}

function continueGame() {
  if (!pendingSave) return;
  FX.unlockAudio();
  $('cover').classList.add('hide');
  restoreGame(pendingSave);
}

function syncMute() {
  document.querySelectorAll('.mutebtn')
    .forEach(b => b.textContent = FX.isMuted() ? '🔇' : '🔊');
}

function openFinder() {
  renderFinder('');
  $('fd-q').value = '';
  $('finder').style.display = 'flex';
  $('fd-q').focus();
}

function bootGame(chapterId, opts = {}) {
  IS_DRAFT = !!opts.draft;
  const src = opts.src || (window.MB_SCRIPTS || {})[chapterId];
  if (!src) { document.body.textContent = '剧本未找到：' + chapterId; return; }
  CH = parseScript(src);

  $('hud-name').textContent = CH.meta.protagonist || '';
  $('hud-badge').textContent = CH.meta.badge ? '警号 ' + CH.meta.badge : '';
  $('cv-title').textContent = (CH.meta.title || '') + (IS_DRAFT ? ' · 草稿试玩' : '');

  pendingSave = loadSave();
  if (pendingSave && CH.scenes[pendingSave.scene]) {
    const w = $('cv-continue');
    w.style.display = '';
    w.innerHTML = `<span class="w" data-ui="continue">同步记忆</span>（槽位 ${CH.meta.badge} · 继续）`;
  } else {
    pendingSave = null;
  }
  syncMute();

  let fdTimer = null;
  $('fd-q').addEventListener('input', () => {
    clearTimeout(fdTimer);
    fdTimer = setTimeout(() => renderFinder($('fd-q').value.trim()), 250);
  });
}
