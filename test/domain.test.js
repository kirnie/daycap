import { test, eq } from './harness.js';
import { registrableDomain } from '../src/lib/domain.js';

test('domain: subdomains share one bucket', () => {
  eq(registrableDomain('https://www.youtube.com/watch?v=1'), 'youtube.com');
  eq(registrableDomain('https://m.youtube.com/'), 'youtube.com');
  eq(registrableDomain('https://news.ycombinator.com/item?id=1'), 'ycombinator.com');
});

test('domain: multi-part suffixes keep three labels', () => {
  eq(registrableDomain('https://www.bbc.co.uk/news'), 'bbc.co.uk');
  eq(registrableDomain('https://shop.example.com.au/'), 'example.com.au');
});

test('domain: hosts that stand alone', () => {
  eq(registrableDomain('http://localhost:3000/'), 'localhost');
  eq(registrableDomain('http://192.168.1.10/admin'), '192.168.1.10');
  eq(registrableDomain('https://EXAMPLE.com./'), 'example.com');
});

test('domain: untrackable URLs give null', () => {
  eq(registrableDomain('chrome://extensions'), null);
  eq(registrableDomain('chrome-extension://abc/page.html'), null);
  eq(registrableDomain('file:///home/x/a.html'), null);
  eq(registrableDomain('about:blank'), null);
  eq(registrableDomain(''), null);
  eq(registrableDomain(undefined), null);
  eq(registrableDomain('https://'), null);
});
