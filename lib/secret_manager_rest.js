// lib/secret_manager_rest.js — fetches a Secret Manager secret's latest version via
// plain REST + Application Default Credentials. Ported verbatim from
// na_newsletter_automation/lib/secret_manager_rest.js.
const { getAccessToken } = require('./gcp_access_token');

// Returns the secret's raw payload as a UTF-8 string. Caller decides how to parse it.
async function getSecret(projectId, secretName, attempt = 1) {
  const token = await getAccessToken();
  const url = `https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/${secretName}/versions/latest:access`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`Secret Manager ${res.status} for ${secretName}: ${await res.text()}`);
    const { payload } = await res.json();
    return Buffer.from(payload.data, 'base64').toString('utf8');
  } catch (err) {
    if (attempt >= 3) throw err;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** (attempt - 1)));
    return getSecret(projectId, secretName, attempt + 1);
  }
}

module.exports = { getSecret, getAccessToken };
