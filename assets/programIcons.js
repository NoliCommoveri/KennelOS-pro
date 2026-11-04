// programIcons.js — the icons a waitlist program can show on the public list
// (vocab WAITLIST_PROGRAM_ICON; End-State guide §29 Public list). Inline SVG, no
// files to fetch. cloud/public/family/common.js keeps an identical copy for the
// family pages (they're served apart from the app); tests/familyPages.test.js
// fails if the two drift.
export const PROGRAM_ICON_SVG = {
  star: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#d49b0b" d="M12 2.5l2.9 6.1 6.6.7-4.9 4.5 1.4 6.6L12 17l-5.9 3.4 1.4-6.6-4.9-4.5 6.6-.7z"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#2f9e5b"/><path d="M7 12.5l3.3 3.3L17 9" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  heart: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#d64545" d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.1 0 3.6 1.1 5.3 3 1.7-1.9 3.2-3 5.3-3 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"/></svg>',
  ribbon: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8.8 21.5L15.6 10.6C17.6 7.3 16 2.8 12 2.8S6.4 7.3 8.4 10.6L15.2 21.5" fill="none" stroke="#d9559a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  medal: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 2h4l2 6H9zM13 2h4l-2 6h-2z" fill="#3f6fb5"/><circle cx="12" cy="15.5" r="6" fill="#c9971c"/><path fill="#fff" d="M12 11.8l1.1 2.3 2.5.3-1.9 1.7.5 2.5-2.2-1.3-2.2 1.3.5-2.5-1.9-1.7 2.5-.3z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4a6b8a" d="M12 2.5l8 3v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6z"/></svg>',
  paw: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g fill="#8a5a3c"><ellipse cx="6.2" cy="10" rx="2.1" ry="2.6"/><ellipse cx="10" cy="5.8" rx="2.1" ry="2.7"/><ellipse cx="14" cy="5.8" rx="2.1" ry="2.7"/><ellipse cx="17.8" cy="10" rx="2.1" ry="2.6"/><path d="M12 11c3 0 5.6 3.4 5.6 6.1 0 2.1-1.6 3.1-3.3 2.6-.9-.3-1.5-.5-2.3-.5s-1.4.2-2.3.5c-1.7.5-3.3-.5-3.3-2.6C6.4 14.4 9 11 12 11z"/></g></svg>'
};

// A program's icon in her own pages (the waitlist, a family's entry, Programs):
// the drawing, titled with what it does, or '' without one.
export function programIconHtml(program, title = 'Its icon on the public list') {
  const svg = PROGRAM_ICON_SVG[program?.public_icon];
  return svg ? `<span class="program-icon" title="${String(title).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)}">${svg}</span>` : '';
}
