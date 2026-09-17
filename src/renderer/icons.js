'use strict';
/*
 * The built-in icon set. Each entry is the inside of a 24x24 SVG drawn with
 * strokes only, so it takes whatever colour the surrounding text has. To replace
 * an icon, replace its paths here; to add a kind of piece, add it both here and
 * to PIECE_TYPES in src/core/timecard.js.
 */
const ICONS = {
  earrings:
    '<path d="M7.5 3v4.5M16.5 3v4.5"/>' +
    '<path d="M7.5 7.5c-2 2.6-3 4.6-3 6.3a3 3 0 0 0 6 0c0-1.7-1-3.7-3-6.3z"/>' +
    '<path d="M16.5 7.5c-2 2.6-3 4.6-3 6.3a3 3 0 0 0 6 0c0-1.7-1-3.7-3-6.3z"/>',
  ring:
    '<circle cx="12" cy="15" r="6"/>' +
    '<path d="M9.3 6.2 12 9l2.7-2.8-1.3-2.2h-2.8z"/>',
  pendant:
    '<path d="M4 3c1.3 4.8 4.2 7.8 8 9 3.8-1.2 6.7-4.2 8-9"/>' +
    '<path d="M12 12v1.8"/>' +
    '<path d="m12 13.8 3 3.6-3 3.6-3-3.6z"/>',
  chain:
    '<rect x="2.5" y="8.5" width="9" height="7" rx="3.5"/>' +
    '<rect x="12.5" y="8.5" width="9" height="7" rx="3.5"/>' +
    '<path d="M9 12h6"/>',
  bracelet:
    '<ellipse cx="12" cy="10.5" rx="8.5" ry="5.5"/>' +
    '<path d="M12 16v1.5"/>' +
    '<circle cx="12" cy="19.3" r="1.8"/>',
  cuff:
    '<path d="M8.2 5.2a8 8 0 1 0 7.6 0"/>' +
    '<path d="M9.7 8.5a4.5 4.5 0 1 0 4.6 0"/>' +
    '<path d="m8.2 5.2 1.5 3.3M15.8 5.2l-1.5 3.3"/>',
  brooch:
    '<ellipse cx="12" cy="10" rx="7.5" ry="5.5"/>' +
    '<ellipse cx="12" cy="10" rx="3" ry="2"/>' +
    '<path d="M3 19h17.5M18.5 17l2.5 2-2.5 2"/>',
  custom:
    '<path d="m12 3 2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1z"/>',
  other:
    '<path d="M6.5 4h11L22 9.5 12 20.5 2 9.5z"/>' +
    '<path d="M2 9.5h20"/>' +
    '<path d="M9.5 4 8 9.5l4 11 4-11L14.5 4"/>',
  overhead:
    '<circle cx="12" cy="12" r="8.5"/>' +
    '<path d="M12 7v5l3.2 2"/>',
  // interface glyphs
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  camera:
    '<path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/>' +
    '<circle cx="12" cy="13" r="3.5"/>',
  none: '<circle cx="12" cy="12" r="8.5"/><path d="m6 18 12-12"/>',
};

function iconSvg(id) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[id] || ICONS.other}</svg>`;
}
