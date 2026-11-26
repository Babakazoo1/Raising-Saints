# Google Calendar ⇄ Shop-Ware Sync

This keeps your Shop-Ware appointments and Google Calendar in sync, in both directions.

- **Separate calendars.** Appointments go on their own Google calendar ("Shop-Ware Appointments"), so you can hide it with one checkbox.
- **Two-way.** An appointment booked in Shop-Ware shows up in Google. An event you add, move, edit or delete in Google goes back to Shop-Ware.
- **Full details on every event:** customer name, phone and email; vehicle year, make, model, VIN, plate and mileage; whether it's a **waiter** or a **drop-off**; whether they **need a ride (Uber/shuttle)**; the advisor; the RO number; and the notes.
  - The title shows the important part at a glance, for example `⏳ WAITER · 🚕 RIDE | Ana Lopez | 2019 Ford F-150 XLT`.
  - Colours: red for waiters, blue for drop-offs, orange for ride needed.
- **Extra calendars for teams.** You can add calendars such as "Sales Team" that show only some appointments and are shared to those people's own Google Calendars.
- **Alerts when something breaks.** You get an email (and, if you want, a Google Chat or Slack message) when:
  - Shop-Ware access is denied
  - Shop-Ware is down or rate-limiting
  - a calendar is lost
  - an event couldn't be synced
  - an unusual number of appointments is deleted at once (deletions pause until you check)
  - the sync hasn't succeeded in 45 minutes

  You get another message once it's working again.

It runs as a **Google Apps Script** in your Google account, so there's no server to host or pay for. It checks for changes every 5 minutes.

---

## Setup (about 20 minutes, one time)

### 1. Get Shop-Ware API access
Ask Shop-Ware support for API access for your shop. You need three values:
- **Partner ID** (`X-Api-Partner-Id`)
- **Secret** (`X-Api-Secret`)


You'll look up your Tenant ID and Shop ID in step 3.

Shop-Ware issues these through its Technology Partner program, and your shop has to approve the integration.

### 2. Create the Apps Script project
Sign in to Google as the account that should **own** the calendars. A shop account like `office@…` is better than a personal one, so the sync doesn't depend on one employee.

1. Go to <https://script.google.com> and click **New project**. Name it "Shop-Ware Calendar Sync".
2. Open **Project Settings** (gear icon). Tick **Show "appsscript.json" manifest file in editor**. Set the **time zone** to **(GMT-07:00) Mountain Time – Denver**.
3. Back in the **Editor**, create one script file for each file in `src/` (`Config`, `Format`, `Alerts`, `ShopWare`, `Sync`, `Setup`) and paste in its contents. Replace the contents of `appsscript.json` with `src/appsscript.json`. It's already set to Mountain time (`America/Denver`, which handles daylight saving). In Arizona, which doesn't observe daylight saving, change it to `America/Phoenix`.
   - *Developer alternative:* `npm i -g @google/clasp`, `clasp login`, copy `.clasp.json.example` to `.clasp.json` with your script ID, then `clasp push`.

### 3. Add your Shop-Ware keys (kept out of the code)
Go to **Project Settings → Script Properties → Add script property** and add:

| Property | Value |
|---|---|
| `SHOPWARE_PARTNER_ID` | from Shop-Ware |
| `SHOPWARE_SECRET` | from Shop-Ware |
| `SHOPWARE_TENANT_ID` | see below |
| `SHOPWARE_SHOP_ID` | see below |
| `ALERT_EMAILS` | *(optional)* who gets alerts, comma-separated. Defaults to the account running the script. |
| `ALERT_WEBHOOK_URL` | *(optional)* Google Chat or Slack incoming-webhook URL |

Save the first two, then pick **`findShopIds`** in the toolbar and click **Run**. Approve the Google permission prompt. The log lists the tenant and shop IDs your key can use, and your shop's time zone. Add `SHOPWARE_TENANT_ID` and `SHOPWARE_SHOP_ID` from it. If it says no shop is authorized yet, ask Shop-Ware support to authorize your shop for the partner key.

### 4. Check the field names (important)
Run **`debugDumpAppointment`**. The log shows a real upcoming Shop-Ware appointment, its repair order, customer and vehicle, and the event this sync would create from it.

In Shop-Ware's API, an appointment doesn't hold the customer or vehicle itself. It links to a repair order, and the repair order has them. So appointments without a repair order show only their title and notes.

Compare the field names with `CONFIG.FIELDS` in `Config.js`. Each setting lists several likely names, and the first one present is used.
- **Waiter / drop-off / ride.** If Shop-Ware stores these as their own fields, add those field names. If not, the sync looks for words in the appointment title and notes, such as "waiter", "drop off", "uber", "needs a ride" or "shuttle". You can edit `CONFIG.KEYWORDS`.

### 5. Turn it on
Run **`setup`**. It does the following, and is safe to run again any time:
- creates the calendar(s) and shares them as configured
- schedules the sync every 5 minutes, plus an hourly health check
- tests the Shop-Ware connection and runs the first sync

Then run **`sendTestAlert`** to confirm alerts reach you.

**Suggested first week:** set `twoWay: false` on your calendar in `Config.js` before running `setup`. Google is then a read-only copy and nothing is written to Shop-Ware. Once the events look right, set it back to `true` and run `setup` again.

Last, in the left sidebar open **Triggers** → each trigger → **Failure notification settings** → **Notify me immediately**. This is Google's own backup alert, for the rare case where the script can't run at all.

---

## Day-to-day use

**Booking from Google Calendar.** Add an event to the *Shop-Ware Appointments* calendar with a start and end time. Within about 5 minutes it's created in Shop-Ware, and your event is replaced with the fully formatted one. Put the customer details in the description:

```
Title:       Brake inspection – waiter
Description: Customer: Ana Lopez
             Phone: 555-123-4567
             Vehicle: 2019 Ford F-150
             Needs a ride home
```

In Shop-Ware it becomes an appointment titled `Ana Lopez – Brake inspection – waiter`, with the phone, vehicle and `[WAITER] [NEEDS RIDE]` in its notes. Shop-Ware's API can't attach a customer to an appointment directly; that happens when the front desk links it to a repair order. Once they do, the Google event fills in the full customer and vehicle details on its own.

**Changing.** You can drag an event to a new time, or edit the text under **Notes:** in its description, and Shop-Ware is updated. Customer and vehicle changes are made in Shop-Ware, and the event updates on its own.

**Deleting.** What deleting an event in Google does is set by `GOOGLE_DELETE_BEHAVIOR` in `Config.js`:
- `'cancel'` (default): the Shop-Ware appointment is renamed `[CANCELLED] …`, so nothing is lost and it can be undone
- `'delete'`: the appointment is deleted from Shop-Ware
- `'restore'`: Shop-Ware is left alone and the event comes back

Deleting an appointment in Shop-Ware, or renaming it to start with `[CANCELLED]`, removes the event from Google.

**Safety brake.** If more than 10 deletions show up at once (`MAX_DELETES_PER_RUN`), for example because someone deleted the whole calendar, the extra deletions are held and you get an alert. Everything else keeps syncing. Then run `resumeDeletes` if they were intended, or `discardHeldDeletes` to bring the events back.

**Not supported.** All-day and repeating events can't become appointments. They're marked `⚠ NOT IN SHOP-WARE` and you get an email.

**Hiding it.** Untick the calendar in Google Calendar's left sidebar.

## Adding calendars for other teams

In `Config.js`, add an entry to `CALENDARS`. There's a commented-out "Sales Team" example to copy:

```js
{
  key: 'sales',                 // short, lowercase, never change it later
  name: 'Sales Team',
  twoWay: true,                 // false = read-only copy
  filter: function (v) { return v.text.indexOf('sales') !== -1; },
  shareWith: [
    { email: 'sales-team@raisingsaintsauto.com', role: 'writer', type: 'group' },
    { email: 'jordan@raisingsaintsauto.com', role: 'reader' },
  ],
},
```

Then run `setup` again. The people you list get the calendar in their own Google Calendar. Roles mean:
- `reader`: can see the details
- `writer`: can also book and change appointments
- `freeBusyReader`: sees only busy times

**Filters.** A filter can check `v.text` (all text, lowercase), `v.advisorName`, `v.flags.waiter`, `v.flags.ride`, `v.customerName`, `v.vehicleName` and the raw `v.appt`. Appointments created *from* a calendar always stay on that calendar.

**Removing someone.** Run `removeShare('sales', 'person@example.com')`.

## Alerts you might get

| Alert | Meaning | What to do |
|---|---|---|
| **Shop-Ware access denied** | Keys wrong or rotated, or integration disabled | Fix the Script Properties or call Shop-Ware, then run `testConnection` |
| **Missing setting** | A Script Property is empty | Add it |
| **Google Calendar access problem** | A synced calendar was deleted, or the account lost access | Run `setup` |
| **Cannot reach Shop-Ware / sync error / rate limit** | Shop-Ware is down or slow | Usually nothing. It retries on its own |
| **Event not added to Shop-Ware** | That one event couldn't be created | Follow the link in the email and fix the event. Any edit makes it retry |
| **Deletions paused** | Too many deletions at once | Run `resumeDeletes` if intended, otherwise `discardHeldDeletes` |
| **No successful sync in N minutes** | Something stopped the sync | Check **Executions** in Apps Script |

Each problem emails you at most once every 6 hours while it lasts. You get a "✅ working again" email when it clears. Changes made during an outage aren't lost; they sync once access is back.

## Maintenance helpers (run from the editor)
- `findShopIds`: lists the tenant and shop IDs your key can use
- `testConnection`: checks the Shop-Ware keys
- `syncNow`: syncs right now
- `reconcileNow`: refreshes every upcoming event, for example after changing a filter
- `resetSync`: re-reads everything from Shop-Ware on the next run
- `debugDumpAppointment`: shows raw Shop-Ware data for field mapping
- `sendTestAlert`: sends a test email
- `resumeDeletes` / `discardHeldDeletes`: release or cancel deletions held by the safety brake

## Development
The code in `src/` runs in Apps Script. `test/` runs the same files in Node, against in-memory fakes of Google Calendar and the Shop-Ware API:

```
npm test
```

## Notes and limits
- The Shop-Ware endpoints and fields follow Shop-Ware's v1 API spec:
  - Appointment fields: `shop_id`, `staff_id`, `repair_order_id`, `title`, `description`, `start_at`, `end_at`, `updated_at`.
  - Filters: `shop_id`, `start_after`, `updated_after`.
  - New appointments need `shop_id`, `start_at`, and a title or repair order.
  - Appointments have no cancelled flag; deleted ones simply return 404.

  All names are configurable in `Config.js`. Step 4 confirms them against your real data.
- Shop-Ware webhooks (instant updates) aren't used, because Apps Script web-app URLs redirect and Shop-Ware requires a URL that doesn't.
- Changes appear within about 5 minutes, not instantly.
- If the same appointment is moved in both places within the same 5 minutes, the Google change wins.
