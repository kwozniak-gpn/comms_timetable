'use strict';

// lib/chat_notify.js — posts a short Google Chat alert when the status-poller flags a
// NEW 🚨 or hits an error it can't resolve on its own. Kasia's spec: "the message on
// chat should be condensed to just country, date and 2-3 words flag" — same terse
// convention as na_newsletter_automation/lib/chat_notify.js's postChatFlag, ported here.
//
// Fire-and-forget: a Chat post failing must never break the poller itself. Webhook URL
// comes from COMMS_TIMETABLE_CHAT_WEBHOOK_URL — confirm with Kasia whether this reuses
// the existing "Comms Chat" space (uk_newsletter_automation's COMMS_BLOCK_WEBHOOK_URL)
// or a new dedicated webhook before wiring a real value in.

const WEBHOOK_URL = process.env.COMMS_TIMETABLE_CHAT_WEBHOOK_URL;

async function postChatFlag(country, date, flag) {
  if (!WEBHOOK_URL) return; // not configured — fail silently, same as every sibling repo's chat_notify
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text: `🚨 ${country} ${date}: ${flag}` }),
    });
    if (!res.ok) console.error(`chat_notify: webhook returned ${res.status} (non-fatal)`);
  } catch (e) {
    console.error('chat_notify: post failed (non-fatal):', e.message);
  }
}

// Same channel, used for "I can't find an expected column/row/tab" errors — never
// fail silently (see jobs/status-poller.js's error-handling step).
async function postChatError(summary) {
  if (!WEBHOOK_URL) return;
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text: `⚠️ ${summary}` }),
    });
    if (!res.ok) console.error(`chat_notify: webhook returned ${res.status} (non-fatal)`);
  } catch (e) {
    console.error('chat_notify: post failed (non-fatal):', e.message);
  }
}

module.exports = { postChatFlag, postChatError };
