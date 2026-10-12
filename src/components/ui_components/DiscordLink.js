import React from 'react';

export const DISCORD_INVITE_URL = 'https://discord.gg/3sTJxG9JHk';
const DISCORD_BLURPLE = '#5865F2';

export const DiscordLogo = ({ size = 18, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true">
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);

// "Join us on Discord" link. Electron's setWindowOpenHandler routes
// target="_blank" links to the system browser, so a plain anchor is enough.
// This is a community link, NOT a sign-in method — the copy says so, and the
// card variant keeps it visually apart from the auth buttons.
//   variant="card"    — explained community card (sign-in / register / account)
//   variant="compact" — subtle row for the Settings sidebar footer
const COMMUNITY_TOPICS = [
  'News on new feature releases',
  'Questions about using the app',
  'Suggestions for product features',
  'Chat with the wider Ternlux community',
];

const hoverHandlers = (on, off) => ({
  onMouseOver: e => Object.assign(e.currentTarget.style, on),
  onMouseOut: e => Object.assign(e.currentTarget.style, off),
});

const DiscordLink = ({ variant = 'card', style }) => {
  if (variant === 'compact') {
    return (
      <a
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        title="Join the Ternlux community on Discord for release news, questions and feature suggestions"
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px', borderRadius: 6, textDecoration: 'none',
          transition: 'background 0.15s', ...style,
        }}
        {...hoverHandlers({ background: 'rgba(88,101,242,0.08)' }, { background: 'transparent' })}
      >
        <DiscordLogo size={20} color={DISCORD_BLURPLE} />
        <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.3 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: '#262626' }}>Join the community</span>
          <span style={{ fontSize: 11, color: '#8c8c8c' }}>News, help &amp; ideas on Discord</span>
        </span>
      </a>
    );
  }

  return (
    <div
      style={{
        textAlign: 'left', border: '1px solid #e4e6fb', background: '#f6f7ff',
        borderRadius: 10, padding: 16, ...style,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <DiscordLogo size={22} color={DISCORD_BLURPLE} />
        <span style={{ fontSize: 14, fontWeight: 700, color: '#262626' }}>
          Join the Ternlux community
        </span>
      </div>
      <div style={{ fontSize: 13, color: '#595959', marginBottom: 6 }}>
        Our Discord server is where we share:
      </div>
      <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 13, color: '#595959', lineHeight: 1.6 }}>
        {COMMUNITY_TOPICS.map(t => <li key={t}>{t}</li>)}
      </ul>
      <div style={{ display: 'flex', justifyContent: 'center' }}>
      <a
        href={DISCORD_INVITE_URL}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '7px 14px', borderRadius: 6,
          border: `1px solid ${DISCORD_BLURPLE}`, color: DISCORD_BLURPLE, background: '#fff',
          fontSize: 13, fontWeight: 600, textDecoration: 'none',
          transition: 'background 0.15s, color 0.15s',
        }}
        {...hoverHandlers(
          { background: DISCORD_BLURPLE, color: '#fff' },
          { background: '#fff', color: DISCORD_BLURPLE },
        )}
      >
        <DiscordLogo size={16} />
        Join our Discord
      </a>
      </div>
    </div>
  );
};

export default DiscordLink;
