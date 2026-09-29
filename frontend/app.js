'use strict';

const $ = (id) => document.getElementById(id);
const casesEl = $('cases');
const timeLimitEl = $('timeLimit');
const runBtn = $('runBtn');
const errorBox = $('errorBox');
const verdictEl = $('verdict');
const caseTemplate = $('caseTemplate');
const layoutEl = $('layout');
const splitter = $('splitter');
const editorHost = $('editor');

const STORAGE_KEY = 'local-judge-v1';
const THEME_KEY = 'local-judge-theme';
const themeBtn = $('themeBtn');
const MONACO_BASE = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min';

const TEMPLATE = `class Scanner {
  t = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/);
  i = 0;
  next() { return this.t[this.i++]; }
  nextInt() { return +this.next(); }
  nextBigInt() { return BigInt(this.next()); }
}

function main(){
  const sc = new Scanner();
  //処理はここから
}

main();
`;

const LABELS = {
  AC: '正解',
  WA: '不正解',
  TLE: '時間超過',
  RE: '実行時エラー',
  OLE: '出力サイズ超過',
  IE: '内部エラー',
  DONE: '実行のみ',
  WJ: 'ジャッジ待ち',
};

/* ---------- コードエディタ ---------- */
// Monacoの読み込み前(や読み込み失敗時)はただのテキストエリアで動かす
const editor = {
  monaco: null,
  textarea: null,
  getValue() {
    return this.monaco ? this.monaco.getValue() : this.textarea.value;
  },
  setValue(text) {
    if (this.monaco) {
      // 元に戻す(Ctrl+Z)が効くように編集操作として置き換える
      const model = this.monaco.getModel();
      this.monaco.executeEdits('template', [{ range: model.getFullModelRange(), text }]);
      this.monaco.pushUndoStop();
    } else {
      this.textarea.value = text;
    }
  },
};

function createFallbackEditor(initial) {
  const ta = document.createElement('textarea');
  ta.className = 'fallback';
  ta.spellcheck = false;
  ta.value = initial;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: t, value } = ta;
      ta.value = value.slice(0, s) + '  ' + value.slice(t);
      ta.selectionStart = ta.selectionEnd = s + 2;
    }
  });
  editorHost.appendChild(ta);
  editor.textarea = ta;
}

function loadMonaco() {
  if (typeof require === 'undefined' || !require.config) return; // CDNに届かなかった

  // Web Workerを別オリジン(CDN)から動かすための設定
  window.MonacoEnvironment = {
    getWorkerUrl() {
      const src = `self.MonacoEnvironment={baseUrl:'${MONACO_BASE}/'};importScripts('${MONACO_BASE}/vs/base/worker/workerMain.js');`;
      return `data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`;
    },
  };
  require.config({ paths: { vs: `${MONACO_BASE}/vs` } });
  require(['vs/editor/editor.main'], () => {
    const initial = editor.textarea.value;
    editor.textarea.remove();
    editor.textarea = null;

    defineMonacoThemes();
    const m = monaco.editor.create(editorHost, {
      value: initial,
      language: 'javascript',
      theme: currentTheme() === 'dark' ? 'judge-dark' : 'judge-light',
      fontFamily: '"JetBrains Mono", Consolas, Menlo, monospace',
      fontSize: 14,
      tabSize: 2,
      insertSpaces: true,
      detectIndentation: false,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true, // 分割バーで幅が変わっても追従
      bracketPairColorization: { enabled: true },
      renderWhitespace: 'selection',
      padding: { top: 10 },
    });
    m.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      if (!runBtn.disabled) run();
    });
    m.onDidChangeModelContent(scheduleSave);
    editor.monaco = m;
  });
}

/* ---------- ダークモード ---------- */

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === 'dark' ? 'ライトモードにする' : 'ダークモードにする';
  themeBtn.setAttribute('aria-pressed', theme === 'dark');
  if (window.monaco) monaco.editor.setTheme(theme === 'dark' ? 'judge-dark' : 'judge-light');
}

themeBtn.addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch { /* 無視 */ }
  applyTheme(next);
});

// 自分で切り替えたことがなければ、OSの設定変更に追従する
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* 無視 */ }
  if (!saved) applyTheme(e.matches ? 'dark' : 'light');
});

// ページの色に合わせたMonacoのテーマ
function defineMonacoThemes() {
  monaco.editor.defineTheme('judge-light', {
    base: 'vs',
    inherit: true,
    rules: [],
    colors: { 'editor.background': '#ffffff' },
  });
  monaco.editor.defineTheme('judge-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#1b2129',
      'editor.lineHighlightBackground': '#222a34',
      'editorLineNumber.foreground': '#56606e',
      'editorLineNumber.activeForeground': '#b8c2cf',
      'editorGutter.background': '#1b2129',
    },
  });
}

/* ---------- 左右の分割バー ---------- */

const SPLIT_MIN = 220; // テストケース欄の最小幅(px)
const EDITOR_MIN = 320; // コード欄の最小幅(px)

function contentBox() {
  const rect = layoutEl.getBoundingClientRect();
  const cs = getComputedStyle(layoutEl);
  const left = rect.left + parseFloat(cs.paddingLeft);
  const width = rect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  return { left, width };
}

let splitRatio = 0.38; // テストケース欄の幅の割合(左右どちらにあっても同じ意味)
let swapped = false;   // true: コードが左、テストケースが右

function applySwap(value) {
  swapped = value;
  layoutEl.classList.toggle('swapped', swapped);
  $('swapBtn').setAttribute('aria-pressed', swapped);
}

$('swapBtn').addEventListener('click', () => {
  applySwap(!swapped);
  save();
});

function applySplit(ratio) {
  const { width } = contentBox();
  const max = Math.max(SPLIT_MIN, width - 12 - EDITOR_MIN);
  const px = Math.min(Math.max(ratio * width, SPLIT_MIN), max);
  splitRatio = width > 0 ? px / width : ratio;
  layoutEl.style.setProperty('--left-width', `${px}px`);
  splitter.setAttribute('aria-valuenow', Math.round(splitRatio * 100));
}

splitter.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  splitter.setPointerCapture(e.pointerId);
  splitter.classList.add('dragging');
  document.body.classList.add('resizing');
});
splitter.addEventListener('pointermove', (e) => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  const { left, width } = contentBox();
  // テストケース欄が右にあるときは、右端からの距離が幅になる
  const casesWidth = swapped ? left + width - e.clientX - 6 : e.clientX - left - 6;
  applySplit(casesWidth / width);
});
const endDrag = (e) => {
  if (!splitter.hasPointerCapture(e.pointerId)) return;
  splitter.releasePointerCapture(e.pointerId);
  splitter.classList.remove('dragging');
  document.body.classList.remove('resizing');
  save();
};
splitter.addEventListener('pointerup', endDrag);
splitter.addEventListener('pointercancel', endDrag);
splitter.addEventListener('dblclick', () => { applySplit(0.38); save(); });
splitter.addEventListener('keydown', (e) => {
  // 矢印キーの向きとバーが動く向きを一致させる
  const step = (e.shiftKey ? 0.1 : 0.02) * (swapped ? -1 : 1);
  if (e.key === 'ArrowLeft') applySplit(splitRatio - step);
  else if (e.key === 'ArrowRight') applySplit(splitRatio + step);
  else return;
  e.preventDefault();
  save();
});
window.addEventListener('resize', () => applySplit(splitRatio));

/* ---------- テストケースの追加・削除 ---------- */

function addCase(input = '', expected = '') {
  const li = caseTemplate.content.firstElementChild.cloneNode(true);
  li.querySelector('.in').value = input;
  li.querySelector('.expected').value = expected;
  li.querySelector('.remove').addEventListener('click', () => {
    if (casesEl.children.length === 1) return; // 最低1つは残す
    li.remove();
    renumber();
    save();
  });
  casesEl.appendChild(li);
  renumber();
  return li;
}

function renumber() {
  [...casesEl.children].forEach((li, i) => {
    li.querySelector('.case-title').textContent = `ケース ${i + 1}`;
  });
}

function clearResults() {
  verdictEl.hidden = true;
  for (const li of casesEl.children) {
    delete li.dataset.status;
    li.querySelector('.badge').hidden = true;
    li.querySelector('.case-time').textContent = '';
    li.querySelector('.output').hidden = true;
  }
}

/* ---------- 保存・復元(このブラウザ内のみ) ---------- */

function save() {
  const data = {
    code: editor.getValue(),
    timeLimit: timeLimitEl.value,
    split: splitRatio,
    swapped,
    cases: [...casesEl.children].map((li) => ({
      input: li.querySelector('.in').value,
      expected: li.querySelector('.expected').value,
    })),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

function load() {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    data = null;
  }
  createFallbackEditor(data?.code ?? TEMPLATE);
  timeLimitEl.value = data?.timeLimit ?? '2';
  applySwap(data?.swapped === true);
  applySplit(typeof data?.split === 'number' ? data.split : 0.38);
  const cases = data?.cases?.length ? data.cases : [{ input: '', expected: '' }];
  cases.forEach((c) => addCase(c.input, c.expected));
}

/* ---------- 実行 ---------- */

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

async function run() {
  errorBox.hidden = true;
  clearResults();

  const seconds = Number(timeLimitEl.value);
  if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 20) {
    showError('実行時間制限は0.1〜20秒で入力してください。');
    return;
  }

  const items = [...casesEl.children];
  const timeLimitMs = Math.round(seconds * 1000);
  const payload = {
    code: editor.getValue(),
    timeLimitMs,
    testCases: items.map((li) => ({
      input: li.querySelector('.in').value,
      expected: li.querySelector('.expected').value,
    })),
  };

  runBtn.disabled = true;
  runBtn.textContent = '実行中…';
  save();

  // 結果が届くまで全ケースを WJ(ジャッジ待ち)にしておく
  const results = [];
  items.forEach((li) => setBadge(li, 'WJ'));
  showProgress(0, items.length);

  let finished = false;
  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      // 検証エラーなどは今まで通り普通のJSONで返ってくる
      const data = await res.json().catch(() => ({}));
      clearResults();
      showError(data.error ?? `サーバがエラーを返しました(${res.status})`);
      return;
    }

    // 1行 = 1つのJSON。届いた分から順に画面へ反映する
    for await (const msg of readLines(res.body)) {
      if (msg.type === 'error') {
        showError(msg.error);
        continue;
      }
      if (msg.type !== 'case') continue;

      results[msg.index] = msg.result;
      const li = items[msg.index];
      if (li) renderCase(li, msg.result, timeLimitMs);

      if (msg.summary) {
        renderSummary(msg.summary, results);
        finished = true;
      } else {
        showProgress(msg.index + 1, items.length);
      }
    }
    if (!finished) {
      showError('すべてのケースの結果を受け取る前に接続が切れました。');
    }
  } catch {
    showError('サーバに接続できません。start.bat でサーバを起動しているか確認してください。');
  } finally {
    // 結果が来なかったケースの WJ 表示は消す
    items.forEach((li) => {
      if (li.dataset.status === 'WJ') {
        delete li.dataset.status;
        li.querySelector('.badge').hidden = true;
      }
    });
    if (!finished) verdictEl.hidden = true;
    runBtn.disabled = false;
    runBtn.textContent = '実行する';
  }
}

// レスポンスを改行ごとに区切って、JSONとして1つずつ取り出す
async function* readLines(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

function setBadge(li, status) {
  li.dataset.status = status;
  const badge = li.querySelector('.badge');
  badge.textContent = status;
  badge.title = LABELS[status] ?? '';
  badge.hidden = false;
}

// 実行中の総合判定欄: WJ と「何ケース終わったか」
function showProgress(done, total) {
  verdictEl.dataset.status = 'WJ';
  $('verdictStatus').textContent = 'WJ';
  $('verdictStatus').title = LABELS.WJ;
  $('verdictCount').textContent = `${done} / ${total} ケース完了`;
  $('verdictTime').textContent = '';
  verdictEl.hidden = false;
}

function renderCase(li, r, timeLimitMs) {
  setBadge(li, r.status);

  const over = r.status === 'TLE' ? ` / 制限 ${timeLimitMs} ms` : '';
  li.querySelector('.case-time').textContent = r.timeMs != null ? `${r.timeMs} ms${over}` : '';

  li.querySelector('.output').hidden = false;
  li.querySelector('.stdout').textContent = r.stdout === '' ? '(出力なし)' : r.stdout;
  // 標準エラー出力は何か書き込まれたときだけ表示
  li.querySelector('.out-block.err').hidden = r.stderr === '';
  li.querySelector('.stderr').textContent = r.stderr;
}

function renderSummary(summary, results) {
  $('env').textContent = `Node.js ${summary.nodeVersion}`;

  const judged = results.filter((r) => r && r.status !== 'DONE');
  const acCount = judged.filter((r) => r.status === 'AC').length;

  verdictEl.dataset.status = summary.overall;
  $('verdictStatus').textContent = summary.overall;
  $('verdictStatus').title = LABELS[summary.overall] ?? '';
  $('verdictCount').textContent =
    judged.length > 0
      ? `${acCount} / ${judged.length} ケース正解(${LABELS[summary.overall]})`
      : `${results.length} ケース実行(判定なし)`;
  $('verdictTime').textContent = `最大 ${summary.maxTimeMs} ms`;
  verdictEl.hidden = false;
}

/* ---------- その他の操作 ---------- */

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !runBtn.disabled) {
    e.preventDefault();
    run();
  }
});

document.addEventListener('input', scheduleSave);

runBtn.addEventListener('click', run);
$('addCaseBtn').addEventListener('click', () => {
  // フォーカスを移すと追加したケースまでスクロールしてしまうので、何もしない
  addCase();
  save();
});
$('clearCasesBtn').addEventListener('click', () => {
  if (!confirm('テストケースをすべて消して、空のケース1つだけにしますか?')) return;
  errorBox.hidden = true;
  verdictEl.hidden = true;
  casesEl.replaceChildren();
  addCase();
  save();
});
$('templateBtn').addEventListener('click', () => {
  if (editor.getValue().trim() && !confirm('今のコードをひな形で置き換えますか?')) return;
  editor.setValue(TEMPLATE);
  save();
});

applyTheme(currentTheme());
load();
loadMonaco();
