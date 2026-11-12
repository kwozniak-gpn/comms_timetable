// lib/gcs_marker_rest.js — durable key/value "has this already happened" marker,
// stored as a small JSON object in Cloud Storage via plain REST + Application
// Default Credentials. Ported verbatim from na_newsletter_automation/lib/
// gcs_marker_rest.js. Used here to dedup "only Chat-ping on a genuinely NEW 🚨" —
// last-known-status-per-cell, keyed by week-tab name.
const { getAccessToken: getToken } = require('./gcp_access_token');
const IMPERSONATE_SA = process.env.GCP_IMPERSONATE_SA || 'grpn-sa-terraform-couponscrm@prj-grp-central-sa-prod-0b25.iam.gserviceaccount.com';
function getAccessToken() {
  // Only impersonate when explicitly running as a human locally; inside Cloud Run the
  // metadata-server branch in gcp_access_token.js answers first and this is unused.
  return process.env.CLOUD_RUN_JOB ? getToken() : getToken({ impersonateServiceAccount: IMPERSONATE_SA });
}

async function writeMarker(bucket, objectName, data) {
  const token = await getAccessToken();
  const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`GCS marker write ${res.status} for ${objectName}: ${await res.text()}`);
}

async function deleteMarker(bucket, objectName) {
  const token = await getAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) throw new Error(`GCS marker delete ${res.status} for ${objectName}: ${await res.text()}`);
}

async function readMarker(bucket, objectName) {
  const token = await getAccessToken();
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GCS marker read ${res.status} for ${objectName}: ${await res.text()}`);
  return res.json();
}

async function acquireLock(bucket, objectName, { staleMs = 10 * 60 * 1000, holder } = {}) {
  const token = await getAccessToken();
  const payload = JSON.stringify({ acquiredAt: new Date().toISOString(), holder: holder || 'unknown' });
  const createUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}&ifGenerationMatch=0`;
  const createRes = await fetch(createUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload,
  });
  if (createRes.ok) return true;
  if (createRes.status !== 412) throw new Error(`GCS lock acquire ${createRes.status} for ${objectName}: ${await createRes.text()}`);

  const existing = await readMarker(bucket, objectName);
  const age = existing && existing.acquiredAt ? Date.now() - new Date(existing.acquiredAt).getTime() : Infinity;
  if (age <= staleMs) return false;

  await writeMarker(bucket, objectName, JSON.parse(payload));
  return true;
}

async function releaseLock(bucket, objectName) {
  await deleteMarker(bucket, objectName);
}

module.exports = { writeMarker, deleteMarker, readMarker, acquireLock, releaseLock };
