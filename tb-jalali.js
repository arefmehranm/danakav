/*
 * Persian (Jalali / Shamsi) calendar for the embedded ThingsBoard Angular UI.
 *
 * The upstream bundles format every date through `Intl.DateTimeFormat` with the
 * active locale, which defaults to `en-US`, so the dashboard's time-window
 * date picker renders a Gregorian grid ("2026", "Thu 08 Oct", "M T W T F S S").
 *
 * Overriding the constructor to always use `fa-IR` makes the Intl-based
 * `@mat-datetimepicker` `NgxMatDateAdapter` render a Jalali grid with Persian
 * digits and month / weekday names, without patching the lazy-loaded upstream
 * chunk. The selected value stays a real `Date`, so telemetry queries remain
 * correct; only the human-readable calendar changes.
 *
 * Loaded only inside the /_tb/ iframe (see docker/nginx.conf `sub_filter`).
 */
(function () {
  if (typeof Intl === 'undefined' || !Intl.DateTimeFormat) return;
  if (Intl.DateTimeFormat.__tbJalali) return;

  const Orig = Intl.DateTimeFormat;

  function PersianDateTimeFormat(locale, options) {
    return new Orig('fa-IR', options);
  }
  PersianDateTimeFormat.prototype = Orig.prototype;

  // Keep statics such as supportedLocalesOf / __tbJalali reachable.
  Object.getOwnPropertyNames(Orig).forEach((key) => {
    if (key === 'prototype' || key === 'length' || key === 'name') return;
    try {
      Object.defineProperty(
        PersianDateTimeFormat,
        key,
        Object.getOwnPropertyDescriptor(Orig, key),
      );
    } catch {
      /* non-configurable static: ignore */
    }
  });

  PersianDateTimeFormat.__tbJalali = true;
  Intl.DateTimeFormat = PersianDateTimeFormat;

  /*
   * The month grid renders its day numbers from `getDateNames()`, which the
   * adapter derives from a fixed Gregorian "basket" of 2017 dates. With the
   * Persian calendar that yields numbers three days behind the real Jalali day
   * (e.g. the cell labelled "۹ مهر ۱۴۰۵" displays "۱۲"). The cell's aria-label
   * IS formatted from the real date, so we mirror its leading day number back
   * onto the visible content.
   */
  const DIGITS = /[0-9\u0660-\u0669\u06F0-\u06F9]+/;

  function fixDayNumbers() {
    const cells = document.querySelectorAll(
      '.mat-datetimepicker-calendar-body-cell[aria-label]',
    );
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      const match = (cell.getAttribute('aria-label') || '').match(DIGITS);
      if (!match) continue;
      const content =
        cell.querySelector('.mat-datetimepicker-calendar-body-cell-content') ||
        cell.firstElementChild;
      if (content && content.textContent.trim() !== match[0]) {
        content.textContent = match[0];
      }
    }
  }

  function start() {
    fixDayNumbers();
    if (!window.MutationObserver) return;
    new MutationObserver(() => {
      if (document.querySelector('mat-datetimepicker-calendar')) fixDayNumbers();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

