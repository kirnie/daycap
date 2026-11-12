# Tabtime

A browser extension for Brave, Chrome and other Chromium browsers that shows
where your browsing time goes and lets you cap it.

- **Counts active time per site.** Only the tab you are actually looking at
  earns time. The clock pauses when you switch to another app, lock the screen
  or stop touching the keyboard and mouse.
- **Daily limits.** Give a site a number of minutes per day. When it is used
  up, the site is replaced by a block page in every tab until midnight.
- **Private by default.** Everything stays in your browser profile. There are
  no accounts, no servers and no network requests. See [PRIVACY.md](PRIVACY.md).

## Install

### From the Chrome Web Store

Not published yet. Once it is, the link will be here, and it will install in
Brave, Chrome, Edge and other Chromium browsers.

### From source

1. Download this repository: **Code → Download ZIP** and unpack it, or
   `git clone` it.
2. Open `brave://extensions` (or `chrome://extensions`).
3. Turn on **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the folder that contains
   `manifest.json`.
5. Pin the Tabtime icon to the toolbar.

To update, pull the new version and press the reload arrow on the Tabtime card
on the extensions page.

## Use

### See today's time

Click the Tabtime icon. The popup shows your active time today and your top
sites. **Dashboard** opens the full view: time by hour, every site visited
today, and a day-by-day history.

### Set a limit

1. In the popup click **Set a limit**, or open **Dashboard → Limits**.
2. Pick the site and the minutes per day.

A limit covers the whole site, subdomains included: a limit on `youtube.com`
also covers `m.youtube.com`.

### When a limit is reached

- Every tab on that site is replaced by a block page until 00:00 local time.
- There is no snooze. If the number was wrong, raise the limit in the
  dashboard and the block lifts immediately.
- You can get a warning notification at 50%, 80% or 90% of a limit
  (**Settings → Warn before a limit**).

### Settings worth knowing

| Setting | What it does |
|---|---|
| Idle timeout | How long without input before the clock pauses (default 60 seconds). |
| Accurate tracking | More reliable focus detection, and lets playing video count as activity. Off by default because it needs access to every site. |
| Keep history for | How many days of history are kept (default 30). |
| Export CSV | Saves everything that is stored as `date,domain,seconds,minutes`. |
| Delete all history | Removes all recorded time. |

## Permissions

Out of the box Tabtime has no access to page content. It uses `tabs` to read
the address of the active tab, `idle` to detect when you are away, `alarms`,
`notifications` and `storage`. Access to all sites is requested only if you turn
on **Accurate tracking**, and is removed again when you turn it off.

## Development

```
npm test                    # Node
gjs -m test/run-gjs.js      # GNOME's gjs, if Node is not installed
npm run package             # builds dist/tabtime-<version>.zip for the store
```

Without npm, the package is just a zip of the extension files:
`zip -r dist/tabtime.zip manifest.json icons src`.

There is no build step and there are no dependencies. How the tracking works,
and why, is written up in [DESIGN.md](DESIGN.md).
