'use strict';
/* Renderer policy only. Execution budgets and backend contracts stay with their owners. */
(function (root) {
  const config = Object.freeze({
    timing: Object.freeze({ errorMs: 15000, toastMs: 5000, chatRenderMs: 120, pollMs: 2500, programmaticScrollMs: 400, streamMarkdownMs: 110 }),
    lists: Object.freeze({ virtualThreshold: 50, sessionRowPx: 48, minViewportPx: 240, overscanBefore: 3, overscanRows: 7, locatorPageSize: 24 }),
    chat: Object.freeze({ messageWindow: 80, messageStep: 60, taskWindow: 40, taskStep: 30, nearBottomPx: 120, titleChars: 80, previewChars: 96, activitySteps: 8, activityEvents: 24 }),
    preview: Object.freeze({ textChars: 20000, eventChars: 4000, summaryChars: 8000, artifactChars: 200000 }),
  });
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.EveUiConfig = config;
})(typeof window === 'undefined' ? globalThis : window);
