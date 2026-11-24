/**
 * One-time setup and maintenance helpers. Run these from the Apps Script
 * editor (choose the function in the toolbar, then click Run).
 */

/** Creates the calendars, shares them, installs the timers and runs a first sync. Safe to re-run. */
function setup() {
  swCredentials_(); // throws a clear error if Script Properties are missing
  var p = props_();
  CONFIG.CALENDARS.forEach(function (cfg) {
    if (!/^[a-z0-9]+$/.test(cfg.key)) throw new Error('Calendar key "' + cfg.key + '" must be lowercase letters/numbers only.');
    var id = p.getProperty('CAL_ID_' + cfg.key);
    var cal = id ? CalendarApp.getCalendarById(id) : null;
    if (!cal) {
      cal = CalendarApp.createCalendar(cfg.name, {
        summary: 'Synced automatically with Shop-Ware. ' +
          (cfg.twoWay ? 'Events you add or change here are sent to Shop-Ware.' : 'Read-only copy of Shop-Ware.'),
        timeZone: Session.getScriptTimeZone(),
      });
      p.setProperty('CAL_ID_' + cfg.key, cal.getId());
      console.log('Created calendar "' + cfg.name + '"');
    } else if (cal.getName() !== cfg.name) {
      cal.setName(cfg.name);
    }
    shareCalendar_(cfg, cal.getId());
  });
  installTriggers_();
  console.log(testConnection());
  syncNow();
  console.log('Setup complete. Last error (if any): ' + (p.getProperty('LAST_ERROR') || 'none'));
}

/** Give each shareWith person/group access. Does not remove anyone. */
function shareCalendar_(cfg, calId) {
  var existing = {};
  (Calendar.Acl.list(calId).items || []).forEach(function (rule) {
    if (rule.scope && rule.scope.value) existing[rule.scope.value.toLowerCase()] = rule.role;
  });
  (cfg.shareWith || []).forEach(function (s) {
    var email = String(s.email || '').trim();
    if (!email) return;
    var role = s.role || 'reader';
    if (existing[email.toLowerCase()] === role) return;
    Calendar.Acl.insert({ role: role, scope: { type: s.type || 'user', value: email } }, calId, { sendNotifications: true });
    console.log('Shared "' + cfg.name + '" with ' + email + ' as ' + role);
  });
}

/** Stop sharing a calendar with someone: removeShare('sales', 'person@example.com') */
function removeShare(calendarKey, email) {
  var calId = props_().getProperty('CAL_ID_' + calendarKey);
  (Calendar.Acl.list(calId).items || []).forEach(function (rule) {
    if (rule.scope && rule.scope.value && rule.scope.value.toLowerCase() === email.toLowerCase()) {
      Calendar.Acl.remove(calId, rule.id);
      console.log('Removed ' + email + ' from ' + calendarKey);
    }
  });
}

function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['syncNow', 'healthCheck'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(CONFIG.SYNC_INTERVAL_MINUTES).create();
  ScriptApp.newTrigger('healthCheck').timeBased().everyHours(1).create();
}

/** Checks the Shop-Ware credentials. Returns a human-readable result. */
function testConnection() {
  var body = swRequest_('get', CONFIG.PATHS.appointments, { query: { page: 1, per_page: 1 } });
  var msg = 'Shop-Ware connection OK (' + listResults_(body).length + ' appointment(s) on the first page).';
  console.log(msg);
  return msg;
}

/** Sends a test alert so you know notifications reach you. */
function sendTestAlert() {
  send_('🔔 Test alert from the calendar sync',
    'Alerts from the Google Calendar / Shop-Ware sync will arrive like this.\nRecipients: ' + alertRecipients_());
}

/**
 * Logs the raw JSON of a recent appointment with its customer and vehicle, so
 * you can check the names in CONFIG.FIELDS against what Shop-Ware returns.
 * Look for the waiter / drop-off / ride fields in particular.
 */
function debugDumpAppointment() {
  var A = CONFIG.FIELDS.appointment;
  var list = listResults_(swRequest_('get', CONFIG.PATHS.appointments, { query: { page: 1, per_page: 5 } }));
  if (!list.length) { console.log('No appointments returned.'); return; }
  var appt = list[list.length - 1];
  console.log('APPOINTMENT:\n' + JSON.stringify(appt, null, 2));
  var cid = pickField_(appt, A.customerId);
  var vid = pickField_(appt, A.vehicleId);
  if (cid) console.log('CUSTOMER:\n' + JSON.stringify(swRequest_('get', CONFIG.PATHS.customers + '/' + cid, { allow404: true }), null, 2));
  if (vid) console.log('VEHICLE:\n' + JSON.stringify(swRequest_('get', CONFIG.PATHS.vehicles + '/' + vid, { allow404: true }), null, 2));
  console.log('RENDERED EVENT:\n' + JSON.stringify(renderEvent_(swLoadView_(appt)), null, 2));
}

/** Forces a complete re-sync on the next run (e.g. after changing CONFIG.FIELDS or filters). */
function resetSync() {
  var p = props_();
  Object.keys(p.getProperties()).forEach(function (k) {
    if (k.indexOf('SYNC_TOKEN_') === 0 || k === 'SW_LAST_PULL_AT' || k === 'RECONCILE_AT') p.deleteProperty(k);
  });
  console.log('Sync state cleared. The next run re-reads everything from Shop-Ware.');
}

/** Refresh every synced event right now (also picks up filter changes). */
function reconcileNow() {
  maybeReconcile_(configuredCalendars_(), true);
}
