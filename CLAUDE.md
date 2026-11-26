# Notes for Claude

## The extension is published

Daycap is live on the Chrome Web Store:
https://chromewebstore.google.com/detail/bchoepedlbpjbgcedohjbkfbelfbnffd
(extension ID `bchoepedlbpjbgcedohjbkfbelfbnffd`). Real users install it and
receive every upload automatically, so:

- **Bump `version` in `manifest.json` before every store upload.** The store
  rejects a package whose version is not higher than the live one. Then run
  `npm run package` and upload `dist/daycap-<version>.zip`.
- **Never break data users already have.** Any change to what is kept in
  `chrome.storage.local` (day records, settings, limits) needs a migration:
  raise `SCHEMA` in `src/lib/store.js` and extend `migrate()` so older data is
  upgraded on startup. Readers should also tolerate the old shape until the
  migration has run.
- **Treat internal identifiers as stable.** Storage keys and message types
  (e.g. `tabtime-probe`) keep their old
  `tabtime` names. The product was renamed from Tabtime to Daycap in 1.1.1;
  renaming them buys nothing.
- **New permissions need care.** Adding a required permission disables the
  extension for existing users until they accept it; prefer optional
  permissions.
