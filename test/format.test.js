const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./fakes');

const env = makeEnv();
const ctx = env.context;

test('flags come from keywords as whole words only', () => {
  assert.deepEqual({ ...ctx.detectFlags_({}, 'Waiter - oil change, needs a ride after? no: UBER home') },
    { waiter: true, dropOff: false, ride: true });
  // "override" must not count as a ride, "waiting on parts" is not a waiter
  assert.deepEqual({ ...ctx.detectFlags_({}, 'override TPMS, waiting on parts, drop off tonight') },
    { waiter: false, dropOff: true, ride: false });
});

test('dedicated Shop-Ware fields win over keywords', () => {
  const f = ctx.detectFlags_({ waiter: false, needs_ride: 'yes' }, 'WAITER');
  assert.equal(f.waiter, false);
  assert.equal(f.ride, true);
});

test('renders summary and description with all details', () => {
  const view = ctx.buildView_(
    { id: 7, start_at: '2026-12-01T15:00:00Z', end_at: '2026-12-01T16:30:00Z', description: 'Waiter. Needs Uber after drop?\nBrakes squeak', status: 'scheduled' },
    { first_name: 'Ana', last_name: 'Lopez', phones: [{ number: '(555) 123-4567' }], emails: ['ana@example.com'] },
    { year: 2019, make: 'Ford', model: 'F-150', sub_model: 'XLT', vin: '1FTEW1E5XKFA00000', plate: 'ABC123', mileage: 61234 },
    { number: 'RO-88' },
    { first_name: 'Sam', last_name: 'Writer' });
  const ev = ctx.renderEvent_(view);
  assert.equal(ev.summary, '⏳ WAITER · 🚕 RIDE | Ana Lopez | 2019 Ford F-150 XLT');
  for (const s of ['Phone: (555) 123-4567', 'ana@example.com', 'VIN: 1FTEW1E5XKFA00000', 'Plate: ABC123',
    'Mileage: 61234', 'Visit: WAITER', 'Needs ride: YES', 'Advisor: Sam Writer', 'RO #: RO-88', 'Shop-Ware appointment #7']) {
    assert.ok(ev.description.includes(s), 'missing ' + s);
  }
  assert.equal(ev.start.dateTime, '2026-12-01T15:00:00.000Z');
  assert.equal(ev.colorId, '11');
  assert.equal(ctx.extractNotes_(ev.description), 'Waiter. Needs Uber after drop?\nBrakes squeak');
});

test('missing end time uses default duration', () => {
  const ev = ctx.renderEvent_(ctx.buildView_({ id: 1, start_at: '2026-12-01T15:00:00Z' }));
  assert.equal(ev.end.dateTime, '2026-12-01T16:00:00.000Z');
});

test('event ids round-trip and are valid Google ids', () => {
  const id = ctx.eventIdFor_('sales', '12345');
  assert.match(id, /^[0-9a-v]{5,}$/);
  assert.deepEqual({ ...ctx.parseEventId_(id) }, { calKey: 'sales', shopwareId: '12345' });
  assert.equal(ctx.parseEventId_('abc123xyz'), null);
  assert.equal(ctx.parseEventId_('shopzz'), null);
});

test('parses an event typed into Google Calendar', () => {
  const p = ctx.parseEventText_('Oil change - waiter',
    'Customer: Ana Lopez<br>Phone: 555-123-4567<br>Vehicle: 2019 Ford F-150<br>needs a ride home<br>check brakes');
  assert.equal(p.fields.customer, 'Ana Lopez');
  assert.equal(p.fields.phone, '555-123-4567');
  assert.equal(p.fields.vehicle, '2019 Ford F-150');
  assert.match(p.fields.notes, /check brakes/);
  assert.equal(p.flags.waiter, true);
  assert.equal(p.flags.ride, true);
  const notes = ctx.composeShopwareNotes_(p);
  assert.match(notes, /^\[WAITER\] \[NEEDS RIDE\]/);
  // and those notes are recognised again when they come back from Shop-Ware
  const back = ctx.detectFlags_({}, notes);
  assert.equal(back.waiter, true);
  assert.equal(back.ride, true);
});

test('fingerprint ignores html and timezone formatting differences', () => {
  const a = { summary: 'x', description: 'a\nb', start: { dateTime: '2026-12-01T09:00:00-06:00' }, end: { dateTime: '2026-12-01T10:00:00-06:00' } };
  const b = { summary: 'x', description: 'a<br>b', start: { dateTime: '2026-12-01T15:00:00Z' }, end: { dateTime: '2026-12-01T16:00:00.000Z' } };
  assert.equal(ctx.eventFingerprint_(a), ctx.eventFingerprint_(b));
});
