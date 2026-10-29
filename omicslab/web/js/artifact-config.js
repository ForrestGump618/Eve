// Resource budgets match the workspace HTML and figure-annotation API contracts.
export const artifactConfig = {
  maxTabs: 8,
  maxBytes: 2_000_000,
  requestTimeoutMs: 30_000,
  sidebar: {pageSize: 100},
  annotation: {
    color: '#d92d20',
    width: 3,
    minWidth: 1,
    maxWidth: 24,
    maxStrokes: 500,
    maxPoints: 500,
    maxNoteLength: 5000,
    noteRows: 3,
    regionPadding: 0.005,
    regionPrecision: 4,
  },
};

export function ensureArtifactStyles() {
  if (document.querySelector('link[data-artifact-styles]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/artifacts.css?v=1.0.0', import.meta.url).href;
  link.dataset.artifactStyles = '';
  document.head.append(link);
}
