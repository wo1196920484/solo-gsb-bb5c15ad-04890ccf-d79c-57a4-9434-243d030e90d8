import { createHash } from 'crypto';
import type {
  Hit,
  MaskRule,
  SampleItem,
  SampleReview,
  SamplingConfig,
  SamplingPlan,
  SamplingQuota,
  SamplingState,
} from './types';

/* ------------------------------------------------------------------ */
/* 抽样复核：配置规整                                                    */
/* ------------------------------------------------------------------ */

/** 总抽样数上限（防止误填超大值） */
export const MAX_SAMPLING_TOTAL = 100_000;
/** 每条规则最低样本数上限 */
export const MAX_SAMPLING_MIN_PER_RULE = 10_000;

/** 默认抽样配置（旧任务缺少抽样字段时按此迁移：不启用） */
export const DEFAULT_SAMPLING_CONFIG: SamplingConfig = {
  enabled: false,
  total: 10,
  minPerRule: 1,
};

function normalizeCount(value: unknown, fallback: number, max: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.min(Math.round(value), max);
  }
  return fallback;
}

/** 规整抽样配置：非负整数、超出上限截断；非法值回退默认 */
export function normalizeSamplingConfig(value: unknown): SamplingConfig {
  const v = (value ?? {}) as Partial<SamplingConfig>;
  return {
    enabled: v.enabled === true,
    total: normalizeCount(v.total, DEFAULT_SAMPLING_CONFIG.total, MAX_SAMPLING_TOTAL),
    minPerRule: normalizeCount(
      v.minPerRule,
      DEFAULT_SAMPLING_CONFIG.minPerRule,
      MAX_SAMPLING_MIN_PER_RULE,
    ),
  };
}

/**
 * 规整抽样复核状态（宽容模式，供任务迁移 / API 校验共用）：
 * 非法结论条目跳过，同 key 只保留第一条。
 */
export function normalizeSamplingState(value: unknown): SamplingState {
  const v = (value ?? {}) as Partial<SamplingState>;
  const reviews: SampleReview[] = [];
  const seen = new Set<string>();
  if (Array.isArray(v.reviews)) {
    for (const r of v.reviews) {
      if (r === null || typeof r !== 'object') continue;
      const x = r as unknown as Record<string, unknown>;
      if (typeof x.key !== 'string' || !x.key) continue;
      if (x.state !== 'approved' && x.state !== 'rejected') continue;
      if (seen.has(x.key)) continue;
      seen.add(x.key);
      reviews.push({
        key: x.key,
        state: x.state,
        reviewedAt: typeof x.reviewedAt === 'string' ? x.reviewedAt : '',
      });
    }
  }
  return { config: normalizeSamplingConfig(v.config), reviews };
}

/* ------------------------------------------------------------------ */
/* 确定性分层抽样                                                        */
/* ------------------------------------------------------------------ */

/** 命中键的确定性散列：同一候选集重复抽样结果稳定（不依赖任何随机状态） */
function hashOf(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * 名额分配：先满足各规则最低数（候选不足按实际候选数），再把剩余名额按
 * 各规则剩余命中占比以最大余数法分配（并列按规则顺序）。最低数之和超过
 * 总数时最低数优先（总数退化为下限）；总数超过候选总数时按候选数截断。
 */
export function allocateQuotas(
  groups: { ruleId: string; count: number }[],
  total: number,
  minPerRule: number,
): Map<string, number> {
  const base = groups.map((g) => Math.min(minPerRule, g.count));
  const quota = new Map<string, number>(groups.map((g, i) => [g.ruleId, base[i]]));
  const restCounts = groups.map((g, i) => g.count - base[i]);
  const restTotal = restCounts.reduce((s, c) => s + c, 0);
  const remaining = Math.min(total - base.reduce((s, b) => s + b, 0), restTotal);
  if (remaining <= 0) return quota;
  // 最大余数法：名额先按占比取整，剩余逐个补给小数余数最大的规则
  const shares = restCounts.map((c) => (remaining * c) / restTotal);
  const extra = shares.map((s) => Math.floor(s));
  let leftover = remaining - extra.reduce((s, f) => s + f, 0);
  const order = groups
    .map((_, i) => i)
    .sort((a, b) => shares[b] - extra[b] - (shares[a] - extra[a]) || a - b);
  for (const i of order) {
    if (leftover <= 0) break;
    extra[i] += 1;
    leftover -= 1;
  }
  for (let i = 0; i < groups.length; i++) quota.set(groups[i].ruleId, base[i] + extra[i]);
  return quota;
}

/**
 * 抽样复核计划：从最终应用命中（胜出且未保留原文）中确定性分层抽样。
 *  - 候选按规则分层，先满足各规则最低数，再按剩余命中占比以最大余数法分配；
 *  - 层内按命中键散列排序抽取：同一候选集重复预览样本稳定，不依赖随机状态；
 *  - 仍有效的已通过结论（命中仍为应用态）钉入样本，命中变化后仅补抽差额；
 *  - 驳回结论随逐条例外保留原文，命中退出候选集，不再出现在样本中；
 *  - 失效结论（命中消失，或通过 / 驳回与当前状态不一致）从计划中剔除。
 */
export function planSampling(
  hits: Hit[],
  rules: MaskRule[],
  state: SamplingState | undefined,
): SamplingPlan {
  const { config, reviews: rawReviews } = normalizeSamplingState(state);

  /* 候选 = 最终应用命中；跨 cue 命中挂在多条 cue 上，按命中键去重 */
  const hitByKey = new Map<string, Hit>();
  const applied: Hit[] = [];
  for (const h of hits) {
    if (hitByKey.has(h.key)) continue;
    hitByKey.set(h.key, h);
    if (!h.reverted) applied.push(h);
  }

  /* 仍有效的结论：通过 → 命中仍为应用态；驳回 → 命中当前保留原文 */
  const reviews = rawReviews.filter((r) => {
    const h = hitByKey.get(r.key);
    if (!h) return false;
    return r.state === 'approved' ? !h.reverted : h.reverted;
  });
  const reviewByKey = new Map(reviews.map((r) => [r.key, r]));
  const rejected = reviews.filter((r) => r.state === 'rejected').length;

  const plan: SamplingPlan = {
    enabled: config.enabled,
    config,
    candidates: applied.length,
    quotas: [],
    samples: [],
    pending: 0,
    approved: 0,
    rejected,
    reviews,
    blocked: false,
  };
  if (!config.enabled) return plan;

  /* 按规则分层（规则集顺序；未知规则按首次出现顺序附后） */
  const ruleOrder = new Map(rules.map((r, i) => [r.id, i]));
  const byRule = new Map<string, Hit[]>();
  for (const h of applied) {
    const list = byRule.get(h.ruleId) ?? [];
    list.push(h);
    byRule.set(h.ruleId, list);
  }
  const groups = Array.from(byRule.entries()).sort(
    (a, b) =>
      (ruleOrder.get(a[0]) ?? Number.MAX_SAFE_INTEGER) -
      (ruleOrder.get(b[0]) ?? Number.MAX_SAFE_INTEGER),
  );
  const quotaMap = allocateQuotas(
    groups.map(([ruleId, list]) => ({ ruleId, count: list.length })),
    config.total,
    config.minPerRule,
  );
  const quotas: SamplingQuota[] = groups.map(([ruleId, list]) => ({
    ruleId,
    ruleName: list[0].ruleName,
    candidates: list.length,
    quota: quotaMap.get(ruleId) ?? 0,
  }));

  /* 层内抽取：已通过的候选钉入样本（仍有效的已复核项），其余按键散列补抽 */
  const samples: SampleItem[] = [];
  for (const [ruleId, list] of groups) {
    const quota = quotaMap.get(ruleId) ?? 0;
    const pinned = list.filter((h) => reviewByKey.get(h.key)?.state === 'approved');
    const rest = list
      .filter((h) => reviewByKey.get(h.key)?.state !== 'approved')
      .sort((a, b) => {
        const ha = hashOf(a.key);
        const hb = hashOf(b.key);
        return ha < hb ? -1 : ha > hb ? 1 : 0;
      });
    const picked = [...pinned, ...rest.slice(0, Math.max(0, quota - pinned.length))];
    for (const h of picked) {
      const approved = reviewByKey.get(h.key)?.state === 'approved';
      samples.push({
        key: h.key,
        ruleId: h.ruleId,
        ruleName: h.ruleName,
        cueIndex: h.spans[0]?.cueIndex ?? 0,
        start: h.start,
        match: h.match,
        replacement: h.replacement,
        entityKey: h.entityKey,
        state: approved ? 'approved' : 'pending',
        reviewedAt: approved ? reviewByKey.get(h.key)?.reviewedAt : undefined,
      });
    }
  }
  /* 面板按字幕顺序复核 */
  samples.sort(
    (a, b) =>
      a.cueIndex - b.cueIndex || a.start - b.start || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const approved = samples.filter((s) => s.state === 'approved').length;
  plan.quotas = quotas;
  plan.samples = samples;
  plan.approved = approved;
  plan.pending = samples.length - approved;
  plan.blocked = plan.pending > 0;
  return plan;
}

/** 抽样复核未完成：存在未复核样本，阻断导出 */
export class SamplingPendingError extends Error {
  plan: SamplingPlan;
  constructor(plan: SamplingPlan) {
    super(
      `抽样复核未完成：仍有 ${plan.pending} 条样本未复核，请在抽样复核面板逐项通过或驳回后再导出`,
    );
    this.name = 'SamplingPendingError';
    this.plan = plan;
  }
}
