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
  // Shop-Ware appointments reach the customer and vehicle through the repair order.
  env.sw.db.repair_orders[3] = { id: 3, number: 1234, customer_id: 1, vehicle_id: 2 };
  env.run('setup()');
  env.shopCal = env.store.CAL_ID_shop;
  return env;
}

function deleteInGoogle(env, calId, swId) {
  env.cal.user.remove(calId, env.run(`eventIdFor_('shop', '${swId}')`));
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

test('Shop-Ware appointments appear on Google with RO, customer and vehicle details, and only once', () => {
  const env = setupEnv();
  const appt = env.sw.addAppointment({ start_at: at(24), end_at: at(25), repair_order_id: 3, description: 'Drop off, needs Uber to work' });
  env.sw.addAppointment({ start_at: at(-24 * 60), repair_order_id: 3 }); // far in the past: ignored
  env.run('resetSync(); syncNow()');
  let events = env.cal.user.events(env.shopCal);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, '🔑 DROP-OFF · 🚕 RIDE | Ana Lopez | 2019 Ford F-150');
  assert.match(events[0].description, /VIN: VIN123/);
  assert.match(events[0].description, /RO #: 1234/);
  assert.equal(events[0].extendedProperties.private.swId, String(appt.id));
  // The first run only asks Shop-Ware for recent appointments
  assert.ok(env.sw.calls.some((c) => /appointments\?shop_id=7&start_after=/.test(c)));

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
  const appt = env.sw.addAppointment({ start_at: at(24), end_at: at(25), repair_order_id: 3, description: 'old notes' });
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

test('an event typed into Google becomes a Shop-Ware appointment', () => {
  const env = setupEnv();
  env.cal.user.create(env.shopCal, {
    summary: 'Brake inspection - waiter',
    description: 'Customer: Ana Lopez\nPhone: 555-123-4567\nVehicle: 2019 Ford F-150\nNeeds a ride home',
    start: { dateTime: at(5) }, end: { dateTime: at(6) },
  });
  env.run('syncNow()');
  const appts = Object.values(env.sw.db.appointments);
  assert.equal(appts.length, 1);
  assert.equal(appts[0].shop_id, 7);
  assert.equal(appts[0].title, 'Ana Lopez – Brake inspection - waiter');
  assert.match(appts[0].description, /\[WAITER\] \[NEEDS RIDE\]/);
  assert.match(appts[0].description, /Phone: 555-123-4567/);
  // The hand-typed event was replaced by a formatted, linked one
  const events = env.cal.user.events(env.shopCal);
  assert.equal(events.length, 1);
  assert.equal(events[0].extendedProperties.private.swId, String(appts[0].id));
  assert.match(events[0].summary, /WAITER · 🚕 RIDE \| Ana Lopez – Brake inspection/);
  // Removing the original event must not have touched Shop-Ware
  env.run('syncNow()');
  assert.equal(Object.values(env.sw.db.appointments).length, 1);
  assert.equal(env.mail.length, 0);
});

test('deleting in Google marks the appointment [CANCELLED] in Shop-Ware by default', () => {
  const env = setupEnv();
  const a = env.sw.addAppointment({ start_at: at(24), end_at: at(25), repair_order_id: 3 });
  env.run('resetSync(); syncNow()');
  deleteInGoogle(env, env.shopCal, a.id);
  env.run('syncNow(); syncNow(); reconcileNow()');
  assert.match(env.sw.db.appointments[a.id].title, /^\[CANCELLED\] Ana Lopez/);
  assert.equal(env.cal.user.events(env.shopCal).length, 0); // and it does not come back
});

test('delete behaviours: "delete" removes it, "restore" puts the event back', () => {
  const env = setupEnv({ configure: (C) => { C.GOOGLE_DELETE_BEHAVIOR = 'delete'; } });
  const a = env.sw.addAppointment({ start_at: at(24), end_at: at(25), repair_order_id: 3 });
  env.run('resetSync(); syncNow()');
  deleteInGoogle(env, env.shopCal, a.id);
  env.run('syncNow()');
  assert.equal(env.sw.db.appointments[a.id], undefined);

  const env2 = setupEnv({ configure: (C) => { C.GOOGLE_DELETE_BEHAVIOR = 'restore'; } });
  const b = env2.sw.addAppointment({ start_at: at(24), end_at: at(25), repair_order_id: 3 });
  env2.run('resetSync(); syncNow()');
  deleteInGoogle(env2, env2.shopCal, b.id);
  env2.run('syncNow()');
  assert.ok(env2.sw.db.appointments[b.id]);
  assert.equal(env2.cal.user.events(env2.shopCal).length, 1);
});

test('deleting in Shop-Ware removes the event from Google', () => {
  const env = setupEnv();
  const b = env.sw.addAppointment({ start_at: at(26), end_at: at(27), repair_order_id: 3 });
  env.run('resetSync(); syncNow()');
  delete env.sw.db.appointments[b.id];
  env.run('reconcileNow(); syncNow(); syncNow()');
  assert.equal(env.cal.user.events(env.shopCal).length, 0);
});

test('[CANCELLED] title in Shop-Ware removes the event without deleting the appointment', () => {
  const env = setupEnv();
  const a = env.sw.addAppointment({ start_at: at(24), end_at: at(25), repair_order_id: 3, title: 'Oil change' });
  env.run('resetSync(); syncNow()');
  env.sw.touch(a.id, { title: '[CANCELLED] Oil change' });
  env.run('syncNow(); syncNow()');
  assert.equal(env.cal.user.events(env.shopCal).length, 0);
  assert.ok(env.sw.db.appointments[a.id]);
});

test('safety brake: mass deletion in Google is held back until resumed', () => {
  const env = setupEnv({ configure: (C) => { C.MAX_DELETES_PER_RUN = 2; } });
  const ids = [1, 2, 3, 4, 5].map((h) => env.sw.addAppointment({ start_at: at(24 + h), end_at: at(25 + h), title: 'Job ' + h }).id);
  env.run('resetSync(); syncNow()');
  ids.forEach((id) => deleteInGoogle(env, env.shopCal, id));
  env.run('syncNow(); syncNow()');
  const cancelled = () => ids.filter((id) => /^\[CANCELLED\]/.test(env.sw.db.appointments[id].title)).length;
  assert.equal(cancelled(), 2);
  assert.equal(env.mail.length, 1);
  assert.match(env.mail[0].subject, /deletions paused/);
  assert.match(env.mail[0].body, /resumeDeletes/);
  // Pausing deletions does not stop the rest of the sync, and is not reported as "resolved"
  env.sw.addAppointment({ start_at: at(50), end_at: at(51), title: 'New job' });
  env.run('syncNow()');
  assert.ok(env.cal.user.events(env.shopCal).some((e) => /New job/.test(e.summary)));
  assert.equal(env.mail.length, 1);

  env.run('resumeDeletes()');
  assert.equal(cancelled(), 5);
  assert.equal(env.store.DELETES_PAUSED, undefined);
});

test('safety brake: discarding held deletions brings the events back', () => {
  const env = setupEnv({ configure: (C) => { C.MAX_DELETES_PER_RUN = 1; } });
  const ids = [1, 2, 3].map((h) => env.sw.addAppointment({ start_at: at(24 + h), end_at: at(25 + h), title: 'Job ' + h }).id);
  env.run('resetSync(); syncNow()');
  ids.forEach((id) => deleteInGoogle(env, env.shopCal, id));
  env.run('syncNow(); discardHeldDeletes(); syncNow()');
  const live = ids.filter((id) => !/^\[CANCELLED\]/.test(env.sw.db.appointments[id].title));
  assert.equal(live.length, 2);
  assert.equal(env.cal.user.events(env.shopCal).length, 2);
});

test('safety brake: health check keeps reminding while deletions are paused', () => {
  const env = setupEnv();
  env.store.DELETES_PAUSED = String(Date.now());
  env.store.DEFERRED_DELETES = JSON.stringify([{ kind: 'shopware', swId: '1' }]);
  env.run('healthCheck()');
  assert.match(env.mail.at(-1).subject, /deletions are still paused/);
});

test('appointments from another shop in the same tenant are ignored', () => {
  const env = setupEnv();
  env.sw.addAppointment({ start_at: at(24), end_at: at(25), title: 'Other location', shop_id: 8 });
  env.run('resetSync(); syncNow()');
  assert.equal(env.cal.user.events(env.shopCal).length, 0);
});

test('findShopIds works with only the API keys', () => {
  const env = setupEnv();
  delete env.store.SHOPWARE_TENANT_ID;
  delete env.store.SHOPWARE_SHOP_ID;
  const logs = [];
  env.context.console = { log: (m) => logs.push(m), warn() {}, error() {} };
  env.run('findShopIds()');
  assert.ok(logs.some((l) => /SHOPWARE_TENANT_ID = 42/.test(l)));
  assert.ok(logs.some((l) => /SHOPWARE_SHOP_ID = 7 .*Raising Saints/.test(l)));
  assert.equal(env.store.SHOPWARE_TENANT_ID, undefined);
});

test('filtered calendars only show matching appointments, and removals there do not delete Shop-Ware', () => {
  const env = setupEnv({ configure: salesCalendar });
  const salesCal = env.store.CAL_ID_sales;
  const s = env.sw.addAppointment({ start_at: at(24), end_at: at(25), title: 'Sales: test drive', repair_order_id: 3 });
  env.sw.addAppointment({ start_at: at(24), end_at: at(25), title: 'Oil change', repair_order_id: 3 });
  env.run('resetSync(); syncNow()');
  assert.equal(env.cal.user.events(env.shopCal).length, 2);
  assert.equal(env.cal.user.events(salesCal).length, 1);

  // No longer a sales appointment -> leaves the sales calendar only
  env.sw.touch(s.id, { title: 'Test drive' });
  env.run('syncNow(); syncNow()');
  assert.equal(env.cal.user.events(salesCal).length, 0);
  assert.ok(env.sw.db.appointments[s.id]);
  assert.ok(!/CANCELLED/.test(env.sw.db.appointments[s.id].title));
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
  env.cal.user.create(env.shopCal, { summary: 'Made while broken', start: { dateTime: at(3) }, end: { dateTime: at(4) } });
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
});

test('missing settings and stale syncs are reported', () => {
  const env = setupEnv();
  delete env.store.SHOPWARE_SECRET;
  env.run('syncNow()');
  assert.match(env.mail.at(-1).subject, /missing setting/);

  env.store.SHOPWARE_SECRET = 'secret';
  delete env.store.SHOPWARE_SHOP_ID;
  env.store.ALERT_CONFIG = '0';
  env.run('syncNow()');
  assert.match(env.mail.at(-1).body, /SHOPWARE_SHOP_ID/);

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
