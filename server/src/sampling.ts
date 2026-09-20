import { createHash } from 'crypto';
import type {
  Hit,
  MaskRule,
  SampleConfig,
  SampleItem,
  SampleReview,
  SampleResult,
  SampleStratum,
} from './types';

/** 总抽样数 / 每规则最低样本数的上限（防止误填超大值） */
export const MAX_SAMPLE_SIZE = 100_000;

/** 默认抽样配置：启用、总抽样 10、每规则最低 0 */
export function defaultSampleConfig(): SampleConfig {
  return { enabled: false, total: 10, perRuleMinimum: {} };
}

/**
 * 规整抽样配置：
 * - enabled 非布尔按 false；
 * - total / perRuleMinimum 取非负有限整数，上限截断，非法值回退默认（total 默认 10）。
 */
export function normalizeSampleConfig(value: unknown): SampleConfig {
  const fallback = defaultSampleConfig();
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Record<string, unknown>;
  const normCount = (v: unknown, fallbackValue: number): number => {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      return Math.min(Math.round(v), MAX_SAMPLE_SIZE);
    }
    return fallbackValue;
  };
  const perRuleMinimum: Record<string, number> = {};
  if (raw.perRuleMinimum && typeof raw.perRuleMinimum === 'object') {
    for (const [ruleId, n] of Object.entries(raw.perRuleMinimum as Record<string, unknown>)) {
      if (typeof ruleId === 'string' && ruleId) {
        perRuleMinimum[ruleId] = normCount(n, 0);
      }
    }
  }
  return {
    enabled: raw.enabled === true,
    total: normCount(raw.total, fallback.total),
    perRuleMinimum,
  };
}

/**
 * 确定性抽样排序哈希：SHA-256(命中键) 取前 8 字节十六进制转 53 位安全整数。
 * 同一候选集（命中键不变）在任意机器、任意时刻得到完全一致的顺序。
 */
function sampleRank(key: string): number {
  const hex = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12);
  return parseInt(hex, 16);
}

/**
 * 名额分配：先满足各规则最低数（不超过该层候选池大小），再把剩余名额按
 * 各层**剩余命中占比**用**最大余数法（largest remainder method, Hare quota）**
 * 分配，每层不超过候选池大小。总命中不足时自然产生缺口。
 *
 * @param pools 各层候选池大小（最终应用命中数，按规则集顺序）
 * @param minimums 各层配置的最低样本数（同序）
 * @param total 目标总抽样数
 */
export function allocateQuotas(pools: number[], minimums: number[], total: number): number[] {
  const n = pools.length;
  const quotas = new Array<number>(n).fill(0);
  let remaining = Math.max(0, total);

  // 第一轮：保底名额（受候选池大小限制）
  for (let i = 0; i < n; i++) {
    const base = Math.min(minimums[i] ?? 0, pools[i] ?? 0, remaining);
    quotas[i] = base;
    remaining -= base;
  }

  // 第二轮：剩余名额按剩余命中占比 + 最大余数法
  const restPool = pools.map((p, i) => Math.max(0, p - quotas[i]));
  const restTotal = restPool.reduce((a, b) => a + b, 0);
  if (remaining > 0 && restTotal > 0) {
    const exact = restPool.map((p) => (remaining * p) / restTotal);
    // 向下取整并以各层剩余候选池封顶（总名额超过总池量时整体取满，缺口留空）
    const floors = exact.map((x, i) => Math.min(Math.floor(x), restPool[i]));
    let toGive = remaining - floors.reduce((a, b) => a + b, 0);
    if (toGive > 0) {
      // 余数降序，余数相同按规则集顺序（层索引）在前，保证确定性；
      // 只向仍有空位（floor 未达池大小）的层发放
      const order = exact
        .map((x, i) => ({ i, frac: x - Math.floor(x), room: restPool[i] - floors[i] }))
        .filter((o) => o.room > 0)
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
      for (const o of order) {
        if (toGive <= 0) break;
        floors[o.i] += 1;
        toGive -= 1;
      }
    }
    for (let i = 0; i < n; i++) {
      quotas[i] += floors[i];
    }
  }

  return quotas;
}

/**
 * 从最终应用命中中做确定性分层抽样。
 *
 * 分层 = 每条当前启用规则；候选池 = 该规则的最终**应用**胜出命中
 * （驳回写入逐条例外 / 实体保留 / 其他撤销后命中已移出候选池）。
 *
 * - 名额：先满足各规则最低样本数，剩余名额按剩余命中占比以最大余数法分配；
 * - 保留：仍对应现存命中（含已驳回 / 已撤销）的已复核项始终保留并占用本层名额，
 *   命中消失的失效记录由调用方据返回结果清理；
 * - 补抽：层名额扣除保留项后，从该层当前候选池中按命中键的 SHA-256 排序确定性补足；
 * - 同一候选集（命中键集合不变）重复计算得到完全一致的样本；命中变化后已复核项不动、
 *   仅从新候选池补抽，原未抽中的未复核样本可能被替换。
 */
export function computeSample(input: {
  config: SampleConfig;
  rules: MaskRule[];
  /** 全部胜出命中（按锚定 cue 去重前的全集均可，内部按 key 去重；跨 cue 命中只计一次） */
  hits: Hit[];
  reviews: SampleReview[];
}): SampleResult {
  const { config } = input;

  // 按 key 去重（跨 cue 命中挂在多个 cue 上）
  const hitByKey = new Map<string, Hit>();
  for (const h of input.hits) {
    if (!hitByKey.has(h.key)) hitByKey.set(h.key, h);
  }

  // 分层按规则集顺序（仅启用规则），保证配额余数并列与输出顺序确定
  const enabledRules = input.rules.filter((r) => r.enabled);
  const strataRules = enabledRules.map((rule) => {
    const ruleHits = [...hitByKey.values()].filter((h) => h.ruleId === rule.id);
    return { rule, pool: ruleHits.filter((h) => !h.reverted), all: ruleHits };
  });
  const reviewByKey = new Map(input.reviews.map((r) => [r.key, r]));

  const pools = strataRules.map((s) => s.pool.length);
  const minimums = strataRules.map((s) => config.perRuleMinimum[s.rule.id] ?? 0);
  const quotas = allocateQuotas(pools, minimums, config.total);

  // 关闭抽样时仍返回分层命中 / 名额预览（供配置面板参考），但不产生样本、不阻断导出
  if (!config.enabled) {
    return {
      enabled: false,
      total: config.total,
      totalPoolHits: pools.reduce((a, b) => a + b, 0),
      sampled: 0,
      approved: 0,
      rejected: 0,
      pending: 0,
      filled: true,
      shortfall: 0,
      strata: strataRules.map((s, i) => ({
        ruleId: s.rule.id,
        ruleName: s.rule.name,
        poolHits: pools[i],
        minimum: minimums[i],
        quota: quotas[i],
        sampled: 0,
        approved: 0,
        rejected: 0,
        pending: 0,
      })),
      items: [],
    };
  }

  const items: SampleItem[] = [];
  const strataOut: SampleStratum[] = [];
  let approved = 0;
  let rejected = 0;

  strataRules.forEach(({ rule, pool, all }, idx) => {
    const quota = quotas[idx];
    // 仍有效（命中存在，无论当前应用 / 撤销）的已复核记录全部保留并优先占用本层名额；
    // 命中消失（字幕 / 规则变化）的失效记录由调用方据样本清单裁剪清理。
    const pinned = all
      .map((hit) => ({ hit, review: reviewByKey.get(hit.key) }))
      .filter((x): x is { hit: Hit; review: SampleReview } => !!x.review)
      .sort((a, b) => a.review.reviewedAt.localeCompare(b.review.reviewedAt) || a.hit.key.localeCompare(b.hit.key));
    const pinnedKeys = new Set(pinned.map((p) => p.hit.key));

    // 补抽：当前候选池（应用命中）中未保留的，按命中键哈希确定性排序
    const fillCount = Math.max(0, quota - pinned.length);
    const fresh = pool
      .filter((h) => !pinnedKeys.has(h.key))
      .sort((a, b) => sampleRank(a.key) - sampleRank(b.key) || a.key.localeCompare(b.key))
      .slice(0, fillCount);

    const chosen = [...pinned.map((p) => p.hit), ...fresh]
      .sort(
        (a, b) =>
          (a.spans[0].cueIndex - b.spans[0].cueIndex) ||
          a.start - b.start ||
          a.key.localeCompare(b.key),
      );

    let sApproved = 0;
    let sRejected = 0;
    for (const h of chosen) {
      const review = reviewByKey.get(h.key) ?? null;
      const verdict = review?.verdict === 'approve' || review?.verdict === 'reject'
        ? review.verdict
        : null;
      if (verdict === 'approve') sApproved++;
      else if (verdict === 'reject') sRejected++;
      const anchor = h.spans[0];
      items.push({
        key: h.key,
        ruleId: h.ruleId,
        ruleName: h.ruleName,
        cueIndex: anchor.cueIndex,
        cueId: '', // 由调用方从 cue 数据补齐
        time: { start: '', end: '' },
        cueIndexes: h.spans.map((s) => s.cueIndex),
        match: h.match,
        replacement: h.replacement,
        reverted: h.reverted,
        verdict,
        reviewedAt: review?.reviewedAt,
      });
    }

    const sampled = chosen.length;
    const pending = sampled - sApproved - sRejected;
    approved += sApproved;
    rejected += sRejected;
    strataOut.push({
      ruleId: rule.id,
      ruleName: rule.name,
      poolHits: pool.length,
      minimum: minimums[idx],
      quota,
      sampled,
      approved: sApproved,
      rejected: sRejected,
      pending,
    });
  });

  const totalPoolHits = pools.reduce((a, b) => a + b, 0);
  // 缺口 = 目标总数与实际样本数之差（总命中不足、各层配额取满池后仍未抽满）
  const sampledTotal = strataOut.reduce((a, s) => a + s.sampled, 0);
  const shortfall = Math.max(0, config.total - sampledTotal);
  return {
    enabled: true,
    total: config.total,
    totalPoolHits,
    sampled: items.length,
    approved,
    rejected,
    pending: items.length - approved - rejected,
    filled: shortfall === 0,
    shortfall,
    strata: strataOut,
    items,
  };
}

/** 用 cue 数据补齐样本条目的 cue id / 时间（锚定 cue） */
export function enrichSampleItems(
  sample: SampleResult,
  cueInfo: Map<number, { id: string; start: string; end: string }>,
): SampleResult {
  for (const item of sample.items) {
    const cue = cueInfo.get(item.cueIndex);
    if (cue) {
      item.cueId = cue.id;
      item.time = { start: cue.start, end: cue.end };
    }
  }
  return sample;
}
