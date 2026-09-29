// AtCoder用ローカルジャッジ バックエンド
// 依存パッケージなし。Node.js 18以上で動作。
//   起動: node backend/server.js  →  http://localhost:2434
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const HOST = '127.0.0.1'; // ループバックのみで待ち受け(外部公開しない)
const PORT = Number(process.env.PORT) || 3000;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

const LIMITS = {
  bodyBytes: 20 * 1024 * 1024, // リクエスト全体
  codeBytes: 512 * 1024,       // ソースコード(AtCoderと同じ512KiB)
  cases: 100,
  timeMsMin: 100,
  timeMsMax: 20000,
  stdoutBytes: 32 * 1024 * 1024,
  stderrBytes: 64 * 1024,
};

// AtCoderのNode.js実行に近いオプション
const NODE_ARGS = ['--max-old-space-size=1024'];

/* ---------- 判定 ---------- */

// 行末の空白と末尾の空行を無視して比較(AtCoderの判定に近い挙動)
function normalize(s) {
  const lines = s.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/* ---------- 1ケース実行 ---------- */

function runOne(file, cwd, input, timeLimitMs, ctl) {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const child = spawn(process.execPath, [...NODE_ARGS, file], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH }, // 親の環境変数は渡さない
    });
    // ブラウザ側が途中で切断したとき、実行中のプロセスを止められるようにする
    ctl.kill = () => child.kill('SIGKILL');

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let outputLimitExceeded = false;
    let killedByTimer = false;

    // TLEでもどれくらい遅いか分かるよう、制限の2倍(最大+5秒)まで待ってから強制終了
    const hardKillMs = Math.min(timeLimitMs * 2, timeLimitMs + 5000);
    const timer = setTimeout(() => {
      killedByTimer = true;
      child.kill('SIGKILL');
    }, hardKillMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > LIMITS.stdoutBytes) {
        outputLimitExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < LIMITS.stderrBytes) stderr += chunk.toString('utf8');
    });

    // 入力を読まずに終了するコードだとEPIPEになるので握りつぶす
    child.stdin.on('error', () => {});
    child.stdin.end(input);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ error: `プロセスを起動できませんでした: ${err.message}` });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const timeMs = Number(process.hrtime.bigint() - start) / 1e6;
      resolve({
        stdout,
        stderr: stderr.slice(0, LIMITS.stderrBytes),
        exitCode: code,
        signal,
        timeMs: Math.round(timeMs),
        killedByTimer,
        outputLimitExceeded,
      });
    });
  });
}

/* ---------- 全ケース実行 ---------- */

function decide(r, tc, timeLimitMs) {
  if (r.error) return 'IE';
  if (r.outputLimitExceeded) return 'OLE';
  if (r.killedByTimer || r.timeMs > timeLimitMs) return 'TLE';
  if (r.exitCode !== 0 || r.signal) return 'RE';
  if (tc.expected.trim() === '') return 'DONE'; // 期待出力なし=実行のみ
  return normalize(r.stdout) === normalize(tc.expected) ? 'AC' : 'WA';
}

function summarize(results) {
  const judged = results.filter((r) => r.status !== 'DONE');
  const priority = ['IE', 'RE', 'OLE', 'TLE', 'WA'];
  const overall =
    judged.length === 0
      ? 'DONE'
      : priority.find((p) => judged.some((r) => r.status === p)) ?? 'AC';
  return {
    overall,
    maxTimeMs: Math.max(0, ...results.map((r) => r.timeMs ?? 0)),
    nodeVersion: process.version,
  };
}

// 1ケース終わるごとに onCase(index, result, summary) を呼ぶ。
// summary は最後のケースのときだけ付く(それ以外は undefined)。
async function judge({ code, testCases, timeLimitMs }, onCase, ctl) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atcoder-judge-'));
  const file = path.join(dir, 'Main.js');
  await fsp.writeFile(file, code, 'utf8');

  const results = [];
  try {
    // 実行時間を正確に測るため、並列ではなく1ケースずつ順番に実行
    for (let i = 0; i < testCases.length; i++) {
      if (ctl.aborted) return;
      const tc = testCases[i];
      const r = await runOne(file, dir, tc.input, timeLimitMs, ctl);
      if (ctl.aborted) return;

      const result = {
        status: decide(r, tc, timeLimitMs),
        timeMs: r.timeMs ?? null,
        stdout: r.stdout ?? '',
        stderr: r.error ?? r.stderr ?? '',
        exitCode: r.exitCode ?? null,
      };
      results.push(result);

      const isLast = i === testCases.length - 1;
      onCase(i, result, isLast ? summarize(results) : undefined);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/* ---------- 入力検証 ---------- */

function validate(body) {
  if (typeof body !== 'object' || body === null) return 'JSONの形式が不正です';
  const { code, testCases, timeLimitMs } = body;
  if (typeof code !== 'string' || code.trim() === '') return 'コードが空です';
  if (Buffer.byteLength(code) > LIMITS.codeBytes) return 'コードが512KiBを超えています';
  if (!Array.isArray(testCases) || testCases.length === 0) return 'テストケースが1つもありません';
  if (testCases.length > LIMITS.cases) return `テストケースは${LIMITS.cases}個までです`;
  for (const tc of testCases) {
    if (typeof tc?.input !== 'string' || typeof tc?.expected !== 'string') {
      return 'テストケースの形式が不正です';
    }
  }
  if (!Number.isFinite(timeLimitMs) || timeLimitMs < LIMITS.timeMsMin || timeLimitMs > LIMITS.timeMsMax) {
    return `実行時間制限は${LIMITS.timeMsMin}〜${LIMITS.timeMsMax}msで指定してください`;
  }
  return null;
}

/* ---------- HTTP ---------- */

// DNSリバインディング対策: Hostヘッダがlocalhost系以外なら拒否
function isLocalHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

// 他サイトのページからコード実行APIを叩かれないようOriginを確認
function isAllowedOrigin(origin) {
  if (!origin) return true; // curl等
  try {
    const u = new URL(origin);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.join(FRONTEND_DIR, rel);
  // ディレクトリトラバーサル防止
  if (!filePath.startsWith(FRONTEND_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  });
}

let busy = false; // 同時実行はしない(計測がぶれるため)

const server = http.createServer((req, res) => {
  if (!isLocalHost(req.headers.host)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  if (req.method === 'POST' && req.url === '/api/run') {
    if (!isAllowedOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: '許可されていないOriginです' });
      return;
    }
    if (busy) {
      sendJson(res, 409, { error: '別の実行が進行中です。終わってから再実行してください' });
      return;
    }

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMITS.bodyBytes) {
        sendJson(res, 413, { error: 'リクエストが大きすぎます' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (res.writableEnded) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        sendJson(res, 400, { error: 'JSONを解析できませんでした' });
        return;
      }
      const problem = validate(body);
      if (problem) {
        sendJson(res, 400, { error: problem });
        return;
      }
      // ここから先は NDJSON(1行に1つのJSON)で、ケースが終わるたびに1行ずつ送る
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.flushHeaders();
      const sendLine = (obj) => {
        if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
      };

      // ブラウザを閉じた・再読み込みしたなどで接続が切れたら、残りのケースは実行しない
      const ctl = { aborted: false, kill: null };
      res.on('close', () => {
        if (!res.writableFinished) {
          ctl.aborted = true;
          ctl.kill?.();
        }
      });

      busy = true;
      try {
        await judge(
          body,
          (index, result, summary) => {
            const line = { type: 'case', index, result };
            if (summary) line.summary = summary; // 最後のケースに総合判定を付ける
            sendLine(line);
          },
          ctl,
        );
      } catch (e) {
        sendLine({ type: 'error', error: `内部エラー: ${e.message}` });
      } finally {
        busy = false;
        res.end();
      }
    });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405).end();
});

server.listen(PORT, HOST, () => {
  console.log(`ローカルジャッジ起動: http://localhost:${PORT}  (Node ${process.version})`);
});
