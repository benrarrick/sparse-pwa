import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as P from '../js/places.js';

test('placesIntent: known kinds', () => {
  assert.equal(P.placesIntent('coffee near me').label, 'Cafés');
  assert.equal(P.placesIntent('coffee near me').place, '');
  assert.equal(P.placesIntent('nearest pharmacy').label, 'Pharmacies');
  assert.equal(P.placesIntent('nearby ATMs').label, 'Cash machines');
  assert.equal(P.placesIntent('best pizza near me').label, 'Pizza');
  assert.equal(P.placesIntent('toilets nearby?').label, 'Toilets');
  const leeds = P.placesIntent('pharmacy near Leeds city centre');
  assert.equal(leeds.label, 'Pharmacies');
  assert.equal(leeds.place, 'Leeds city centre');
});

test('placesIntent: name search only for "near me"', () => {
  const t = P.placesIntent('Tesco near me');
  assert.equal(t.type, null);
  assert.equal(t.term, 'tesco');
  assert.equal(P.placesIntent('Tesco near Leeds'), null);
});

test('placesIntent: ordinary searches are left alone', () => {
  for (const q of ['weather', 'how to make coffee near me', 'houses near the sea', 'best hiking trails near denver', 'coffee', 'cafe', 'what is the nearest star', 'reviews of pharmacy near me']) {
    assert.equal(P.placesIntent(q), null, q);
  }
});

test('distance, bearing and formatting', () => {
  const a = { lat: 51.5074, lon: -0.1278 };
  const b = { lat: 51.5074, lon: -0.1178 };
  const d = P.distance(a, b);
  assert.ok(d > 650 && d < 720, String(d));
  assert.equal(P.direction(P.bearing(a, b)), 'E');
  assert.equal(P.direction(P.bearing(a, { lat: 51.6, lon: -0.1278 })), 'N');
  assert.equal(P.formatDistance(140), '140 m');
  assert.equal(P.formatDistance(1234), '1.2 km');
  assert.equal(P.formatDistance(12345), '12 km');
  assert.equal(P.formatDistance(100, true), '330 ft');
  assert.equal(P.formatDistance(1609, true), '1.0 mi');
});

test('overpassQuery', () => {
  const q = P.overpassQuery(51.5, -0.12, 800, P.placesIntent('pizza near me'));
  assert.match(q, /nwr\(around:800,51\.50000,-0\.12000\)\["cuisine"="pizza"\];/);
  assert.match(q, /out tags center 60;$/);
  const n = P.overpassQuery(51.5, -0.12, 2000, P.placesIntent('M&S near me'));
  assert.match(n, /\["name"~"m&s",i\]/);
  const evil = P.overpassQuery(51.5, -0.12, 100, { type: null, term: 'a"b);out;' });
  assert.ok(!evil.includes('a"b'), evil);
});

test('nominatimUrl', () => {
  const u = new URL(P.nominatimUrl(51.5, -0.12, 1000, P.placesIntent('atm near me')));
  assert.equal(u.host, 'nominatim.openstreetmap.org');
  assert.equal(u.searchParams.get('q'), 'atm');
  assert.equal(u.searchParams.get('bounded'), '1');
  assert.equal(u.searchParams.get('viewbox').split(',').length, 4);
});

const here = { lat: 51.5074, lon: -0.1278 };

test('parseOverpass: nearest first, named only, nodes and ways', () => {
  const json = {
    elements: [
      { type: 'node', lat: 51.51, lon: -0.1278, tags: { name: 'Far Cafe', amenity: 'cafe', opening_hours: 'Mo-Su 08:00-17:00', website: 'https://far.example', phone: '+44 1' } },
      { type: 'node', lat: 51.5078, lon: -0.1278, tags: { name: 'Near Cafe', amenity: 'cafe', 'addr:housenumber': '5', 'addr:street': 'High St', website: 'javascript:alert(1)' } },
      { type: 'way', center: { lat: 51.5075, lon: -0.1275 }, tags: { name: 'Way Cafe', amenity: 'cafe' } },
      { type: 'node', lat: 51.5075, lon: -0.1279, tags: { amenity: 'cafe' } },
      { type: 'node', lat: 51.5078, lon: -0.1278, tags: { name: 'Near Cafe', amenity: 'cafe' } },
    ],
  };
  const r = P.parseOverpass(json, here);
  assert.deepEqual(r.map((p) => p.name), ['Way Cafe', 'Near Cafe', 'Far Cafe']);
  assert.equal(r[1].address, '5 High St');
  assert.equal(r[1].web, '');
  assert.equal(r[2].web, 'https://far.example');
  assert.equal(r[0].dir.length > 0, true);
  const withUnnamed = P.parseOverpass(json, here, { keepUnnamed: true, label: 'Cafés' });
  assert.equal(withUnnamed.length, 4);
  assert.equal(withUnnamed.find((p) => p.dist < 20 && p.name !== 'Way Cafe').name, 'Cafés');
  assert.equal(P.parseOverpass(null, here).length, 0);
});

test('parseNominatim', () => {
  const json = [
    { lat: '51.5059', lon: '-0.1171', name: 'Riverside Cafe', type: 'cafe', display_name: 'Riverside Cafe, Festival Terrace, South Bank, London', extratags: { opening_hours: 'Mo-Tu 10:00-18:00', 'contact:website': 'https://r.example' } },
    { lat: '51.5075', lon: '-0.1280', name: 'Cafe Spreads', type: 'cafe', display_name: 'Cafe Spreads, 15A, Pall Mall', extratags: {} },
  ];
  const r = P.parseNominatim(json, here);
  assert.equal(r[0].name, 'Cafe Spreads');
  assert.equal(r[1].hours, 'Mo-Tu 10:00-18:00');
  assert.equal(r[1].web, 'https://r.example');
  assert.equal(r[1].address, 'Festival Terrace, South Bank');
});

// 2026-10-14 is a Wednesday.
const at = (day, hh, mm = 0) => new Date(2026, 9, 11 + day, hh, mm);

test('openStatus: weekdays, weekends, off', () => {
  const h = 'Mo-Fr 08:00-18:00; Sa 09:00-13:00; Su off';
  assert.deepEqual(P.openStatus(h, at(3, 10)), { open: true, text: 'Open until 18:00' });
  assert.deepEqual(P.openStatus(h, at(3, 7, 30)), { open: false, text: 'Closed now · opens 08:00' });
  assert.deepEqual(P.openStatus(h, at(3, 19)), { open: false, text: 'Closed now · opens tomorrow 08:00' });
  assert.deepEqual(P.openStatus(h, at(6, 14)), { open: false, text: 'Closed now · opens Mon 08:00' });
  assert.deepEqual(P.openStatus(h, at(0, 12)), { open: false, text: 'Closed now · opens tomorrow 08:00' });
});

test('openStatus: 24/7, overnight, split days, overrides', () => {
  assert.equal(P.openStatus('24/7', at(2, 3)).open, true);
  assert.equal(P.openStatus('Mo-Su 18:00-02:00', at(3, 23)).open, true);
  assert.deepEqual(P.openStatus('Mo-Su 18:00-02:00', at(3, 1)), { open: true, text: 'Open until 02:00' });
  assert.equal(P.openStatus('Mo-Su 18:00-02:00', at(3, 12)).open, false);
  assert.equal(P.openStatus('Tu,Th 09:00-12:00,13:00-17:00', at(4, 12, 30)).open, false);
  assert.equal(P.openStatus('Tu,Th 09:00-12:00,13:00-17:00', at(4, 13, 30)).open, true);
  assert.equal(P.openStatus('Mo-Fr 08:00-18:00; We off', at(3, 10)).open, false);
  assert.equal(P.openStatus('Mo-Fr 08:00-18:00; PH off', at(3, 10)).open, true);
  assert.equal(P.openStatus('09:00-17:00', at(1, 10)).open, true);
});

test('openStatus: gives up on what it cannot read', () => {
  for (const h of ['Mar-Oct Mo-Su 10:00-18:00', 'sunrise-sunset', 'Mo-Fr 08:00+', 'by appointment', '', 'Mo-Fr 08:00-18:00, Sa 09:00-12:00', 'Mo 25:00-26:00']) {
    assert.equal(P.openStatus(h, at(3, 10)), null, h);
  }
});
