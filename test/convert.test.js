import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as C from '../js/convert.js';

test('currencyIntent: pairs, names, symbols', () => {
  assert.deepEqual(C.currencyIntent('50 eur to usd'), { amount: 50, from: 'EUR', to: 'USD' });
  assert.deepEqual(C.currencyIntent('100 US dollars in pounds'), { amount: 100, from: 'USD', to: 'GBP' });
  assert.deepEqual(C.currencyIntent('$20 in euros'), { amount: 20, from: 'USD', to: 'EUR' });
  assert.deepEqual(C.currencyIntent('£1,250.50 to yen'), { amount: 1250.5, from: 'GBP', to: 'JPY' });
  assert.deepEqual(C.currencyIntent('usd to gbp'), { amount: 1, from: 'USD', to: 'GBP' });
  assert.deepEqual(C.currencyIntent('usd gbp'), { amount: 1, from: 'USD', to: 'GBP' });
  assert.deepEqual(C.currencyIntent('convert 5 euros to dollars?'), { amount: 5, from: 'EUR', to: 'USD' });
  assert.deepEqual(C.currencyIntent('how much is 10 swiss francs in dollars'), { amount: 10, from: 'CHF', to: 'USD' });
});

test('currencyIntent: leaves other searches alone', () => {
  for (const q of ['5 miles to km', 'weather in paris', 'euro 2024 results', 'usd', '50 usd', 'dollar to dollar', 'cats in hats', '10 pounds to kg', 'tea to coffee']) {
    assert.equal(C.currencyIntent(q), null, q);
  }
});

test('parseRates reads both Frankfurter shapes', () => {
  const v2 = C.parseRates([
    { date: '2026-10-15', base: 'EUR', quote: 'USD', rate: 1.12 },
    { date: '2026-10-16', base: 'EUR', quote: 'GBP', rate: 0.84 },
  ]);
  assert.deepEqual(v2, { date: '2026-10-16', rates: { EUR: 1, USD: 1.12, GBP: 0.84 } });
  const v1 = C.parseRates({ base: 'EUR', date: '2026-10-15', rates: { USD: 1.12, JPY: 177 } });
  assert.deepEqual(v1, { date: '2026-10-15', rates: { EUR: 1, USD: 1.12, JPY: 177 } });
  assert.equal(C.parseRates({}), null);
  assert.equal(C.parseRates([]), null);
});

test('convertCurrency crosses through the euro', () => {
  const rates = { EUR: 1, USD: 1.2, GBP: 0.8 };
  assert.ok(Math.abs(C.convertCurrency(100, 'USD', 'GBP', rates).value - 66.6667) < 0.001);
  assert.equal(C.convertCurrency(10, 'EUR', 'USD', rates).value, 12);
  assert.equal(C.convertCurrency(10, 'EUR', 'XYZ', rates), null);
});

test('ratesUrl asks for one euro-based download', () => {
  const u = new URL(C.ratesUrl());
  assert.equal(u.host, 'api.frankfurter.dev');
  assert.equal(u.searchParams.get('base'), 'EUR');
  assert.ok(u.searchParams.get('quotes').split(',').includes('USD'));
  assert.ok(!u.searchParams.get('quotes').split(',').includes('EUR'));
});

test('unitIntent and convertUnit', () => {
  const run = (q) => {
    const i = C.unitIntent(q);
    return i && C.convertUnit(i);
  };
  assert.ok(Math.abs(run('5 miles to km') - 8.04672) < 1e-9);
  assert.ok(Math.abs(run('10 kg in lb') - 22.0462262) < 1e-6);
  assert.ok(Math.abs(run('72 f in c') - 22.2222222) < 1e-6);
  assert.ok(Math.abs(run('72°F to celsius') - 22.2222222) < 1e-6);
  assert.equal(run('0 c to k'), 273.15);
  assert.equal(run('2 cups to ml').toFixed(1), '473.2');
  assert.equal(run('1 gb to mb'), 1000);
  assert.equal(run('1 gib to mib'), 1024);
  assert.equal(run('60 mph to km/h').toFixed(2), '96.56');
  assert.equal(run('5 in to cm').toFixed(1), '12.7');
  assert.equal(run('1 acre to sq ft').toFixed(0), '43560');
  assert.equal(run('1 hour to minutes'), 60);
});

test('unitIntent: mismatched or unknown units are ignored', () => {
  for (const q of ['5 km to kg', 'weather in paris', '5 foo to bar', '5 km to km', 'km to miles', 'hello']) assert.equal(C.unitIntent(q), null, q);
});

test('formatNumber', () => {
  assert.equal(C.formatNumber(1234.5678, 'en-US'), '1,234.57');
  assert.equal(C.formatNumber(0.84612345, 'en-US'), '0.8461');
  assert.equal(C.formatNumber(54.1234, 'en-US'), '54.1234');
  assert.equal(C.formatNumber(0, 'en-US'), '0');
  assert.equal(C.formatNumber(NaN, 'en-US'), '—');
});
