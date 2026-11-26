/**
 * Error classification and "something needs your attention" notifications.
 *
 * Categories:
 *   AUTH        Shop-Ware rejected the credentials / integration disabled (401, 403)
 *   RATE_LIMIT  Shop-Ware is throttling us (429) after retries
 *   SERVER      Shop-Ware is erroring (5xx) after retries
 *   NETWORK     could not reach Shop-Ware at all
 *   GOOGLE      Google Calendar refused something (calendar deleted, access removed...)
 *   CONFIG      a required setting is missing
 *   DATA        one appointment/event could not be synced (others still sync)
 *   STALE       health check: no successful sync for a while
 *   SAFETY      too many deletions at once; deletions paused
 */

function SyncError(category, message, details) {
  this.name = 'SyncError';
  this.category = category;
  this.message = message;
  this.details = details || '';
  this.stack = new Error(message).stack;
}
SyncError.prototype = Object.create(Error.prototype);
SyncError.prototype.constructor = SyncError;

var ALERT_ADVICE = {
  AUTH: 'Shop-Ware rejected the API credentials. The partner id or secret may be wrong or rotated, ' +
    'or the integration may be turned off for your shop.\n\n' +
    'TO FIX: check SHOPWARE_PARTNER_ID, SHOPWARE_SECRET and SHOPWARE_TENANT_ID in Apps Script ' +
    '(Project Settings -> Script Properties), or ask Shop-Ware support whether API access is still enabled. ' +
    'Then run testConnection() from the editor. Sync resumes on its own once access works.',
  RATE_LIMIT: 'Shop-Ware is limiting how often we can call it. The sync keeps retrying. ' +
    'If this keeps happening, raise SYNC_INTERVAL_MINUTES in Config.js.',
  SERVER: 'Shop-Ware is returning server errors. This is usually on their side and temporary. The sync keeps retrying.',
  NETWORK: 'Shop-Ware could not be reached. The sync keeps retrying.',
  GOOGLE: 'Google Calendar refused a request. A synced calendar may have been deleted, or the account ' +
    'running the sync may have lost access.\n\nTO FIX: open the Apps Script project and run setup() again.',
  CONFIG: 'A required setting is missing.\n\nTO FIX: open Apps Script -> Project Settings -> Script Properties and add it, then run testConnection().',
  DATA: 'One appointment could not be synced. Everything else is still syncing.',
  SAFETY: 'TO FIX: open the Apps Script project. If the deletions were intended, run resumeDeletes(). ' +
    'If they were a mistake, run discardHeldDeletes() and the events come back.',
  STALE: 'The sync has not finished successfully for a while, so the calendars may be out of date.\n\n' +
    'TO FIX: open the Apps Script project -> Executions to see the latest error.',
};

function props_() {
  return PropertiesService.getScriptProperties();
}

function alertRecipients_() {
  var configured = props_().getProperty('ALERT_EMAILS');
  if (configured) return configured;
  return Session.getEffectiveUser().getEmail();
}

/**
 * Send an alert at most once per ALERT_REPEAT_HOURS for the same key.
 * Ongoing problems (AUTH, NETWORK...) are remembered so a "resolved" message
 * can follow once things work again.
 */
function notify_(category, subjectDetail, body, key) {
  var p = props_();
  var alertKey = 'ALERT_' + (key || category);
  var last = Number(p.getProperty(alertKey) || 0);
  var now = Date.now();
  if (now - last < CONFIG.ALERT_REPEAT_HOURS * 3600 * 1000) return false;
  p.setProperty(alertKey, String(now));
  if (category !== 'DATA' && category !== 'SAFETY') p.setProperty('OPEN_ISSUE_' + category, String(now));

  var subject = '⚠️ Calendar sync needs attention: ' + subjectDetail;
  var text = [
    (ALERT_ADVICE[category] || ''),
    '',
    'What happened:',
    body,
    '',
    'Category: ' + category,
    'Time: ' + new Date(now).toString(),
    '',
    '— Raising Saints Google Calendar / Shop-Ware sync',
  ].join('\n');
  send_(subject, text);
  return true;
}

/** Called after a fully successful sync: tell people about issues that cleared up. */
function resolveOpenIssues_() {
  var p = props_();
  var all = p.getProperties();
  var resolved = Object.keys(all).filter(function (k) { return k.indexOf('OPEN_ISSUE_') === 0; });
  if (!resolved.length) return;
  resolved.forEach(function (k) {
    p.deleteProperty(k);
    p.deleteProperty('ALERT_' + k.substring('OPEN_ISSUE_'.length));
  });
  var cats = resolved.map(function (k) { return k.substring('OPEN_ISSUE_'.length); });
  send_('✅ Calendar sync is working again',
    'The calendar sync finished successfully again. Resolved: ' + cats.join(', ') + '.\n\n' +
    'Changes made while it was down have now been synced.');
}

function send_(subject, text) {
  try {
    MailApp.sendEmail({ to: alertRecipients_(), subject: subject, body: text });
  } catch (e) {
    console.error('Could not send alert email: ' + e);
  }
  var hook = props_().getProperty('ALERT_WEBHOOK_URL');
  if (hook) {
    try {
      UrlFetchApp.fetch(hook, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ text: '*' + subject + '*\n' + text }), muteHttpExceptions: true,
      });
    } catch (e) {
      console.error('Could not post alert webhook: ' + e);
    }
  }
}

/** Turn any thrown error into a SyncError. */
function classifyError_(e) {
  if (e instanceof SyncError) return e;
  var msg = String((e && e.message) || e);
  // Advanced Calendar service errors look like:
  // "GoogleJsonResponseException: API call to calendar.events.insert failed with error: Not Found"
  if (/API call to calendar\./i.test(msg) || /CalendarApp|calendar.*(not found|forbidden|permission)/i.test(msg)) {
    return new SyncError('GOOGLE', msg);
  }
  if (/address unavailable|dns error|timed out|timeout|exception: unexpected error/i.test(msg)) {
    return new SyncError('NETWORK', msg);
  }
  return new SyncError('SERVER', msg, (e && e.stack) || '');
}

/** Errors that stop the whole run. */
function handleFatal_(e) {
  var err = classifyError_(e);
  console.error('[' + err.category + '] ' + err.message + (err.details ? '\n' + err.details : ''));
  var subjects = {
    AUTH: 'Shop-Ware access denied', RATE_LIMIT: 'Shop-Ware rate limit', SERVER: 'sync error',
    NETWORK: 'cannot reach Shop-Ware', GOOGLE: 'Google Calendar access problem', CONFIG: 'missing setting',
  };
  notify_(err.category, subjects[err.category] || err.category, err.message + (err.details ? '\n\n' + err.details : ''));
  // Record failure for the health check.
  props_().setProperty('LAST_ERROR', '[' + err.category + '] ' + err.message);
  props_().setProperty('LAST_ERROR_AT', String(Date.now()));
}

/** Errors for a single record — logged and alerted, but the run continues. */
function handleItemError_(what, key, e) {
  var err = classifyError_(e);
  if (err.category === 'AUTH' || err.category === 'NETWORK' || err.category === 'RATE_LIMIT') throw err;
  console.warn('Item failed (' + what + '): ' + err.message);
  if (err.alreadyNotified) return;
  notify_('DATA', what, err.message, 'DATA_' + key);
}

/**
 * Trigger: runs hourly. Alerts if no sync has succeeded recently. This catches
 * failures that stop syncNow() before it can report anything itself.
 */
function healthCheck() {
  var p = props_();
  var last = Number(p.getProperty('LAST_SUCCESS_AT') || 0);
  var ageMin = (Date.now() - last) / 60000;
  if (!last || ageMin > CONFIG.STALE_SYNC_ALERT_MINUTES) {
    var lastErr = p.getProperty('LAST_ERROR') || 'none recorded';
    notify_('STALE', 'no successful sync in ' + (last ? Math.round(ageMin) + ' minutes' : 'a long time'),
      'Last successful sync: ' + (last ? new Date(last).toString() : 'never') +
      '\nLast recorded error: ' + lastErr);
  }
  if (p.getProperty('DELETES_PAUSED')) {
    var held = JSON.parse(p.getProperty('DEFERRED_DELETES') || '[]');
    notify_('SAFETY', 'deletions are still paused',
      held.length + ' deletion(s) are waiting for you to review.', 'SAFETY_REMINDER');
  }
  var triggers = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'syncNow'; });
  if (!triggers.length) {
    notify_('CONFIG', 'sync schedule is missing', 'The timed trigger for syncNow() is missing. Run setup() again.', 'NO_TRIGGER');
  }
}
