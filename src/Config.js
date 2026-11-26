/**
 * Raising Saints — Google Calendar <-> Shop-Ware appointment sync.
 *
 * ALL user-tunable settings live in this file. Secrets (API keys) do NOT go
 * here — they go in Script Properties (Project Settings -> Script Properties):
 *
 *   SHOPWARE_PARTNER_ID   (required)  X-Api-Partner-Id issued by Shop-Ware
 *   SHOPWARE_SECRET       (required)  X-Api-Secret issued by Shop-Ware
 *   SHOPWARE_TENANT_ID    (required)  your tenant id in Shop-Ware  } run findShopIds()
 *   SHOPWARE_SHOP_ID      (required)  your shop id in Shop-Ware    } to look these up
 *   ALERT_EMAILS          (optional)  comma-separated; defaults to the script owner
 *   ALERT_WEBHOOK_URL     (optional)  Google Chat / Slack incoming-webhook URL
 */
var CONFIG = {
  // ---- Shop-Ware API --------------------------------------------------------
  SHOPWARE_BASE_URL: 'https://api.shop-ware.com/api/v1',
  // Web link used in event descriptions so you can click straight into Shop-Ware.
  // {tenant} and {id} are replaced. Set to '' to leave the link out.
  SHOPWARE_APPOINTMENT_LINK: '',
  PAGE_SIZE: 100,

  // ---- Sync behaviour -------------------------------------------------------
  SYNC_INTERVAL_MINUTES: 5,        // 1, 5, 10, 15 or 30 (Apps Script limits)
  SYNC_PAST_DAYS: 7,               // keep appointments this far back on Google
  SYNC_FUTURE_DAYS: 120,           // and this far ahead
  DEFAULT_DURATION_MINUTES: 60,    // used when an appointment has no end time
  RECONCILE_EVERY_MINUTES: 60,     // how often to look for appointments deleted in Shop-Ware
  // What deleting an event in Google does to the Shop-Ware appointment:
  //   'cancel'  rename it "[CANCELLED] ..." in Shop-Ware (reversible; Shop-Ware has no cancelled flag)
  //   'delete'  delete it from Shop-Ware
  //   'restore' do nothing in Shop-Ware and put the Google event back
  GOOGLE_DELETE_BEHAVIOR: 'cancel',
  CANCELLED_TITLE_PREFIX: '[CANCELLED]',
  // Safety brake: if more deletions than this show up in one run (e.g. someone
  // deleted the whole calendar), deletions pause and you get an alert.
  // Run resumeDeletes() after checking.
  MAX_DELETES_PER_RUN: 10,

  // ---- Alerts ---------------------------------------------------------------
  ALERT_REPEAT_HOURS: 6,           // don't repeat the same alert more often than this
  STALE_SYNC_ALERT_MINUTES: 45,    // health check alerts if no successful sync for this long

  // ---- Calendars ------------------------------------------------------------
  // Each entry becomes its own Google Calendar (so you can show/hide it).
  //   key        short unique id — never change it after setup
  //   name       name shown in Google Calendar
  //   twoWay     true  = events created/edited/deleted here go back to Shop-Ware
  //              false = read-only mirror of Shop-Ware
  //   filter     optional function(view) -> true/false choosing which
  //              appointments appear. `view` has: appt, customer, vehicle,
  //              flags {waiter, dropOff, ride}, advisorName, text (all text, lowercase)
  //   shareWith  people / Google Groups who get the calendar in their own Google Calendar
  //              role: 'reader' (see details), 'writer' (can add/edit), 'freeBusyReader'
  CALENDARS: [
    {
      key: 'shop',
      name: 'Shop-Ware Appointments',
      twoWay: true,
      filter: null,
      shareWith: [
        // { email: 'frontdesk@raisingsaintsauto.com', role: 'writer' },
      ],
    },
    // Example: a sales-team calendar that only shows sales appointments.
    // {
    //   key: 'sales',
    //   name: 'Sales Team',
    //   twoWay: true,
    //   filter: function (v) { return v.text.indexOf('sales') !== -1; },
    //   shareWith: [
    //     { email: 'sales-team@raisingsaintsauto.com', role: 'writer', type: 'group' },
    //   ],
    // },
  ],

  // ---- Shop-Ware field mapping ---------------------------------------------
  // Shop-Ware's v1 spec lists these appointment fields: id, shop_id, staff_id,
  // repair_order_id, title, description, start_at, end_at, created_at,
  // updated_at, integrator_tags. Appointments have NO customer/vehicle id and
  // NO cancelled/status flag: the customer and vehicle come from the linked
  // repair order, and deleted appointments simply disappear (404).
  // Run debugDumpAppointment() once with real credentials to confirm. Each
  // entry can list several candidate names; the first one present wins.
  FIELDS: {
    appointment: {
      id: ['id'],
      start: ['start_at', 'starts_at', 'start_time', 'start'],
      end: ['end_at', 'ends_at', 'end_time', 'end'],
      title: ['title', 'name', 'summary'],
      notes: ['description', 'notes', 'note', 'comments'],
      customerId: ['customer_id'],          // not in the v1 spec; taken from the repair order
      vehicleId: ['vehicle_id'],            // not in the v1 spec; taken from the repair order
      repairOrderId: ['repair_order_id'],
      advisorId: ['staff_id', 'advisor_id', 'service_writer_id'],
      shopId: ['shop_id'],
      status: ['status', 'state'],
      updatedAt: ['updated_at'],
      // Optional dedicated flags. If Shop-Ware has no such field, the sync falls
      // back to keywords in the title/notes (see KEYWORDS below).
      waiter: ['waiter', 'is_waiter', 'waiting'],
      dropOff: ['drop_off', 'dropoff', 'is_drop_off'],
      ride: ['needs_ride', 'ride', 'shuttle', 'needs_shuttle', 'loaner'],
    },
    customer: {
      firstName: ['first_name'],
      lastName: ['last_name'],
      business: ['business_name', 'company_name', 'company'],
      phones: ['phones', 'phone_numbers', 'phone'],
      emails: ['emails', 'email'],
    },
    vehicle: {
      year: ['year'],
      make: ['make'],
      model: ['model'],
      trim: ['sub_model', 'submodel', 'trim', 'detail'],
      vin: ['vin'],
      plate: ['plate', 'license_plate', 'plate_number'],
      mileage: ['mileage', 'odometer', 'mileage_in'],
      color: ['color'],
    },
    repairOrder: {
      number: ['number', 'ro_number', 'id'],
      customerId: ['customer_id'],
      vehicleId: ['vehicle_id'],
    },
    staff: {
      firstName: ['first_name'],
      lastName: ['last_name'],
      name: ['name', 'full_name'],
    },
  },

  // Endpoint paths (relative to /tenants/{tenant}/)
  PATHS: {
    appointments: 'appointments',
    customers: 'customers',
    vehicles: 'vehicles',
    repairOrders: 'repair_orders',
    staff: 'staffs',
  },
  // List filters from the v1 spec (UTC ISO-8601). Results are also filtered
  // locally, so the sync stays correct even if one is ignored.
  UPDATED_SINCE_PARAM: 'updated_after',
  START_AFTER_PARAM: 'start_after',
  // If Shop-Ware expects writes wrapped like {"appointment": {...}}, set this to
  // 'appointment'. null sends the fields at the top level.
  WRITE_WRAPPER_KEY: null,
  // Appointment statuses meaning "this is cancelled" (lowercase), in case
  // Shop-Ware ever adds a status field. Today only the title prefix and
  // deletion (404) are used.
  CANCELLED_STATUSES: ['cancelled', 'canceled', 'deleted'],

  // Keyword detection (lowercase) for when Shop-Ware has no dedicated field.
  KEYWORDS: {
    // Matched as whole words/phrases, so 'ride' would not match 'override'.
    waiter: ['waiter', 'will wait', 'customer waiting', 'wait for it'],
    dropOff: ['drop off', 'drop-off', 'dropoff', 'dropping off', 'leave car', 'leaving car', 'overnight'],
    ride: ['uber', 'lyft', 'shuttle', 'needs ride', 'needs a ride', 'need a ride', 'ride home', 'loaner'],
  },

  // Google Calendar event colours (1-11). null = calendar default.
  COLORS: { waiter: '11', dropOff: '9', ride: '6' },
};
