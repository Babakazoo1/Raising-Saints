const test = require('node:test');
const assert = require('node:assert/strict');
const { makeEnv } = require('./fakes');

const HOUR = 3600000;
function at(hoursFromNow) { return new Date(Date.now() + hoursFromNow * HOUR).toISOString(); }

function salesCalendar(CONFIG) {
  CONFIG.CALENDARS.push({
    key: 'sales', name: 'Sales Team', twoWay: true,
    filter: function (v) { return v.text.indexOf('sales') !== -1; },
    shareWith: [{ email: 'sales@example.com', role: 'writer', type: 'group' }],
  });
}

function setupEnv(opts) {
  const env = makeEnv(opts);
  env.customer = { id: 1, first_name: 'Ana', last_name: 'Lopez', phones: [{ number: '(555) 123-4567' }] };
  env.vehicle = { id: 2, year: 2019, make: 'Ford', model: 'F-150', vin: 'VIN123' };
  env.sw.db.customers[1] = env.customer;
  env.sw.db.vehicles[2] = env.vehicle;
  env.run('setup()');
  env.shopCal = env.store.CAL_ID_shop;
  return env;
}

test('setup creates the calendar, shares it and schedules the sync', () => {
  const env = setupEnv({ configure: salesCalendar });
  assert.ok(env.store.CAL_ID_shop);
  assert.ok(env.store.CAL_ID_sales);
  assert.equal(env.cal.cals[env.store.CAL_ID_sales].name, 'Sales Team');
  assert.deepEqual(env.cal.cals[env.store.CAL_ID_sales].acl.map((r) => [r.scope.value, r.role, r.scope.type]),
    [['sales@example.com', 'writer', 'group']]);
  assert.deepEqual(env.triggers.map((t) => t.getHandlerFunction()).sort(), ['healthCheck', 'syncNow']);
  assert.ok(env.store.LAST_SUCCESS_AT);
  assert.equal(env.mail.length, 0);
});

test('Shop-Ware appointments appear on Google with details, and only once', () => {
  const env = setupEnv();
  const appt = env.sw.addAppointment({ start_at: at(24), end_at: at(25), customer_id: 1, vehicle_id: 2, description: 'Drop off, needs Uber to work' });
  env.sw.addAppointment({ start_at: at(-24 * 60), customer_id: 1 }); // far in the past: ignored
  env.run('resetSync(); syncNow()');
  let events = env.cal.user.events(env.shopCal);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, '🔑 DROP-OFF · 🚕 RIDE | Ana Lopez | 2019 Ford F-150');
  assert.match(events[0].description, /VIN: VIN123/);
  assert.equal(events[0].extendedProperties.private.swId, String(appt.id));

  // Running again without changes does not rewrite the event
  const before = env.cal.cals[env.shopCal].events[events[0].id]._seq;
  env.run('syncNow(); reconcileNow()');
  assert.equal(env.cal.cals[env.shopCal].events[events[0].id]._seq, before);

  // A change in Shop-Ware flows through
  env.sw.touch(appt.id, { start_at: at(30), end_at: at(31) });
  env.run('syncNow()');
  events = env.cal.user.events(env.shopCal);
  assert.equal(events[0].start.dateTime, new Date(env.sw.db.appointments[appt.id].start_at).toISOString());
});

test('moving the event or editing its notes in Google updates Shop-Ware', () => {
  const env = setupEnv();
  const appt = env.sw.addAppointment({ start_at: at(24), end_at: at(25), customer_id: 1, description: 'old notes' });
  env.run('resetSync(); syncNow()');
  const ev = env.cal.user.events(env.shopCal)[0];
  const newStart = at(48);
  env.cal.user.edit(env.shopCal, ev.id, {
    start: { dateTime: newStart }, end: { dateTime: at(49) },
    description: ev.description.replace('old notes', 'customer is a WAITER now'),
  });
  env.run('syncNow()');
  const rec = env.sw.db.appointments[appt.id];
  assert.equal(new Date(rec.start_at).toISOString(), newStart);
  assert.equal(rec.description, 'customer is a WAITER now');
  const after = env.cal.user.events(env.shopCal)[0];
  assert.match(after.summary, /WAITER/); // re-rendered from Shop-Ware
  // and it doesn't ping-pong
  const n = env.sw.calls.filter((c) => c.startsWith('PUT')).length;
  env.run('syncNow(); syncNow()');
  assert.equal(env.sw.calls.filter((c) => c.startsWith('PUT')).length, n);
});

test('an event typed into Google becomes a Shop-Ware appointment linked to the customer', () => {
  const env = setupEnv();
  env.cal.user.create(env.shopCal, {
    summary: 'Brake inspection - waiter',
    description: 'Customer: Ana Lopez\nPhone: 555-123-4567\nVehicle: 2019 Ford F-150\nNeeds a ride home',
    start: { dateTime: at(5) }, end: { dateTime: at(6) },
  });
  env.run('syncNow()');
  const appts = Object.values(env.sw.db.appointments);
  assert.equal(appts.length, 1);
  assert.equal(appts[0].customer_id, 1);
  assert.match(appts[0].description, /\[WAITER\] \[NEEDS RIDE\]/);
  // The hand-typed event was replaced by a formatted, linked one
  const events = env.cal.user.events(env.shopCal);
  assert.equal(events.length, 1);
  assert.equal(events[0].extendedProperties.private.swId, String(appts[0].id));
  assert.match(events[0].summary, /WAITER · 🚕 RIDE \| Ana Lopez/);
  // Removing the original event must not have deleted anything in Shop-Ware
  env.run('syncNow()');
  assert.equal(Object.values(env.sw.db.appointments).length, 1);
});

test('unknown customer still creates the appointment and asks you to link it', () => {
  const env = setupEnv();
  env.cal.user.create(env.shopCal, {
    summary: 'New guy tire rotation', description: 'Customer: Bob\nPhone: 555-999-0000',
    start: { dateTime: at(5) }, end: { dateTime: at(6) },
  });
  env.run('syncNow()');
  const appts = Object.values(env.sw.db.appointments);
  assert.equal(appts.length, 1);
  assert.equal(appts[0].customer_id, undefined);
  assert.equal(env.mail.length, 1);
  assert.match(env.mail[0].body, /attach the customer/);
});

test('deleting in Google deletes in Shop-Ware; deleting in Shop-Ware removes from Google', () => {
  const env = setupEnv();
  const a = env.sw.addAppointment({ start_at: at(24), end_at: at(25), customer_id: 1 });
  const b = env.sw.addAppointment({ start_at: at(26), end_at: at(27), customer_id: 1 });
  env.run('resetSync(); syncNow()');
  const evA = env.run(`eventIdFor_('shop', '${a.id}')`);
  env.cal.user.remove(env.shopCal, evA);
  env.run('syncNow()');
  assert.equal(env.sw.db.appointments[a.id], undefined);

  delete env.sw.db.appointments[b.id];
  env.run('reconcileNow(); syncNow(); syncNow()');
  assert.equal(env.cal.user.events(env.shopCal).length, 0);
});

test('cancelled status in Shop-Ware removes the event without deleting the appointment', () => {
  const env = setupEnv();
  const a = env.sw.addAppointment({ start_at: at(24), end_at: at(25), customer_id: 1, status: 'scheduled' });
  env.run('resetSync(); syncNow()');
  env.sw.touch(a.id, { status: 'cancelled' });
  env.run('syncNow(); syncNow()');
  assert.equal(env.cal.user.events(env.shopCal).length, 0);
  assert.ok(env.sw.db.appointments[a.id]);
});

test('filtered calendars only show matching appointments, and removals there do not delete Shop-Ware', () => {
  const env = setupEnv({ configure: salesCalendar });
  const salesCal = env.store.CAL_ID_sales;
  const s = env.sw.addAppointment({ start_at: at(24), end_at: at(25), title: 'Sales: test drive', customer_id: 1 });
  env.sw.addAppointment({ start_at: at(24), end_at: at(25), title: 'Oil change', customer_id: 1 });
  env.run('resetSync(); syncNow()');
  assert.equal(env.cal.user.events(env.shopCal).length, 2);
  assert.equal(env.cal.user.events(salesCal).length, 1);

  // No longer a sales appointment -> leaves the sales calendar only
  env.sw.touch(s.id, { title: 'Test drive' });
  env.run('syncNow(); syncNow()');
  assert.equal(env.cal.user.events(salesCal).length, 0);
  assert.ok(env.sw.db.appointments[s.id]);
  assert.equal(env.cal.user.events(env.shopCal).length, 2);
});

test('event created on the sales calendar stays on the sales calendar', () => {
  const env = setupEnv({ configure: salesCalendar });
  const salesCal = env.store.CAL_ID_sales;
  env.cal.user.create(salesCal, { summary: 'Fleet quote call', description: 'Customer: Ana Lopez\nPhone: 5551234567', start: { dateTime: at(3) }, end: { dateTime: at(4) } });
  env.run('syncNow(); syncNow(); reconcileNow()');
  assert.equal(env.cal.user.events(salesCal).length, 1);
  assert.equal(env.cal.user.events(env.shopCal).length, 1);
  assert.equal(Object.keys(env.sw.db.appointments).length, 1);
});

test('access denied sends one alert, keeps retrying, then reports recovery and catches up', () => {
  const env = setupEnv();
  env.sw.authFail = true;
  const ev = env.cal.user.create(env.shopCal, { summary: 'Made while broken', start: { dateTime: at(3) }, end: { dateTime: at(4) } });
  env.run('syncNow(); syncNow(); syncNow()');
  assert.equal(env.mail.length, 1);
  assert.match(env.mail[0].subject, /Shop-Ware access denied/);
  assert.match(env.mail[0].body, /SHOPWARE_SECRET/);
  assert.equal(Object.keys(env.sw.db.appointments).length, 0);

  env.sw.authFail = false;
  env.run('syncNow()');
  assert.equal(env.mail.length, 2);
  assert.match(env.mail[1].subject, /working again/);
  // The event made during the outage was not lost
  assert.equal(Object.keys(env.sw.db.appointments).length, 1);
  assert.ok(ev);
});

test('missing credentials and stale syncs are reported', () => {
  const env = setupEnv();
  delete env.store.SHOPWARE_SECRET;
  env.run('syncNow()');
  assert.match(env.mail.at(-1).subject, /missing setting/);
  env.store.LAST_SUCCESS_AT = String(Date.now() - 3 * HOUR);
  env.store.ALERT_STALE = '0';
  env.run('healthCheck()');
  assert.match(env.mail.at(-1).subject, /no successful sync in 180 minutes/);
});

test('all-day and repeating Google events are flagged instead of silently ignored', () => {
  const env = setupEnv();
  env.cal.user.create(env.shopCal, { summary: 'Shop closed', start: { date: '2026-12-25' }, end: { date: '2026-12-26' } });
  env.run('syncNow(); syncNow()');
  const ev = env.cal.user.events(env.shopCal)[0];
  assert.match(ev.summary, /^⚠ NOT IN SHOP-WARE/);
  assert.equal(env.mail.length, 1);
  assert.equal(Object.keys(env.sw.db.appointments).length, 0);
});

test('webhook alerts are posted when configured', () => {
  const env = setupEnv();
  env.store.ALERT_WEBHOOK_URL = 'https://chat.example.com/hook';
  env.sw.authFail = true;
  env.run('syncNow()');
  assert.equal(env.webhooks.length, 1);
});

test('Shop-Ware rejecting a new appointment flags the event and sends exactly one email', () => {
  const env = setupEnv();
  env.run("CONFIG.FIELDS.appointment.start = ['wrong_field']");
  env.cal.user.create(env.shopCal, { summary: 'Will fail', start: { dateTime: at(3) }, end: { dateTime: at(4) } });
  env.run('syncNow(); syncNow()');
  assert.equal(env.mail.length, 1);
  assert.match(env.mail[0].body, /HTTP 422/);
  assert.match(env.cal.user.events(env.shopCal)[0].summary, /^⚠ NOT IN SHOP-WARE – Will fail/);
});

test('an expired Google sync token recovers without errors', () => {
  const env = setupEnv();
  env.store.SYNC_TOKEN_shop = 'EXPIRED';
  env.run('syncNow()');
  assert.notEqual(env.store.SYNC_TOKEN_shop, 'EXPIRED');
  assert.equal(env.mail.length, 0);
});
