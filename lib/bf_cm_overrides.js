// lib/bf_cm_overrides.js — per-country weekly send-day cadence + the 2026 Black
// Friday/Cyber Monday replacement-date overrides, ported verbatim from
// row_newsletter_automation/cloud_daily_build.js (BF_CM_2026_OVERRIDES, nextSendDate())
// rather than depending on that repo at runtime — small, frozen-for-2026 data.
//
// Scope note: the override table below only covers the 9 ROW+UAE countries — confirmed
// by research into all 3 sibling repos that NA and UK have NO equivalent BF/CM
// send-date-override table of their own (their Q4 handling is a different mechanism —
// a bottom-banner theme/image swap, not a send-DATE change). Do not invent NA/UK entries
// here; if Kasia confirms NA/UK also need a BF/CM date override, get the real dates from
// her first, the same way these ROW dates were confirmed against the 2026 calendar
// before being relied on.
//
// These are REPLACEMENT send dates, not extra sends (Kasia's explicit rule, 27 Oct
// 2026): a 1-send/week country swaps its one send; a 2-send/week country (AU, IE, UK)
// keeps its first normal day and only swaps the second.
const BF_CM_2026_OVERRIDES = {
  // Black Friday week -> Fri 27 Nov 2026
  'DE:2026-11-23': '2026-11-27',
  'FR:2026-11-24': '2026-11-27',
  'IT:2026-11-24': '2026-11-27',
  'NL:2026-11-26': '2026-11-27',
  'UAE:2026-11-26': '2026-11-27',
  'ES:2026-11-28': '2026-11-27',
  // Cyber Monday week -> Mon 30 Nov 2026
  'FR:2026-12-01': '2026-11-30',
  'IT:2026-12-01': '2026-11-30',
  'NL:2026-12-03': '2026-11-30',
  'PL:2026-12-04': '2026-11-30',
  'UAE:2026-12-03': '2026-11-30',
  'ES:2026-12-05': '2026-11-30',
  'AU:2026-12-01': '2026-11-30',
  'IE:2026-12-01': '2026-11-30',
};

// Canonical per-country sendDays, confirmed against newsletter_build/lib/country_config.js
// (UK/ROW/UAE) and config/blueprints.json's na.programmes weekday arrays (NA CO/CW).
// NA_CO/NA_CW are pseudo-country keys matching the GRN tab's own column headers
// ("NA CO", "NA CW") — NA doesn't use day-based cadence the same way, it's really
// "every day except Wednesday" (CO) / "Wednesday only" (CW).
const COUNTRY_SEND_DAYS = {
  AU: ['Tuesday', 'Friday'],
  DE: ['Monday'],
  FR: ['Tuesday'],
  IT: ['Tuesday'],
  NL: ['Thursday'],
  PL: ['Friday'],
  ES: ['Saturday'],
  UK: ['Thursday', 'Friday'],
  IE: ['Tuesday', 'Friday'],
  UAE: ['Thursday'],
  'NA CO': ['Monday', 'Tuesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  'NA CW': ['Wednesday'],
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Matches each country's own deployed Cloud Scheduler timeZone — see ROW's
// COUNTRY_BUILD_TIMEZONE comment for the real bug this guards against (a country whose
// cron-fire moment lands on a different UTC calendar day silently computes one day
// behind). Defaults to Europe/Warsaw for anything not listed.
const COUNTRY_BUILD_TIMEZONE = {
  AU: 'Australia/Sydney',
  UK: 'Europe/London',
};

function localDateString(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Finds the next date (today inclusive) whose weekday appears in sendDays, then applies
// the BF/CM override table above if this country/date combination has one. Ported
// verbatim from row_newsletter_automation/cloud_daily_build.js's nextSendDate().
function nextSendDate(sendDays, fromDate = new Date(), country = null) {
  const timeZone = (country && COUNTRY_BUILD_TIMEZONE[country]) || 'Europe/Warsaw';
  const anchor = new Date(`${localDateString(fromDate, timeZone)}T00:00:00Z`);
  for (let i = 0; i < 14; i++) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + i);
    const dayName = DAY_NAMES[d.getUTCDay()];
    if (sendDays.includes(dayName)) {
      let dateIso = d.toISOString().slice(0, 10);
      const overrideKey = country ? `${country}:${dateIso}` : null;
      if (overrideKey && BF_CM_2026_OVERRIDES[overrideKey]) {
        dateIso = BF_CM_2026_OVERRIDES[overrideKey];
      }
      const overriddenDay = DAY_NAMES[new Date(`${dateIso}T00:00:00Z`).getUTCDay()];
      return { dateIso, day: overriddenDay };
    }
  }
  throw new Error(`nextSendDate: no match within 14 days for sendDays=${JSON.stringify(sendDays)}`);
}

// Convenience wrapper — looks up a country's own sendDays from the table above.
function getSendDateForCountry(countryCode, fromDate = new Date()) {
  const sendDays = COUNTRY_SEND_DAYS[countryCode];
  if (!sendDays) throw new Error(`getSendDateForCountry: no sendDays configured for "${countryCode}"`);
  return nextSendDate(sendDays, fromDate, countryCode);
}

module.exports = {
  BF_CM_2026_OVERRIDES, COUNTRY_SEND_DAYS, DAY_NAMES, COUNTRY_BUILD_TIMEZONE,
  nextSendDate, getSendDateForCountry, localDateString,
};
