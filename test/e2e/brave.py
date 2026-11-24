# End-to-end test in a real, headless Brave (or Chromium), driven over the
# DevTools protocol. Needs Python 3 with the `websockets` package.
#
#   python3 test/e2e/brave.py            # functional checks against this tree
#   python3 test/e2e/brave.py perf DIR   # worker + block page CPU and heap for DIR
#   python3 test/e2e/brave.py cost DIR   # storage reads/writes of the worker in DIR
#                                        # (an extension tree, e.g. a `git archive` of
#                                        # an older commit) over a fresh start + 3 ticks
#
# It starts its own browser with a throwaway profile on port 9333, maps
# site.test to a local http server, and kills the whole browser process group
# on exit. Your normal browser profile is never touched.
import asyncio, json, os, shutil, signal, subprocess, sys, tempfile, time, urllib.parse, urllib.request
import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
MODE = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in ('cost', 'perf') else 'full'
EXT = os.path.abspath(sys.argv[2]) if MODE != 'full' and len(sys.argv) > 2 else ROOT
PORT = 9333
BROWSER = os.environ.get('BROWSER_BIN') or shutil.which('brave-browser') or shutil.which('chromium-browser') or shutil.which('chromium')

COUNTER = """// injected by test/e2e/brave.py: counts the worker's storage calls from first load
globalThis.__r = { reads: 0, writes: 0, ticks: 0 };
for (const name of ['local', 'session']) {
  const area = chrome.storage[name];
  const get = area.get.bind(area); const set = area.set.bind(area);
  area.get = (...x) => { globalThis.__r.reads += 1; return get(...x); };
  area.set = (...x) => { globalThis.__r.writes += 1; return set(...x); };
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') globalThis.__r.ticks += 1; });
"""

work = tempfile.mkdtemp(prefix='tabtime-e2e-')
if MODE == 'cost':
    copy = os.path.join(work, 'ext')
    os.makedirs(copy)
    shutil.copy(os.path.join(EXT, 'manifest.json'), copy)
    for part in ('icons', 'src'):
        shutil.copytree(os.path.join(EXT, part), os.path.join(copy, part))
    with open(os.path.join(copy, 'src', '__count.js'), 'w') as f: f.write(COUNTER)
    bg = os.path.join(copy, 'src', 'background.js')
    with open(bg) as f: body = f.read()
    with open(bg, 'w') as f: f.write("import './__count.js';\n" + body)
    EXT = copy

http = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '-d', os.path.join(HERE, 'www')],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
profile = os.path.join(work, 'profile')
brave = subprocess.Popen([BROWSER, '--headless=new', f'--user-data-dir={profile}',
                          f'--load-extension={EXT}', f'--disable-extensions-except={EXT}',
                          f'--remote-debugging-port={PORT}', '--no-first-run', '--no-default-browser-check',
                          '--host-resolver-rules=MAP site.test 127.0.0.1', 'about:blank'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)

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

results = []
def check(label, ok, extra=''):
    results.append(ok); print(('ok   ' if ok else 'FAIL ') + label + (f'  [{extra}]' if extra else ''), flush=True)

async def main():
    for _ in range(50):
        try:
            sw = [t for t in targets() if t['type'] == 'service_worker' and t['url'].endswith('/src/background.js')]
            if sw: break
        except Exception: pass
        await asyncio.sleep(0.3)
    ext_id = urllib.parse.urlparse(sw[0]['url']).netloc
    base = f'chrome-extension://{ext_id}'
    w = await connect(sw[0])
    ver = json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json/version'))
    b = Conn(await websockets.connect(ver['webSocketDebuggerUrl'], max_size=None))
    await asyncio.sleep(1.5)   # let init() finish

    if MODE == 'perf':
        # Worker: sampled CPU (profiler, non-idle samples) and heap over three
        # idle ticks. Blocked tab: page CPU (TaskDuration) and worker CPU over
        # 60s visible, then 60s hidden.
        await w.call('Profiler.enable')
        await w.call('Profiler.setSamplingInterval', {'interval': 100})
        async def worker_cpu(seconds):
            await w.call('Profiler.start'); await asyncio.sleep(seconds)
            prof = (await w.call('Profiler.stop'))['profile']
            idle = {n['id'] for n in prof['nodes'] if n['callFrame']['functionName'] in ('(idle)', '(program)')}
            return sum(d for sid, d in zip(prof['samples'], prof['timeDeltas']) if sid not in idle) / 1000
        async def page_cpu(c):
            m = {x['name']: x['value'] for x in (await c.call('Performance.getMetrics'))['metrics']}
            return 1000 * m.get('TaskDuration', 0)
        idle_ms = await worker_cpu(92)
        heap = await w.call('Runtime.getHeapUsage')
        print(f"worker, 3 idle ticks     : {idle_ms:.1f} ms CPU, heap {heap['usedSize'] / 1024:.0f} KB")
        today = await w.ev("(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()")
        await w.ev(f"chrome.storage.local.set({{ limits: {{ 'site.test': 5 }}, 'day:{today}': {{ date: '{today}', totals: {{ 'site.test': 400 }}, hours: {{}}, blocked: {{ 'site.test': 1 }}, warned: {{}} }} }})")
        await asyncio.sleep(1)
        bp_id = (await b.call('Target.createTarget', {'url': f'{base}/src/blocked/blocked.html?d=site.test&k={today}&u=http%3A%2F%2Fsite.test%2F'}))['targetId']
        await asyncio.sleep(2)
        bp = await connect(next(t for t in targets() if t['id'] == bp_id))
        await bp.call('Performance.enable')
        for label in ('visible', 'hidden'):
            if label == 'hidden':
                other = (await b.call('Target.createTarget', {'url': 'about:blank', 'background': False}))['targetId']
                await b.call('Target.activateTarget', {'targetId': other})
                await asyncio.sleep(1)
            state = await bp.ev('document.visibilityState')
            p0 = await page_cpu(bp)
            wms = await worker_cpu(60)
            p1 = await page_cpu(bp)
            print(f"blocked tab {state:8s} 60s: page {p1 - p0:.1f} ms CPU, worker {wms:.1f} ms CPU")
        return

    if MODE == 'cost':
        # Three ticks with nothing trackable in front, then three with a real
        # page being tracked. Counts are cumulative from worker start.
        a = await w.ev('JSON.stringify(globalThis.__r)')
        await asyncio.sleep(92)
        z = await w.ev('JSON.stringify(globalThis.__r)')
        live = (await b.call('Target.createTarget', {'url': 'http://site.test:8765/page.html'}))['targetId']
        await b.call('Target.activateTarget', {'targetId': live})
        await asyncio.sleep(2)
        y = await w.ev('JSON.stringify(globalThis.__r)')
        await asyncio.sleep(90)
        x = await w.ev('JSON.stringify(globalThis.__r)')
        n = lambda v: json.loads(v)
        d = lambda p, q: {k: n(q)[k] - n(p)[k] for k in ('reads', 'writes', 'ticks')}
        print('startup               :', {k: n(a)[k] for k in ('reads', 'writes')})
        print('ticks, nothing tracked:', d(a, z))
        print('ticks, page tracked   :', d(y, x))
        return

    # Live tracking: a real page in the active tab, two real 30s ticks.
    live = (await b.call('Target.createTarget', {'url': 'http://site.test:8765/page.html'}))['targetId']
    await b.call('Target.activateTarget', {'targetId': live})
    t0 = time.time()
    await asyncio.sleep(66)
    credited = await w.ev("""(async () => { const d = new Date();
      const k = `day:${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const r = (await chrome.storage.local.get(k))[k]; return r ? r.totals['site.test'] || 0 : 0; })()""")
    waited = time.time() - t0
    check('live tracking credits real time on a real page', 25 <= credited <= waited + 1, f'{credited:.1f}s credited in {waited:.0f}s')
    await b.call('Target.closeTarget', {'targetId': live})

    today = await w.ev("(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })()")

    # The state below is written straight into storage, as an edit from
    # DevTools would be. Wait until the worker has stopped tracking the closed
    # tab, so no in-flight tick writes its own day record over ours, then make
    # sure the write stuck and the worker's caches have heard about it.
    for _ in range(80):
        if await w.ev("chrome.storage.session.get('track').then((x) => !(x.track && x.track.domain))"): break
        await asyncio.sleep(0.5)
    seeded = f"""{{ date: '{today}', totals: {{ 'site.test': 400 }}, hours: {{}}, blocked: {{ 'site.test': Date.now() }}, warned: {{}} }}"""
    for _ in range(5):
        await w.ev(f"chrome.storage.local.set({{ limits: {{ 'site.test': 5 }}, 'day:{today}': {seeded} }})")
        await asyncio.sleep(1)
        if await w.ev(f"chrome.storage.local.get('day:{today}').then((x) => x['day:{today}'].totals['site.test'] === 400)"): break

    original = 'http://site.test:8765/page.html?q=1#frag'
    await b.call('Target.createTarget', {'url': original})
    blocked = None
    for _ in range(30):
        await asyncio.sleep(0.3)
        blocked = next((t for t in targets() if t['type'] == 'page' and t['url'].startswith(f'{base}/src/blocked/blocked.html')), None)
        if blocked: break
    check('navigating to a spent site lands on the block page', bool(blocked), blocked and blocked['url'])
    q = urllib.parse.parse_qs(urllib.parse.urlparse(blocked['url']).query)
    check('block page carries the exact original URL and the day', q.get('u') == [original] and q.get('k') == [today], json.dumps(q))

    bp = await connect(blocked)
    await asyncio.sleep(0.8)
    check('block page shows the block', await bp.ev("document.getElementById('eyebrow').textContent") == 'Daily limit reached')

    dash_t = (await b.call('Target.createTarget', {'url': f'{base}/src/dashboard/dashboard.html'}))['targetId']
    await asyncio.sleep(1)
    dash = await connect(next(t for t in targets() if t['id'] == dash_t))
    r1 = await dash.ev("chrome.runtime.sendMessage({ type: 'setLimit', domain: 'site.test', minutes: 60 })")
    r2 = await dash.ev("chrome.runtime.sendMessage({ type: 'removeLimit', domain: 'site.test' })")
    lim = await w.ev("chrome.storage.local.get('limits').then((x) => x.limits)")
    check('raising a spent limit is refused', r1.get('error') == 'locked' and lim == {'site.test': 5}, json.dumps(r1)[:80])
    check('removing a spent limit is refused', r2.get('error') == 'locked', json.dumps(r2)[:80])
    await dash.ev("chrome.runtime.sendMessage({ type: 'clearData' })")
    day = await w.ev(f"chrome.storage.local.get('day:{today}').then((x) => x['day:{today}'])")
    snap = await dash.ev("chrome.runtime.sendMessage({ type: 'snapshot' })")
    check('deleting history keeps the block', 'site.test' in snap['blocked'] and day['totals'].get('site.test') == 400)
    await dash.ev("document.querySelector('[data-view=limits], #go-limits')?.click()")
    await asyncio.sleep(0.5)
    locked_ui = await dash.ev("""(() => { const i = document.querySelector('#all-limits input'); const t = document.querySelector('#all-limits .c-status').textContent; return { disabled: i && i.disabled, t }; })()""")
    check('dashboard shows the limit as locked', locked_ui and locked_ui['disabled'] and 'Locked until 00:00' in locked_ui['t'], json.dumps(locked_ui))
    await b.call('Target.closeTarget', {'targetId': dash_t})
    await asyncio.sleep(0.5)

    async def popup_sheet():
        pid = (await b.call('Target.createTarget', {'url': f'{base}/src/popup/popup.html'}))['targetId']
        await asyncio.sleep(1)
        p = await connect(next(t for t in targets() if t['id'] == pid))
        await p.ev("document.getElementById('add-limit').click()")
        await asyncio.sleep(0.5)
        got = await p.ev("""(() => { const $ = (i) => document.getElementById(i);
          return { domain: $('sheet-domain').textContent, title: $('rule-title').textContent,
            off: ['step-up', 'step-down', 'limit-range', 'save-limit', 'remove-limit'].filter((i) => $(i).disabled),
            presetsOff: [...document.querySelectorAll('#presets .preset')].every((x) => x.disabled) }; })()""")
        await b.call('Target.closeTarget', {'targetId': pid})
        return got
    ps = await popup_sheet()
    check('popup: a spent limit is locked', ps['domain'] == 'site.test' and ps['title'] == 'Locked until midnight'
          and len(ps['off']) == 5 and ps['presetsOff'], json.dumps(ps))

    # Midnight, as the block page sees it: today's record no longer holds the block.
    await w.ev(f"chrome.storage.local.remove('day:{today}')")
    await asyncio.sleep(0.8)
    check('block page notices on its own (no polling)', await bp.ev("document.getElementById('eyebrow').textContent") == 'Available again')
    await w.ev(f"chrome.storage.local.set({{ 'day:{today}': {{ date: '{today}', totals: {{ 'site.test': 60 }}, hours: {{}}, blocked: {{}}, warned: {{}} }} }})")
    ps = await popup_sheet()
    check('popup: an unspent limit is editable', ps['domain'] == 'site.test' and ps['title'] == 'Blocks until midnight'
          and ps['off'] == [] and not ps['presetsOff'], json.dumps(ps))
    await w.ev(f"chrome.storage.local.remove('day:{today}')")
    pages_before = [t['url'] for t in targets() if t['type'] == 'page']
    await bp.ev("document.getElementById('dashboard').click()")
    await asyncio.sleep(1.5)
    pages_after = [t['url'] for t in targets() if t['type'] == 'page']
    check('"Continue" returns to the exact original URL', original in pages_after, json.dumps(pages_after))
    check('and does not open the dashboard', not any('dashboard.html' in u for u in pages_after), json.dumps(pages_after))

    # Midnight, for real: a block page whose clock is shifted to 23:59:50
    # local. It must repaint every second in the final minute, then lift by
    # itself after 00:00 and say "New day" -- with no worker involved.
    cl = (await b.call('Target.createTarget', {'url': 'about:blank'}))['targetId']
    cp = await connect(next(t for t in targets() if t['id'] == cl))
    await cp.call('Page.enable')
    await cp.call('Page.addScriptToEvaluateOnNewDocument', {'source': """(() => {
      const real = Date.now.bind(Date); const n = new Date();
      const offset = new Date(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 50).getTime() - real();
      const RealDate = Date;
      globalThis.Date = class extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(real() + offset); }
        static now() { return real() + offset; }
      }; })()"""})
    fake_today = today   # 23:59:50 is still today
    await w.ev(f"chrome.storage.local.set({{ limits: {{ 'site.test': 5 }}, 'day:{fake_today}': {{ date: '{fake_today}', totals: {{ 'site.test': 400 }}, hours: {{}}, blocked: {{ 'site.test': 1 }}, warned: {{}} }} }})")
    await asyncio.sleep(0.5)
    await cp.call('Page.navigate', {'url': f'{base}/src/blocked/blocked.html?d=site.test&k={fake_today}&u=' + urllib.parse.quote(original, safe='')})
    await asyncio.sleep(1.2)
    seen = []
    for _ in range(4):
        seen.append(await cp.ev("document.getElementById('remaining').textContent"))
        await asyncio.sleep(1)
    check('final minute: the countdown repaints every second', len(set(seen)) >= 3 and all(x.endswith('s') for x in seen), json.dumps(seen))
    await asyncio.sleep(8)
    after = await cp.ev("[document.getElementById('eyebrow').textContent, document.getElementById('dashboard').textContent.trim()]")
    check('after 00:00 the page lifts by itself and says "New day"', after[0] == 'New day' and after[1] == 'Continue to site.test', json.dumps(after))
    await b.call('Target.closeTarget', {'targetId': cl})
    await w.ev(f"chrome.storage.local.remove('day:{fake_today}')")
    await asyncio.sleep(0.5)

    nd = (await b.call('Target.createTarget', {'url': f'{base}/src/blocked/blocked.html?d=site.test&k=2000-01-01&u=' + urllib.parse.quote(original, safe='')}))['targetId']
    await asyncio.sleep(1)
    ndp = await connect(next(t for t in targets() if t['id'] == nd))
    check('a block page from an earlier day says "New day"', await ndp.ev("document.getElementById('eyebrow').textContent") == 'New day')

try:
    asyncio.run(asyncio.wait_for(main(), 300))
finally:
    import signal
    http.terminate()
    try: os.killpg(brave.pid, signal.SIGTERM); brave.wait(5)
    except Exception:
        try: os.killpg(brave.pid, signal.SIGKILL)
        except Exception: pass
    time.sleep(1)
    shutil.rmtree(work, ignore_errors=True)
if results:
    print(f'{sum(results)}/{len(results)} passed')
    sys.exit(0 if all(results) else 1)
