# First-run prompt verification

## Behavior

- The dialog contains one purpose sentence, one optional `下次不再提示` checkbox, one primary action, and the standard close control.
- The checkbox is checked by default. Unchecking it keeps the prompt eligible for the next launch.
- Closing or clicking `连接模型` persists the current checkbox choice.
- The title may wrap, body copy uses a balanced short measure, and the primary action spans the dialog for a stable touch target.

## Automated checks

Run:

```powershell
node tests/frontend-onboarding.mjs
node tests/frontend-settings.mjs
python -m pytest -q tests/test_suwen_platform.py tests/test_science_workbench.py tests/test_dreaming.py
& 'C:\Users\Qingyuan Zhuang\.codex\skills\impeccable\scripts\impeccable.cmd' detect --json omicslab/web/js/suwen.js omicslab/web/css/base.css omicslab/web/css/platform.css
```

Results:

- Edge `156.0.4314.50`: onboarding, opt-out persistence, focus, wrapping, and overflow checks passed.
- Desktop `1440x900`: modal `464px`, purpose text `15px / 24.75px`, one line, button height `40px`.
- Mobile `390x844`: modal `366px`, no horizontal overflow, all labels contained.
- Dark mode: solid light-blue action, no gradient image, text contrast at or above WCAG AA.
- Settings browser regression: passed.
- Python targeted regression: `84 passed`.
- Impeccable detector: `[]`.

## Evidence

- `onboarding-desktop.png`
- `onboarding-mobile.png`
- `onboarding-dark-mobile.png`
- `onboarding-browser-results.json`

The screenshots come from a local Edge fixture with a mocked bootstrap response. They verify the rendered component, not a packaged installer or a real model-provider connection.
