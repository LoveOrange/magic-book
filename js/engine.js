/* ====================================================================
 *  魔法书剧本引擎 v0 —— 解析并运行 MBS 格式剧本（规范见 FORMAT.md）
 *  章节文本注册在 window.MB_SCRIPTS，由 game.html 选择加载。
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

/* ---------------- 运行时状态 ---------------- */

let CH = null;
const STATE = {
  scene: null,
  flags: new Set(),
  items: [],
  clues: [],
  archive: [],   // {title, body}
  mode: '',      // 当前渲染态（'' | 'memory'）
};
let selected = null;
let printQueue = [];

const $ = id => document.getElementById(id);

function saveKey() { return 'mb-save-' + CH.meta.id; }

function saveGame() {
  localStorage.setItem(saveKey(), JSON.stringify({
    v: CH.meta.version,
    scene: STATE.scene,
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
  try { return JSON.parse(localStorage.getItem(saveKey())); }
  catch { return null; }
}

/* ---------------- 文本输出 ---------------- */

function fmt(s) {
  return s.replace(/\[([^\]|]+)(?:\|([^\]]+))?\]/g,
    (_, w, id) => `<span class="w" data-act="${id || w}">${w}</span>`);
}

function sayLine(t, extraCls) {
  const p = document.createElement('p');
  let cls = extraCls || '', m;
  if (t.startsWith(': ')) t = t.slice(2); // 块内文本行的可选前缀
  if (t.startsWith('! ')) { cls += ' obj'; t = t.slice(2); }
  else if ((m = t.match(/^([一-龥A-Za-z0-9·]{1,10})(（内心）|\(内心\))?\s*[:：]\s*(.+)$/))) {
    if (m[2]) { cls += ' think'; t = m[3]; }
    else { cls += ' speech'; t = `<b>${m[1]}</b>` + fmt(m[3]); p.innerHTML = t; }
    if (!p.innerHTML) t = fmt(t);
  }
  if (STATE.mode === 'memory') cls += ' mem';
  p.className = cls.trim();
  if (!p.innerHTML) p.innerHTML = fmt(t);
  $('log').appendChild(p);
  p.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return p;
}

function divider(t) { sayLine(t, 'divider'); }

function clearQueue() { printQueue.forEach(clearTimeout); printQueue = []; }

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

/* 执行单行动作；返回 'goto' 表示流程已转移 */
function execAction(t) {
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
  if ((m = t.match(/^off\s*(\w*)/)))       { offWord(m[1]); return; }
  if ((m = t.match(/^archive\s+(.+)/))) {
    const [title, body = ''] = m[1].split('|').map(s => s.trim());
    STATE.archive.push({ title, body });
    return;
  }
  if ((m = t.match(/^goto\s+(\w+)/)))      { enterScene(m[1]); return 'goto'; }
  if ((m = t.match(/^nav\s+(\S+)/)))       { location.href = m[1]; return; }
  sayLine(t);
}

let currentWord = null; // off 不带参数时置灰的目标

function offWord(id) {
  const target = id || currentWord;
  if (!target) return;
  document.querySelectorAll(`.w[data-act="${target}"]`)
    .forEach(el => el.classList.add('used'));
}

function execBlock(block) {
  currentWord = block.word;
  for (const a of block.actions) {
    if (execAction(a) === 'goto') { currentWord = null; return; }
  }
  if (block.once) offWord(block.word);
  currentWord = null;
  checkWhens();
}

function checkWhens() {
  const sc = CH.scenes[STATE.scene];
  if (!sc) return;
  for (const w of sc.whens) {
    if (!w.fired && evalCond(w.cond)) {
      w.fired = true;
      execAction(w.action);
      return;
    }
  }
}

/* ---------------- 场景 ---------------- */

function enterScene(id) {
  const sc = CH.scenes[id];
  if (!sc) { console.error('场景不存在：' + id); return; }
  clearQueue();
  /* 上个场景的互动词随场景切换全部失效（存档以场景为粒度） */
  document.querySelectorAll('#log .w').forEach(el => el.classList.add('used'));
  STATE.scene = id;
  STATE.mode = sc.props.mode || '';
  document.body.classList.toggle('memory', STATE.mode === 'memory');
  if (sc.props.bg) document.body.style.backgroundColor = sc.props.bg;
  if (sc.props.amb) FX.amb(sc.props.amb);
  if (sc.props.fx) runFx(sc.props.fx === 'off' ? 'fxoff' : sc.props.fx);
  sc.whens.forEach(w => w.fired = false);
  saveGame();

  if (sc.props.label) divider(sc.props.label);
  const coda = sc.props.style === 'coda' ? ' coda' : '';
  sc.flow.forEach((line, i) => {
    printQueue.push(setTimeout(() => {
      sayLine(line, coda);
      if (i === sc.flow.length - 1) checkWhens();
    }, i * 380));
  });
  if (!sc.flow.length) checkWhens();
}

/* ---------------- 点击分发 ---------------- */

document.addEventListener('click', e => {
  const el = e.target.closest('.w[data-act]');
  if (!el || el.classList.contains('used')) return;
  const sc = CH.scenes[STATE.scene];
  if (!sc) return;
  const id = el.dataset.act;
  if (selected) {
    const block = sc.blocks[id + '@' + selected];
    if (block) { const item = selected; select(null); execBlock(block); }
    else {
      el.classList.remove('shake'); void el.offsetWidth;
      el.classList.add('shake');
      hint('（' + CH.items[selected].name + '对它没有反应。）', true);
    }
  } else if (sc.blocks[id]) {
    execBlock(sc.blocks[id]);
  } else if (Object.keys(sc.blocks).some(k => k.startsWith(id + '@'))) {
    hint('（直接点没有用，似乎需要装填什么。）', true);
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

/* 文字溃散：取最近的正文字符抛散整屏 */
function fxDissolve() {
  const text = [...document.querySelectorAll('#log p')].slice(-4)
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

function bootGame(chapterId) {
  const src = (window.MB_SCRIPTS || {})[chapterId];
  if (!src) { document.body.textContent = '剧本未找到：' + chapterId; return; }
  CH = parseScript(src);

  $('hud-name').textContent = CH.meta.protagonist || '';
  $('hud-badge').textContent = CH.meta.badge ? '警号 ' + CH.meta.badge : '';
  $('cv-title').textContent = CH.meta.title || '';

  const save = loadSave();
  if (save && CH.scenes[save.scene]) {
    const w = $('cv-continue');
    w.style.display = '';
    w.innerHTML = `<span class="w" id="go-continue">同步记忆</span>（槽位 ${CH.meta.badge} · 继续）`;
    $('go-continue').onclick = () => {
      FX.unlockAudio();
      STATE.flags = new Set(save.flags);
      STATE.items = save.items;
      STATE.clues = save.clues || [];
      STATE.archive = save.archive || [];
      renderItems();
      $('cover').classList.add('hide');
      enterScene(save.scene);
    };
  }
  $('go-start').onclick = () => {
    FX.unlockAudio();
    localStorage.removeItem(saveKey());
    $('cover').classList.add('hide');
    enterScene(CH.meta.start || CH.order[0]);
  };

  const syncMute = () => document.querySelectorAll('.mutebtn')
    .forEach(b => b.textContent = FX.isMuted() ? '🔇' : '🔊');
  document.querySelectorAll('.mutebtn')
    .forEach(b => b.onclick = () => { FX.toggle(); syncMute(); });
  syncMute();

  $('btn-archive').onclick = openArchive;
  $('arc-close').onclick = () => $('archive').style.display = 'none';
}
