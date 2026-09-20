import { useMemo, useState } from 'react';
import type { SampleItem, SampleResult, SampleVerdict } from '../types';

interface Props {
  sample: SampleResult;
  /** 逐项复核：approve 通过；reject 驳回（写入逐条例外） */
  onVerdict: (key: string, verdict: SampleVerdict) => void;
  /** 清除一条复核结论（恢复未复核） */
  onClear: (key: string) => void;
  /** 定位到样本所在字幕 */
  onLocate: (cueIndex: number) => void;
}

type Filter = 'pending' | 'all' | 'approved' | 'rejected';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'pending', label: '待复核' },
  { key: 'all', label: '全部' },
  { key: 'approved', label: '已通过' },
  { key: 'rejected', label: '已驳回' },
];

function fmtTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString();
}

function ItemRow({
  item,
  index,
  onVerdict,
  onClear,
  onLocate,
}: {
  item: SampleItem;
  index: number;
  onVerdict: (key: string, verdict: SampleVerdict) => void;
  onClear: (key: string) => void;
  onLocate: (cueIndex: number) => void;
}) {
  const cross = item.cueIndexes.length > 1;
  return (
    <li className={`sample-item sample-v-${item.verdict ?? 'pending'}`}>
      <div className="sample-item-head">
        <span className="sample-idx mono">#{index + 1}</span>
        <span className="sample-rule-tag">{item.ruleName}</span>
        {cross && (
          <span className="sample-cross-tag" title={`跨 cue 命中，涉及字幕 ${item.cueIndexes.map((c) => `#${c + 1}`).join('、')}`}>
            跨cue
          </span>
        )}
        <button
          className="btn btn-mini sample-locate"
          onClick={() => onLocate(item.cueIndex)}
          title="滚动到该字幕"
        >
          ⌖ 字幕 #{item.cueIndex + 1}
        </button>
        <span className="sample-time mono">
          {item.time.start} → {item.time.end}
        </span>
        <span className={`sample-verdict sample-verdict-${item.verdict ?? 'pending'}`}>
          {item.verdict === 'approve' && `✓ 已通过 ${fmtTime(item.reviewedAt)}`}
          {item.verdict === 'reject' && `✕ 已驳回 ${fmtTime(item.reviewedAt)}`}
          {item.verdict === null && '待复核'}
        </span>
      </div>
      <div className="sample-item-body">
        <div className="sample-text-row">
          <span className="sample-text-label">原文</span>
          <code className="sample-match">{item.match}</code>
        </div>
        <div className="sample-text-row">
          <span className="sample-text-label">替换</span>
          <code className="sample-replacement">{item.replacement}</code>
          {item.reverted && <em className="sample-reverted-flag">当前保留原文</em>}
        </div>
      </div>
      <div className="sample-item-actions">
        <button
          className={`btn btn-mini ${item.verdict === 'approve' ? 'sample-btn-active sample-btn-approve' : ''}`}
          onClick={() => onVerdict(item.key, 'approve')}
          title="确认该替换有效（仅记录抽样复核结论）"
        >
          ✓ 通过
        </button>
        <button
          className={`btn btn-mini ${item.verdict === 'reject' ? 'sample-btn-active sample-btn-reject' : ''}`}
          onClick={() => onVerdict(item.key, 'reject')}
          title="驳回该替换：恢复原文（写入现有逐条例外）"
        >
          ✕ 驳回（撤销替换）
        </button>
        {item.verdict !== null && (
          <button
            className="btn btn-mini btn-ghost"
            onClick={() => onClear(item.key)}
            title="清除本条复核结论，恢复为待复核"
          >
            ⟲ 清除结论
          </button>
        )}
      </div>
    </li>
  );
}

/**
 * 抽样复核面板：逐项通过 / 驳回。
 * 驳回写入现有逐条例外（命中变为保留原文并移出候选池，触发补抽）；
 * 存在未复核样本时导出按钮在顶栏被阻断。
 */
export function SamplePanel({ sample, onVerdict, onClear, onLocate }: Props) {
  const [filter, setFilter] = useState<Filter>('pending');

  const rows = useMemo(
    () =>
      sample.items.filter((i) => {
        if (filter === 'pending') return i.verdict === null;
        if (filter === 'approved') return i.verdict === 'approve';
        if (filter === 'rejected') return i.verdict === 'reject';
        return true;
      }),
    [sample.items, filter],
  );

  const counts = useMemo(
    () => ({
      pending: sample.pending,
      all: sample.items.length,
      approved: sample.approved,
      rejected: sample.rejected,
    }),
    [sample],
  );

  const remaining = sample.pending;

  return (
    <div className={`sample-panel ${remaining > 0 ? 'sample-blocking' : 'sample-done'}`}>
      <div className="sample-panel-head">
        <span className="sample-panel-title">
          {remaining > 0 ? `🔎 抽样复核：还有 ${remaining} 条待复核（导出前须逐项处理）` : '✓ 抽样复核已全部完成，可以导出'}
        </span>
        <span className="sample-progress mono">
          样本 {sample.sampled}/{sample.total}
          {sample.shortfall > 0 && ` · 缺口 ${sample.shortfall}`} · 通过 {sample.approved} · 驳回 {sample.rejected}
        </span>
      </div>

      <div className="sample-strata">
        {sample.strata.map((s) => (
          <span key={s.ruleId} className="sample-stratum" title={`规则「${s.ruleName}」：候选池 ${s.poolHits}、最低 ${s.minimum}、名额 ${s.quota}`}>
            {s.ruleName}
            <b className="mono">{s.sampled}</b>
            {s.pending > 0 && <em className="sample-stratum-pending">待 {s.pending}</em>}
          </span>
        ))}
      </div>

      <div className="sample-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`sample-filter ${filter === f.key ? 'active' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            <span className="sample-filter-count">{counts[f.key]}</span>
          </button>
        ))}
      </div>

      <ul className="sample-list">
        {rows.length === 0 && (
          <li className="empty-tip">
            {filter === 'pending' ? '没有待复核样本。' : '该筛选下暂无样本。'}
          </li>
        )}
        {rows.map((item) => (
          <ItemRow
            key={item.key}
            item={item}
            index={sample.items.indexOf(item)}
            onVerdict={onVerdict}
            onClear={onClear}
            onLocate={onLocate}
          />
        ))}
      </ul>
    </div>
  );
}
