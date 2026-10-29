# Eve Design System

## Direction

Eve is a restrained scientific instrument: neutral work surfaces, precise thin boundaries, one blue accent for decisive actions, and semantic colors only when the interface needs to communicate state. The product should feel editorial and calm rather than decorative or futuristic.

## Color

The interface uses three color classes only:

- Neutral grays for every surface, border, label, and body text.
- One accent blue for primary actions, links, selection, and focus.
- Small semantic pairs for success, warning, danger, and information.

### Neutral scale

| Token | HEX | Primary use |
| --- | --- | --- |
| `--neutral-50` | `#F7F8FA` | Page background |
| `--neutral-130` | `#F0F2F5` | Secondary surface |
| `--neutral-200` | `#E8EBEF` | Quiet grouping |
| `--neutral-260` | `#D9DDE3` | Borders |
| `--neutral-380` | `#A8B0BB` | Disabled state |
| `--neutral-480` | `#7F8895` | Placeholder |
| `--neutral-560` | `#666F7C` | Tertiary text |
| `--neutral-680` | `#4B5563` | Secondary text |
| `--neutral-780` | `#343B45` | Strong secondary |
| `--neutral-880` | `#242A32` | Soft inverse surface |
| `--neutral-980` | `#171B21` | Primary text |

### Accent

| Token | HEX | Use |
| --- | --- | --- |
| `--accent-50` | `#EEF2FF` | Soft selected background |
| `--accent-600` | `#3157D5` | Primary buttons, links, focus |
| `--accent-700` | `#2445B0` | Hover and pressed primary action |

### Semantic pairs

| Meaning | Background | Foreground |
| --- | --- | --- |
| Success | `#EAF7EF` | `#17663A` |
| Warning | `#FFF7E6` | `#7A4B00` |
| Danger | `#FFF0F0` | `#9E2F2F` |
| Information | `#EEF4FF` | `#2553A6` |

Semantic foregrounds are used on their matching light backgrounds. Body-size text must remain at or above 4.5:1.

## Dark Mode

Dark mode is designed independently rather than inverted.

| Token | HEX | Use |
| --- | --- | --- |
| `--page` | `#181A1E` | Page, never pure black |
| `--surface` | `#1F2228` | Panels |
| `--surface-raised` | `#262A31` | Inputs and selected rows |
| `--border` | `#373C45` | Layer separation |
| `--text` | `#F0F2F5` | Primary text |
| `--text-secondary` | `#B6BDC7` | Secondary text |
| `--accent` | `#8EA8FF` | Primary action in dark mode |

## Typography

- Display and UI: `Aptos Display`, `Segoe UI Variable`, `PingFang SC`, `Microsoft YaHei`, sans-serif.
- Body: `Aptos`, `Segoe UI Variable`, `PingFang SC`, `Microsoft YaHei`, sans-serif.
- Code and measurements: `Cascadia Code`, `SFMono-Regular`, Consolas, monospace.
- Base size: 14px. Supporting copy: 12px. Page titles: 28–32px. Card titles: 15–18px.
- Body line-height: 1.55. Long-form reading: 1.7. Heading tracking no tighter than `-0.03em`.
- Body measure: 68–76 characters. Controls use sentence case.

## Spacing And Shape

- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 40, 56, 72px.
- Standard panel radius: 12px. Large overlays: 16px. Small controls: 8px.
- Use a border or a shadow for elevation, not both at decorative strength.
- Avoid nested cards and repeated icon-heading-copy tiles.

## Layout

- Navigation: one workspace sidebar with projects, files, child agents, and recent conversations.
- Home: a dashboard that leads with active work and next actions, not a welcome message.
- Chat: quiet full-width reading surface with compact user bubbles and collapsible execution detail.
- Settings: grouped controls with sticky save affordances on long pages.
- Operational panels: file tree, Git, terminal, chart preview, and child agents stay in sidebar or split panes.

## Motion

- Standard interaction duration: 150–220ms.
- Use `cubic-bezier(0.23, 1, 0.32, 1)` for enter and response.
- Animate only `transform`, `opacity`, and color where necessary.
- Buttons respond on press. Menus, sheets, and panels animate from their trigger.
- No animation for high-frequency typing, terminal output, or list scrolling.
- Respect `prefers-reduced-motion`; disable route and modal transforms while retaining state changes.

## Interaction Rules

- One primary action per dialog. Secondary dismissal uses the close control or Escape.
- Empty states use one sentence and one action.
- Errors name the problem and the recovery path.
- Long tool results and raw JSON are collapsed; user-facing summaries come first.
- Destructive and autonomous actions require explicit confirmation and preserve a visible result.
