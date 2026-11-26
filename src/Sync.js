/**
 * The sync engine. syncNow() runs on a timer (see Setup.js) and does:
 *   1. Google -> Shop-Ware: events created / moved / edited / deleted on
 *      two-way calendars since the last run (Google sync tokens).
 *   2. Shop-Ware -> Google: appointments changed since the last run.
 *   3. Hourly: re-check every upcoming synced event against Shop-Ware, removing
 *      ones deleted there and refreshing customer/vehicle details.
 *
 * Deletions are rate-limited per run (CONFIG.MAX_DELETES_PER_RUN). Past the
 * limit they are held back, you get an alert, and resumeDeletes() applies them.
 */

var MANAGED_PREFIX_ERROR = '⚠ NOT IN SHOP-WARE – ';
var deleteBudget_ = null; // reset at the start of every run

function syncNow() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.log('Another sync is still running; skipping this run.');
    return;
  }
  try {
    swCredentials_(); // fail fast on missing config
    deleteBudget_ = CONFIG.MAX_DELETES_PER_RUN;
    var cals = configuredCalendars_();
    pushGoogleChanges_(cals);
    pullShopwareChanges_(cals);
    maybeReconcile_(cals);
    pruneSuppressions_();
    props_().setProperty('LAST_SUCCESS_AT', String(Date.now()));
    resolveOpenIssues_();
  } catch (e) {
    handleFatal_(e);
  } finally {
    lock.releaseLock();
  }
}

/** [{cfg, id}] for every calendar in CONFIG.CALENDARS. */
function configuredCalendars_() {
  var p = props_();
  return CONFIG.CALENDARS.map(function (cfg) {
    var id = p.getProperty('CAL_ID_' + cfg.key);
    if (!id) throw new SyncError('CONFIG', 'Calendar "' + cfg.name + '" has not been created yet. Run setup().');
    return { cfg: cfg, id: id };
  });
}

// ---------------------------------------------------------------------------
// Google Calendar helpers
// ---------------------------------------------------------------------------

function isNotFound_(e) {
  return /not found|404|410|has been deleted|resource has been deleted/i.test(String((e && e.message) || e));
}

function getEvent_(calId, eventId) {
  try {
    return Calendar.Events.get(calId, eventId);
  } catch (e) {
    if (isNotFound_(e)) return null;
    throw e;
  }
}

/**
 * Deletions we make ourselves must not be mistaken for a person deleting the
 * event (which would delete the Shop-Ware appointment). Stored durably in
 * Script Properties, pruned after 3 days.
 */
function suppressKey_(calId, eventId) {
  return 'SKIPDEL_' + hash_(calId + '|' + eventId) + '_' + hash_(eventId + '|' + calId);
}

function suppressDeletion_(calId, eventId) {
  props_().setProperty(suppressKey_(calId, eventId), String(Date.now()));
}

function isSuppressed_(calId, eventId) {
  return !!props_().getProperty(suppressKey_(calId, eventId));
}

function pruneSuppressions_() {
  var p = props_();
  var all = p.getProperties();
  var cutoff = Date.now() - 3 * 86400000;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('SKIPDEL_') === 0 && Number(all[k]) < cutoff) p.deleteProperty(k);
  });
}

function deleteOurEvent_(calId, eventId) {
  suppressDeletion_(calId, eventId);
  try {
    Calendar.Events.remove(calId, eventId);
  } catch (e) {
    if (!isNotFound_(e)) throw e;
  }
}

function removeFromAllCalendars_(cals, swId) {
  cals.forEach(function (c) {
    var eventId = eventIdFor_(c.cfg.key, swId);
    var existing = getEvent_(c.id, eventId);
    if (existing && existing.status !== 'cancelled') deleteOurEvent_(c.id, eventId);
  });
}

function inWindow_(view) {
  var now = Date.now();
  var start = new Date(view.start).getTime();
  var end = view.end ? new Date(view.end).getTime() : start;
  return end >= now - CONFIG.SYNC_PAST_DAYS * 86400000 && start <= now + CONFIG.SYNC_FUTURE_DAYS * 86400000;
}

/** Was this appointment created from the given Google calendar? */
function createdFromCalendar_(view, cfg) {
  return view.notes.indexOf('(Created from Google Calendar: ' + cfg.name + ')') !== -1;
}

function calendarWants_(cfg, view) {
  if (view.cancelled) return false;
  if (!cfg.filter || createdFromCalendar_(view, cfg)) return true;
  try {
    return !!cfg.filter(view);
  } catch (e) {
    throw new SyncError('CONFIG', 'The filter for calendar "' + cfg.name + '" crashed: ' + e);
  }
}

/** Create, update or remove this appointment's event on every calendar. */
function upsertAppointment_(cals, view) {
  if (!view.start || isNaN(new Date(view.start).getTime())) {
    throw new SyncError('DATA', 'Shop-Ware appointment #' + view.id + ' has no usable start time.');
  }
  cals.forEach(function (c) {
    var eventId = eventIdFor_(c.cfg.key, view.id);
    var existing = getEvent_(c.id, eventId);
    var live = existing && existing.status !== 'cancelled';

    if (!calendarWants_(c.cfg, view)) {
      if (live) deleteOurEvent_(c.id, eventId);
      return;
    }
    // Don't create events for appointments outside the window; leave old ones alone.
    if (!live && !inWindow_(view)) return;
    // A Google deletion held by the safety brake stays deleted until resumed/discarded.
    if (!live && existing && isDeletionHeld_(view.id)) return;

    var body = renderEvent_(view);
    var fp = eventFingerprint_(body);
    if (live) {
      var priv = (existing.extendedProperties && existing.extendedProperties.private) || {};
      if (priv.swHash === fp && eventFingerprint_(existing) === fp &&
          (existing.colorId || null) === (body.colorId || null)) {
        return; // already up to date
      }
    }
    body.status = 'confirmed';
    body.extendedProperties = { private: { swId: view.id, swHash: fp, swManaged: '1' } };
    if (existing) {
      // Also revives an event that was deleted (ids can't be re-inserted).
      Calendar.Events.update(body, c.id, eventId);
    } else {
      body.id = eventId;
      Calendar.Events.insert(body, c.id);
    }
  });
}

// ---------------------------------------------------------------------------
// 1. Google -> Shop-Ware
// ---------------------------------------------------------------------------

function initialSyncToken_(calId) {
  var pageToken, resp;
  do {
    resp = Calendar.Events.list(calId, { maxResults: 250, pageToken: pageToken, showDeleted: true });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return resp.nextSyncToken;
}

function pushGoogleChanges_(cals) {
  var p = props_();
  cals.forEach(function (c) {
    if (!c.cfg.twoWay) return;
    var tokenKey = 'SYNC_TOKEN_' + c.cfg.key;
    var token = p.getProperty(tokenKey);
    if (!token) {
      // First run for this calendar: start watching from now.
      p.setProperty(tokenKey, initialSyncToken_(c.id));
      return;
    }
    var items = [];
    var pageToken, resp;
    try {
      do {
        resp = Calendar.Events.list(c.id, { syncToken: token, pageToken: pageToken, showDeleted: true, maxResults: 250 });
        items = items.concat(resp.items || []);
        pageToken = resp.nextPageToken;
      } while (pageToken);
    } catch (e) {
      if (/410|sync token|full sync/i.test(String(e.message || e))) {
        // Google expired the token. Re-baseline; the hourly reconcile covers the gap.
        console.warn('Sync token expired for ' + c.cfg.name + '; resetting.');
        p.setProperty(tokenKey, initialSyncToken_(c.id));
        return;
      }
      throw e;
    }
    items.forEach(function (ev) {
      try {
        handleGoogleEvent_(cals, c, ev);
      } catch (e) {
        handleItemError_('Google event "' + (ev.summary || ev.id) + '" on ' + c.cfg.name, 'G_' + ev.id, e);
      }
    });
    // Saved only after every change was handled, so a fatal error (e.g. Shop-Ware
    // access denied) means these changes are retried on the next run.
    p.setProperty(tokenKey, resp.nextSyncToken);
  });
}

function handleGoogleEvent_(cals, c, ev) {
  var parsedId = parseEventId_(ev.id);
  var priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  var swId = parsedId ? parsedId.shopwareId : priv.swId;

  if (ev.status === 'cancelled') {
    if (isSuppressed_(c.id, ev.id) || !swId) return;
    var appt = swGetAppointment_(swId);
    if (!appt || buildView_(appt).cancelled) {
      removeFromAllCalendars_(cals, swId);
      return;
    }
    if (CONFIG.GOOGLE_DELETE_BEHAVIOR === 'restore') {
      upsertAppointment_(cals, swLoadView_(appt)); // put it back; Shop-Ware decides
      return;
    }
    if (!takeDeleteBudget_({ kind: 'google', calId: c.id, eventId: ev.id, swId: swId })) return;
    applyGoogleDeletion_(cals, swId, appt);
    return;
  }

  var fp = eventFingerprint_(ev);
  if (priv.swHash === fp) return; // our own write, or nothing a person changed

  if (ev.recurrence || ev.recurringEventId) {
    return markEventProblem_(c, ev, 'Repeating events are not supported. Create each appointment separately.');
  }
  if (!ev.start || !ev.start.dateTime) {
    return markEventProblem_(c, ev, 'All-day events cannot become Shop-Ware appointments. Give the event a start and end time.');
  }

  if (swId) pushEdit_(cals, ev, swId);
  else pushCreate_(cals, c, ev);
}

/** First candidate field name present on the record (else the first candidate). */
function fieldName_(rec, names) {
  for (var i = 0; i < names.length; i++) {
    if (rec && Object.prototype.hasOwnProperty.call(rec, names[i])) return names[i];
  }
  return names[0];
}

/** A synced event was moved or its notes edited in Google. */
function pushEdit_(cals, ev, swId) {
  var A = CONFIG.FIELDS.appointment;
  var appt = swGetAppointment_(swId);
  if (!appt) {
    removeFromAllCalendars_(cals, swId); // gone in Shop-Ware
    return;
  }
  var body = {};
  var newStart = new Date(ev.start.dateTime).toISOString();
  var newEnd = new Date(ev.end.dateTime).toISOString();
  var curStart = pickField_(appt, A.start);
  var curEnd = pickField_(appt, A.end);
  if (!curStart || new Date(curStart).toISOString() !== newStart) body[fieldName_(appt, A.start)] = newStart;
  if (!curEnd || new Date(curEnd).toISOString() !== newEnd) body[fieldName_(appt, A.end)] = newEnd;
  var notes = extractNotes_(stripHtml_(ev.description));
  if (notes !== null && notes !== String(pickField_(appt, A.notes) || '').replace(/\s+$/, '')) {
    body[fieldName_(appt, A.notes)] = notes;
  }
  if (Object.keys(body).length) {
    swUpdateAppointment_(swId, body);
    console.log('Updated Shop-Ware appointment #' + swId + ' from Google: ' + Object.keys(body).join(', '));
  }
  // Re-render from Shop-Ware so every calendar shows the same thing.
  var fresh = swGetAppointment_(swId) || Object.assign({}, appt, body);
  upsertAppointment_(cals, swLoadView_(fresh));
}

/** Someone typed a new event into a two-way Google calendar. */
function pushCreate_(cals, c, ev) {
  var A = CONFIG.FIELDS.appointment;
  var summary = String(ev.summary || '').replace(MANAGED_PREFIX_ERROR, '');
  var parsed = parseEventText_(summary, ev.description);
  try {
    // Shop-Ware appointments have no customer field (only a repair order), so
    // the customer goes in the title and notes for the front desk to see.
    var title = summary || 'Appointment';
    var cust = parsed.fields.customer;
    if (cust && title.toLowerCase().indexOf(cust.toLowerCase()) === -1) title = cust + ' – ' + title;
    var body = {};
    body[A.start[0]] = new Date(ev.start.dateTime).toISOString();
    body[A.end[0]] = new Date(ev.end.dateTime).toISOString();
    body[A.title[0]] = title;
    body[A.notes[0]] = composeShopwareNotes_(parsed).replace(
      '(Created from Google Calendar)', '(Created from Google Calendar: ' + c.cfg.name + ')');

    var created = swCreateAppointment_(body);
    var newId = pickField_(created, A.id);
    if (newId === undefined) throw new SyncError('DATA', 'Shop-Ware did not return an id for the new appointment.');
    console.log('Created Shop-Ware appointment #' + newId + ' from Google event ' + ev.id);

    var fresh = swGetAppointment_(newId) || created;
    upsertAppointment_(cals, swLoadView_(fresh));
    // Replace the hand-typed event with the managed one just created.
    deleteOurEvent_(c.id, ev.id);
  } catch (e) {
    var err = classifyError_(e);
    if (err.category === 'DATA') {
      markEventProblem_(c, ev, err.message);
      err.alreadyNotified = true;
    }
    throw err;
  }
}

/**
 * Flag an event that couldn't sync: prefix its title and alert. Its stored
 * fingerprint is updated so it isn't retried until someone edits it again.
 */
function markEventProblem_(c, ev, reason) {
  var summary = String(ev.summary || '');
  if (summary.indexOf(MANAGED_PREFIX_ERROR) !== 0) summary = MANAGED_PREFIX_ERROR + summary;
  var patched = { summary: summary, description: ev.description, start: ev.start, end: ev.end };
  var priv = Object.assign({}, (ev.extendedProperties && ev.extendedProperties.private) || {});
  priv.swHash = eventFingerprint_(patched);
  priv.swError = String(reason).substring(0, 500);
  Calendar.Events.patch({ summary: summary, extendedProperties: { private: priv } }, c.id, ev.id);
  notify_('DATA', 'event not added to Shop-Ware',
    'The event "' + (ev.summary || '') + '" on the "' + c.cfg.name + '" calendar could not be synced:\n' + reason +
    '\n\nFix the event (any edit makes it retry): ' + (ev.htmlLink || ''), 'MARK_' + ev.id);
}

// ---------------------------------------------------------------------------
// 2. Shop-Ware -> Google
// ---------------------------------------------------------------------------

function pullShopwareChanges_(cals) {
  var p = props_();
  var runStart = Date.now();
  var last = Number(p.getProperty('SW_LAST_PULL_AT') || 0);
  var A = CONFIG.FIELDS.appointment;
  var query = {};
  var since = null;
  if (last) {
    since = new Date(last - 2 * 60000); // overlap protects against clock skew
    query[CONFIG.UPDATED_SINCE_PARAM] = since.toISOString();
  } else {
    // First run: only appointments from SYNC_PAST_DAYS ago onwards, not all history.
    query[CONFIG.START_AFTER_PARAM] = new Date(Date.now() - CONFIG.SYNC_PAST_DAYS * 86400000).toISOString();
  }
  var appts = swListAll_(CONFIG.PATHS.appointments, query);
  var count = 0;
  appts.forEach(function (appt) {
    if (isOtherShop_(appt)) return;
    if (since) {
      var updated = pickField_(appt, A.updatedAt);
      if (updated && new Date(updated) < since) return;
    } else {
      // First full pull: skip appointments outside the window before loading details.
      var start = pickField_(appt, A.start);
      if (!start || !inWindow_({ start: start, end: pickField_(appt, A.end) })) return;
    }
    var id = pickField_(appt, A.id);
    try {
      upsertAppointment_(cals, swLoadView_(appt));
      count++;
    } catch (e) {
      handleItemError_('Shop-Ware appointment #' + id, 'SW_' + id, e);
    }
  });
  if (count) console.log('Pulled ' + count + ' changed appointment(s) from Shop-Ware.');
  p.setProperty('SW_LAST_PULL_AT', String(runStart));
}

// ---------------------------------------------------------------------------
// 3. Hourly reconcile
// ---------------------------------------------------------------------------

function maybeReconcile_(cals, force) {
  var p = props_();
  var last = Number(p.getProperty('RECONCILE_AT') || 0);
  if (!force && Date.now() - last < CONFIG.RECONCILE_EVERY_MINUTES * 60000) return;
  var ids = {};
  var timeMin = new Date(Date.now() - 86400000).toISOString();
  cals.forEach(function (c) {
    var pageToken, resp;
    do {
      resp = Calendar.Events.list(c.id, {
        privateExtendedProperty: 'swManaged=1', timeMin: timeMin, singleEvents: true,
        maxResults: 250, pageToken: pageToken,
      });
      (resp.items || []).forEach(function (ev) {
        var priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
        if (priv.swId) ids[priv.swId] = true;
      });
      pageToken = resp.nextPageToken;
    } while (pageToken);
  });
  Object.keys(ids).forEach(function (swId) {
    try {
      var appt = swGetAppointment_(swId);
      if (!appt) {
        // Deleted in Shop-Ware (it has no cancelled flag; records just vanish).
        if (takeDeleteBudget_({ kind: 'shopware', swId: swId })) removeFromAllCalendars_(cals, swId);
      } else {
        upsertAppointment_(cals, swLoadView_(appt));
      }
    } catch (e) {
      handleItemError_('Shop-Ware appointment #' + swId, 'SW_' + swId, e);
    }
  });
  p.setProperty('RECONCILE_AT', String(Date.now()));
}

// ---------------------------------------------------------------------------
// Deletions and the safety brake
// ---------------------------------------------------------------------------

/** Apply GOOGLE_DELETE_BEHAVIOR for an appointment whose event was deleted in Google. */
function applyGoogleDeletion_(cals, swId, appt) {
  var A = CONFIG.FIELDS.appointment;
  if (CONFIG.GOOGLE_DELETE_BEHAVIOR === 'delete') {
    swDeleteAppointment_(swId);
    console.log('Deleted Shop-Ware appointment #' + swId + ' (deleted in Google).');
  } else {
    var title = String(pickField_(appt, A.title) || swLoadView_(appt).customerName || 'Appointment');
    var body = {};
    body[fieldName_(appt, A.title)] = CONFIG.CANCELLED_TITLE_PREFIX + ' ' + title;
    swUpdateAppointment_(swId, body);
    console.log('Marked Shop-Ware appointment #' + swId + ' as cancelled (deleted in Google).');
  }
  removeFromAllCalendars_(cals, swId);
}

/**
 * Returns true if a deletion may go ahead now. Past MAX_DELETES_PER_RUN (or
 * while paused) the deletion is stored for resumeDeletes() and you get an alert.
 */
function takeDeleteBudget_(item) {
  var p = props_();
  var paused = !!p.getProperty('DELETES_PAUSED');
  if (!paused && deleteBudget_ !== null && deleteBudget_ <= 0) {
    paused = true;
    p.setProperty('DELETES_PAUSED', String(Date.now()));
    notify_('SAFETY', 'deletions paused',
      'More than ' + CONFIG.MAX_DELETES_PER_RUN + ' appointments were deleted at once. In case that was a ' +
      'mistake (for example a whole calendar deleted), deletions are on hold and nothing more was deleted. ' +
      'Everything else keeps syncing.');
  }
  if (paused) {
    var held = JSON.parse(p.getProperty('DEFERRED_DELETES') || '[]');
    var key = JSON.stringify(item);
    if (!held.some(function (h) { return JSON.stringify(h) === key; })) held.push(item);
    p.setProperty('DEFERRED_DELETES', JSON.stringify(held));
    return false;
  }
  if (deleteBudget_ !== null) deleteBudget_--;
  return true;
}

function isDeletionHeld_(swId) {
  var raw = props_().getProperty('DEFERRED_DELETES');
  if (!raw) return false;
  return JSON.parse(raw).some(function (h) { return h.kind === 'google' && String(h.swId) === String(swId); });
}

/**
 * Run from the editor after a "deletions paused" alert, once you've checked
 * the deletions were intended. Re-checks each one before applying it.
 */
function resumeDeletes() {
  var p = props_();
  var held = JSON.parse(p.getProperty('DEFERRED_DELETES') || '[]');
  p.deleteProperty('DELETES_PAUSED');
  p.deleteProperty('DEFERRED_DELETES');
  deleteBudget_ = null; // a person said go: no limit for this batch
  var cals = configuredCalendars_();
  var done = 0;
  held.forEach(function (item) {
    var appt = swGetAppointment_(item.swId);
    if (item.kind === 'shopware') {
      if (!appt) { removeFromAllCalendars_(cals, item.swId); done++; }
      return;
    }
    // Google deletion: only apply if the event is still deleted.
    var ev = getEvent_(item.calId, item.eventId);
    if (ev && ev.status !== 'cancelled') return;
    if (appt && !buildView_(appt).cancelled) { applyGoogleDeletion_(cals, item.swId, appt); done++; }
  });
  deleteBudget_ = CONFIG.MAX_DELETES_PER_RUN;
  console.log('Applied ' + done + ' of ' + held.length + ' held deletions.');
  return done;
}

/** Undo a pause without applying the held deletions (Google events come back on the next reconcile). */
function discardHeldDeletes() {
  var p = props_();
  var held = JSON.parse(p.getProperty('DEFERRED_DELETES') || '[]');
  p.deleteProperty('DELETES_PAUSED');
  p.deleteProperty('DEFERRED_DELETES');
  var cals = configuredCalendars_();
  held.forEach(function (item) {
    var appt = item.kind === 'google' && swGetAppointment_(item.swId);
    if (appt) upsertAppointment_(cals, swLoadView_(appt)); // restore the Google event
  });
  console.log('Discarded ' + held.length + ' held deletions.');
}
