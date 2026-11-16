/**
 * Popup Light / Dark / System switch.
 *
 * Loaded in <head> so the saved choice applies before the page paints.
 * "system" (the default) removes data-theme, so popup.css follows the
 * computer's prefers-color-scheme. The choice is kept per browser in
 * localStorage; settings sync stays limited to the extension's own settings.
 */
(function () {
  'use strict';

  const KEY = 'ocs-popup-theme';
  const CHOICES = ['system', 'light', 'dark'];

  function read() {
    try {
      const value = localStorage.getItem(KEY);
      return CHOICES.includes(value) ? value : 'system';
    } catch (_) {
      return 'system';
    }
  }

  function apply(choice) {
    const root = document.documentElement;
    if (choice === 'light' || choice === 'dark') root.setAttribute('data-theme', choice);
    else root.removeAttribute('data-theme');
    for (const button of document.querySelectorAll('.theme-switch button')) {
      button.setAttribute('aria-checked', button.dataset.theme === choice ? 'true' : 'false');
      button.tabIndex = button.dataset.theme === choice ? 0 : -1;
    }
  }

  function save(choice) {
    try { localStorage.setItem(KEY, choice); } catch (_) { /* private mode: apply for this view only */ }
    apply(choice);
  }

  apply(read());

  document.addEventListener('DOMContentLoaded', () => {
    const buttons = Array.from(document.querySelectorAll('.theme-switch button'));
    apply(read());
    buttons.forEach((button, index) => {
      button.addEventListener('click', () => save(button.dataset.theme));
      // Radio-group keys: arrows move and select.
      button.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const step = e.key === 'ArrowRight' ? 1 : -1;
        const next = buttons[(index + step + buttons.length) % buttons.length];
        save(next.dataset.theme);
        next.focus();
      });
    });
  });
})();
