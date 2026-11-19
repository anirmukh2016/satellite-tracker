const test = require('node:test');
const assert = require('node:assert/strict');
const lib = () => import('../frontend/settings.js');

test('hash round-trip keeps toggles, time and observer', async () => {
  const { encodeHash, decodeHash } = await lib();
  const t = new Date('2026-11-19T04:30:00Z');
  const h = encodeHash({ on: ['past', 'zone'], t, observer: { lat: 51.5, lon: -0.12 } });
  assert.equal(h, '#on=past,zone&t=2026-11-19T04:30:00Z&o=51.500,-0.120');
  const d = decodeHash(h);
  assert.deepEqual(d.on, ['past', 'zone']);
  assert.equal(d.t.toISOString(), t.toISOString());
  assert.deepEqual(d.observer, { lat: 51.5, lon: -0.12 });
});

test('malformed or hostile hashes are ignored', async () => {
  const { decodeHash } = await lib();
  assert.deepEqual(decodeHash('#on=bogus,zone&t=nonsense&o=999,5'), { on: ['zone'] });
  assert.deepEqual(decodeHash(''), {});
});

test('saved settings merge over defaults and tolerate bad storage', async () => {
  const { loadSettings, saveSettings } = await lib();
  const mem = { d: {}, getItem(k) { return this.d[k] ?? null; }, setItem(k, v) { this.d[k] = v; } };
  assert.deepEqual(loadSettings(mem).on, ['past', 'future', 'daynight']);
  saveSettings({ on: ['ground'], cam: 20, observer: null }, mem);
  assert.equal(loadSettings(mem).cam, 20);
  assert.deepEqual(loadSettings({ getItem() { throw new Error('blocked'); } }).on, ['past', 'future', 'daynight']);
});
