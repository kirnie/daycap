"""Chrome Web Store screenshots (1280x800) of the real UI with sample data.

    python3 store/screenshots.py

Starts its own headless Brave/Chromium with a throwaway profile (port 9334),
seeds two weeks of made-up history, and writes store/screenshot-*.png.
Needs Python 3 with `websockets` and Pillow. Your browser profile is untouched.
"""
import asyncio, base64, io, json, os, random, shutil, signal, subprocess, tempfile, time, urllib.parse, urllib.request
from datetime import date, datetime, timedelta
import websockets
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PORT = 9334
W, H = 1280, 800
BROWSER = os.environ.get('BROWSER_BIN') or shutil.which('brave-browser') or shutil.which('chromium-browser') or shutil.which('chromium')
FONT = '/usr/share/fonts/abattis-cantarell-fonts/Cantarell-ExtraBold.otf'
FONT_REG = '/usr/share/fonts/abattis-cantarell-fonts/Cantarell-Regular.otf'

# Minutes per day, roughly; each day gets some noise.
SITES = {'youtube.com': 52, 'github.com': 64, 'reddit.com': 31, 'mail.google.com': 26,
         'wikipedia.org': 14, 'news.ycombinator.com': 12, 'x.com': 9, 'stackoverflow.com': 11}
LIMITS = {'reddit.com': 30, 'youtube.com': 60, 'x.com': 15}

def seed():
    rnd = random.Random(7)
    now = datetime.now()
    out = {'schema': 2, 'limits': LIMITS, 'settings': {'warnAtPercent': 80}}
    for back in range(14, -1, -1):
        d = date.today() - timedelta(days=back)
        key = d.isoformat()
        weekend = d.weekday() >= 5
        scale = 1.0 if back else min(1.0, max(0.3, (now.hour + now.minute / 60 - 8) / 13))
        totals = {}
        for site, mins in SITES.items():
            m = mins * rnd.uniform(0.55, 1.35) * scale
            if weekend and site in ('github.com', 'mail.google.com', 'stackoverflow.com'): m *= 0.25
            if weekend and site in ('youtube.com', 'reddit.com'): m *= 1.4
            totals[site] = int(m * 60)
        blocked = {}
        if back == 0:
            totals['reddit.com'] = LIMITS['reddit.com'] * 60
            blocked['reddit.com'] = int(time.time() * 1000) - 25 * 60 * 1000
        last_hour = now.hour if back == 0 else 23
        hours_w = {h: (0.4 if h in (12, 13) else 1.0) * (1.3 if h in (20, 21) else 1.0)
                   for h in range(8, last_hour + 1)}
        total = sum(totals.values()); hw = sum(hours_w.values())
        hours = {str(h): int(total * v / hw * rnd.uniform(0.7, 1.3)) for h, v in hours_w.items()}
        out[f'day:{key}'] = {'date': key, 'totals': totals, 'hours': hours, 'blocked': blocked, 'warned': {}}
    return out

def targets():
    return json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/list'))

class Conn:
    def __init__(self, ws): self.ws, self.n = ws, 0
    async def call(self, method, params=None):
        self.n += 1; i = self.n
        await self.ws.send(json.dumps({'id': i, 'method': method, 'params': params or {}}))
        while True:
            m = json.loads(await self.ws.recv())
            if m.get('id') == i:
                if 'error' in m: raise RuntimeError(m['error'])
                return m['result']
    async def ev(self, expr):
        r = await self.call('Runtime.evaluate', {'expression': expr, 'awaitPromise': True, 'returnByValue': True})
        if 'exceptionDetails' in r: raise RuntimeError(r['exceptionDetails'])
        return r['result'].get('value')

async def connect(t): return Conn(await websockets.connect(t['webSocketDebuggerUrl'], max_size=None))

async def open_page(b, url, width, height, scale=1):
    tid = (await b.call('Target.createTarget', {'url': 'about:blank'}))['targetId']
    await b.call('Target.activateTarget', {'targetId': tid})
    p = await connect(next(t for t in targets() if t['id'] == tid))
    await p.call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': height, 'deviceScaleFactor': scale, 'mobile': False})
    await p.call('Emulation.setScrollbarsHidden', {'hidden': True})
    await p.call('Emulation.setEmulatedMedia', {'features': [{'name': 'prefers-color-scheme', 'value': 'dark'}]})
    await p.call('Page.enable')
    await p.call('Page.navigate', {'url': url})
    await asyncio.sleep(1.5)
    return p

async def shot(p, clip=None):
    params = {'format': 'png'}
    if clip: params['clip'] = {**clip, 'scale': 1}
    data = (await p.call('Page.captureScreenshot', params))['data']
    return Image.open(io.BytesIO(base64.b64decode(data))).convert('RGB')

def framed(ui, title, sub):
    """Popup on a 1280x800 canvas with a caption beside it."""
    bg = Image.new('RGB', (W, H), (23, 22, 28))
    d = ImageDraw.Draw(bg)
    scale = min(1.0, (H - 96) / ui.height)
    ui = ui.resize((int(ui.width * scale), int(ui.height * scale)), Image.LANCZOS)
    x = W - 140 - ui.width; y = (H - ui.height) // 2
    d.rounded_rectangle([x - 1, y - 1, x + ui.width, y + ui.height], 14, outline=(56, 53, 63), width=2)
    mask = Image.new('L', ui.size, 0); ImageDraw.Draw(mask).rounded_rectangle([0, 0, ui.width - 1, ui.height - 1], 13, fill=255)
    bg.paste(ui, (x, y), mask)
    tf, sf = ImageFont.truetype(FONT, 50), ImageFont.truetype(FONT_REG, 25)
    tx = 120
    lines = title.split('\n')
    ty = H // 2 - 40 * len(lines) - 10
    for i, line in enumerate(lines):
        d.text((tx, ty + i * 62), line, font=tf, fill=(242, 241, 245))
    sy = ty + len(lines) * 62 + 22
    for i, line in enumerate(sub.split('\n')):
        d.text((tx, sy + i * 36), line, font=sf, fill=(166, 162, 178))
    return bg

async def main(work):
    for _ in range(50):
        try:
            sw = [t for t in targets() if t['type'] == 'service_worker' and t['url'].endswith('/src/background.js')]
            if sw: break
        except Exception: pass
        await asyncio.sleep(0.3)
    base = 'chrome-extension://' + urllib.parse.urlparse(sw[0]['url']).netloc
    w = await connect(sw[0])
    ver = json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/version'))
    b = Conn(await websockets.connect(ver['webSocketDebuggerUrl'], max_size=None))
    await asyncio.sleep(1.5)

    data = seed()
    today = date.today().isoformat()
    await w.ev(f'chrome.storage.local.set({json.dumps(data)})')
    await asyncio.sleep(0.5)
    assert await w.ev(f"chrome.storage.local.get('day:{today}').then((x) => x['day:{today}'].totals['reddit.com'])") == 1800

    out = {}
    dash = await open_page(b, f'{base}/src/dashboard/dashboard.html', W, H)
    out['2-dashboard-today'] = await shot(dash)
    for view, name in (('history', '3-dashboard-history'), ('limits', '4-dashboard-limits')):
        await dash.ev(f"document.querySelector('[data-view=\"{view}\"]').click()")
        await asyncio.sleep(0.8)
        out[name] = await shot(dash)

    blocked = await open_page(b, f'{base}/src/blocked/blocked.html?d=reddit.com&k={today}&u=' +
                              urllib.parse.quote('https://www.reddit.com/', safe=''), W, H)
    out['5-block-page'] = await shot(blocked)

    pop = await open_page(b, f'{base}/src/popup/popup.html', 380, 1200, scale=2)
    hgt = await pop.ev('Math.ceil(document.documentElement.getBoundingClientRect().height)')
    ui = await shot(pop, {'x': 0, 'y': 0, 'width': 380, 'height': hgt})
    out['1-popup'] = framed(ui, 'Where did\nthe day go?', 'Active time per site, counted only\nfor the tab you are looking at.')

    for name, im in sorted(out.items()):
        im = im.resize((W, H), Image.LANCZOS) if im.size != (W, H) else im
        path = os.path.join(HERE, f'screenshot-{name}.png')
        im.save(path); print(os.path.relpath(path, ROOT), im.size)

if __name__ == '__main__':
    work = tempfile.mkdtemp(prefix='tabtime-shots-')
    brave = subprocess.Popen([BROWSER, '--headless=new', f'--user-data-dir={work}',
                              f'--load-extension={ROOT}', f'--disable-extensions-except={ROOT}',
                              f'--remote-debugging-port={PORT}', '--no-first-run', '--no-default-browser-check',
                              '--hide-scrollbars', 'about:blank'],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        asyncio.run(main(work))
    finally:
        os.killpg(brave.pid, signal.SIGKILL)
        shutil.rmtree(work, ignore_errors=True)
