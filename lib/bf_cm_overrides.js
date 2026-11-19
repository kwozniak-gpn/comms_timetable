// lib/bf_cm_overrides.js — per-country weekly send-day cadence + the 2026 Black
// Friday/Cyber Monday replacement-date overrides, ported verbatim from
// row_newsletter_automation/cloud_daily_build.js (BF_CM_2026_OVERRIDES, nextSendDate())
// rather than depending on that repo at runtime — small, frozen-for-2026 data.
//
// Scope note, corrected 19 Nov 2026: the table covers the 9 ROW+UAE countries plus ONE
// UK entry (CM-week only - UK's BF-week send needed no shift, see Kasia's 13 Nov 2026
// "BF/CM Newsletter Build Dates" email). NA has no entry and needs none - NA's own
// cadence (daily except Wednesday) already lands on both 27 Nov and 30 Nov naturally.
// This table only fixes what the GRN dashboard DISPLAYS - uk_newsletter_automation's own
// code has no BF/CM override mechanism at all (confirmed, nothing in its
// cloud_daily_build.js); UK's real send date for that week is whatever a human writes
// directly into its Dates tab. Get real dates from Kasia before adding any further
// entry, same as every date here was confirmed against her email + the real calendar
// before being relied on - never infer a market's BF/CM date from the general pattern.
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
  // UK added 19 Nov 2026 - confirmed against Kasia's 13 Nov 2026 "BF/CM Newsletter
  // Build Dates" email: UK's Thu send (normally lands Thu 3 Dec that week) moves to
  // Mon 30 Nov; UK's Fri 4 Dec send stays as usual, correctly no entry for it. This
  // only fixes the GRN dashboard's displayed date - uk_newsletter_automation itself has
  // no BF/CM override mechanism at all (confirmed, nothing in cloud_daily_build.js),
  // its real send date is whatever a human writes into the Dates tab directly.
  'UK:2026-12-03': '2026-11-30',
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

// Applies the BF_CM_2026_OVERRIDES table to an already-computed dateIso, same lookup
// nextSendDate uses internally — extracted so GRN_BUILD_SCHEDULE-driven dates (which
// don't go through nextSendDate's weekday scan) still get the BF/CM substitution.
function applyBfCmOverride(country, dateIso) {
  const overrideKey = `${country}:${dateIso}`;
  const overriddenIso = BF_CM_2026_OVERRIDES[overrideKey] || dateIso;
  const day = DAY_NAMES[new Date(`${overriddenIso}T00:00:00Z`).getUTCDay()];
  return { dateIso: overriddenIso, day };
}

// GRN's real build-day -> send schedule, given directly by Kasia (16 Nov 2026) and
// cross-checked against GRN 02.11.26's live data. This is NOT a generic "next occurrence
// of the country's weekly send day" rule — that undercounts in several real cases:
//   - IE and AU each send twice a week (Tue+Fri / Tue+Fri respectively), and each build
//     day stages a DIFFERENT one of the two occurrences (Tuesday's build stages the
//     upcoming Friday; Thursday's build stages the FOLLOWING week's Tuesday, skipping
//     the Friday already claimed by Tuesday's build).
//   - NA CO/NA CW never send same-week as their build — every NA slot is a full 7 days
//     out, except Monday's build, which additionally catches up the weekend (Sat +5,
//     Sun +6) since nobody builds Sat/Sun.
// A same-day-inclusive weekday scan (nextSendDate) cannot express either of those, so
// each column here is a fixed day-offset from its own block's build date instead.
// Column order matches the Country row order written into GRN Template exactly.
const GRN_BUILD_SCHEDULE = {
  Monday: [
    { country: 'UK', offsetDays: 3 }, { country: 'NL', offsetDays: 3 }, { country: 'UAE', offsetDays: 3 },
    { country: 'NA CO', offsetDays: 5 }, { country: 'NA CO', offsetDays: 6 }, { country: 'NA CO', offsetDays: 7 },
  ],
  Tuesday: [
    { country: 'AU', offsetDays: 3 }, { country: 'UK', offsetDays: 3 }, { country: 'PL', offsetDays: 3 },
    { country: 'IE', offsetDays: 3 }, { country: 'NA CO', offsetDays: 7 },
  ],
  Wednesday: [
    { country: 'ES', offsetDays: 3 }, { country: 'FR', offsetDays: 6 }, { country: 'NA CW', offsetDays: 7 },
  ],
  Thursday: [
    { country: 'DE', offsetDays: 4 }, { country: 'IE', offsetDays: 5 }, { country: 'NA CO', offsetDays: 7 },
  ],
  Friday: [
    { country: 'AU', offsetDays: 4 }, { country: 'IT', offsetDays: 4 }, { country: 'NA CO', offsetDays: 7 },
  ],
};

module.exports = {
  BF_CM_2026_OVERRIDES, COUNTRY_SEND_DAYS, DAY_NAMES, COUNTRY_BUILD_TIMEZONE, GRN_BUILD_SCHEDULE,
  nextSendDate, getSendDateForCountry, applyBfCmOverride, localDateString,
};
