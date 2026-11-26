/**
 * In-memory fakes for the Apps Script globals the sync uses (Calendar advanced
 * service, CalendarApp, UrlFetchApp, PropertiesService, ...) plus a fake
 * Shop-Ware API, so the real src/ files can be exercised in Node.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');
const FILES = ['Config.js', 'Format.js', 'Alerts.js', 'ShopWare.js', 'Sync.js', 'Setup.js'];

function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }

function notFound(op) {
  return new Error('GoogleJsonResponseException: API call to calendar.events.' + op + ' failed with error: Not Found');
}

function makeCalendar() {
  const cals = {}; // calId -> { events: {id: ev}, acl: [] }
  let seq = 0;
  let autoId = 0;
  function cal(calId) {
    if (!cals[calId]) throw new Error('API call to calendar.events.list failed with error: Not Found');
    return cals[calId];
  }
  function touch(ev) { ev._seq = ++seq; ev.updated = new Date().toISOString(); return ev; }
  function out(ev) { const c = clone(ev); delete c._seq; return c; }
  const Events = {
    get(calId, id) {
      const ev = cal(calId).events[id];
      if (!ev) throw notFound('get');
      return out(ev);
    },
    insert(body, calId) {
      const c = cal(calId);
      const id = body.id || 'g' + (++autoId) + 'random_user_event';
      if (c.events[id]) throw new Error('API call to calendar.events.insert failed with error: The requested identifier already exists.');
      if (body.id && !/^[0-9a-v]{5,1024}$/.test(body.id)) throw new Error('API call to calendar.events.insert failed with error: Invalid resource id value.');
      const ev = touch(Object.assign({ status: 'confirmed' }, clone(body), { id, htmlLink: 'https://calendar.google.com/event?eid=' + id }));
      c.events[id] = ev;
      return out(ev);
    },
    update(body, calId, id) {
      const c = cal(calId);
      if (!c.events[id]) throw notFound('update');
      c.events[id] = touch(Object.assign({ status: 'confirmed' }, clone(body), { id, htmlLink: c.events[id].htmlLink }));
      return out(c.events[id]);
    },
    patch(body, calId, id) {
      const c = cal(calId);
      if (!c.events[id]) throw notFound('patch');
      c.events[id] = touch(Object.assign(c.events[id], clone(body)));
      return out(c.events[id]);
    },
    remove(calId, id) {
      const c = cal(calId);
      const ev = c.events[id];
      if (!ev || ev.status === 'cancelled') throw new Error('API call to calendar.events.delete failed with error: Resource has been deleted');
      // Like Google: a deleted event comes back in sync results with only id + status.
      c.events[id] = touch({ id, status: 'cancelled' });
    },
    list(calId, opts) {
      const c = cal(calId);
      let items = Object.values(c.events);
      if (opts.syncToken) {
        if (opts.syncToken === 'EXPIRED') throw new Error('API call to calendar.events.list failed with error: Sync token is no longer valid, a full sync is required.');
        items = items.filter((e) => e._seq > Number(opts.syncToken));
      } else {
        if (!opts.showDeleted) items = items.filter((e) => e.status !== 'cancelled');
        if (opts.privateExtendedProperty) {
          const [k, v] = opts.privateExtendedProperty.split('=');
          items = items.filter((e) => e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private[k] === v);
        }
        if (opts.timeMin) items = items.filter((e) => e.end && new Date(e.end.dateTime || e.end.date) >= new Date(opts.timeMin));
      }
      return { items: items.map(out), nextSyncToken: String(seq) };
    },
  };
  const Acl = {
    list(calId) { return { items: clone(cal(calId).acl) }; },
    insert(rule, calId) { cal(calId).acl.push(Object.assign({ id: 'acl' + cal(calId).acl.length }, clone(rule))); },
    remove(calId, ruleId) { cal(calId).acl = cal(calId).acl.filter((r) => r.id !== ruleId); },
  };
  const CalendarApp = {
    createCalendar(name) {
      const id = 'cal' + Object.keys(cals).length + '@group.calendar.google.com';
      cals[id] = { name, events: {}, acl: [] };
      return CalendarApp.getCalendarById(id);
    },
    getCalendarById(id) {
      if (!cals[id]) return null;
      return { getId: () => id, getName: () => cals[id].name, setName: (n) => { cals[id].name = n; } };
    },
  };
  // Helpers for tests: act like a person using Google Calendar.
  const user = {
    events(calId) { return Object.values(cal(calId).events).filter((e) => e.status !== 'cancelled').map(out); },
    create(calId, body) { return Events.insert(body, calId); },
    edit(calId, id, changes) { return Events.patch(changes, calId, id); },
    remove(calId, id) { return Events.remove(calId, id); },
  };
  return { Calendar: { Events, Acl }, CalendarApp, cals, user };
}

// Appointment fields allowed on writes, per Shop-Ware's v1 spec.
const APPT_WRITABLE = ['shop_id', 'staff_id', 'repair_order_id', 'title', 'description', 'start_at', 'end_at', 'integrator_tags'];

function makeShopware() {
  const db = { appointments: {}, customers: {}, vehicles: {}, repair_orders: {}, staffs: {}, shops: { 7: { id: 7, name: 'Raising Saints', time_zone: 'America/Denver' } } };
  let nextId = 1000;
  const sw = {
    db,
    calls: [],
    authFail: false,
    // Behaves like Shop-Ware's REST API; returns [status, bodyObject].
    handle(method, url, payload, headers) {
      const u = new URL(url);
      if (u.pathname === '/api/v1/tenants') {
        sw.calls.push('GET /api/v1/tenants');
        if (sw.authFail || headers['X-Api-Secret'] !== 'secret') return [401, {}];
        return [200, { results: [{ id: 42, name: 'Raising Saints Auto' }] }];
      }
      const m = u.pathname.match(/^\/api\/v1\/tenants\/([^/]+)\/([a-z_]+)(?:\/([^/]+))?$/);
      sw.calls.push(method.toUpperCase() + ' ' + u.pathname + u.search);
      if (sw.authFail || headers['X-Api-Secret'] !== 'secret') return [401, { error: 'Unauthorized' }];
      if (!m) return [404, {}];
      const [, , coll, id] = m;
      const table = db[coll];
      if (!table) return [404, {}];
      const now = new Date().toISOString();
      if (method === 'get' && !id) {
        let rows = Object.values(table);
        const q = u.searchParams;
        if (q.get('shop_id') && coll === 'appointments') rows = rows.filter((r) => String(r.shop_id) === q.get('shop_id'));
        if (q.get('start_after')) rows = rows.filter((r) => r.start_at >= q.get('start_after'));
        if (q.get('updated_after')) rows = rows.filter((r) => !r.updated_at || r.updated_at >= q.get('updated_after'));
        if (q.get('phone')) rows = rows.filter((r) => JSON.stringify(r.phones || []).replace(/\D/g, '').includes(q.get('phone').replace(/\D/g, '')));
        if (q.get('email')) rows = rows.filter((r) => JSON.stringify(r.emails || []).includes(q.get('email')));
        const per = Number(q.get('per_page') || 30);
        const page = Number(q.get('page') || 1);
        return [200, { results: rows.slice((page - 1) * per, page * per), total_count: rows.length, total_pages: Math.max(1, Math.ceil(rows.length / per)), current_page: page }];
      }
      if (method === 'get') return table[id] ? [200, clone(table[id])] : [404, {}];
      if (method === 'post') {
        const body = JSON.parse(payload);
        if (coll === 'appointments') {
          const bad = Object.keys(body).filter((k) => !APPT_WRITABLE.includes(k));
          if (bad.length) return [422, { errors: ['unknown fields: ' + bad.join(', ')] }];
          if (!body.shop_id || !body.start_at) return [422, { errors: ['shop_id and start_at required'] }];
          if (!body.title && !body.repair_order_id) return [422, { errors: ['title or repair_order_id required'] }];
        }
        const rec = Object.assign({ id: nextId++ }, body, { created_at: now, updated_at: now });
        table[rec.id] = rec;
        return [201, clone(rec)];
      }
      if (method === 'put') {
        if (!table[id]) return [404, {}];
        const upd = JSON.parse(payload);
        const badU = Object.keys(upd).filter((k) => !APPT_WRITABLE.includes(k));
        if (coll === 'appointments' && badU.length) return [422, { errors: ['unknown fields: ' + badU.join(', ')] }];
        Object.assign(table[id], upd, { updated_at: now });
        return [200, clone(table[id])];
      }
      if (method === 'delete') {
        if (!table[id]) return [404, {}];
        delete table[id];
        return [204, null];
      }
      return [405, {}];
    },
    // Helpers for tests: act like someone using Shop-Ware.
    addAppointment(fields) {
      const now = new Date().toISOString();
      const rec = Object.assign({ id: nextId++, shop_id: 7, created_at: now, updated_at: now }, fields);
      db.appointments[rec.id] = rec;
      return rec;
    },
    touch(id, fields) {
      Object.assign(db.appointments[id], fields, { updated_at: new Date(Date.now() + 1000).toISOString() });
    },
  };
  return sw;
}

function makeEnv(opts = {}) {
  const cal = makeCalendar();
  const sw = makeShopware();
  const store = {};
  const cache = {};
  const mail = [];
  const triggers = [];
  const webhooks = [];
  const Properties = {
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty: (k, v) => { store[k] = String(v); },
    deleteProperty: (k) => { delete store[k]; },
    getProperties: () => Object.assign({}, store),
  };
  const context = {
    console: opts.verbose ? console : { log() {}, warn() {}, error() {} },
    Calendar: cal.Calendar,
    CalendarApp: cal.CalendarApp,
    PropertiesService: { getScriptProperties: () => Properties },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cache ? cache[k] : null),
        put: (k, v) => { cache[k] = v; },
        removeAll: (ks) => ks.forEach((k) => delete cache[k]),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    MailApp: { sendEmail: (m) => mail.push(m) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.com' }), getScriptTimeZone: () => 'America/Chicago' },
    Utilities: { sleep() {} },
    ScriptApp: {
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1),
      newTrigger: (fn) => {
        const b = { timeBased: () => b, everyMinutes: () => b, everyHours: () => b, create: () => { const t = { getHandlerFunction: () => fn }; triggers.push(t); return t; } };
        return b;
      },
    },
    UrlFetchApp: {
      fetch(url, params) {
        if (!url.startsWith('https://api.shop-ware.com/')) {
          webhooks.push({ url, payload: params.payload });
          return { getResponseCode: () => 200, getContentText: () => 'ok', getAllHeaders: () => ({}) };
        }
        const [code, body] = sw.handle(params.method || 'get', url, params.payload, params.headers || {});
        return {
          getResponseCode: () => code,
          getContentText: () => (body === null ? '' : JSON.stringify(body)),
          getAllHeaders: () => ({}),
        };
      },
    },
  };
  vm.createContext(context);
  for (const f of FILES) vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), context, { filename: f });
  if (opts.configure) vm.runInContext('(' + opts.configure.toString() + ')(CONFIG)', context);
  if (opts.credentials !== false) {
    store.SHOPWARE_PARTNER_ID = 'partner';
    store.SHOPWARE_SECRET = 'secret';
    store.SHOPWARE_TENANT_ID = '42';
    store.SHOPWARE_SHOP_ID = '7';
  }
  const run = (code) => vm.runInContext(code, context);
  return { context, run, cal, sw, store, mail, triggers, webhooks };
}

module.exports = { makeEnv };
