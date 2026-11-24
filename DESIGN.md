# Tabtime: design notes

How Tabtime works and why it works that way: the tracking rules, the platform
problems found along the way and how they were measured and fixed, what is
stored, and what is deliberately left out.

For what the extension is and how to install and use it, see
[README.md](README.md).

Tabtime is a Brave/Chromium extension that counts time on the **active tab of
the focused window**, summarises the day, and blocks a site until midnight once
it passes a daily limit. It was built for personal use on Fedora. No accounts,
no servers, no network requests.

## What counts as active

One clock, never two. At any instant exactly one tab earns time: the active tab
of the focused Brave window. The rule is identical for every window, on every
workspace, on every monitor.

The clock stops when:

- the browser loses focus (another app, another workspace)
- the screen locks
- there is no keyboard or mouse input for the idle timeout (default 60s)
- the tab is not an `http(s)` page

A second Brave window sitting visible next to the focused one earns nothing, so
a day's total can never exceed the wall clock.

### Wayland focus, and why it needed two fixes

Two separate platform behaviours bite here. Both were found by instrumenting the
extension and reading the log, not by guessing.

**1. The spurious blur.** On several Linux window managers the browser reports
"no window focused" *immediately before* focus moves from one of its own windows
to another. Handled naively the clock would stop and restart on every alt-tab
between two Brave windows. So a blur is not believed straight away: it is
recorded, and only becomes a real pause once ~1.2s has passed with nothing else
taking focus.

**2. The focus flag flaps.** This is the one that actually broke multi-window
tracking on GNOME/Wayland. `chrome.windows` reports `focused: false` for *every*
window for seconds at a time, then the correct one reports `true` again --
measured at every 10-30s during ordinary browsing. Polling the flag therefore
cannot be the source of truth: tracking died and resumed continuously, which
looks exactly like "the other workspace is not tracked".

The fix is to remember focus rather than poll it. The focused window id is
written down from three signals -- `onFocusChanged`, tab activation, and a URL
change on an active tab (the last two only happen when the user is actually in
the browser, which also re-seeds focus after a service-worker restart). The flag
stays the fast path and is preferred whenever it names a window, and **every time
it does, the remembered id is refreshed from it** -- that last part matters,
because the logs show the user changing window with no `onFocusChanged` event at
all, so events alone would go stale.

Measured before and after, same machine, same browsing:

| | before | after |
|---|---|---|
| `no-focused-window` outcomes | 23 | 0 |
| flaps absorbed (`via: event`) | n/a | continuous tracking |

Note that **system idle detection cannot substitute for any of this** -- if you
switch to a terminal on another workspace and keep typing, the OS still sees
input and reports you active. Window focus is the only signal that catches it.

### A known, measured cost

A tab mid-navigation reports an empty URL for about 140ms before the new one
commits, so the clock stops for that long on each navigation. It is not worth
special-casing.

## Limits and blocking

- One limit per site, in minutes per day.
- At the limit, every tab on that site is replaced by the block page —
  background tabs included, so one cannot idle past the limit and be waiting
  for you later.
- The block holds until **00:00 local time**. There is no snooze.
- A spent limit is **locked until midnight**: it can be neither raised nor
  removed while the site is blocked. Limits can be changed freely before they
  run out. The worker enforces the lock (`setLimit`/`removeLimit` answer
  `{ error: 'locked' }`), and the popup and dashboard disable their controls.
- **Delete all history** cannot be used as an unblock either: today's time and
  block stamp for sites blocked right now are written back after the wipe
  (`keepBlocked` in `src/lib/accrual.js`), and nothing else is.
- Once the block lifts at midnight, the block page says so and its button
  returns you to the exact URL it replaced. The page carries the day it was put
  up (`k=`), which is how it tells a new day apart.
- Limits are keyed by site, the same way time is counted: entering
  `news.ycombinator.com` sets the limit on `ycombinator.com`.

Whether a site *is* blocked is always derived from today's time and the live
limit, never from a stored flag, so the block lifts at midnight on its own,
without a separate unblock step.

## How sites are bucketed

By registrable domain (eTLD+1), so `m.youtube.com`, `www.youtube.com` and
`youtube.com` share one total and one limit.

The suffix list is a short hand-maintained one (`src/lib/domain.js`) rather than
the full Public Suffix List. It covers the common multi-part suffixes
(`co.uk`, `com.au`, `co.jp`, …). The visible consequence: a site like
`news.ycombinator.com` buckets as `ycombinator.com`. Add entries to
`MULTI_PART_SUFFIXES` if you hit a case it gets wrong.

## Surviving the service worker

MV3 evicts the background worker constantly, so nothing important lives in
memory. The tracker persists `{domain, since, heartbeat}` to
`chrome.storage.session` and works by *settling*: on every event and every 30s
alarm it credits the elapsed span and moves the segment start to now.

That means a slower tick (Chrome may clamp the alarm period) delays the limit
check but never loses time. Credit is capped at 150s past the last heartbeat, so
a suspended machine or a closed browser cannot bank hours it never spent.

## Keeping it light

The 30s tick is the only recurring work. It used to make nine storage reads;
now a warm worker makes none: a tick that credits time writes the day record
and reads nothing. Measured in a headless Brave from a fresh start through
three real ticks: 38 reads before (23 at startup, 15 in ticks), 5 after (all
at startup, 0 in ticks).

That works because only the service worker writes storage -- the popup,
dashboard and block page go through messages or only read. So the worker keeps
three things in memory, write-through: its tracking state (`storage.session`),
the combined settings + limits + playback gates (`getConfig`, which the single
getters share), and the day record it last wrote. Any store write drops or
refreshes the matching cache. So does a change seen through
`storage.onChanged` that is not the value already cached, such as an edit from
DevTools. Generation counters stop a read that raced a write from being kept.
An evicted worker just reads again on its next start, and startup runs once
even when `onStartup` and the missing-alarm check both fire. Beyond that:

- **Idle ticks write nothing.** When no site is tracked before or after a tick
  and only `heartbeat`/`since` moved, the tracking state is not saved, so a
  browser sitting behind other apps all night costs no storage. Ticks do keep
  writing while a browser window still claims focus, for example on a lock
  screen: `lastFlagTrue` then moves, and it has to survive an eviction for focus
  memory to bridge a Wayland flap.
- **The badge** is written only when its number changes, and only from the
  events that can change it (a limit crossed or set, a wipe, midnight). It is
  not refreshed on every tick.
- **Block pages never message the worker.** They read `limits` and today's
  record straight from storage, repaint on `storage.onChanged`, and run their
  clock only while visible, once a minute (every second only in the last minute
  before midnight). A blocked tab left open all day wakes nothing.
- **The dashboard** refreshes every 30s only while it is visible. It fetches
  the full history once, and after that swaps in just today's record, since
  past days do not change.
- **Navigation checks** read the day record only for sites that have a limit.
- **The page probe** (Accurate tracking only) reports from sub-frames only when
  their playback state changes, so a page full of ad iframes does not wake the
  worker once per frame on load.
- **Media reports** are read only in Accurate mode, the only mode that
  writes them, and the diagnostics bookkeeping is skipped when diagnostics
  are off.

## Permissions

| Permission | Why |
|---|---|
| `storage` | day records, limits, settings — all local |
| `tabs` | read the active tab's URL |
| `idle` | detect lock screen and away-from-keyboard |
| `alarms` | the 30s heartbeat and the midnight reset |
| `notifications` | the warning before a limit, and the block notice |
| `scripting` | only used by Accurate tracking, to register its page script |
| `*://*/*` (optional, off by default) | only requested if you turn on Accurate tracking |

**No page access by default.** Out of the box the extension has no host
permissions, injects nothing, and makes no network requests. Blocking is done by
navigating the tab to a bundled page.

### Accurate tracking, and what it costs

Without it, focus comes from the browser's window flag, which is unreliable on
Wayland (see above). Settings → **Accurate tracking** fixes that by asking the
pages themselves, and the price is the broadest permission there is: access to
every site, and a script (`src/content/probe.js`) injected into every page and
frame. That script reports two booleans to the extension's own service worker —
"this page has focus" and "a video/audio element is playing" — and nothing
else. It reads no page content. Turning the setting off removes the permission
and the script.

## Diagnostics

Off by default. Settings → Diagnostics keeps a bounded 80-entry ring buffer in
`chrome.storage.local` under the key `diag`: every focus event, and every
tracking decision whose outcome changed. It holds window ids and site names,
never URLs. Turning the setting off deletes the log, and so does **Delete all
history**.

## Data

Stored in `chrome.storage.local` in this browser profile only:

- `day:YYYY-MM-DD` — seconds per site, total seconds per hour of the day (not
  per site), and when each limit was first hit
- `limits` — minutes per day, per site
- `playbackOnly` — sites marked "audio only"
- `settings` — idle timeout, warning threshold, notifications, retention

Not stored: URLs, page titles, or any timeline of individual visits.

Days older than the retention setting (default: 30 calendar days) are deleted at
midnight and at browser start. History and Settings → **Export CSV**
(`date,domain,seconds,minutes`) cover everything that is kept, so nothing is
stored that you cannot see.

Records written by 1.0.0 also held a per-visit session list and per-site hours.
They are rewritten in the slim form the first time this version starts.

## Layout

```
manifest.json
icons/                  generated PNGs
src/
  background.js         tracker, limit enforcement, message API
  content/probe.js      the Accurate tracking page script (not loaded by default)
  lib/
    domain.js           registrable-domain bucketing
    time.js             day keys, local midnight, duration formatting
    accrual.js          the accounting rules, free of chrome.* so they are testable
    store.js            storage schema, retention, migration
  styles/tokens.css     shared design tokens
  popup/                toolbar popup + limit sheet
  dashboard/            today, history, limits, settings
  blocked/              the page a blocked site is replaced by
test/                   tests for lib/ (no dependencies)
```

## Tests

```
npm test                    # Node
gjs -m test/run-gjs.js      # GNOME's gjs, if Node is not installed
```

They cover site bucketing, day and hour boundaries (including a span crossing
midnight), the credit cap after a suspend, limit/block derivation, the wipe
keeping blocks, the storage caches, retention by calendar date, and the
migration of old records.

```
python3 test/e2e/brave.py            # real headless Brave/Chromium, ~2 min
python3 test/e2e/brave.py cost DIR   # worker storage reads/writes for tree DIR
```

The end-to-end test needs Python's `websockets`. It loads the unpacked
extension into a throwaway headless profile, maps `site.test` to a local
server, and checks live tracking on a real page, blocking (with the exact URL
kept), the limit lock in the worker, dashboard and popup, the wipe keeping a
block, the block page noticing the lift without polling, "Continue" going back
to the original URL, the "New day" text, and a block page with its clock
shifted to 23:59:50 counting down by the second and lifting itself after
00:00. `cost` mode injects a counter into
a copy of any tree, for comparisons like this one (fresh start, then three
ticks idle and three tracked):

| | before (`dcec2e2`) | now |
|---|---|---|
| startup reads / writes | 23 / 4 | 5 / 2 |
| idle ticks: reads / writes | 15 / 3 | 0 / 3 |
| tracked ticks: reads / writes | 24 / 6 | 0 / 6 |

`perf` mode (`python3 test/e2e/brave.py perf DIR`) measures CPU and memory
the same way: sampled worker CPU over three idle ticks, and a blocked tab over
60s visible and 60s hidden.

| | before (`dcec2e2`) | now |
|---|---|---|
| worker, 3 idle ticks | 1.0 ms CPU, 729 KB heap | 1.0 ms CPU, 697 KB heap |
| blocked tab visible, 60s: page / worker | 50.3 / 3.8 ms | 2.0 / 0.3 ms |
| blocked tab hidden, 60s: page / worker | 8.7 / 2.1 ms | 1.1 / 0.5 ms |

The visible block page used to repaint every second. Its clock reads in whole
minutes until the last minute before midnight, so it now repaints on minute
boundaries and switches to every second only for that last minute.

The writes left are the minimum. A tracked tick must save the day record (the
credit) and the tracking state's new `since`/`heartbeat`, because without the
second an evicted worker would credit the same span twice. The idle writes in
the table come from headless Brave reporting its window as focused, so
`lastFlagTrue` moves (see *Keeping it light*). With the browser behind other
apps, an idle tick writes nothing. The Wayland focus heuristics themselves are
not covered: they need a real compositor.

## Known limits

- **Fonts.** The design used Space Grotesk and IBM Plex Sans. Extension pages
  cannot pull from a font CDN without loosening CSP, so the shipped UI uses the
  system stack (Cantarell on Fedora). Drop `.woff2` files into `src/styles/` and
  add `@font-face` rules if you want the original faces.
- **Blocking happens on navigation commit**, so a blocked page may flash for a
  frame before the redirect. Moving to `declarativeNetRequest` would stop the
  request outright, at the cost of adding a host permission.
- **Audible background tabs earn nothing** — only the focused tab counts. If you
  want music to keep the clock running, that is a deliberate change to
  `resolveTarget()` in `src/background.js`.
