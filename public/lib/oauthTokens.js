/**
 * Keep OAuth connections' access tokens fresh, and save what a refresh returns.
 *
 * Every OAuth connector (Google, Microsoft, Dropbox, Salesforce, the ad
 * platforms…) gets a short-lived access token and a refresh token when the
 * user signs in. Before this module, each connector refreshed the access token
 * in memory and nothing wrote the result back, so:
 *   - every run in a new app session refreshed again from the original token,
 *   - a provider that ROTATES refresh tokens (Microsoft, Salesforce when set
 *     up that way, Pinterest, Outreach, Zoho with some settings) eventually
 *     rejected the original one, and the connection broke until the user
 *     signed in again.
 *
 * `ensureFreshOAuthConfig` runs inside getFullConfig — the one place every
 * caller (node runs, chat runs, Test connection, table listing) goes through
 * to read a saved connection's secrets — so all of them see a valid token and
 * every refresh is saved: the tokens to the encrypted credential store, the
 * expiry to the connection record.
 *
 * Refreshes for one connection are serialised. Two runs that start together
 * share one refresh instead of both spending the same rotating refresh token,
 * where the second would fail and could revoke the first.
 */

// Refresh a little before the provider's expiry, so a token never expires
// between this check and the request that uses it.
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

const inflight = new Map();

function isOAuthPlugin(plugin) {
  return !!plugin && plugin.authType === 'oauth2' && typeof plugin.refreshAccessToken === 'function';
}

/**
 * Whether the saved token needs refreshing. A token with no recorded expiry is
 * left alone (some providers' tokens never expire — Slack, Meta system users);
 * the 401 retry in ApiFetch covers the case where it had expired after all.
 */
function needsRefresh(config, now = Date.now()) {
  if (!config || !config.refreshToken) return false;
  if (!config.accessToken) return true;
  const expiry = Number(config.expiryDate) || 0;
  if (!expiry) return false;
  return now >= expiry - REFRESH_MARGIN_MS;
}

/**
 * Return `config` with a valid access token, refreshing and saving first when
 * it is (nearly) expired, or always when `force` is set (after a 401).
 *
 * @param {object} p
 * @param {string} p.connectionId
 * @param {object} p.config      the merged, decrypted connection config
 * @param {object} p.plugin      the connection's connector plugin
 * @param {Function} p.persist   async (connectionId, secretFields, publicFields)
 *                               saves the new values; secret fields go to the
 *                               encrypted store, public ones to the connection record
 * @param {boolean} [p.force]
 * @returns {Promise<object>}    the config to use. On a failed refresh this is
 *                               the original config plus `oauthRefreshError`,
 *                               so the request still runs and reports the
 *                               provider's own error instead of a generic one.
 */
async function ensureFreshOAuthConfig({ connectionId, config, plugin, persist, force = false }) {
  if (!connectionId || !isOAuthPlugin(plugin)) return config;
  if (!force && !needsRefresh(config)) return config;
  if (!config.refreshToken) return config;

  if (inflight.has(connectionId)) {
    const shared = await inflight.get(connectionId);
    // The shared refresh may have been started with an older copy of the
    // config; keep this caller's other fields and take only the new tokens.
    return { ...config, ...pickTokens(shared) };
  }

  const run = (async () => {
    let result;
    try {
      result = await plugin.refreshAccessToken(config);
    } catch (err) {
      result = { success: false, message: err.message };
    }
    const tokens = result && result.success !== false ? (result.tokens || null) : null;
    if (!tokens || !tokens.accessToken) {
      const reason = (result && (result.message || result.error)) || 'the provider returned no access token';
      console.warn(`[oauth] Could not refresh the token for connection ${connectionId}: ${reason}`);
      return { ...config, oauthRefreshError: reason };
    }

    const next = {
      ...config,
      accessToken: tokens.accessToken,
      // A provider that does not rotate leaves refresh_token out of the
      // response; the one we have stays valid.
      refreshToken: tokens.refreshToken || config.refreshToken,
      expiryDate: tokens.expiryDate || null,
    };
    // Values a connector learns on refresh that the requests need (Salesforce's
    // instance URL can change when an org moves). Public, not secret.
    const extra = result.extra && typeof result.extra === 'object' ? result.extra : {};
    Object.assign(next, extra);

    try {
      await persist(
        connectionId,
        { accessToken: next.accessToken, refreshToken: next.refreshToken },
        { expiryDate: next.expiryDate, ...extra },
      );
    } catch (err) {
      // The refreshed token still works for this run; only the next app
      // session will refresh again. Never fail the request over it.
      console.warn(`[oauth] Refreshed the token for ${connectionId} but could not save it: ${err.message}`);
    }
    return next;
  })();

  inflight.set(connectionId, run);
  try {
    return await run;
  } finally {
    inflight.delete(connectionId);
  }
}

function pickTokens(cfg) {
  const out = {};
  for (const k of ['accessToken', 'refreshToken', 'expiryDate', 'oauthRefreshError']) {
    if (cfg && cfg[k] !== undefined) out[k] = cfg[k];
  }
  return out;
}

/** An axios-style error that means "this token was not accepted". */
function isAuthRejection(err) {
  const status = err && (err.response ? err.response.status : err.status);
  return status === 401;
}

module.exports = {
  REFRESH_MARGIN_MS,
  isOAuthPlugin,
  needsRefresh,
  ensureFreshOAuthConfig,
  isAuthRejection,
};
