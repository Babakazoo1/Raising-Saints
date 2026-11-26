/**
 * Minimal Shop-Ware API client.
 * Auth: X-Api-Partner-Id + X-Api-Secret headers; every path is under /tenants/{tenant}/.
 */

/** opts.keysOnly: only the API keys are needed (used by findShopIds). */
function swCredentials_(opts) {
  var p = PropertiesService.getScriptProperties();
  var c = {
    partnerId: p.getProperty('SHOPWARE_PARTNER_ID'),
    secret: p.getProperty('SHOPWARE_SECRET'),
    tenant: p.getProperty('SHOPWARE_TENANT_ID'),
    shopId: p.getProperty('SHOPWARE_SHOP_ID'),
  };
  var missing = [];
  if (!c.partnerId) missing.push('SHOPWARE_PARTNER_ID');
  if (!c.secret) missing.push('SHOPWARE_SECRET');
  if (!(opts && opts.keysOnly)) {
    if (!c.tenant) missing.push('SHOPWARE_TENANT_ID (run findShopIds)');
    if (!c.shopId) missing.push('SHOPWARE_SHOP_ID (run findShopIds)');
  }
  if (missing.length) throw new SyncError('CONFIG', 'Missing Script Properties: ' + missing.join(', '));
  return c;
}

function buildQuery_(query) {
  if (!query) return '';
  var parts = Object.keys(query).filter(function (k) {
    return query[k] !== undefined && query[k] !== null && query[k] !== '';
  }).map(function (k) {
    return encodeURIComponent(k) + '=' + encodeURIComponent(query[k]);
  });
  return parts.length ? '?' + parts.join('&') : '';
}

/**
 * One API call with retries for 429/5xx.
 * opts: { query, body, allow404, root }  (root: path is not under /tenants/{id}/)
 * Returns parsed JSON, or null for an allowed 404.
 */
function swRequest_(method, path, opts) {
  opts = opts || {};
  var c = swCredentials_({ keysOnly: !!opts.root });
  var prefix = opts.root ? '/' : '/tenants/' + encodeURIComponent(c.tenant) + '/';
  var url = CONFIG.SHOPWARE_BASE_URL + prefix + path + buildQuery_(opts.query);
  var params = {
    method: method,
    muteHttpExceptions: true,
    headers: { 'X-Api-Partner-Id': c.partnerId, 'X-Api-Secret': c.secret, Accept: 'application/json' },
  };
  if (opts.body !== undefined) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(opts.body);
  }

  var maxAttempts = 4;
  for (var attempt = 1; ; attempt++) {
    var res;
    try {
      res = UrlFetchApp.fetch(url, params);
    } catch (e) {
      if (attempt < maxAttempts) { Utilities.sleep(1000 * attempt); continue; }
      throw new SyncError('NETWORK', 'Could not reach Shop-Ware (' + method + ' ' + path + '): ' + e);
    }
    var code = res.getResponseCode();
    var text = res.getContentText() || '';
    if (code >= 200 && code < 300) {
      if (!text) return {};
      try { return JSON.parse(text); } catch (e) { return {}; }
    }
    if (code === 404 && opts.allow404) return null;
    if (code === 401 || code === 403) {
      throw new SyncError('AUTH', 'Shop-Ware returned HTTP ' + code + ' for ' + method + ' ' + path + '.',
        truncate_(text));
    }
    if ((code === 429 || code >= 500) && attempt < maxAttempts) {
      var retryAfter = Number(headerValue_(res, 'Retry-After')) || Math.pow(2, attempt);
      Utilities.sleep(Math.min(retryAfter, 20) * 1000);
      continue;
    }
    if (code === 429) throw new SyncError('RATE_LIMIT', 'Shop-Ware rate limit (HTTP 429) on ' + method + ' ' + path);
    if (code >= 500) throw new SyncError('SERVER', 'Shop-Ware HTTP ' + code + ' on ' + method + ' ' + path, truncate_(text));
    // 400 / 404 / 422: a problem with this particular record.
    throw new SyncError('DATA', 'Shop-Ware HTTP ' + code + ' on ' + method + ' ' + path + ': ' + truncate_(text));
  }
}

function headerValue_(res, name) {
  var h = (res.getAllHeaders && res.getAllHeaders()) || {};
  for (var k in h) if (k.toLowerCase() === name.toLowerCase()) return h[k];
  return null;
}

function truncate_(s) {
  s = String(s || '');
  return s.length > 800 ? s.substring(0, 800) + '…' : s;
}

/** Records from a list response, whatever the envelope looks like. */
function listResults_(body) {
  if (Array.isArray(body)) return body;
  if (!body) return [];
  return body.results || body.data || body.items || body.records || [];
}

function swShopId_() {
  return PropertiesService.getScriptProperties().getProperty('SHOPWARE_SHOP_ID');
}

/** All pages of a list endpoint (appointments are limited to our shop). */
function swListAll_(path, query) {
  var out = [];
  var seen = {};
  var page = 1;
  for (;;) {
    var q = Object.assign({ shop_id: swShopId_() }, query || {}, { page: page, per_page: CONFIG.PAGE_SIZE });
    var body = swRequest_('get', path, { query: q });
    var results = listResults_(body);
    results.forEach(function (r) {
      var key = r && r.id !== undefined ? String(r.id) : null;
      if (key === null || !seen[key]) { if (key !== null) seen[key] = true; out.push(r); }
    });
    var totalPages = body && (body.total_pages || (body.meta && body.meta.total_pages));
    if (!results.length) break;
    if (totalPages ? page >= totalPages : results.length < CONFIG.PAGE_SIZE) break;
    page++;
    if (page > 200) break; // safety valve
  }
  return out;
}

/** Unwrap {appointment: {...}} style single-record responses. */
function unwrap_(body, key) {
  if (!body) return body;
  if (body[key] && typeof body[key] === 'object') return body[key];
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) return body.data;
  return body;
}

// ---- Cached lookups (customer / vehicle / RO / staff change rarely) -------

function swGetCached_(path, id, key) {
  if (id === undefined || id === null || id === '') return null;
  var cache = CacheService.getScriptCache();
  var cacheKey = 'sw:' + path + ':' + id;
  var hit = cache.get(cacheKey);
  if (hit) return JSON.parse(hit);
  var rec = unwrap_(swRequest_('get', path + '/' + encodeURIComponent(id), { allow404: true }), key);
  if (rec) {
    var json = JSON.stringify(rec);
    if (json.length < 90000) cache.put(cacheKey, json, 6 * 3600);
  }
  return rec;
}

function swGetAppointment_(id) {
  return unwrap_(swRequest_('get', CONFIG.PATHS.appointments + '/' + encodeURIComponent(id), { allow404: true }), 'appointment');
}

/** Shop-Ware requires shop_id + start_at, and a title or repair_order_id. */
function swCreateAppointment_(fields) {
  var body = Object.assign({}, fields);
  body[CONFIG.FIELDS.appointment.shopId[0]] = Number(swShopId_()) || swShopId_();
  return unwrap_(swRequest_('post', CONFIG.PATHS.appointments, { body: wrapWrite_(body) }), 'appointment');
}

function wrapWrite_(body) {
  if (!CONFIG.WRITE_WRAPPER_KEY) return body;
  var w = {};
  w[CONFIG.WRITE_WRAPPER_KEY] = body;
  return w;
}

/** True if the appointment belongs to another shop in the same tenant. */
function isOtherShop_(appt) {
  var shop = pickField_(appt, CONFIG.FIELDS.appointment.shopId);
  var mine = swShopId_();
  return shop !== undefined && mine && String(shop) !== String(mine);
}

function swUpdateAppointment_(id, body) {
  return unwrap_(swRequest_('put', CONFIG.PATHS.appointments + '/' + encodeURIComponent(id), { body: wrapWrite_(body) }), 'appointment');
}

function swDeleteAppointment_(id) {
  return swRequest_('delete', CONFIG.PATHS.appointments + '/' + encodeURIComponent(id), { allow404: true });
}

/**
 * Collect the related repair order, customer, vehicle and advisor, and build
 * the view. Appointments link to a repair order, which carries the customer
 * and vehicle ids.
 */
function swLoadView_(appt) {
  var A = CONFIG.FIELDS.appointment;
  var R = CONFIG.FIELDS.repairOrder;
  var ro = swGetCached_(CONFIG.PATHS.repairOrders, pickField_(appt, A.repairOrderId), 'repair_order');
  var customerId = pickField_(appt, A.customerId);
  if (customerId === undefined) customerId = pickField_(ro, R.customerId);
  var vehicleId = pickField_(appt, A.vehicleId);
  if (vehicleId === undefined) vehicleId = pickField_(ro, R.vehicleId);
  var customer = swGetCached_(CONFIG.PATHS.customers, customerId, 'customer');
  var vehicle = swGetCached_(CONFIG.PATHS.vehicles, vehicleId, 'vehicle');
  var advisor = swGetCached_(CONFIG.PATHS.staff, pickField_(appt, A.advisorId), 'staff');
  var view = buildView_(appt, customer, vehicle, ro, advisor);
  view.tenant = PropertiesService.getScriptProperties().getProperty('SHOPWARE_TENANT_ID');
  return view;
}
