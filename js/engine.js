/* ====================================================================
 *  魔法书剧本引擎 v0 —— 解析并运行 MBS 格式剧本（规范见 FORMAT.md）
 *  章节文本注册在 window.MB_SCRIPTS，由 game.html 选择加载。
 *
 *  展现模型：一场景一「页」。当前页内的互动就地展开；goto 解锁新页；
 *  页码条支持回翻，含未读元素的页以高亮点提示。
 * ==================================================================== */
'use strict';

/* ---------------- 解析器 ---------------- */

const SCENE_PROPS = ['label', 'bg', 'amb', 'music', 'fx', 'mode', 'style'];

function parseScript(src) {
  const ch = { meta: {}, items: {}, scenes: {}, order: [] };
  let mode = null, scene = null, block = null, blockIndent = 0;

  for (const raw of src.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('//')) continue;
    const indent = line.match(/^\s*/)[0].length;
    const t = line.trim();
    let m;

    if (t === '@meta')  { mode = 'meta';  continue; }
    if (t === '@items') { mode = 'items'; continue; }
    if ((m = t.match(/^@scene\s+(\S+)/))) {
      scene = { id: m[1], props: {}, flow: [], blocks: {}, whens: [] };
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
    if (mode !== 'scene') continue;

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
    if (scene.flow.length === 0 &&
        (m = t.match(/^(\w+)\s*:\s*(.*)$/)) && SCENE_PROPS.includes(m[1])) {
      scene.props[m[1]] = m[2];
      continue;
    }
    scene.flow.push(t);
  }
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
  return errs;
}

/* ---------------- 运行时状态 ---------------- */

let CH = null;
const STATE = {
  scene: null,   // 推进前沿（最新解锁的页）
  pages: [],     // 已解锁的页（场景 id，按解锁顺序）
  seen: {},      // sceneId -> [点击过的词 id]
  flags: new Set(),
  items: [],
  clues: [],
  archive: [],   // {title, body}
};
let viewScene = null;   // 当前正在查看的页
let curScene = null;    // 当前正在写入的页（pump 执行期间设置）
let selected = null;
let IS_DRAFT = false;   // 草稿试玩：存档与正式进度隔离

const $ = id => document.getElementById(id);

const SAVE_FMT = 2;

function saveKey() { return 'mb-save-' + (IS_DRAFT ? 'draft-' : '') + CH.meta.id; }

function saveGame() {
  localStorage.setItem(saveKey(), JSON.stringify({
    fmt: SAVE_FMT,
    v: CH.meta.version,
    scene: STATE.scene,
    pages: STATE.pages,
    seen: STATE.seen,
    flags: [...STATE.flags],
    items: STATE.items,
    clues: STATE.clues,
    archive: STATE.archive,
  }));
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

function pageFor(sid) {
  return document.querySelector(`#log .page[data-scene="${sid}"]`);
}

function createPage(sid) {
  const sc = CH.scenes[sid];
  const sec = document.createElement('section');
  sec.className = 'page';
  sec.dataset.scene = sid;
  if (sc.props.label) {
    const h = document.createElement('h2');
    h.className = 'page-title';
    h.textContent = sc.props.label;
    sec.appendChild(h);
  }
  $('log').appendChild(sec);
  return sec;
}

function showPage(sid) {
  viewScene = sid;
  document.querySelectorAll('#log .page')
    .forEach(p => p.classList.toggle('cur', p.dataset.scene === sid));
  const sc = CH.scenes[sid];
  /* 页的氛围跟随视图：背景 / 环境音 / 效果层 / 记忆态 */
  if (sc.props.bg) document.body.style.backgroundColor = sc.props.bg;
  if (sc.props.amb) FX.amb(sc.props.amb);
  if (sc.props.fx) runFx(sc.props.fx === 'off' ? 'fxoff' : sc.props.fx);
  document.body.classList.toggle('memory', sc.props.mode === 'memory');
  updatePagebar();
  const pg = pageFor(sid);
  if (sid === STATE.scene) {
    (pg.lastElementChild || pg).scrollIntoView({ behavior: 'smooth', block: 'end' });
  } else {
    pg.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function markSeen(sid, wordId) {
  (STATE.seen[sid] = STATE.seen[sid] || []).includes(wordId) ||
    STATE.seen[sid].push(wordId);
}

/* 该页是否还有从未点过的可互动元素 */
function hasUnseen(sid) {
  const pg = pageFor(sid), sc = CH.scenes[sid];
  if (!pg || !sc) return false;
  const seen = STATE.seen[sid] || [];
  return [...pg.querySelectorAll('.w[data-act]')].some(el => {
    if (el.classList.contains('used')) return false;
    const id = el.dataset.act;
    if (seen.includes(id)) return false;
    return sc.blocks[id] || Object.keys(sc.blocks).some(k => k.startsWith(id + '@'));
  });
}

function updatePagebar() {
  const bar = $('pagebar');
  if (!bar) return;
  bar.innerHTML = '';
  STATE.pages.forEach((sid, i) => {
    const b = document.createElement('span');
    b.className = 'pg'
      + (sid === viewScene ? ' cur' : '')
      + (hasUnseen(sid) ? ' unseen' : '');
    b.textContent = i + 1;
    b.title = CH.scenes[sid].props.label || sid;
    b.onclick = () => {
      if (Q.length) { hint('（文字还在播放中……）', true); return; }
      showPage(sid);
    };
    bar.appendChild(b);
  });
}

/* ---------------- 文本输出 ---------------- */

function fmt(s) {
  return s.replace(/\[([^\]|]+)(?:\|([^\]]+))?\]/g,
    (_, w, id) => `<span class="w" data-act="${id || w}">${w}</span>`);
}

function sayLine(t, extraCls, sid) {
  const target = pageFor(sid || curScene || STATE.scene);
  if (!target) return { textContent: '' };
  const p = document.createElement('p');
  let cls = extraCls || '', m;
  if (t.startsWith(': ')) t = t.slice(2); // 块内文本行的可选前缀
  if (t.startsWith('! ')) { cls += ' obj'; t = t.slice(2); }
  else if ((m = t.match(/^([一-龥A-Za-z0-9·]{1,10})(（内心）|\(内心\))?\s*[:：]\s*(.+)$/))) {
    if (m[2]) { cls += ' think'; t = m[3]; }
    else {
      cls += ' speech';
      if (m[1] === '系统') cls += ' sysv'; // 记忆侦查辅助系统的语音
      t = `<b>${m[1]}</b>` + fmt(m[3]); p.innerHTML = t;
    }
    if (!p.innerHTML) t = fmt(t);
  }
  const sc = CH.scenes[target.dataset.scene];
  if (sc && sc.props.mode === 'memory') cls += ' mem';
  p.className = cls.trim();
  if (!p.innerHTML) p.innerHTML = fmt(t);
  target.appendChild(p);
  if (target.classList.contains('cur')) {
    p.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
  return p;
}

/* ---------------- 文本节奏：事件队列 + 点击继续 ---------------- */

const CHUNK_CHARS = 72;  // 每次推进的字数预算
const Q = [];            // 事件：{line, word, scene, cls}

function qClear() { Q.length = 0; }

function updateMore() {
  $('more').style.display = Q.length ? 'block' : 'none';
}

let currentWord = null;  // off 不带参数时置灰的目标

function pump() {
  let budget = CHUNK_CHARS;
  while (true) {
    if (!Q.length && !checkWhens()) break;
    if (!Q.length) continue;
    const ev = Q.shift();
    currentWord = ev.word || null;
    curScene = ev.scene || STATE.scene;
    const r = execAction(ev.line, ev.cls);
    if (r === 'goto' && ev.word) offWord(ev.word, ev.scene); // 出口词用毕置灰
    currentWord = null;
    if (typeof r === 'number') budget -= r;
    if (budget <= 0 && Q.length) break;
  }
  curScene = null;
  updateMore();
  updatePagebar();
}

/* ---------------- 道具 / 线索 / 卷宗 ---------------- */

function hasItem(id) { return STATE.items.includes(id); }

function addItem(id) {
  if (hasItem(id) || !CH.items[id]) return;
  STATE.items.push(id);
  renderItems();
  FX.sfx('get');
  sayLine('【获得：' + CH.items[id].name + '】', 'get');
}

function removeItem(id) {
  STATE.items = STATE.items.filter(x => x !== id);
  if (selected === id) select(null);
  renderItems();
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
    chip.onclick = () => select(selected === id ? null : id);
    inv.appendChild(chip);
  }
}

function select(id) {
  selected = id;
  renderItems();
  hint(id ? '已装填：' + CH.items[id].name + ' —— 点击文中的目标使用，再点一次退弹' : '');
}

function addClue(text) {
  if (STATE.clues.includes(text)) return;
  STATE.clues.push(text);
  FX.sfx('clue');
  sayLine('【线索：' + text + '】', 'clue');
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
  if ((m = t.match(/^hint\s+(.+)/)))       { hint(m[1], true); return; }
  if ((m = t.match(/^sfx\s+(\w+)/)))       { FX.sfx(m[1]); return; }
  if ((m = t.match(/^amb\s+(\w+)/)))       { FX.amb(m[1]); return; }
  if ((m = t.match(/^fx\s+(\w+)\s*(.*)/))) { runFx(m[1], m[2]); return; }
  if ((m = t.match(/^off\s*(\w*)/)))       { offWord(m[1] || currentWord, curScene); return; }
  if ((m = t.match(/^archive\s+(.+)/))) {
    const [title, body = ''] = m[1].split('|').map(s => s.trim());
    STATE.archive.push({ title, body });
    return;
  }
  if ((m = t.match(/^goto\s+(\w+)/)))      { enterScene(m[1]); return 'goto'; }
  if ((m = t.match(/^nav\s+(\S+)/)))       { location.href = m[1]; return; }
  return sayLine(t, cls).textContent.length;
}

function offWord(id, sid) {
  if (!id) return;
  const scope = (sid && pageFor(sid)) || document;
  scope.querySelectorAll(`.w[data-act="${id}"]`)
    .forEach(el => el.classList.add('used'));
}

function execBlock(block, sid) {
  if (block.once) offWord(block.word, sid); // 立即置灰，防止文本放映期间重复触发
  for (const a of block.actions) Q.push({ line: a, word: block.word, scene: sid });
  pump();
}

/* 检查已解锁各页的自动触发；命中则把动作入队（写入其所属页），返回 true */
function checkWhens() {
  for (const sid of STATE.pages) {
    const sc = CH.scenes[sid];
    for (const w of sc.whens) {
      if (!w.fired && evalCond(w.cond)) {
        w.fired = true;
        Q.push({ line: w.action, word: null, scene: sid });
        return true;
      }
    }
  }
  return false;
}

/* ---------------- 场景（页）---------------- */

function enterScene(id) {
  const sc = CH.scenes[id];
  if (!sc) { console.error('场景不存在：' + id); return; }
  qClear();
  if (pageFor(id)) { showPage(id); return; } // 已解锁的页：仅跳转视图

  createPage(id);
  STATE.pages.push(id);
  STATE.scene = id;
  sc.whens.forEach(w => w.fired = false);
  saveGame();

  const coda = sc.props.style === 'coda' ? 'coda' : '';
  for (const line of sc.flow) Q.push({ line, word: null, scene: id, cls: coda });
  showPage(id);
}

/* ---------------- 点击分发 ---------------- */

document.addEventListener('click', e => {
  /* 文本未放完：底部道具栏/页眉/页码条/卷宗照常工作，其余点击一律视为「继续」 */
  if (Q.length) {
    if (e.target.closest('footer, header, #hud, #pagebar, #archive, #cover')) return;
    pump();
    return;
  }
  const el = e.target.closest('.w[data-act]');
  if (!el || el.classList.contains('used')) return;
  const pageEl = el.closest('.page');
  const sid = pageEl ? pageEl.dataset.scene : STATE.scene;
  const sc = CH && CH.scenes[sid];
  if (!sc) return;
  const id = el.dataset.act;
  markSeen(sid, id);
  if (selected) {
    const block = sc.blocks[id + '@' + selected];
    if (block) { select(null); execBlock(block, sid); }
    else {
      el.classList.remove('shake'); void el.offsetWidth;
      el.classList.add('shake');
      hint('（' + CH.items[selected].name + '对它没有反应。）', true);
    }
  } else if (sc.blocks[id]) {
    execBlock(sc.blocks[id], sid);
  } else if (Object.keys(sc.blocks).some(k => k.startsWith(id + '@'))) {
    hint('（直接点没有用，似乎需要装填什么。）', true);
  }
  updatePagebar();
});

/* 键盘推进：空格 / 回车 */
document.addEventListener('keydown', e => {
  if ((e.key === ' ' || e.key === 'Enter') && Q.length) {
    e.preventDefault();
    pump();
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
    knock()     { [0, 220, 440].forEach(d => setTimeout(() => tone('sine', 95, .12, .5, 60), d)); },
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

/* 读档重建：按解锁顺序重放各页的场景正文（不重放互动展开），恢复状态 */
function restoreGame(save) {
  STATE.flags = new Set(save.flags);
  STATE.items = save.items;
  STATE.clues = save.clues || [];
  STATE.archive = save.archive || [];
  STATE.seen = save.seen || {};
  STATE.pages = [];
  renderItems();

  for (const sid of save.pages) {
    const sc = CH.scenes[sid];
    if (!sc) continue;
    createPage(sid);
    STATE.pages.push(sid);
    curScene = sid;
    const coda = sc.props.style === 'coda' ? 'coda' : '';
    for (const line of sc.flow) sayLine(line, coda, sid);
    curScene = null;
    /* 已点过的一次性词与出口词恢复置灰 */
    const seen = STATE.seen[sid] || [];
    for (const el of pageFor(sid).querySelectorAll('.w[data-act]')) {
      const b = sc.blocks[el.dataset.act];
      if (b && seen.includes(el.dataset.act) &&
          (b.once || b.actions.some(a => /^goto\s/.test(a) || /^if .+:\s*goto\s/.test(a)))) {
        el.classList.add('used');
      }
    }
    /* 非前沿页的触发器视为已触发（其揭示文本不重放） */
    if (sid !== save.scene) {
      sc.whens.forEach(w => { if (evalCond(w.cond)) w.fired = true; });
    }
  }
  STATE.scene = save.scene;
  showPage(save.scene);
  pump(); // 前沿页的 when 会重新揭示出口
}

function bootGame(chapterId, opts = {}) {
  IS_DRAFT = !!opts.draft;
  const src = opts.src || (window.MB_SCRIPTS || {})[chapterId];
  if (!src) { document.body.textContent = '剧本未找到：' + chapterId; return; }
  CH = parseScript(src);

  $('hud-name').textContent = CH.meta.protagonist || '';
  $('hud-badge').textContent = CH.meta.badge ? '警号 ' + CH.meta.badge : '';
  $('cv-title').textContent = (CH.meta.title || '') + (IS_DRAFT ? ' · 草稿试玩' : '');

  const save = loadSave();
  if (save && CH.scenes[save.scene]) {
    const w = $('cv-continue');
    w.style.display = '';
    w.innerHTML = `<span class="w" id="go-continue">同步记忆</span>（槽位 ${CH.meta.badge} · 继续）`;
    $('go-continue').onclick = () => {
      FX.unlockAudio();
      $('cover').classList.add('hide');
      restoreGame(save);
    };
  }
  $('go-start').onclick = () => {
    FX.unlockAudio();
    localStorage.removeItem(saveKey());
    $('cover').classList.add('hide');
    enterScene(CH.meta.start || CH.order[0]);
    pump();
  };

  const syncMute = () => document.querySelectorAll('.mutebtn')
    .forEach(b => b.textContent = FX.isMuted() ? '🔇' : '🔊');
  document.querySelectorAll('.mutebtn')
    .forEach(b => b.onclick = () => { FX.toggle(); syncMute(); });
  syncMute();

  $('btn-archive').onclick = openArchive;
  $('arc-close').onclick = () => $('archive').style.display = 'none';
}
