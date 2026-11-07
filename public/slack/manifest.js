/**
 * The Slack app manifest a user pastes into api.slack.com to create THIS
 * computer's Ternlux bot. One app per computer: Slack delivers an app's events
 * only to connections opened with that app's tokens, so two computers with two
 * apps never split each other's messages.
 * https://docs.slack.dev/reference/app-manifest
 */

const os = require('os');

const NAME_MAX = 35; // Slack's limit for an app name
// The bot user's display name is its handle: Slack allows only a-z, 0-9, '-',
// '_' and '.', and asks for fewer than 22 characters.
const HANDLE_MAX = 21;

const BOT_SCOPES = [
  'app_mentions:read', // @mentions in channels (answered with "DMs only" for now)
  'chat:write',        // replies
  'im:history',        // read direct messages to the bot
  'im:read',
  'im:write',
  'files:read',        // download files sent to the bot (→ connections)
  'files:write',       // upload charts and CSVs
  'reactions:write',   // the ⏳ "working" reaction
  'users:read',        // names for paired users
];

// "Alexs-MacBook-Air.local" → "Alexs MacBook Air"
function computerName(hostname = os.hostname()) {
  return String(hostname || 'this computer')
    .replace(/\.(local|lan|home)$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'this computer';
}

const defaultBotName = (hostname) => `Ternlux · ${computerName(hostname)}`.slice(0, NAME_MAX);

// What Slack accepts as a name: printable, at most 35 characters.
function cleanName(name) {
  const n = String(name || '').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return n || defaultBotName();
}

/**
 * The bot user's handle for an app name: "Ternlux · MacBook Air 13" →
 * "ternlux-macbookair13". Words are hyphenated while that fits, run together
 * when it does not, and cut as a last resort.
 */
function botHandle(name) {
  const words = String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9]+/g) || [];
  const rest = words[0] === 'ternlux' ? words.slice(1) : words;
  if (!rest.length) return 'ternlux';
  const spaced = `ternlux-${rest.join('-')}`;
  if (spaced.length <= HANDLE_MAX) return spaced;
  return `ternlux-${rest.join('')}`.slice(0, HANDLE_MAX).replace(/[-_.]+$/, '');
}

function buildManifest(name) {
  const display = cleanName(name);
  return {
    display_information: {
      name: display,
      description: 'Ask Ternlux about your data, workflows and runs from Slack.',
      background_color: '#1d4ed8',
    },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: botHandle(display), always_online: false },
    },
    oauth_config: { scopes: { bot: BOT_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: ['message.im', 'app_mention'] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

// Opens Slack's "create app from manifest" with this manifest filled in.
const createAppUrl = (manifest) => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;

module.exports = { buildManifest, createAppUrl, defaultBotName, computerName, cleanName, botHandle, BOT_SCOPES, NAME_MAX, HANDLE_MAX };
