/**
 * Pure helpers: turning Shop-Ware records into Google events and back.
 * Nothing in this file calls a Google or Shop-Ware API, so it is unit-tested
 * in Node (see test/).
 */

var NOTES_HEADER = 'Notes:';
var FOOTER_RULE = '────────────';

/** First non-empty value among candidate field names. */
function pickField_(obj, names) {
  if (!obj || !names) return undefined;
  for (var i = 0; i < names.length; i++) {
    var v = obj[names[i]];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

/** True if any candidate field exists on the record at all (even false). */
function hasField_(obj, names) {
  if (!obj || !names) return false;
  for (var i = 0; i < names.length; i++) {
    if (Object.prototype.hasOwnProperty.call(obj, names[i]) && obj[names[i]] !== null) return true;
  }
  return false;
}

function truthy_(v) {
  if (typeof v === 'string') return /^(true|yes|y|1)$/i.test(v.trim());
  return !!v;
}

/** Phones/emails may come as strings, arrays of strings or arrays of objects. */
function listValues_(v) {
  if (v === undefined || v === null || v === '') return [];
  var arr = Array.isArray(v) ? v : [v];
  var out = [];
  arr.forEach(function (item) {
    if (item === null || item === undefined) return;
    if (typeof item === 'object') {
      var s = item.number || item.phone || item.address || item.email || item.value;
      if (s) out.push(String(s));
    } else {
      out.push(String(item));
    }
  });
  return out;
}

function customerName_(c) {
  if (!c) return '';
  var F = CONFIG.FIELDS.customer;
  var name = [pickField_(c, F.firstName), pickField_(c, F.lastName)].filter(Boolean).join(' ');
  return name || String(pickField_(c, F.business) || '');
}

function vehicleText_(v) {
  if (!v) return '';
  var F = CONFIG.FIELDS.vehicle;
  return [pickField_(v, F.year), pickField_(v, F.make), pickField_(v, F.model), pickField_(v, F.trim)]
    .filter(Boolean).join(' ');
}

function staffName_(s) {
  if (!s) return '';
  var F = CONFIG.FIELDS.staff;
  return String(pickField_(s, F.name) ||
    [pickField_(s, F.firstName), pickField_(s, F.lastName)].filter(Boolean).join(' '));
}

function escapeRegex_(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word / whole-phrase keyword match. */
function hasKeyword_(text, keywords) {
  return (keywords || []).some(function (k) {
    return new RegExp('(^|[^a-z0-9])' + escapeRegex_(k.toLowerCase()) + '($|[^a-z0-9])').test(text);
  });
}

/** Waiter / drop-off / ride flags: dedicated Shop-Ware field if present, else keywords. */
function detectFlags_(appt, text) {
  var F = CONFIG.FIELDS.appointment;
  var K = CONFIG.KEYWORDS;
  var lower = (text || '').toLowerCase();
  function flag(fieldNames, keywords) {
    if (hasField_(appt, fieldNames)) {
      for (var i = 0; i < fieldNames.length; i++) {
        if (appt[fieldNames[i]] !== undefined && appt[fieldNames[i]] !== null) return truthy_(appt[fieldNames[i]]);
      }
    }
    return hasKeyword_(lower, keywords);
  }
  var flags = {
    waiter: flag(F.waiter, K.waiter),
    dropOff: flag(F.dropOff, K.dropOff),
    ride: flag(F.ride, K.ride),
  };
  if (flags.waiter && flags.dropOff) flags.dropOff = false; // waiter wins if both
  return flags;
}

/**
 * Everything we know about one appointment, flattened. This is what calendar
 * filters receive and what the event is rendered from.
 */
function buildView_(appt, customer, vehicle, repairOrder, advisor) {
  var A = CONFIG.FIELDS.appointment;
  var V = CONFIG.FIELDS.vehicle;
  var C = CONFIG.FIELDS.customer;
  var title = String(pickField_(appt, A.title) || '');
  var notes = String(pickField_(appt, A.notes) || '');
  var view = {
    appt: appt,
    customer: customer || null,
    vehicle: vehicle || null,
    repairOrder: repairOrder || null,
    id: String(pickField_(appt, A.id)),
    start: pickField_(appt, A.start),
    end: pickField_(appt, A.end),
    status: String(pickField_(appt, A.status) || '').toLowerCase(),
    title: title,
    notes: notes,
    customerName: customerName_(customer),
    phones: listValues_(pickField_(customer, C.phones)),
    emails: listValues_(pickField_(customer, C.emails)),
    vehicleName: vehicleText_(vehicle),
    vin: String(pickField_(vehicle, V.vin) || ''),
    plate: String(pickField_(vehicle, V.plate) || ''),
    mileage: pickField_(vehicle, V.mileage),
    vehicleColor: String(pickField_(vehicle, V.color) || ''),
    roNumber: repairOrder ? String(pickField_(repairOrder, CONFIG.FIELDS.repairOrder.number) || '') : '',
    advisorName: staffName_(advisor),
  };
  view.flags = detectFlags_(appt, title + '\n' + notes);
  view.text = [title, notes, view.customerName, view.vehicleName, view.advisorName].join('\n').toLowerCase();
  view.cancelled = CONFIG.CANCELLED_STATUSES.indexOf(view.status) !== -1 ||
    title.toUpperCase().indexOf(CONFIG.CANCELLED_TITLE_PREFIX.toUpperCase()) === 0;
  return view;
}

function addMinutesIso_(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
}

/** Google Calendar event body (summary/description/start/end/colour) for a view. */
function renderEvent_(view) {
  var f = view.flags;
  var badge = f.waiter ? '⏳ WAITER' : f.dropOff ? '🔑 DROP-OFF' : '';
  if (f.ride) badge = (badge ? badge + ' · ' : '') + '🚕 RIDE';
  var who = view.customerName || view.title || (view.notes.split('\n')[0] || 'Appointment');
  var summary = [badge, who, view.vehicleName].filter(Boolean).join(' | ');

  var lines = [];
  if (view.customerName) lines.push('👤 Customer: ' + view.customerName);
  if (view.phones.length) lines.push('📞 Phone: ' + view.phones.join(', '));
  if (view.emails.length) lines.push('✉️ Email: ' + view.emails.join(', '));
  if (view.vehicleName) {
    lines.push('🚗 Vehicle: ' + view.vehicleName + (view.vehicleColor ? ' (' + view.vehicleColor + ')' : ''));
  }
  if (view.vin) lines.push('VIN: ' + view.vin);
  if (view.plate) lines.push('Plate: ' + view.plate);
  if (view.mileage !== undefined && view.mileage !== null && view.mileage !== '') lines.push('Mileage: ' + view.mileage);
  lines.push('🕒 Visit: ' + (f.waiter ? 'WAITER (customer is waiting)' : f.dropOff ? 'Drop-off' : 'Not specified'));
  lines.push('🚕 Needs ride: ' + (f.ride ? 'YES' : 'No'));
  if (view.advisorName) lines.push('🧑‍🔧 Advisor: ' + view.advisorName);
  if (view.roNumber) lines.push('🧾 RO #: ' + view.roNumber);
  if (view.title && view.title !== who) lines.push('📝 Title: ' + view.title);
  lines.push('');
  lines.push(NOTES_HEADER);
  lines.push(view.notes || '');
  lines.push('');
  lines.push(FOOTER_RULE);
  lines.push('Shop-Ware appointment #' + view.id + ' (synced automatically).');
  lines.push('Change the time or the Notes here and it updates Shop-Ware. Customer and vehicle changes go in Shop-Ware.');
  if (CONFIG.SHOPWARE_APPOINTMENT_LINK) {
    lines.push(CONFIG.SHOPWARE_APPOINTMENT_LINK.replace('{id}', view.id).replace('{tenant}', view.tenant || ''));
  }

  var end = view.end || addMinutesIso_(view.start, CONFIG.DEFAULT_DURATION_MINUTES);
  var colorId = f.waiter ? CONFIG.COLORS.waiter : f.dropOff ? CONFIG.COLORS.dropOff : f.ride ? CONFIG.COLORS.ride : null;
  var ev = {
    summary: summary,
    description: lines.join('\n'),
    start: { dateTime: new Date(view.start).toISOString() },
    end: { dateTime: new Date(end).toISOString() },
  };
  if (colorId) ev.colorId = colorId;
  return ev;
}

/** The Notes section of a description we rendered (null if it isn't ours). */
function extractNotes_(description) {
  var d = String(description || '');
  var start = d.indexOf('\n' + NOTES_HEADER + '\n');
  var end = d.lastIndexOf('\n' + FOOTER_RULE);
  if (start === -1 || end === -1 || end < start) return null;
  return d.substring(start + NOTES_HEADER.length + 2, end).replace(/\s+$/, '');
}

/** Strip simple HTML that Google Calendar sometimes stores in descriptions. */
function stripHtml_(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/**
 * Parse an event someone typed directly into Google Calendar.
 * Recognises "Key: value" lines (Customer/Name, Phone, Email, Vehicle, VIN, Plate, Notes)
 * plus waiter / drop-off / ride keywords anywhere in title or description.
 */
function parseEventText_(summary, description) {
  var text = stripHtml_(description);
  var fields = {};
  var other = [];
  var keyMap = {
    customer: 'customer', name: 'customer', client: 'customer',
    phone: 'phone', cell: 'phone', mobile: 'phone',
    email: 'email', 'e-mail': 'email',
    vehicle: 'vehicle', car: 'vehicle',
    vin: 'vin', plate: 'plate',
    notes: 'notes', note: 'notes', concern: 'notes', service: 'notes',
  };
  text.split('\n').forEach(function (raw) {
    var line = raw.trim();
    if (!line) return;
    var m = line.match(/^[^A-Za-z]*([A-Za-z-]+)\s*[:\-–]\s*(.+)$/);
    var key = m && keyMap[m[1].toLowerCase()];
    if (key && !fields[key]) fields[key] = m[2].trim();
    else other.push(line);
  });
  if (other.length) fields.notes = [fields.notes].concat(other).filter(Boolean).join('\n');
  var flags = detectFlags_({}, (summary || '') + '\n' + text);
  return { title: String(summary || '').trim(), fields: fields, flags: flags };
}

/** Notes text written to Shop-Ware for an event made in Google. */
function composeShopwareNotes_(parsed) {
  var f = parsed.fields;
  var tags = [];
  if (parsed.flags.waiter) tags.push('[WAITER]');
  if (parsed.flags.dropOff) tags.push('[DROP-OFF]');
  if (parsed.flags.ride) tags.push('[NEEDS RIDE]');
  var lines = [];
  if (tags.length) lines.push(tags.join(' '));
  if (parsed.title) lines.push(parsed.title);
  if (f.customer) lines.push('Customer: ' + f.customer);
  if (f.phone) lines.push('Phone: ' + f.phone);
  if (f.email) lines.push('Email: ' + f.email);
  if (f.vehicle) lines.push('Vehicle: ' + f.vehicle);
  if (f.vin) lines.push('VIN: ' + f.vin);
  if (f.plate) lines.push('Plate: ' + f.plate);
  if (f.notes) lines.push(f.notes);
  lines.push('(Created from Google Calendar)');
  return lines.join('\n');
}

/** Stable 32-bit FNV-1a hash, hex. */
function hash_(s) {
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('0000000' + h.toString(16)).slice(-8);
}

function normalizeTime_(t) {
  if (!t) return '';
  if (t.dateTime) return new Date(t.dateTime).toISOString();
  return t.date || '';
}

/** Fingerprint of the parts of an event a person might edit. */
function eventFingerprint_(ev) {
  return hash_([
    ev.summary || '', stripHtml_(ev.description || '').replace(/\s+$/, ''),
    normalizeTime_(ev.start), normalizeTime_(ev.end),
  ].join('\u0001'));
}

// ---- Deterministic Google event ids ---------------------------------------
// Google event ids must use base32hex characters (0-9, a-v). We use
// "shop" + hex(calendarKey + "~" + shopwareId) so a cancelled event (which
// arrives with only its id) can still be traced back to its appointment.
var EVENT_ID_PREFIX = 'shop';

function toHex_(s) {
  var out = '';
  var bytes = unescape(encodeURIComponent(s));
  for (var i = 0; i < bytes.length; i++) out += ('0' + bytes.charCodeAt(i).toString(16)).slice(-2);
  return out;
}

function fromHex_(h) {
  var bytes = '';
  for (var i = 0; i < h.length; i += 2) bytes += String.fromCharCode(parseInt(h.substr(i, 2), 16));
  return decodeURIComponent(escape(bytes));
}

function eventIdFor_(calKey, shopwareId) {
  return EVENT_ID_PREFIX + toHex_(calKey + '~' + shopwareId);
}

/** {calKey, shopwareId} or null if the id isn't one of ours. */
function parseEventId_(eventId) {
  if (!eventId || eventId.indexOf(EVENT_ID_PREFIX) !== 0) return null;
  var hex = eventId.substring(EVENT_ID_PREFIX.length);
  if (!/^([0-9a-f]{2})+$/.test(hex)) return null;
  try {
    var s = fromHex_(hex);
    var i = s.indexOf('~');
    if (i <= 0) return null;
    return { calKey: s.substring(0, i), shopwareId: s.substring(i + 1) };
  } catch (e) {
    return null;
  }
}
