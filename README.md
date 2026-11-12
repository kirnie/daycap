# Tabtime

A Brave/Chromium extension that counts time on the **active tab of the focused
window**, summarises the day, and blocks a site until midnight once it passes a
daily limit.

Built for personal use on Fedora. No accounts, no servers, no network requests.

## Install

1. Open `brave://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder
4. Pin the Tabtime icon to the toolbar

To update after editing: press the reload arrow on the card in
`brave://extensions`.

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
- Raising the limit lifts the block immediately, and the block page offers to
  return you to the page it replaced.
- Limits are keyed by site, the same way time is counted: entering
  `news.ycombinator.com` sets the limit on `ycombinator.com`.

Whether a site *is* blocked is always derived from the live limit, never from a
stored flag, which is what makes "raise the limit, block lifts" work without a
separate unblock step.

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
midnight), the credit cap after a suspend, limit/block derivation, retention by
calendar date, and the migration of old records. The focus heuristics in
`background.js` depend on live browser events and are not covered.

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
