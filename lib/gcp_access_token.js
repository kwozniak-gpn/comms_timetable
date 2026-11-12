// lib/gcp_access_token.js — shared Cloud Run / local access-token fetch.
// Ported verbatim from na_newsletter_automation/lib/gcp_access_token.js (itself ported
// from uk_newsletter_automation) — same retry-then-fail-fast behavior inside a Cloud Run
// Job (no gcloud CLI binary in that image), gcloud CLI fallback for local/laptop runs.
// In-process cache — avoids re-shelling to `gcloud auth print-access-token` (slow,
// observed to take many seconds per call in this environment) on every single Sheets/
// Secret Manager REST call within one script run. Tokens are valid ~1hr; refresh a
// couple minutes early to be safe. Keyed by impersonateServiceAccount so a script using
// multiple identities doesn't cross-contaminate.
const _tokenCache = new Map(); // key -> { token, expiresAt }
const TOKEN_TTL_MS = 50 * 60 * 1000;

async function getAccessToken({ impersonateServiceAccount } = {}) {
  const cacheKey = impersonateServiceAccount || '__default__';
  const cached = _tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const token = await _fetchAccessToken({ impersonateServiceAccount });
  _tokenCache.set(cacheKey, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

async function _fetchAccessToken({ impersonateServiceAccount } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(
        'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
        { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(2000) },
      );
      if (res.ok) return (await res.json()).access_token;
    } catch { /* retry below, or fall through once attempts are exhausted */ }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 500));
  }

  if (process.env.CLOUD_RUN_JOB) {
    throw new Error('getAccessToken: metadata server unreachable after 3 attempts, and this is a Cloud Run Job — the gcloud CLI fallback does not exist in this image, so there is no further fallback to try.');
  }

  const { execFileSync } = require('child_process');
  const args = ['auth', 'print-access-token'];
  if (impersonateServiceAccount) args.push(`--impersonate-service-account=${impersonateServiceAccount}`);
  return execFileSync('gcloud', args, {
    encoding: 'utf8', shell: process.platform === 'win32',
  }).trim();
}

module.exports = { getAccessToken };
