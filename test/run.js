import './domain.test.js';
import './time.test.js';
import './accrual.test.js';
import './store.test.js';
import { run } from './harness.js';

const { failed, text } = await run();

if (typeof document !== 'undefined') {
  document.title = failed ? `FAILED (${failed})` : 'All tests passed';
  document.getElementById('out').textContent = text;
} else {
  console.log(text);
  if (typeof process !== 'undefined') process.exitCode = failed ? 1 : 0;
}
