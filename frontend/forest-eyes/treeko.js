/**
 * Forest Eyes — Treeko chat button (treeko.js)
 * ============================================
 * Loaded AFTER app.js. app.js calls ForestTreeko.setSeverity(severity.color) whenever an
 * analysis result is shown, and Treeko's picture follows it:
 *
 *   red    (VERY HIGH deforestation)  → treeko-high.png
 *   orange (MODERATE deforestation)   → treeko-moderate.png
 *   yellow (LOW deforestation)        → treeko-low.png
 *   green  (NEGLIGIBLE deforestation) → treeko-low.png   (also shown before any analysis)
 *
 * Clicking the button fires a `treeko:open` event on window, with the current mood, for
 * the chat window to listen to:
 *   window.addEventListener('treeko:open', e => openChat(e.detail.mood));
 */
(function () {
  'use strict';

  const MOOD_FOR_SEVERITY = { red: 'high', orange: 'moderate', yellow: 'low', green: 'low' };
  const MOOD_TEXT = {
    high: 'high deforestation',
    moderate: 'moderate deforestation',
    low: 'low deforestation',
  };

  const btn = document.getElementById('treeko-btn');
  if (!btn) return;
  let mood = MOOD_TEXT[btn.dataset.mood] ? btn.dataset.mood : 'low';

  function setMood(next) {
    if (!MOOD_TEXT[next] || next === mood) return;
    mood = next;
    btn.dataset.mood = next; // CSS shows the matching picture
    btn.setAttribute('aria-label', `Open Treeko chat assistant (current area: ${MOOD_TEXT[next]})`);
    btn.classList.remove('treeko-pop');
    void btn.offsetWidth; // restart the little "pop" animation
    btn.classList.add('treeko-pop');
  }

  /** @param {string} color — severity.color from app.js getSeverityLevel() */
  function setSeverity(color) {
    setMood(MOOD_FOR_SEVERITY[color] || 'low');
  }

  btn.addEventListener('animationend', () => btn.classList.remove('treeko-pop'));
  btn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('treeko:open', { detail: { mood } }));
  });

  window.ForestTreeko = { setSeverity, setMood, getMood: () => mood };
})();
