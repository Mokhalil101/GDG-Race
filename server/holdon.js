'use strict';
/**
 * The "Hold on!" page (design: StationLocked). Served with HTTP 403 for any game page opened without a station,
 * and with a different message when the station was closed or the launch link is no good.
 */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const VARIANTS = {
  locked: {
    title: 'Hold on!',
    lead: 'Games start at the game stations.',
    body: 'Find someone from the <b>Registration Team</b> (green badge) and they\'ll open a game for you. Then scan your ticket and your score goes on the event leaderboard.',
  },
  closed: {
    title: 'Station closed',
    lead: 'This station was closed by the Registration Team.',
    body: 'Thanks for playing! Ask someone from the <b>Registration Team</b> (green badge) if you want another game opened.',
  },
  expired: {
    title: 'Hold on!',
    lead: 'This game link has expired.',
    body: 'Station links only work on the day they were opened. Ask the <b>Registration Team</b> (green badge) to open the station again.',
  },
  unreachable: {
    title: 'Hold on!',
    lead: 'We couldn\'t check this station right now.',
    body: 'The event platform didn\'t answer. Wait a few seconds and try again, or ask the <b>Registration Team</b> (green badge) for help.',
  },
};

function stars() {
  const rnd = (i, m) => ((Math.sin(i * 47.3) * 43758.5453) % 1 + 1) % 1 * m;
  let html = '';
  for (let i = 0; i < 40; i++) {
    const s = 2 + Math.round(rnd(i + 3, 3));
    html += '<span class="star" style="left:' + (rnd(i, 100)).toFixed(1) + '%;top:' + rnd(i + 1, 100).toFixed(1) + '%;width:' + s + 'px;height:' + s +
      'px;animation-duration:' + (1.5 + rnd(i + 5, 2)).toFixed(1) + 's;animation-delay:-' + rnd(i + 7, 2).toFixed(1) + 's"></span>';
  }
  return html;
}

/** The padlock mascot + copy; also reused (as markup) inside the big-screen pages. */
function lockMarkup() {
  return '<div class="lock-mascot" aria-hidden="true"><div class="lock-bob">' +
    '<div class="shackle"></div><div class="shackle-in"></div>' +
    '<div class="lock-body"><span class="eye l"></span><span class="eye r"></span><span class="glint l"></span><span class="glint r"></span>' +
    '<span class="mouth"></span><span class="cheek l"></span><span class="cheek r"></span></div></div></div>';
}

function renderHoldOn({ basePath = '', variant = 'locked', signInUrl = '' } = {}) {
  const v = VARIANTS[variant] || VARIANTS.locked;
  return '<!doctype html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>Hold on - GDG Games</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&display=swap" rel="stylesheet">' +
    '<link rel="stylesheet" href="' + esc(basePath) + '/station.css"></head>' +
    '<body class="holdon-page"><main class="holdon" data-variant="' + esc(variant) + '">' + stars() + lockMarkup() +
    '<section class="holdon-copy"><h1 class="holdon-title">' + esc(v.title) + '</h1>' +
    '<p class="holdon-lead">' + esc(v.lead) + '</p><p class="holdon-body">' + v.body + '</p>' +
    '<div class="holdon-chips"><span class="holdon-chip"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1b1340" stroke-width="2.5" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3M21 14v7h-7v-3"/></svg>A game is already on screen? Scan its room QR</span></div>' +
    (signInUrl ? '<a class="holdon-link" href="' + esc(signInUrl) + '">Registration Team member? Sign in to open a station</a>' : '') +
    '</section></main></body></html>\n';
}

module.exports = { renderHoldOn, lockMarkup, VARIANTS };
