// UI limits follow the existing team and mailbox REST contracts.
export const teamConfig = Object.freeze({
  pollMs: 3000, hiddenPollMs: 10000, messageLimit: 100, messageMaxLength: 5000,
  memberLimit: 8, goalMaxLength: 16000, titleMaxLength: 120,
});

export const teamLabels = Object.freeze({
  draft: '待批准方案', archived: '已归档', queued: '排队中', running: '运行中',
  succeeded: '已完成', failed: '失败', paused: '已暂停', interrupted: '待恢复',
  cancelled: '已取消', waiting_approval: '待批准', needs_review: '待复核',
  budget_limited: '额度受限', missing: '任务缺失',
});

export const deliveryLabels = Object.freeze({
  queued_at_safe_boundary: '已排队，等待安全节点', followup_queued: '后续任务已排队',
  mailbox_saved: '已存入成员信箱', saved: '已保存', delivered: '已送达', failed: '下发失败',
});

export function teamActions(team) {
  if (team.archived) return [];
  if (team.draft) return ['approve', 'archive'];
  const statuses = (team.members || []).map(member => member.task?.status || 'missing');
  return [
    ...(statuses.some(status => ['queued', 'running', 'waiting_approval'].includes(status)) ? ['pause'] : []),
    ...(statuses.some(status => ['paused', 'interrupted', 'failed', 'budget_limited', 'needs_review', 'waiting_approval'].includes(status)) ? ['resume'] : []),
    ...(statuses.some(status => !['succeeded', 'cancelled', 'failed', 'missing'].includes(status)) ? ['cancel'] : []),
    ...(!statuses.some(status => !['succeeded', 'failed', 'cancelled', 'needs_review'].includes(status)) ? ['archive'] : []),
  ];
}

export function ensureTeamStyles() {
  if (document.querySelector('link[data-team-styles]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('../css/team.css?v=1.0.0', import.meta.url).href;
  link.dataset.teamStyles = '';
  document.head.append(link);
}
