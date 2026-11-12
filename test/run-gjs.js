// Entry point for GNOME's gjs, for machines with neither Node nor a usable
// headless browser:  gjs -m test/run-gjs.js
// gjs has no WHATWG URL, so a minimal stand-in (scheme + host only, which is
// all domain.js reads) is installed before the tests load.
import GLib from 'gi://GLib';

globalThis.URL = class {
  constructor(text) {
    const uri = GLib.Uri.parse(String(text), GLib.UriFlags.NONE);   // throws if invalid
    this.protocol = `${uri.get_scheme()}:`;
    this.hostname = uri.get_host() || '';
  }
};

await import('./run.js');
