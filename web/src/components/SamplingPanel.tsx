import type { SamplingConfig, SamplingPlan, SamplingState } from '../types';

interface Props {
  /** 服务端抽样计划（随预览实时重算） */
  plan: SamplingPlan;
  /** 当前持久化的抽样配置与结论（配置编辑的受控来源） */
  state: SamplingState;
  onConfig: (patch: Partial<SamplingConfig>) => void;
  onReview: (key: string, state: 'approved' | 'rejected') => void;
  /** 撤销「通过」，样本回到待复核 */
  onUnreview: (key: string) => void;
  /** 定位到样本锚定 cue（滚动 + 闪烁） */
  onLocate: (cueIndex: number) => void;
}

/**
 * 抽样复核面板：配置总抽样数与每规则最低样本数，服务端从最终应用命中中
 * 确定性分层抽样（先满足各规则最低数，再按剩余命中占比以最大余数法分配）。
 * 逐项通过 / 驳回；驳回写入逐条例外（保留原文）并自动补抽新样本；
 * 存在未复核样本时阻断导出。
 */
export function SamplingPanel({ plan, state, onConfig, onReview, onUnreview, onLocate }: Props) {
  const cfg = state.config;
  const enabled = cfg.enabled;

  return (
    <div
      className={`sampling-panel ${
        enabled ? (plan.blocked ? 'sampling-blocked' : 'sampling-done') : ''
      }`}
    >
      <div className="sampling-head">
        <label className="sampling-enable" title="从最终应用命中中抽样逐项复核；存在未复核样本时阻断导出">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onConfig({ enabled: e.target.checked })}
          />
          <b>抽样复核</b>
        </label>
        {enabled && (
          <span className="sampling-progress">
            候选 {plan.candidates} · 样本 {plan.samples.length} ·
            <em className={plan.pending > 0 ? 'sampling-pending' : ''}>
              待复核 {plan.pending}
            </em>
            · 已通过 {plan.approved} · 已驳回 {plan.rejected}
          </span>
        )}
      </div>
      <p className="hint sampling-hint">
        从<b>最终应用命中</b>中确定性分层抽样：先满足每条启用规则的最低样本数，
        剩余名额按各规则剩余命中占比以<b>最大余数法</b>分配；同一候选集样本稳定，
        命中变化后仍有效的已复核项保留、自动补抽差额。
        <b>驳回</b>会写入逐条例外（保留原文）并补抽新样本；存在未复核样本时无法导出。
        {!enabled && `（当前最终应用命中 ${plan.candidates} 条）`}
      </p>
      {enabled && (
        <>
          <div className="sampling-config">
            <label>
              总抽样数
              <input
                type="number"
                min={0}
                step={1}
                value={cfg.total}
                onChange={(e) => onConfig({ total: Number(e.target.value) })}
                title="抽取的样本总数；超过候选总数时按候选数截断"
              />
            </label>
            <label>
              每规则最低样本数
              <input
                type="number"
                min={0}
                step={1}
                value={cfg.minPerRule}
                onChange={(e) => onConfig({ minPerRule: Number(e.target.value) })}
                title="每条启用规则至少抽取的样本数（候选不足时按实际候选数）"
              />
            </label>
            {plan.quotas.length > 0 && (
              <span className="sampling-quotas" title="各规则名额分配（样本数 / 候选数）">
                {plan.quotas.map((q) => (
                  <span key={q.ruleId} className="sampling-quota-chip">
                    「{q.ruleName}」{q.quota}/{q.candidates}
                  </span>
                ))}
              </span>
            )}
          </div>
          {plan.blocked && (
            <div className="sampling-warning">
              ⛔ 仍有 {plan.pending} 条样本未复核，逐项通过或驳回后才能导出。
            </div>
          )}
          {plan.samples.length === 0 && (
            <div className="empty-tip">
              {plan.candidates === 0
                ? '当前没有最终应用命中，无可抽样样本。'
                : '按当前配置无需抽样（总抽样数与每规则最低数均为 0）。'}
            </div>
          )}
          <ul className="sampling-list">
            {plan.samples.map((s) => (
              <li key={s.key} className={`sampling-item sampling-item-${s.state}`}>
                <button
                  className="btn btn-mini safety-locate"
                  onClick={() => onLocate(s.cueIndex)}
                  title={`定位到字幕 #${s.cueIndex + 1}`}
                >
                  ⌖
                </button>
                <span className="sampling-rule" title={`规则：${s.ruleName}`}>
                  {s.ruleName}
                </span>
                <span
                  className="sampling-match mono"
                  title={`原文：${s.match}\n实体键：${s.entityKey}\n字幕 #${s.cueIndex + 1}`}
                >
                  {s.match}
                </span>
                <span className="sampling-arrow">→</span>
                <span className="sampling-replacement mono" title={`替换：${s.replacement}`}>
                  {s.replacement}
                </span>
                {s.state === 'pending' ? (
                  <span className="sampling-actions">
                    <button
                      className="btn btn-mini sampling-approve"
                      onClick={() => onReview(s.key, 'approved')}
                      title="通过：保持该处替换"
                    >
                      ✓ 通过
                    </button>
                    <button
                      className="btn btn-mini sampling-reject"
                      onClick={() => onReview(s.key, 'rejected')}
                      title="驳回：写入逐条例外、保留原文，并补抽一条新样本"
                    >
                      ✕ 驳回
                    </button>
                  </span>
                ) : (
                  <span className="sampling-actions">
                    <span className="sampling-state-tag" title={s.reviewedAt ? `通过时间：${s.reviewedAt}` : undefined}>
                      ✓ 已通过
                    </span>
                    <button
                      className="btn btn-mini"
                      onClick={() => onUnreview(s.key)}
                      title="撤销通过，样本回到待复核"
                    >
                      ↩ 待复核
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
          {plan.rejected > 0 && (
            <p className="hint sampling-hint">
              已驳回 {plan.rejected} 条：对应命中已写入逐条例外并保留原文，
              可在预览中点「↩ 应用」恢复替换。
            </p>
          )}
        </>
      )}
    </div>
  );
}
