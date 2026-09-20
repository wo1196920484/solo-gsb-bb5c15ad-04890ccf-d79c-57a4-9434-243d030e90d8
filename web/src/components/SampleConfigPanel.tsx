import { useMemo, useState } from 'react';
import type { MaskRule, SampleConfig, SampleStratum } from '../types';

interface Props {
  config: SampleConfig;
  enabledRules: MaskRule[];
  strata: SampleStratum[];
  onChange: (next: SampleConfig) => void;
}

/**
 * 抽样复核配置（②，随任务持久化）：
 * - 总抽样数；
 * - 每条启用规则的最低样本数；
 * - 实时展示各规则在当前命中下的候选池规模与分层名额（最低数保底 + 最大余数法）。
 */
export function SampleConfigPanel({ config, enabledRules, strata, onChange }: Props) {
  const [open, setOpen] = useState(true);

  const strataByRule = useMemo(
    () => new Map(strata.map((s) => [s.ruleId, s])),
    [strata],
  );

  const setTotal = (raw: string) => {
    const n = Math.max(0, Math.floor(Number(raw) || 0));
    onChange({ ...config, total: n });
  };

  const setMinimum = (ruleId: string, raw: string) => {
    const n = Math.max(0, Math.floor(Number(raw) || 0));
    onChange({
      ...config,
      perRuleMinimum: { ...config.perRuleMinimum, [ruleId]: n },
    });
  };

  const setAllMinimums = (raw: string) => {
    const n = Math.max(0, Math.floor(Number(raw) || 0));
    const perRuleMinimum: Record<string, number> = {};
    for (const r of enabledRules) perRuleMinimum[r.id] = n;
    onChange({ ...config, perRuleMinimum });
  };

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>③ 抽样复核配置</h2>
        <label className="sample-enable" title="启用后从最终应用命中中确定性分层抽样，样本未全部复核时阻断导出">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
          />
          启用抽样
        </label>
        <button className="btn btn-mini btn-ghost" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
        </button>
      </header>
      <p className="hint">
        服务端从<b>最终应用命中</b>中确定性分层抽样：先满足每条启用规则的最低样本数，
        剩余名额按各规则剩余命中占比用<b>最大余数法</b>分配；同一候选集重复预览样本保持稳定，
        命中变化后保留仍有效的已复核项并补抽。驳回写入现有逐条例外；存在未复核样本时阻断导出。
      </p>
      {open && (
        <>
          <div className="sample-config-row">
            <label className="sample-total">
              总抽样数
              <input
                type="number"
                min={0}
                value={config.total}
                onChange={(e) => setTotal(e.target.value)}
              />
            </label>
            {enabledRules.length > 0 && (
              <label className="sample-bulk-min">
                全部规则最低数设为
                <input
                  type="number"
                  min={0}
                  defaultValue={0}
                  key={`bulk-${enabledRules.map((r) => r.id).join(',')}`}
                  onChange={(e) => setAllMinimums(e.target.value)}
                />
              </label>
            )}
          </div>

          {enabledRules.length === 0 ? (
            <div className="empty-tip">暂无启用规则，启用规则后可按规则配置最低样本数。</div>
          ) : (
            <table className="sample-table">
              <thead>
                <tr>
                  <th>启用规则</th>
                  <th className="num">当前命中</th>
                  <th className="num">最低样本</th>
                  <th className="num">分配名额</th>
                  {config.enabled && (
                    <th className="num">已抽 / 待复核</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {enabledRules.map((r) => {
                  const s = strataByRule.get(r.id);
                  return (
                    <tr key={r.id}>
                      <td title={r.name}>
                        {r.name}
                        {r.mode === 'alias' && <em className="sample-mode-tag">化名</em>}
                      </td>
                      <td className="num mono">{s?.poolHits ?? 0}</td>
                      <td className="num">
                        <input
                          className="sample-min-input"
                          type="number"
                          min={0}
                          value={config.perRuleMinimum[r.id] ?? 0}
                          onChange={(e) => setMinimum(r.id, e.target.value)}
                        />
                      </td>
                      <td className="num mono sample-quota" title="先满足最低样本数，剩余名额按命中占比以最大余数法分配">
                        {s?.quota ?? 0}
                      </td>
                      {config.enabled && (
                        <td className="num mono">
                          {s ? `${s.sampled} / ${s.pending}` : '0 / 0'}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {strata.length > 0 && (
            <div className="sample-shortfall-hint">
              {strata.reduce((a, s) => a + s.poolHits, 0) < config.total ? (
                <span className="sample-shortfall">
                  ⓘ 当前最终应用命中不足，最多可抽{' '}
                  {strata.reduce((a, s) => a + s.poolHits, 0)} 条（配置 {config.total} 条，
                  缺口 {config.total - strata.reduce((a, s) => a + s.poolHits, 0)} 条）。
                </span>
              ) : (
                <span>名额先满足最低样本数，剩余按命中占比以最大余数法分配。</span>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
