// apperture icon system — custom Signal Desk glyphs (24×24 viewBox).
// Optical balance for dark glass overlays: 1.75 stroke, round caps, sparse fills.
// icon(name, { size, stroke }) -> SVG markup string.
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  const STROKE = {
    // Assist — four-point spark + satellite ticks
    sparkles:
      '<path d="M12 2.8 13.35 8.55a1.55 1.55 0 0 0 1.0 1.0L20 10.9l-5.65 1.35a1.55 1.55 0 0 0-1.0 1.0L12 18.9l-1.35-5.65a1.55 1.55 0 0 0-1.0-1.0L4 10.9l5.65-1.35a1.55 1.55 0 0 0 1.0-1.0Z"/>' +
      '<path d="M18.4 3.6v2.8M19.8 5h-2.8"/>' +
      '<path d="M5.4 16.6v2.2M6.5 17.7H4.3"/>',

    // What should I say — reply wand with soft sparks
    'wand-sparkles':
      '<path d="M4.2 19.8 14.6 9.4"/>' +
      '<path d="M13.4 8.2 15.8 10.6"/>' +
      '<path d="M16.4 3.9 20.1 7.6a1.15 1.15 0 0 1 0 1.62L18.4 10.9 13.1 5.6 14.8 3.9a1.15 1.15 0 0 1 1.62 0Z"/>' +
      '<path d="M7.9 3.9v2.3M9.05 5.05H6.75"/>' +
      '<path d="M19.7 13.9v2.3M20.85 15.05h-2.3"/>',

    // Follow-up — soft bubble with signal dashes
    'message-circle':
      '<path d="M19.85 12.15a7.85 7.85 0 0 1-11.2 7.05L3.9 20.5l1.5-4.4A7.85 7.85 0 1 1 19.85 12.15Z"/>' +
      '<path d="M9 11.9h6M9 9.15h4.1"/>',

    // Recap — balanced refresh arrows
    'refresh-cw':
      '<path d="M20.2 11a8.2 8.2 0 0 0-14.55-4.25L4 9"/>' +
      '<path d="M4 4.2v4.9h4.9"/>' +
      '<path d="M3.8 13a8.2 8.2 0 0 0 14.55 4.25L20 15"/>' +
      '<path d="M20 19.8v-4.9h-4.9"/>',

    // Smart — taut bolt
    zap: '<path d="M13.35 2.9 6.1 13.35h4.85L9.85 21.1 17.9 10.1h-4.9Z"/>',

    // Resume — document with lines
    'file-text':
      '<path d="M13.6 3.4H7.4A1.9 1.9 0 0 0 5.5 5.3v13.4A1.9 1.9 0 0 0 7.4 20.6h9.2a1.9 1.9 0 0 0 1.9-1.9V8.55Z"/>' +
      '<path d="M13.6 3.4v4.35h4.35"/>' +
      '<path d="M8.6 12.1h6.7M8.6 15.2h4.8"/>',

    'chevron-down': '<path d="m6.8 9.2 5.2 5.2 5.2-5.2"/>',
    'chevron-up': '<path d="m6.8 14.8 5.2-5.2 5.2 5.2"/>',

    x: '<path d="M6.9 6.9 17.1 17.1"/><path d="M17.1 6.9 6.9 17.1"/>',

    'more-horizontal':
      '<circle cx="5.2" cy="12" r="1.45" fill="currentColor" stroke="none"/>' +
      '<circle cx="12" cy="12" r="1.45" fill="currentColor" stroke="none"/>' +
      '<circle cx="18.8" cy="12" r="1.45" fill="currentColor" stroke="none"/>',

    settings:
      '<circle cx="12" cy="12" r="3.15"/>' +
      '<path d="M12 3.15v2.2M12 18.65v2.2M3.15 12h2.2M18.65 12h2.2"/>' +
      '<path d="M5.7 5.7l1.55 1.55M16.75 16.75l1.55 1.55M18.3 5.7l-1.55 1.55M7.25 16.75l-1.55 1.55"/>',

    'message-square-text':
      '<path d="M19.6 4.9H4.4A1.75 1.75 0 0 0 2.65 6.65v8.7A1.75 1.75 0 0 0 4.4 17.1h3.35l3.55 3.35 3.45-3.35H19.6a1.75 1.75 0 0 0 1.75-1.75v-8.7A1.75 1.75 0 0 0 19.6 4.9Z"/>' +
      '<path d="M7.2 9.05h7.7M7.2 12.35h5.2"/>',

    'trash-2':
      '<path d="M4.2 7h15.6"/>' +
      '<path d="M9 7V5.25A1.45 1.45 0 0 1 10.45 3.8h3.1A1.45 1.45 0 0 1 15 5.25V7"/>' +
      '<path d="M18.4 7v11.4a1.9 1.9 0 0 1-1.9 1.9H7.5a1.9 1.9 0 0 1-1.9-1.9V7"/>' +
      '<path d="M10 11v5.2M14 11v5.2"/>',

    key:
      '<circle cx="8" cy="15.2" r="4.35"/>' +
      '<path d="M11.35 12.1 19.4 4.05"/>' +
      '<path d="M16.7 4.2h3.45v3.45"/>',

    shield:
      '<path d="M12 3.1 19.5 5.9v5.65c0 4.55-3 7.45-7.5 8.9-4.5-1.45-7.5-4.35-7.5-8.9V5.9Z"/>' +
      '<path d="m9 12 2.05 2.05 4.05-4.15"/>',

    'eye-off':
      '<path d="M3.2 3.2 20.8 20.8"/>' +
      '<path d="M10.05 10.2a2.7 2.7 0 0 0 3.75 3.75"/>' +
      '<path d="M6.9 7.05A10.7 10.7 0 0 0 3.15 12c1.55 3.65 4.9 6.25 8.85 6.25 1.55 0 3-.35 4.3-1"/>' +
      '<path d="M14.85 8.9A10.5 10.5 0 0 1 20.85 12c-.5 1.15-1.15 2.2-1.95 3.1"/>',

    check: '<path d="m5.2 12.1 4.4 4.4 9.2-9.6"/>',

    // Listen idle — capsule mic
    mic:
      '<rect x="9.05" y="3.2" width="5.9" height="10.6" rx="2.95"/>' +
      '<path d="M6.15 11.5a5.85 5.85 0 0 0 11.7 0"/>' +
      '<path d="M12 17.2v3.6M8.8 20.8h6.4"/>',

    // Screen / display
    monitor:
      '<rect x="3.2" y="4.2" width="17.6" height="11.8" rx="2.1"/>' +
      '<path d="M8.2 19.6h7.6M12 16v3.6"/>',

    // Send — taut arrow (composer)
    send:
      '<path d="M5.1 12h13.2"/>' +
      '<path d="M12.4 5.6 19.1 12l-6.7 6.4"/>'
  };

  const FILLED = {
    play:
      '<path d="M8.05 5.15v13.7a1.05 1.05 0 0 0 1.62.88l10.55-6.85a1.05 1.05 0 0 0 0-1.76L9.67 4.27A1.05 1.05 0 0 0 8.05 5.15Z"/>',
    'stop-square':
      '<rect x="6" y="6" width="12" height="12" rx="2.75"/>',
    // Listen active — solid capsule + stroke yoke (hybrid drawn below)
    'listen-active': null
  };

  const LOGO =
    '<svg viewBox="0 0 24 24" width="SIZE" height="SIZE" fill="none" xmlns="' + NS + '" aria-hidden="true">' +
    '<circle cx="12" cy="4.95" r="2.45" fill="currentColor"/>' +
    '<rect x="10.25" y="7" width="3.5" height="10.9" rx="1.75" fill="currentColor"/>' +
    '<path d="M6.9 19.55h10.2" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" opacity="0.45"/>' +
    '</svg>';

  function listenActive(size) {
    return (
      '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" xmlns="' + NS + '" aria-hidden="true">' +
      '<rect x="9.05" y="3.2" width="5.9" height="10.6" rx="2.95" fill="currentColor"/>' +
      '<path d="M6.15 11.5a5.85 5.85 0 0 0 11.7 0" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>' +
      '<path d="M12 17.2v3.6M8.8 20.8h6.4" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/>' +
      '</svg>'
    );
  }

  function svgStroke(body, size, stroke) {
    return (
      '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" ' +
      'stroke-width="' + stroke + '" stroke-linecap="round" stroke-linejoin="round" ' +
      'vector-effect="non-scaling-stroke" xmlns="' + NS + '" aria-hidden="true">' +
      body +
      '</svg>'
    );
  }

  function svgFill(body, size) {
    return (
      '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="currentColor" stroke="none" ' +
      'xmlns="' + NS + '" aria-hidden="true">' +
      body +
      '</svg>'
    );
  }

  function icon(name, opts) {
    opts = opts || {};
    const size = opts.size || 16;
    const stroke = opts.stroke != null ? opts.stroke : 1.75;
    if (name === 'logo') return LOGO.replaceAll('SIZE', String(size));
    if (name === 'listen-active') return listenActive(size);
    if (name === 'square') return svgFill(FILLED['stop-square'], size);
    if (FILLED[name]) return svgFill(FILLED[name], size);
    if (STROKE[name]) return svgStroke(STROKE[name], size, stroke);
    return '';
  }

  window.ICONS = { icon };
})();
