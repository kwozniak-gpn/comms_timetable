// lib/vc_template.js — VC's recurring weekly send slots, Kasia's exact values
// (10 Nov 2026 brainstorm, locked in project_comms_status_dashboard_design memory).
// Static/frozen data — these newsletters don't change week to week, only the actual
// week's calendar dates do (handled by jobs/weekly-setup.js's date-remap step, same as
// the GRN side). "Who's building?" on every one of these was Hannah — now moot, the
// template itself renames that row to "Who activated?" (one-time edit, see
// scripts/one_time_template_edits.js), so it's deliberately NOT repeated here.
const VC_RECURRING_SENDS = [
  {
    newsletterName: 'UK Weekly Newsletters', day: 'Tuesday',
    segmentName: 'Newsletter_Tuesday_All', segmentSize: '828,000',
    scheduleTime: '17:05 STO 3 hours (17:00-20:00)', exceedMessaging: 'Yes',
  },
  {
    newsletterName: 'UK Weekly Newsletters', day: 'Thursday',
    segmentName: 'Newsletter_Thursday_All', segmentSize: '1.7mil',
    scheduleTime: '14:02 STO 5 hours', exceedMessaging: 'Yes',
  },
  {
    newsletterName: 'IE Newsletter', day: 'Tuesday',
    segmentName: 'Newsletter_Tuesday', segmentSize: '75,000',
    scheduleTime: '17:05', exceedMessaging: '',
  },
  {
    newsletterName: 'IE Newsletter', day: 'Friday',
    segmentName: 'Newsletter_Friday_2025', segmentSize: '75,000',
    scheduleTime: '12:05', exceedMessaging: '',
  },
  {
    newsletterName: 'Weekly Round-Up', day: 'Friday',
    segmentName: 'OfferAlerts_GroupA+B', segmentSize: '583,013',
    scheduleTime: '00:00', exceedMessaging: '',
  },
  {
    newsletterName: 'Rewards', day: 'Monday',
    segmentName: 'OfferAlerts_GroupA_14Days', segmentSize: '695,000',
    scheduleTime: '00:00', exceedMessaging: '',
  },
  {
    newsletterName: 'IE Rewards', day: 'Monday',
    segmentName: 'Offeralerts_Engaged', segmentSize: '30,000',
    scheduleTime: '07:10', exceedMessaging: '',
  },
];

module.exports = { VC_RECURRING_SENDS };
