// A deliberately tiny test harness with no dependencies, so the same files run
// under Node (`npm test`) and in a browser page (test/index.html).

const cases = [];

export function test(name, fn) {
  cases.push({ name, fn });
}

export function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label ? `${label}: ` : ''}expected ${e}, got ${a}`);
}

export function near(actual, expected, label = '') {
  if (Math.abs(actual - expected) > 1e-6) {
    throw new Error(`${label ? `${label}: ` : ''}expected ${expected}, got ${actual}`);
  }
}

export async function run() {
  const lines = [];
  let failed = 0;
  for (const { name, fn } of cases) {
    try {
      await fn();
      lines.push(`ok    ${name}`);
    } catch (err) {
      failed += 1;
      lines.push(`FAIL  ${name}\n      ${err.message}`);
    }
  }
  lines.push('', `${cases.length - failed} passed, ${failed} failed`);
  return { failed, text: lines.join('\n') };
}

// An in-memory stand-in for chrome.storage.local.
export function fakeChrome(initial = {}) {
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const data = clone(initial);
  const local = {
    async get(keys) {
      if (keys == null) return clone(data);
      const list = typeof keys === 'string' ? [keys] : keys;
      const out = {};
      for (const k of list) if (k in data) out[k] = clone(data[k]);
      return out;
    },
    async set(patch) { Object.assign(data, clone(patch)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; },
  };
  return { data, chrome: { storage: { local } } };
}

export function installChrome(initial) {
  const fake = fakeChrome(initial);
  Object.defineProperty(globalThis, 'chrome', { value: fake.chrome, configurable: true, writable: true });
  return fake.data;
}
