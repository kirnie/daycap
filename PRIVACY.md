# Tabtime privacy policy

Tabtime does not collect, transmit or sell any data. It makes no network
requests. Everything it records stays in the browser profile it is installed
in, and is removed when you uninstall the extension.

## What is stored on your device

- Per day: seconds of active time per site (by domain, such as `example.com`),
  total seconds per hour of the day, and the time a limit was first reached.
- Your limits, your settings, and the sites you marked as "audio only".
- If you turn on Diagnostics: the last 80 focus events and tracking decisions,
  holding window ids and site names. Turning it off deletes them.

Not stored: full addresses (URLs), page titles, page content, or a timeline of
individual visits.

## How long it is kept

Days older than the retention setting (30 days by default) are deleted
automatically. **Settings → Delete all history** removes everything at once,
and **Export CSV** shows everything that is kept.

## Page access

By default Tabtime cannot read any page. If you turn on **Accurate tracking**,
it asks for access to all sites and adds a small script to each page. That
script tells the extension two things only: whether the page has focus, and
whether video or audio is playing. It reads no page content, and nothing leaves
the browser. Turning the setting off removes the access.

## Contact

Questions and problems: open an issue on the project's GitHub repository.
