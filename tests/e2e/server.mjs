// Tiny media server for E2E tests: Range support, a Referer-protected path, a throttled path
// and synthetic "player" pages.
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const MEDIA = new URL('../fixtures/media/', import.meta.url).pathname;
const TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mpdx': 'application/dash+xml',
  '.bin': 'application/octet-stream',
};

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<meta property="og:title" content="${title}"><style>body{margin:0;background:#111;color:#eee;font:16px system-ui;display:grid;place-items:center;min-height:100vh}video{width:720px;max-width:90vw;border-radius:12px;background:#000}</style></head>
<body>${body}</body></html>`;

const PAGES = {
  direct: () => page('Aurora Over The Fjords', `<video src="/media/direct.mp4" controls muted autoplay loop playsinline></video>`),
  webm: () => page('Neon City Walk', `<video src="/media/direct.webm" controls muted autoplay loop></video>`),
  hls: () => page('Mountain Timelapse (HLS)', `<video controls muted poster="/poster.svg"></video><script>fetch('/protected/hls-ts/master.m3u8').then(r=>r.text())</script>`),
  aes: () => page('Encrypted Stream Test', `<video controls muted></video><script>fetch('/media/hls-aes/index.m3u8')</script>`),
  fmp4: () => page('Ocean Waves 720p', `<video controls muted></video><script>fetch('/api/stream.json').then(r=>r.json())</script>`),
  dash: () => page('City Lights (DASH)', `<video controls muted></video><script>fetch('/media/dash/manifest.mpd')</script>`),
  slow: () => page('Slow Server Test', `<video src="/slow/direct.mp4" preload="metadata" controls muted></video>`),
  mse: () =>
    page(
      'Obfuscated Player (MSE)',
      `<video id="v" muted autoplay controls></video><script>
const v = document.getElementById('v');
const ms = new MediaSource();
v.src = URL.createObjectURL(ms);
ms.addEventListener('sourceopen', async () => {
  const sb = ms.addSourceBuffer('video/webm; codecs="vp9"');
  const get = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
  const append = (b) => new Promise((r) => { sb.addEventListener('updateend', r, { once: true }); sb.appendBuffer(b); });
  await append(await get('/media/mse-webm/init.webm'));
  for (let i = 1; i <= 10; i++) {
    await new Promise((r) => setTimeout(r, 350));
    await append(await get('/media/mse-webm/seg-' + String(i).padStart(3, '0') + '.webm'));
  }
  ms.endOfStream();
  window.__done = true;
});
</script>`,
    ),
  slower: () => page('Aurora Over The Fjords', `<video src="/slower/direct.mp4" preload="metadata" controls muted poster="/poster.svg"></video>`),
};

export function startServer(port = 0) {
  let base = '';
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (path.startsWith('/page/')) {
      const name = path.slice(6).replace(/\.html$/, '');
      if (!PAGES[name]) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(PAGES[name]());
    }
    if (path === '/poster.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#1b2a6b"/><stop offset="1" stop-color="#6b1b52"/></linearGradient></defs><rect width="640" height="360" fill="url(#g)"/><path d="M0 300 L160 170 L260 250 L380 120 L640 300 L640 360 L0 360Z" fill="#0c0f24"/></svg>`);
    }
    if (path === '/api/stream.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ video: { title: 'Ocean', sources: { hls: `${base}/protected/hls-fmp4/master.m3u8` } } }).replace(/\//g, '\\/'));
    }
    let prefix = ['/media/', '/protected/', '/slow/', '/slower/'].find((p) => path.startsWith(p));
    if (!prefix) return res.writeHead(404).end();
    if (prefix === '/protected/') {
      const ref = req.headers.referer || '';
      if (!ref.startsWith(`${base}/page/`)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('missing referer');
      }
    }
    const file = normalize(join(MEDIA, decodeURIComponent(path.slice(prefix.length))));
    if (!file.startsWith(MEDIA) || !existsSync(file)) return res.writeHead(404).end();
    const size = statSync(file).size;
    const type = TYPES[extname(file)] || 'application/octet-stream';
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
    let start = 0;
    let end = size - 1;
    let status = 200;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      start = m[1] ? +m[1] : size - +m[2];
      end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['content-length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = createReadStream(file, { start, end, highWaterMark: 64 * 1024 });
    if (prefix === '/slow/' || prefix === '/slower/') {
      // Throttle per connection → parallel lanes make a visible difference.
      const delay = prefix === '/slow/' ? 80 : 420;
      stream.on('data', (chunk) => {
        stream.pause();
        res.write(chunk);
        setTimeout(() => stream.resume(), delay);
      });
      stream.on('end', () => res.end());
      req.on('close', () => stream.destroy());
    } else stream.pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, base });
    }),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { base } = await startServer(+(process.argv[2] || 8765));
  console.log('Grabbit test server on', base);
}
