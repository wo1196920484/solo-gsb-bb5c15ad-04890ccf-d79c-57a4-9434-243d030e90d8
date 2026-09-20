/** 引擎自测：node --import tsx src/engine.test.ts（通过 npm run test:engine 运行） */
import assert from 'assert';
import {
  autoAliasFor,
  buildFinalText,
  buildPreview,
  buildScanWindows,
  exportResult,
  normalizeEntity,
  normalizeRule,
  plainText,
  SafetyScanBlockedError,
  SampleReviewPendingError,
  timeToMs,
} from './engine';
import { allocateQuotas, normalizeSampleConfig } from './sampling';
import { PRESETS, SAMPLE_VTT } from './presets';
import { migrateJobState } from './store';
import type {
  AliasEntry,
  EntityDecision,
  JobState,
  MaskRule,
  SampleConfig,
  SampleReview,
} from './types';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function presetRule(name: string, override: Partial<MaskRule> = {}): MaskRule {
  const p = PRESETS.find((x) => x.rule.name === name)!;
  return { id: 'r-' + name, ...p.rule, ...override };
}

test('内联标签剥离与偏移映射', () => {
  const { text, map } = plainText('你好<00:00:01.000>世界<c.yellow>!</c>');
  assert.strictEqual(text, '你好世界!');
  assert.deepStrictEqual(map, [0, 1, 16, 17, 28]);
});

test('基础命中：手机号/邮箱/姓名', () => {
  const rules = [presetRule('手机号'), presetRule('邮箱'), presetRule('姓名')];
  const v = buildPreview({ vtt: SAMPLE_VTT, rules });
  assert.ok(v.totalHits >= 4, `应至少 4 个命中，实际 ${v.totalHits}`);
  const phone = v.cues[0].hits.find((h) => h.ruleName === '手机号')!;
  assert.strictEqual(phone.match, '13812345678');
  assert.strictEqual(phone.replacement, '138****5678');
  const name = v.cues[0].hits.find((h) => h.ruleName === '姓名')!;
  assert.strictEqual(name.match, '张伟');
  assert.strictEqual(name.replacement, '张*');
});

test('优先级合并：身份证(80) 吞并重叠的银行卡(75)', () => {
  const rules = [presetRule('身份证'), presetRule('银行卡')];
  const v = buildPreview({ vtt: SAMPLE_VTT, rules });
  // 18 位身份证数字同时落在银行卡 [16,19] 区间，两条规则在同一区间重叠
  const idCue = v.cues.find((c) => c.text.includes('110101'))!;
  assert.ok(idCue.suppressed.length >= 1, '应有被抑制命中');
  const sup = idCue.suppressed.find((s) => s.ruleName === '银行卡');
  assert.ok(sup, '银行卡应被身份证抑制（18 位重叠区间）');
  assert.strictEqual(sup!.winnerRuleName, '身份证');
});

test('19 位卡号不与身份证冲突，走银行卡规则', () => {
  const rules = [presetRule('身份证'), presetRule('银行卡')];
  const v = buildPreview({ vtt: SAMPLE_VTT, rules });
  const cardCue = v.cues.find((c) => c.text.includes('6222'))!;
  const bank = cardCue.hits.find((h) => h.ruleName === '银行卡');
  assert.ok(bank, '19 位卡号应由银行卡规则命中');
  assert.strictEqual(bank!.match, '6222021234567890123');
  assert.strictEqual(bank!.replacement, '6222********0123');
});

test('逐条撤销：key 稳定且导出恢复原文', () => {
  const rules = [presetRule('手机号')];
  const v1 = buildPreview({ vtt: SAMPLE_VTT, rules });
  const key = v1.cues[0].hits[0].key;
  const v2 = buildPreview({ vtt: SAMPLE_VTT, rules, revertedKeys: [key] });
  assert.strictEqual(v2.appliedHits, 1);
  assert.strictEqual(v2.revertedHits, 1);
  const ex = exportResult({ vtt: SAMPLE_VTT, rules, revertedKeys: [key] });
  assert.ok(!ex.vtt.includes('138****5678'), '撤销号码应保持原文');
  assert.ok(ex.vtt.includes('13812345678'));
  assert.ok(ex.vtt.includes('139****4321'), '未撤销号码应脱敏');
  assert.ok(ex.audit.records.some((r) => r.status === 'reverted'));
  assert.ok(ex.audit.records.some((r) => r.status === 'applied'));
});

test('时间轴/头部完整保留', () => {
  const vtt = 'WEBVTT\n\nNOTE\n这是备注\n\n00:00:01,000 --> 00:00:02,000  align:start\n电话 13812345678\n';
  const rules = [presetRule('手机号')];
  const ex = exportResult({ vtt, rules });
  assert.ok(ex.vtt.includes('NOTE'));
  assert.ok(ex.vtt.includes('00:00:01,000 --> 00:00:02,000  align:start'));
  assert.ok(ex.vtt.includes('电话 138****5678'));
  assert.strictEqual(ex.audit.source.cueCount, 1);
});

test('审计包含规则、原文区间与替换结果', () => {
  const rules = [presetRule('邮箱')];
  const ex = exportResult({ vtt: SAMPLE_VTT, rules });
  const rec = ex.audit.records.find((r) => r.rule.name === '邮箱')!;
  assert.strictEqual(rec.source.text, 'zhang.wei@example.com');
  assert.strictEqual(rec.replacement, '****@example.com');
  assert.strictEqual(typeof rec.source.start, 'number');
  assert.ok(rec.time.start && rec.time.end);
  assert.strictEqual(ex.audit.rules.length, 1);
  assert.ok(/^[a-f0-9]{64}$/.test(ex.audit.source.sha256));
});

test('非法正则在预览中报错而不崩溃', () => {
  const bad = { ...presetRule('手机号'), id: 'bad', pattern: '([0-9]+' };
  const v = buildPreview({ vtt: SAMPLE_VTT, rules: [bad] });
  assert.ok(v.parseErrors.some((e) => e.includes('bad')));
});

/* ---------------------------- 稳定化名 ---------------------------- */

const ALIAS_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
张伟先生到了。

00:00:02.500 --> 00:00:05.000
张伟先生和李娜女士一起。

00:00:05.500 --> 00:00:08.000
张伟先生先走，王芳女士留下。
`;

/** 稳定化名：同一实体跨 cue 使用同一编号化名 */
test('稳定化名：同一实体跨 cue 同一编号，不同实体依次编号', () => {
  const rule: MaskRule = { id: 'al', ...PRESETS.find((p) => p.rule.name === '姓名-稳定化名')!.rule, enabled: true };
  const v = buildPreview({ vtt: ALIAS_VTT, rules: [rule] });
  const all = v.cues.flatMap((c) => c.hits);
  const zhang = all.filter((h) => h.match === '张伟');
  const li = all.find((h) => h.match === '李娜')!;
  const wang = all.find((h) => h.match === '王芳')!;
  assert.strictEqual(zhang.length, 3);
  for (const h of zhang) {
    assert.strictEqual(h.alias, '人物1');
    assert.strictEqual(h.replacement, '人物1');
    assert.strictEqual(h.entityKey, '张伟');
  }
  assert.strictEqual(li.alias, '人物2');
  assert.strictEqual(wang.alias, '人物3');
  assert.deepStrictEqual(
    v.aliases.map((a) => [a.entityKey, a.seq, a.alias, a.auto]),
    [
      ['张伟', 1, '人物1', true],
      ['李娜', 2, '人物2', true],
      ['王芳', 3, '人物3', true],
    ],
  );
});

/** 持久化：把化名表回传后，增删其他字幕不会重排已有编号 */
test('稳定化名：回传映射后删减字幕，已有编号不重排', () => {
  const rule: MaskRule = { id: 'al', ...PRESETS.find((p) => p.rule.name === '姓名-稳定化名')!.rule, enabled: true };
  const v1 = buildPreview({ vtt: ALIAS_VTT, rules: [rule] });

  // 删除含李娜的整条 cue，张伟仍为人物1，王芳仍为人物3（不回收 2）
  const lines = ALIAS_VTT.split('\n');
  const cut = lines.filter((l) => !l.includes('李娜')).join('\n');
  const v2 = buildPreview({ vtt: cut, rules: [rule], aliases: v1.aliases });
  const names = v2.cues.flatMap((c) => c.hits.map((h) => [h.match, h.alias]));
  assert.deepStrictEqual(names, [
    ['张伟', '人物1'],
    ['张伟', '人物1'],
    ['王芳', '人物3'],
  ]);
  // 新实体拿到下一个编号 4
  const withNew = cut.replace('王芳女士', '赵敏女士');
  const v3 = buildPreview({ vtt: withNew, rules: [rule], aliases: v1.aliases });
  const zhao = v3.cues.flatMap((c) => c.hits).find((h) => h.match === '赵敏')!;
  assert.strictEqual(zhao.alias, '人物4');
});

/** 实体键规范化：NFKC（全角→半角等）+ trim，跨 cue 收敛同一实体 */
test('稳定化名：NFKC 与首尾空白规范化实体键', () => {
  assert.strictEqual(normalizeEntity(' ＡＢＣ '), 'ABC');
  const rule: MaskRule = {
    id: 'code',
    name: '代号',
    pattern: '[A-Za-z0-9Ａ-ｚ０-９]{2,}',
    flags: 'g',
    replacement: '',
    priority: 10,
    enabled: true,
    mode: 'alias',
    aliasPrefix: '代号',
    crossCue: false,
    maxCueGapMs: 500,
    beforePattern: '',
    afterPattern: '',
    beforeChars: 0,
    afterChars: 0,
  };
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
代号 abc12

00:00:02.000 --> 00:00:03.000
代号 ａｂｃ１２
`;
  const v = buildPreview({ vtt, rules: [rule] });
  const hits = v.cues.flatMap((c) => c.hits);
  assert.strictEqual(hits.length, 2);
  assert.strictEqual(hits[0].entityKey, 'abc12');
  assert.strictEqual(hits[1].entityKey, 'abc12');
  assert.strictEqual(hits[0].alias, hits[1].alias);
  assert.strictEqual(hits[0].alias, '代号1');
});

/** 手动改名：回传自定义化名后，所有未撤销命中立即联动 */
test('稳定化名：手动改名联动全部未撤销命中，撤销处恢复原文', () => {
  const rule: MaskRule = { id: 'al', ...PRESETS.find((p) => p.rule.name === '姓名-稳定化名')!.rule, enabled: true };
  const v1 = buildPreview({ vtt: ALIAS_VTT, rules: [rule] });
  const renamed: AliasEntry[] = v1.aliases.map((a) =>
    a.entityKey === '张伟' ? { ...a, alias: '客户甲', auto: false } : a,
  );
  const zhangKey = v1.cues[0].hits.find((h) => h.match === '张伟')!.key;
  const v2 = buildPreview({
    vtt: ALIAS_VTT,
    rules: [rule],
    aliases: renamed,
    revertedKeys: [zhangKey],
  });
  const zhang = v2.cues.flatMap((c) => c.hits).filter((h) => h.match === '张伟');
  assert.strictEqual(zhang[0].reverted, true);
  assert.strictEqual(zhang[0].replacement, '客户甲'); // 改名仍联动，撤销只控制是否替换
  assert.ok(zhang.slice(1).every((h) => h.replacement === '客户甲'));
  assert.strictEqual(v2.revertedHits, 1);
  assert.strictEqual(v2.appliedHits, zhang.length - 1 + 2);

  const ex = exportResult({ vtt: ALIAS_VTT, rules: [rule], aliases: renamed, revertedKeys: [zhangKey] });
  assert.ok(ex.vtt.includes('张伟先生到了'), '撤销处保留原文');
  assert.ok(!ex.vtt.includes('人物1'));
  assert.ok(ex.vtt.includes('客户甲先生和'));
  // 审计记录实体键、最终化名、状态
  const recs = ex.audit.records.filter((r) => r.entityKey === '张伟');
  assert.ok(recs.some((r) => r.status === 'reverted' && r.alias === '客户甲'));
  assert.ok(recs.some((r) => r.status === 'applied' && r.alias === '客户甲'));
  assert.ok(ex.audit.aliases!.some((a) => a.entityKey === '张伟' && a.alias === '客户甲'));
});

/** 前缀变更：自动化名跟随新前缀，手动改名保持不变 */
test('稳定化名：前缀调整联动自动条目，自定义条目不受影响', () => {
  const base: MaskRule = { id: 'al', ...PRESETS.find((p) => p.rule.name === '姓名-稳定化名')!.rule, enabled: true };
  const v1 = buildPreview({ vtt: ALIAS_VTT, rules: [base] });
  const aliases: AliasEntry[] = v1.aliases.map((a) =>
    a.entityKey === '李娜' ? { ...a, alias: '当事人', auto: false } : a,
  );
  const renamedRule = { ...base, aliasPrefix: '受访者' };
  const v2 = buildPreview({ vtt: ALIAS_VTT, rules: [renamedRule], aliases });
  const byKey = new Map(v2.aliases.map((a) => [a.entityKey, a.alias]));
  assert.strictEqual(byKey.get('张伟'), '受访者1');
  assert.strictEqual(byKey.get('李娜'), '当事人');
  assert.strictEqual(byKey.get('王芳'), '受访者3');
  assert.strictEqual(autoAliasFor('受访者', 3), '受访者3');
});

/** 模板规则与化名规则并存，重叠抑制语义不变 */
test('稳定化名：与模板规则并存，优先级抑制照常', () => {
  const tpl: MaskRule = {
    id: 'tpl',
    name: '姓名打码',
    pattern: '张伟',
    flags: 'g',
    replacement: '张*',
    priority: 40,
    enabled: true,
    mode: 'template',
    aliasPrefix: '人物',
    crossCue: false,
    maxCueGapMs: 500,
    beforePattern: '',
    afterPattern: '',
    beforeChars: 0,
    afterChars: 0,
  };
  const alias: MaskRule = {
    id: 'al',
    ...PRESETS.find((p) => p.rule.name === '姓名-稳定化名')!.rule,
    enabled: true,
    priority: 10,
  };
  const v = buildPreview({ vtt: ALIAS_VTT, rules: [tpl, alias] });
  const firstCue = v.cues[0];
  assert.strictEqual(firstCue.hits[0].replacement, '张*');
  assert.ok(firstCue.suppressed.some((s) => s.ruleName === '姓名-稳定化名' && s.entityKey === '张伟'));
});

/* ---------------------------- 实体决策 ---------------------------- */

const DECIDE_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
客服张伟先生，工号 1001。

00:00:02.500 --> 00:00:05.000
张伟先生再次来电。
`;

function keepDecision(ruleId: string, entityKey: string): EntityDecision {
  return { ruleId, entityKey, action: 'keep', decidedAt: '2026-09-19T00:00:00.000Z' };
}

/** 始终保留：同实体全部命中保留原文，后续新出现的同实体命中自动继承 */
test('实体决策：始终保留作用于同实体全部命中，新命中自动继承', () => {
  const rule = presetRule('姓名');
  const decisions = [keepDecision(rule.id, '张伟')];
  const v1 = buildPreview({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  const zhang = v1.cues.flatMap((c) => c.hits).filter((h) => h.match === '张伟');
  assert.strictEqual(zhang.length, 2);
  assert.ok(zhang.every((h) => h.reverted && h.decisionSource === 'entity'));

  // 新增一条含同实体的 cue：无需任何操作即继承保留
  const more = DECIDE_VTT + '\n00:00:06.000 --> 00:00:08.000\n张伟先生三顾茅庐。\n';
  const v2 = buildPreview({ vtt: more, rules: [rule], entityDecisions: decisions });
  const zhang2 = v2.cues.flatMap((c) => c.hits).filter((h) => h.match === '张伟');
  assert.strictEqual(zhang2.length, 3);
  assert.ok(zhang2.every((h) => h.reverted && h.decisionSource === 'entity'));

  // 导出 VTT 与预览同一最终状态：全部保留原文
  const ex = exportResult({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  assert.ok(ex.vtt.includes('张伟先生'));
  assert.ok(!ex.vtt.includes('张*'));
});

/** 始终应用 + 逐条例外：例外优先于实体决定，清除例外后恢复继承 */
test('实体决策：逐条例外优先于实体决定，清除后恢复继承', () => {
  const rule = presetRule('姓名');
  const decisions = [keepDecision(rule.id, '张伟')];
  const v1 = buildPreview({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  const target = v1.cues[0].hits.find((h) => h.match === '张伟')!;
  assert.ok(target.reverted);

  // 对该命中写入显式「应用」例外：覆盖实体保留决定
  const v2 = buildPreview({
    vtt: DECIDE_VTT,
    rules: [rule],
    entityDecisions: decisions,
    hitExceptions: [{ key: target.key, state: 'applied' }],
  });
  const t2 = v2.cues[0].hits.find((h) => h.key === target.key)!;
  assert.strictEqual(t2.reverted, false);
  assert.strictEqual(t2.decisionSource, 'exception');
  // 其余同实体命中仍继承保留
  const others = v2.cues
    .flatMap((c) => c.hits)
    .filter((h) => h.match === '张伟' && h.key !== target.key);
  assert.ok(others.length === 1 && others.every((h) => h.reverted && h.decisionSource === 'entity'));

  // 清除例外：恢复继承实体保留决定
  const v3 = buildPreview({
    vtt: DECIDE_VTT,
    rules: [rule],
    entityDecisions: decisions,
    hitExceptions: [],
  });
  assert.ok(v3.cues[0].hits.find((h) => h.key === target.key)!.reverted);

  // 反向：实体决定为始终应用，逐条撤销例外使其保留原文
  const applyDecisions: EntityDecision[] = [
    { ruleId: rule.id, entityKey: '张伟', action: 'apply', decidedAt: '2026-09-19T00:00:00.000Z' },
  ];
  const v4 = buildPreview({
    vtt: DECIDE_VTT,
    rules: [rule],
    entityDecisions: applyDecisions,
    hitExceptions: [{ key: target.key, state: 'reverted' }],
  });
  const t4 = v4.cues[0].hits.find((h) => h.key === target.key)!;
  assert.ok(t4.reverted && t4.decisionSource === 'exception');
  const inherited = v4.cues.flatMap((c) => c.hits).filter((h) => h.match === '张伟' && h.key !== target.key);
  assert.ok(inherited.every((h) => !h.reverted && h.decisionSource === 'entity'));
});

/** 实体键 NFKC 归一：全角 / 半角写法收敛为同一实体，决定一并继承（模板规则同样生效） */
test('实体决策：NFKC 归一后同实体跨写法继承决定', () => {
  const rule: MaskRule = {
    id: 'num',
    name: '编号',
    pattern: '[0-9０-９]{4}',
    flags: 'g',
    replacement: '****',
    priority: 10,
    enabled: true,
    mode: 'template',
    aliasPrefix: '',
    crossCue: false,
    maxCueGapMs: 500,
    beforePattern: '',
    afterPattern: '',
    beforeChars: 0,
    afterChars: 0,
  };
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n编号 1234 与 １２３４\n';
  const v = buildPreview({
    vtt,
    rules: [rule],
    entityDecisions: [keepDecision('num', '1234')],
  });
  const hits = v.cues[0].hits;
  assert.strictEqual(hits.length, 2);
  assert.ok(hits.every((h) => h.entityKey === '1234'));
  assert.ok(hits.every((h) => h.reverted && h.decisionSource === 'entity'));
});

/** 重叠合并后实体决定只对胜出命中生效；被抑制命中不生成例外、不受决定影响 */
test('实体决策：被抑制命中不受影响，决定只作用于胜出命中', () => {
  const idRule = presetRule('身份证');
  const bankRule = presetRule('银行卡');
  const idVtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n身份证号 110101199003071234 登记。\n';
  const decisions = [keepDecision(bankRule.id, normalizeEntity('110101199003071234'))];

  // 身份证(80) 胜出，银行卡被抑制：保留决定不落在任何胜出命中上
  const v1 = buildPreview({ vtt: idVtt, rules: [idRule, bankRule], entityDecisions: decisions });
  assert.ok(v1.cues[0].suppressed.some((s) => s.ruleName === '银行卡'));
  assert.strictEqual(v1.revertedHits, 0);
  assert.strictEqual(v1.exceptionHits, 0);
  const idHit = v1.cues[0].hits.find((h) => h.ruleName === '身份证')!;
  assert.ok(!idHit.reverted && idHit.decisionSource === 'default');

  // 规则变化（身份证停用）后银行卡成为胜出命中，继承保留决定
  const v2 = buildPreview({
    vtt: idVtt,
    rules: [{ ...idRule, enabled: false }, bankRule],
    entityDecisions: decisions,
  });
  const bank = v2.cues[0].hits.find((h) => h.ruleName === '银行卡')!;
  assert.ok(bank.reverted && bank.decisionSource === 'entity');
});

/** 审计：每条记录携带决策来源，报告含实体决定与例外统计，导出与预览同一最终状态 */
test('实体决策：审计记录决策来源，导出与预览状态一致', () => {
  const rule = presetRule('姓名');
  const decisions = [keepDecision(rule.id, '张伟')];
  const v1 = buildPreview({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  const exKey = v1.cues[0].hits.find((h) => h.match === '张伟')!.key;
  const input = {
    vtt: DECIDE_VTT,
    rules: [rule],
    entityDecisions: decisions,
    hitExceptions: [{ key: exKey, state: 'applied' as const }],
  };
  const ex = exportResult(input);
  const recs = ex.audit.records.filter((r) => r.entityKey === '张伟');
  assert.ok(recs.some((r) => r.status === 'applied' && r.decisionSource === 'exception'));
  assert.ok(recs.some((r) => r.status === 'reverted' && r.decisionSource === 'entity'));
  assert.strictEqual(ex.audit.version, 7);
  assert.strictEqual(ex.audit.stats.exceptionHits, 1);
  assert.ok(ex.audit.entityDecisions!.some((d) => d.entityKey === '张伟' && d.action === 'keep'));
  // 导出 VTT 与预览最终状态一致：例外处替换，其余保留
  assert.ok(ex.vtt.includes('张*先生'));
  assert.ok(ex.vtt.includes('张伟先生再次来电'));
});

/** 实体决策列表：汇总命中 / 例外统计，包含当前无命中的持久决定 */
test('实体决策：实体列表汇总统计，含未命中实体的持久决定', () => {
  const rule = presetRule('姓名');
  const decisions: EntityDecision[] = [
    keepDecision(rule.id, '张伟'),
    { ruleId: rule.id, entityKey: '李四', action: 'apply', decidedAt: '2026-09-19T00:00:00.000Z' },
  ];
  const v1 = buildPreview({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  const zw = v1.entities.find((e) => e.entityKey === '张伟')!;
  assert.strictEqual(zw.decision, 'keep');
  assert.strictEqual(zw.totalHits, 2);
  assert.strictEqual(zw.revertedHits, 2);
  assert.strictEqual(zw.exceptionHits, 0);
  // 当前无命中但已持久决定的实体也列出（决定对未来命中生效）
  const ls = v1.entities.find((e) => e.entityKey === '李四')!;
  assert.strictEqual(ls.totalHits, 0);
  assert.strictEqual(ls.decision, 'apply');

  // 写入一条例外后：实体的例外计数与全局例外计数联动
  const key = v1.cues[0].hits.find((h) => h.match === '张伟')!.key;
  const v2 = buildPreview({
    vtt: DECIDE_VTT,
    rules: [rule],
    entityDecisions: decisions,
    hitExceptions: [{ key, state: 'applied' }],
  });
  assert.strictEqual(v2.entities.find((e) => e.entityKey === '张伟')!.exceptionHits, 1);
  assert.strictEqual(v2.exceptionHits, 1);
});

/** 兼容：旧版 revertedKeys 仍按逐条「撤销」例外生效 */
test('兼容：旧版 revertedKeys 作为逐条撤销例外生效', () => {
  const rules = [presetRule('手机号')];
  const v1 = buildPreview({ vtt: SAMPLE_VTT, rules });
  const key = v1.cues[0].hits[0].key;
  const v2 = buildPreview({ vtt: SAMPLE_VTT, rules, revertedKeys: [key] });
  const h = v2.cues[0].hits[0];
  assert.ok(h.reverted && h.decisionSource === 'exception');
  // 显式例外与旧字段并存时，显式例外优先
  const v3 = buildPreview({
    vtt: SAMPLE_VTT,
    rules,
    revertedKeys: [key],
    hitExceptions: [{ key, state: 'applied' }],
  });
  assert.ok(!v3.cues[0].hits[0].reverted);
});

/** 兼容：旧 job.json（revertedKeys 时代）迁移为逐条例外与空实体决定 */
test('兼容：旧 job.json 迁移为逐条例外与空实体决定', () => {
  const migrated = migrateJobState({
    jobId: 'j1',
    vtt: 'WEBVTT',
    rules: [],
    revertedKeys: ['k1', 'k2'],
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepStrictEqual(migrated.hitExceptions, [
    { key: 'k1', state: 'reverted' },
    { key: 'k2', state: 'reverted' },
  ]);
  assert.deepStrictEqual(migrated.entityDecisions, []);
  assert.deepStrictEqual(migrated.aliases, []);

  // 新格式存在时优先，旧字段不再生效
  const m2 = migrateJobState({
    hitExceptions: [{ key: 'x', state: 'applied' }],
    entityDecisions: [{ ruleId: 'r', entityKey: 'e', action: 'keep', decidedAt: 't' }],
    revertedKeys: ['k1'],
  });
  assert.deepStrictEqual(m2.hitExceptions, [{ key: 'x', state: 'applied' }]);
  assert.strictEqual(m2.entityDecisions.length, 1);

  // 旧规则缺少上下文字段：按无条件迁移（beforePattern / afterPattern 为空，字符数 0）
  const legacyRule = { ...presetRule('手机号') } as unknown as Record<string, unknown>;
  delete legacyRule.beforePattern;
  delete legacyRule.afterPattern;
  delete legacyRule.beforeChars;
  delete legacyRule.afterChars;
  delete legacyRule.crossCue;
  const m3 = migrateJobState({ rules: [legacyRule as unknown as MaskRule] });
  assert.strictEqual(m3.rules.length, 1);
  assert.strictEqual(m3.rules[0].beforePattern, '');
  assert.strictEqual(m3.rules[0].afterPattern, '');
  assert.strictEqual(m3.rules[0].beforeChars, 0);
  assert.strictEqual(m3.rules[0].afterChars, 0);
  assert.strictEqual(m3.rules[0].crossCue, false);
});

/* ---------------------------- 导出残留防线 ---------------------------- */

/** 候选文本与字符来源映射：原文 / 人工保留 / 替换产物三段来源正确 */
test('残留防线：候选文本来源映射（原文 / 人工保留 / 替换产物）', () => {
  const rules = [presetRule('手机号')];
  const v1 = buildPreview({ vtt: SAMPLE_VTT, rules });
  const revertKey = v1.cues[0].hits[0].key;
  const v2 = buildPreview({ vtt: SAMPLE_VTT, rules, revertedKeys: [revertKey] });
  const { text, segments } = buildFinalText(v2.cues[0]);
  assert.strictEqual(text, v2.cues[0].text, '全部撤销时候选文本等于原文');
  assert.deepStrictEqual(
    segments.map((s) => [s.source, s.text]),
    [
      ['original', '客服您好，我是张伟先生，我的手机号是'],
      ['reverted', '13812345678'],
      ['original', '。'],
    ],
  );
  // 应用态：替换产物片段带来源规则
  const applied = buildFinalText(v1.cues[0]);
  const rep = applied.segments.find((s) => s.source === 'replacement')!;
  assert.strictEqual(rep.text, '138****5678');
  assert.strictEqual(rep.ruleName, '手机号');
  assert.strictEqual(applied.text.slice(rep.start, rep.end), rep.text);
});

/** 人工保留：撤销 / 实体保留的命中被二次命中时仅提示，不阻断导出 */
test('残留防线：人工保留仅提示，不阻断导出，审计计数', () => {
  const rules = [presetRule('手机号')];
  const v1 = buildPreview({ vtt: SAMPLE_VTT, rules });
  const revertKey = v1.cues[0].hits[0].key;
  const input = { vtt: SAMPLE_VTT, rules, revertedKeys: [revertKey] };
  const v2 = buildPreview(input);
  // 撤销的 13812345678 被手机号规则二次命中 → 人工保留；另一个号码已脱敏无残留
  assert.strictEqual(v2.safety.kept, 1);
  assert.strictEqual(v2.safety.artifact, 0);
  assert.strictEqual(v2.safety.crossBoundary, 0);
  assert.strictEqual(v2.safety.blocked, false);
  const issue = v2.safety.issues[0];
  assert.strictEqual(issue.kind, 'kept');
  assert.strictEqual(issue.match, '13812345678');
  assert.strictEqual(issue.cueIndex, 0);
  assert.strictEqual(issue.rule.name, '手机号');
  assert.ok(issue.segments.every((s) => s.source === 'reverted'));

  // 不阻断导出；审计记录 safetyScan 分类计数与问题清单
  const ex = exportResult(input);
  assert.ok(ex.vtt.includes('13812345678'));
  assert.deepStrictEqual(ex.audit.safetyScan.counts, { kept: 1, artifact: 0, crossBoundary: 0 });
  assert.strictEqual(ex.audit.safetyScan.blocked, false);
  assert.strictEqual(ex.audit.safetyScan.issues.length, 1);
  assert.strictEqual(ex.audit.safetyScan.issues[0].kind, 'kept');
});

/** 实体「始终保留」决定同样视为人工保留 */
test('残留防线：实体保留决定的二次命中归为人工保留', () => {
  const rule = presetRule('姓名');
  const decisions = [keepDecision(rule.id, '张伟')];
  const v = buildPreview({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  assert.strictEqual(v.safety.kept, 2, '两处保留的张伟均应被二次命中');
  assert.strictEqual(v.safety.blocked, false);
  assert.ok(v.safety.issues.every((i) => i.kind === 'kept'));
  const ex = exportResult({ vtt: DECIDE_VTT, rules: [rule], entityDecisions: decisions });
  assert.strictEqual(ex.audit.safetyScan.counts.kept, 2);
});

/** 被抑制命中随人工保留复现：不涉及替换产物 → 人工保留（仅提示），不误判为跨边界 */
test('残留防线：被抑制命中随保留复现归为人工保留', () => {
  const nameRule = presetRule('姓名'); // 命中「张伟」，优先级 20
  const wider: MaskRule = {
    id: 'wide',
    name: '姓名带称谓',
    pattern: '伟先生',
    flags: 'g',
    replacement: '***',
    priority: 10, // 低于姓名，第一遍被抑制
    enabled: true,
    mode: 'template',
    aliasPrefix: '',
    crossCue: false,
    maxCueGapMs: 500,
    beforePattern: '',
    afterPattern: '',
    beforeChars: 0,
    afterChars: 0,
  };
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n张伟先生到了。\n';
  const v1 = buildPreview({ vtt, rules: [nameRule, wider] });
  assert.ok(v1.cues[0].suppressed.some((s) => s.ruleId === 'wide'));
  // 保留「张伟」后：候选文本回到原文，被抑制的「伟先生」复现，但无替换产物参与
  const key = v1.cues[0].hits.find((h) => h.ruleId === nameRule.id)!.key;
  const v2 = buildPreview({ vtt, rules: [nameRule, wider], revertedKeys: [key] });
  assert.strictEqual(v2.safety.blocked, false);
  assert.strictEqual(v2.safety.crossBoundary, 0);
  assert.strictEqual(v2.safety.kept, 2, '张伟（保留命中）与 伟先生（抑制复现）均为人工保留');
  const revived = v2.safety.issues.find((i) => i.rule.id === 'wide')!;
  assert.strictEqual(revived.kind, 'kept');
  assert.deepStrictEqual(
    revived.segments.map((s) => s.source),
    ['reverted', 'original'],
  );
});

/** 替换产物：替换结果本身被另一条规则命中 → 阻断导出，报告来源 / 目标规则 */
test('残留防线：替换产物命中阻断导出并报告来源与目标规则', () => {
  const producer: MaskRule = {
    id: 'p1',
    name: '地址脱敏',
    pattern: '朝阳路\\d+号',
    flags: 'g',
    replacement: '某小区3号楼',
    priority: 50,
    enabled: true,
    mode: 'template',
    aliasPrefix: '',
    crossCue: false,
    maxCueGapMs: 500,
    beforePattern: '',
    afterPattern: '',
    beforeChars: 0,
    afterChars: 0,
  };
  const target: MaskRule = {
    id: 't1',
    name: '楼号',
    pattern: '\\d+号楼',
    flags: 'g',
    replacement: '*号楼',
    priority: 40,
    enabled: true,
    mode: 'template',
    aliasPrefix: '',
    crossCue: false,
    maxCueGapMs: 500,
    beforePattern: '',
    afterPattern: '',
    beforeChars: 0,
    afterChars: 0,
  };
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n我住在朝阳路5号。\n';
  const v = buildPreview({ vtt, rules: [producer, target] });
  assert.strictEqual(v.safety.artifact, 1);
  assert.strictEqual(v.safety.blocked, true);
  const issue = v.safety.issues[0];
  assert.strictEqual(issue.kind, 'artifact');
  assert.strictEqual(issue.match, '3号楼');
  assert.strictEqual(issue.rule.id, 't1', '目标规则为二次命中的规则');
  assert.strictEqual(issue.sourceRule!.id, 'p1', '来源规则为产生替换的规则');
  assert.strictEqual(issue.sourceRule!.name, '地址脱敏');
  assert.strictEqual(issue.segments.length, 1);
  assert.strictEqual(issue.segments[0].source, 'replacement');

  // 导出被阻断：抛出 SafetyScanBlockedError 并携带扫描结果
  assert.throws(
    () => exportResult({ vtt, rules: [producer, target] }),
    (e: unknown) => {
      assert.ok(e instanceof SafetyScanBlockedError);
      assert.strictEqual(e.scan.artifact, 1);
      return true;
    },
  );

  // 撤销来源命中（改为人为保留）后：二次命中落在保留原文上 → 仅提示，放行
  const hitKey = v.cues[0].hits.find((h) => h.ruleId === 'p1')!.key;
  const v2 = buildPreview({ vtt, rules: [producer, target], revertedKeys: [hitKey] });
  assert.strictEqual(v2.safety.blocked, false);
  assert.strictEqual(v2.safety.kept, 1, '来源规则命中保留原文「朝阳路5号」，归为人工保留');
});

/** 跨边界新命中：替换删除分隔符后，两侧原文拼出新的敏感串 → 阻断导出 */
test('残留防线：跨边界新命中阻断导出并列出涉及区间', () => {
  const dashRule: MaskRule = {
    id: 'dash',
    name: '去分隔符',
    pattern: '-',
    flags: 'g',
    replacement: '',
    priority: 90,
    enabled: true,
    mode: 'template',
    aliasPrefix: '',
    crossCue: false,
    maxCueGapMs: 500,
    beforePattern: '',
    afterPattern: '',
    beforeChars: 0,
    afterChars: 0,
  };
  const phone = presetRule('手机号');
  const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n电话 138-12345678 已登记。\n';
  // 第一遍：手机号规则不命中（含分隔符），仅删除分隔符
  const v = buildPreview({ vtt, rules: [dashRule, phone] });
  assert.strictEqual(v.appliedHits, 1);
  // 二次扫描：138-12345678 → 13812345678 被手机号规则命中，跨越 原文+替换+原文
  assert.strictEqual(v.safety.crossBoundary, 1);
  assert.strictEqual(v.safety.blocked, true);
  const issue = v.safety.issues[0];
  assert.strictEqual(issue.kind, 'crossBoundary');
  assert.strictEqual(issue.match, '13812345678');
  assert.strictEqual(issue.rule.name, '手机号');
  assert.deepStrictEqual(
    issue.segments.map((s) => s.source),
    ['original', 'replacement', 'original'],
    '涉及区间应列出跨替换边界的全部片段',
  );
  assert.throws(() => exportResult({ vtt, rules: [dashRule, phone] }), SafetyScanBlockedError);
});

/** 默认预设 + 示例字幕：替换结果不再被任何规则命中，扫描干净 */
test('残留防线：示例字幕默认规则下无残留问题', () => {
  const rules = PRESETS.map((p, i) => ({ id: `r${i}`, ...p.rule }));
  const v = buildPreview({ vtt: SAMPLE_VTT, rules });
  assert.strictEqual(v.safety.issues.length, 0);
  assert.strictEqual(v.safety.blocked, false);
  const ex = exportResult({ vtt: SAMPLE_VTT, rules });
  assert.deepStrictEqual(ex.audit.safetyScan.counts, { kept: 0, artifact: 0, crossBoundary: 0 });
});

/* ---------------------------- 跨 cue 连续扫描 ---------------------------- */

/** 跨 cue 规则：手机号被两条相邻字幕断开 */
function crossPhoneRule(override: Partial<MaskRule> = {}): MaskRule {
  return {
    id: 'r-cross',
    name: '手机号-跨字幕',
    pattern: '(?<!\\d)(1[3-9]\\d)\\d{4}(\\d{4})(?!\\d)',
    flags: 'g',
    replacement: '$1****$2',
    priority: 50,
    enabled: true,
    mode: 'template',
    aliasPrefix: '号码',
    crossCue: true,
    maxCueGapMs: 500,
    beforePattern: '',
    afterPattern: '',
    beforeChars: 0,
    afterChars: 0,
    ...override,
  };
}

const CROSS_VTT = `WEBVTT

c-1
00:00:01.000 --> 00:00:02.000
我的手机号是 1381234

c-2
00:00:02.300 --> 00:00:04.000
5678，记住了吗？
`;

test('跨 cue：时间码解析与相邻窗口分组', () => {
  assert.strictEqual(timeToMs('00:00:02.300'), 2300);
  assert.strictEqual(timeToMs('00:00:02,300'), 2300);
  assert.strictEqual(timeToMs('01:02:03.004'), 3723004);
  assert.strictEqual(timeToMs('02:03.004'), 123004);
  const cues = [
    { index: 0, start: '00:00:01.000', end: '00:00:02.000', text: 'ab' },
    { index: 1, start: '00:00:02.300', end: '00:00:04.000', text: 'cd' },
    { index: 2, start: '00:00:06.000', end: '00:00:07.000', text: 'ef' },
  ];
  const wins = buildScanWindows(cues, 500);
  assert.strictEqual(wins.length, 2, '间隔 2000ms 的第 3 条应自成窗口');
  assert.deepStrictEqual(wins[0].cueIndexes, [0, 1]);
  assert.strictEqual(wins[0].text, 'abcd');
  assert.deepStrictEqual(
    wins[0].loc.map((l) => [l.cue, l.off]),
    [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ],
  );
  // 间隔恰等于阈值也算相邻
  assert.strictEqual(buildScanWindows(cues, 2000).length, 1);
});

test('跨 cue：断开的手机号命中，替换写入首条、后续字符删除、时间标识保留', () => {
  const rule = crossPhoneRule();
  const v = buildPreview({ vtt: CROSS_VTT, rules: [rule] });
  assert.strictEqual(v.totalHits, 1, '跨 cue 命中只计一次');
  assert.strictEqual(v.appliedHits, 1);
  const hit = v.cues[0].hits[0];
  assert.strictEqual(hit.match, '13812345678');
  assert.strictEqual(hit.replacement, '138****5678');
  assert.deepStrictEqual(
    hit.spans.map((s) => [s.cueIndex, s.start, s.end]),
    [
      [0, 7, 13],
      [1, 0, 3],
    ],
  );
  // 同一命中挂在所有涉及 cue 上（预览联动高亮 / 撤销共用同一命中键）
  assert.strictEqual(v.cues[1].hits.length, 1);
  assert.strictEqual(v.cues[1].hits[0].key, hit.key);
  assert.ok(hit.key.includes('+'), '跨 cue 命中键编码全部涉及区间');

  const ex = exportResult({ vtt: CROSS_VTT, rules: [rule] });
  assert.ok(ex.vtt.includes('我的手机号是 138****5678'), '替换写入首条 cue');
  assert.ok(ex.vtt.includes('，记住了吗？'), '后续 cue 被覆盖字符删除、未命中文字保留');
  assert.ok(!ex.vtt.includes('5678，'), '被覆盖字符已删除');
  assert.ok(ex.vtt.includes('c-1') && ex.vtt.includes('c-2'), 'cue 标识保留');
  assert.ok(
    ex.vtt.includes('00:00:01.000 --> 00:00:02.000') &&
      ex.vtt.includes('00:00:02.300 --> 00:00:04.000'),
    '各 cue 时间原样保留',
  );
  // 审计：同一命中键 + 涉及 cue 列表
  const rec = ex.audit.records.find((r) => r.status === 'applied')!;
  assert.strictEqual(rec.key, hit.key);
  assert.deepStrictEqual(rec.cueIndexes, [0, 1]);
  assert.strictEqual(rec.source.text, '13812345678');
  // 替换后候选文本无残留
  assert.strictEqual(ex.audit.safetyScan.blocked, false);
});

test('跨 cue：间隔超过阈值不命中，调大阈值后命中', () => {
  const farVtt = CROSS_VTT.replace('00:00:02.300', '00:00:03.000'); // 间隔 1000ms
  const v1 = buildPreview({ vtt: farVtt, rules: [crossPhoneRule()] });
  assert.strictEqual(v1.totalHits, 0, '间隔 1000ms 超过默认 500ms，不组成窗口');
  const v2 = buildPreview({
    vtt: farVtt,
    rules: [crossPhoneRule({ maxCueGapMs: 1500 })],
  });
  assert.strictEqual(v2.totalHits, 1, '调大阈值后同一敏感串命中');
  assert.strictEqual(v2.cues[0].hits[0].match, '13812345678');
});

test('跨 cue：与单 cue 命中统一按优先级 / 长度消解重叠', () => {
  const tail: MaskRule = {
    id: 'r-tail',
    name: '尾号',
    pattern: '5678，',
    flags: 'g',
    replacement: '***',
    priority: 90,
    enabled: true,
    mode: 'template',
    aliasPrefix: '',
    crossCue: false,
    maxCueGapMs: 500,
    beforePattern: '',
    afterPattern: '',
    beforeChars: 0,
    afterChars: 0,
  };
  // 单 cue 高优先级命中与跨 cue 命中在第二条字幕重叠 → 跨 cue 命中被抑制
  const v1 = buildPreview({ vtt: CROSS_VTT, rules: [crossPhoneRule(), tail] });
  assert.strictEqual(v1.totalHits, 1);
  assert.strictEqual(v1.cues[1].hits[0].ruleId, 'r-tail');
  assert.strictEqual(v1.suppressedHits, 1);
  const sup = v1.cues[0].suppressed[0];
  assert.strictEqual(sup.ruleId, 'r-cross');
  assert.strictEqual(sup.winnerRuleId, 'r-tail');
  assert.deepStrictEqual(
    sup.spans.map((s) => s.cueIndex),
    [0, 1],
    '被抑制的跨 cue 命中记录全部涉及 cue',
  );
  // 反转优先级：跨 cue 命中胜出，单 cue 命中被抑制
  const v2 = buildPreview({
    vtt: CROSS_VTT,
    rules: [crossPhoneRule({ priority: 95 }), tail],
  });
  assert.strictEqual(v2.cues[0].hits[0].ruleId, 'r-cross');
  assert.ok(v2.cues[1].suppressed.some((s) => s.ruleId === 'r-tail'));
});

test('跨 cue：逐条撤销联动所有涉及 cue，残留防线记为人工保留', () => {
  const rule = crossPhoneRule();
  const v1 = buildPreview({ vtt: CROSS_VTT, rules: [rule] });
  const key = v1.cues[0].hits[0].key;
  const v2 = buildPreview({ vtt: CROSS_VTT, rules: [rule], revertedKeys: [key] });
  assert.strictEqual(v2.revertedHits, 1);
  // 两个 cue 上的同一命中都为撤销态
  assert.ok(v2.cues[0].hits[0].reverted);
  assert.ok(v2.cues[1].hits[0].reverted);
  assert.strictEqual(v2.cues[1].hits[0].key, key);
  // 残留防线：跨 cue 窗口二次扫描发现保留的完整号码 → 人工保留（仅提示）
  assert.strictEqual(v2.safety.blocked, false);
  assert.strictEqual(v2.safety.kept, 1);
  const issue = v2.safety.issues[0];
  assert.strictEqual(issue.kind, 'kept');
  assert.strictEqual(issue.match, '13812345678');
  assert.deepStrictEqual(issue.cueIndexes, [0, 1]);
  assert.deepStrictEqual(
    issue.segments.map((s) => [s.cueIndex, s.source]),
    [
      [0, 'reverted'],
      [1, 'reverted'],
    ],
  );
  // 导出恢复两条 cue 原文
  const ex = exportResult({ vtt: CROSS_VTT, rules: [rule], revertedKeys: [key] });
  assert.ok(ex.vtt.includes('1381234'));
  assert.ok(ex.vtt.includes('5678，'));
  const rec = ex.audit.records.find((r) => r.status === 'reverted')!;
  assert.strictEqual(rec.key, key);
  assert.deepStrictEqual(rec.cueIndexes, [0, 1]);
});

test('跨 cue：实体决定与稳定化名沿用同一命中键', () => {
  const aliasRule = crossPhoneRule({ mode: 'alias', replacement: '', aliasPrefix: '号码' });
  const v1 = buildPreview({ vtt: CROSS_VTT, rules: [aliasRule] });
  const hit = v1.cues[0].hits[0];
  assert.strictEqual(hit.alias, '号码1');
  assert.strictEqual(hit.replacement, '号码1');
  assert.strictEqual(hit.entityKey, '13812345678');
  const ex = exportResult({ vtt: CROSS_VTT, rules: [aliasRule] });
  assert.ok(ex.vtt.includes('我的手机号是 号码1'), '化名写入首条 cue');
  assert.ok(ex.vtt.includes('，记住了吗？'), '后续 cue 被覆盖字符删除');

  // 实体「始终保留」决定作用于跨 cue 命中（同一实体键）
  const decisions: EntityDecision[] = [
    { ruleId: aliasRule.id, entityKey: '13812345678', action: 'keep', decidedAt: '2026-09-19T00:00:00.000Z' },
  ];
  const v2 = buildPreview({ vtt: CROSS_VTT, rules: [aliasRule], entityDecisions: decisions });
  assert.ok(v2.cues[0].hits[0].reverted && v2.cues[0].hits[0].decisionSource === 'entity');
  assert.ok(v2.cues[1].hits[0].reverted, '同一命中在后续 cue 同步保留');
  assert.strictEqual(v2.safety.kept, 1, '保留的跨 cue 号码归为人工保留');
});

test('跨 cue：单 cue 命中键保持历史格式，例外状态兼容恢复', () => {
  const rules = [presetRule('手机号')];
  const v = buildPreview({ vtt: SAMPLE_VTT, rules });
  const key = v.cues[0].hits[0].key;
  assert.match(key, /^\d+:\d{2}:\d{2}:\d{2}[.,]\d{3}:\d+-\d+:.+$/, '单 cue 命中键格式不变');
  assert.ok(!key.includes('+'));
  const rec = exportResult({ vtt: SAMPLE_VTT, rules }).audit.records.find(
    (r) => r.status === 'applied',
  )!;
  assert.strictEqual(rec.key, key);
  assert.deepStrictEqual(rec.cueIndexes, [0]);
});

test('跨 cue：旧规则缺少跨 cue 字段时按默认补齐', () => {
  const legacy = presetRule('手机号') as unknown as Record<string, unknown>;
  delete legacy.crossCue;
  delete legacy.maxCueGapMs;
  const n = normalizeRule(legacy as unknown as MaskRule);
  assert.strictEqual(n.crossCue, false);
  assert.strictEqual(n.maxCueGapMs, 500);
  const n2 = normalizeRule({ ...n, crossCue: true, maxCueGapMs: -5 });
  assert.strictEqual(n2.maxCueGapMs, 500, '非法间隔回退默认');
  const n3 = normalizeRule({ ...n, crossCue: true, maxCueGapMs: 800.6 });
  assert.strictEqual(n3.maxCueGapMs, 801, '间隔取整');
});

/* ---------------------------- 上下文条件 ---------------------------- */

/** 构造带上下文条件的手机号规则 */
function contextPhoneRule(ctx: {
  beforePattern?: string;
  afterPattern?: string;
  beforeChars?: number;
  afterChars?: number;
  priority?: number;
  id?: string;
  name?: string;
}): MaskRule {
  return {
    id: ctx.id ?? 'r-ctx',
    name: ctx.name ?? '手机号-上下文',
    pattern: '(?<!\\d)(1[3-9]\\d)\\d{4}(\\d{4})(?!\\d)',
    flags: 'g',
    replacement: '$1****$2',
    priority: ctx.priority ?? 50,
    enabled: true,
    mode: 'template',
    aliasPrefix: '号码',
    crossCue: false,
    maxCueGapMs: 500,
    beforePattern: ctx.beforePattern ?? '',
    afterPattern: ctx.afterPattern ?? '',
    beforeChars: ctx.beforeChars ?? 0,
    afterChars: ctx.afterChars ?? 0,
  };
}

const CTX_VTT = `WEBVTT

00:00:00.000 --> 00:00:02.000
验证码 13812345678 已发送

00:00:02.500 --> 00:00:04.000
我的手机号是13987654321。
`;

test('上下文条件：命中前条件过滤无上下文的候选，通过的正常命中并计数', () => {
  // 命中前 8 个字符内须出现「验证码」
  const rule = contextPhoneRule({ beforePattern: '验证码.{0,8}$', beforeChars: 8 });
  const v = buildPreview({ vtt: CTX_VTT, rules: [rule] });
  assert.strictEqual(v.totalHits, 1, '仅「验证码 13812345678」一处通过条件');
  assert.strictEqual(v.cues[0].hits[0].match, '13812345678');
  assert.strictEqual(v.cues[1].hits.length, 0, '「我的手机号是…」前无验证码，被过滤');
  assert.deepStrictEqual(v.contextFilters, [
    { ruleId: 'r-ctx', ruleName: '手机号-上下文', beforeFiltered: 1, afterFiltered: 0 },
  ]);
});

test('上下文条件：命中后条件过滤，两侧都失败时各自计数', () => {
  // 命中后 4 个字符内须出现「转」
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
电话 13812345678，再见

00:00:02.500 --> 00:00:04.000
电话 13987654321 转 1234
`;
  const rule = contextPhoneRule({ afterPattern: '^.{0,4}转', afterChars: 4 });
  const v = buildPreview({ vtt, rules: [rule] });
  assert.strictEqual(v.totalHits, 1);
  assert.strictEqual(v.cues[1].hits[0].match, '13987654321');
  assert.deepStrictEqual(v.contextFilters, [
    { ruleId: 'r-ctx', ruleName: '手机号-上下文', beforeFiltered: 0, afterFiltered: 1 },
  ]);

  // 两侧条件同时存在且都不满足：前 / 后计数各加一
  const both = contextPhoneRule({
    beforePattern: '验证码.{0,8}$',
    beforeChars: 8,
    afterPattern: '^.{0,4}转',
    afterChars: 4,
  });
  const vtt2 = `WEBVTT

00:00:00.000 --> 00:00:02.000
电话 13812345678，再见

00:00:02.500 --> 00:00:04.000
电话 13987654321 麻烦帮忙转分机
`;
  const v2 = buildPreview({ vtt: vtt2, rules: [both] });
  assert.strictEqual(v2.totalHits, 0, '两处候选两侧条件都不满足');
  assert.deepStrictEqual(v2.contextFilters[0], {
    ruleId: 'r-ctx',
    ruleName: '手机号-上下文',
    beforeFiltered: 2,
    afterFiltered: 2,
  });
});

test('上下文条件：检查字符数限制上下文窗口，超出距离不命中', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
验证码已经发送到了13812345678 了
`;
  // 「验证码」距命中起点 9 个字符（间隔「已经发送到了」6 字），beforeChars=6 时取不到
  const tight = contextPhoneRule({ beforePattern: '验证码', beforeChars: 6 });
  const v1 = buildPreview({ vtt, rules: [tight] });
  assert.strictEqual(v1.totalHits, 0);
  assert.strictEqual(v1.contextFilters[0].beforeFiltered, 1);
  // 放宽到 9 个字符即可命中
  const loose = contextPhoneRule({ beforePattern: '验证码', beforeChars: 9 });
  const v2 = buildPreview({ vtt, rules: [loose] });
  assert.strictEqual(v2.totalHits, 1);
  assert.deepStrictEqual(v2.contextFilters, []);
});

test('上下文条件：窗口边缘按实际可用字符处理，命中仍可通过', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
13812345678 是验证码手机
`;
  // 命中位于 cue 开头：命中前只有 0 个字符；要求命中后出现「是验证码手机」
  const rule = contextPhoneRule({ afterPattern: '^ 是验证码手机', afterChars: 0 });
  const v = buildPreview({ vtt, rules: [rule] });
  assert.strictEqual(v.totalHits, 1, '边缘命中按实际可用上下文判断');

  // beforeChars 大于 cue 长度时不报错：只取到 cue 边缘，条件不通过则过滤
  const before = contextPhoneRule({ beforePattern: '客服', beforeChars: 100 });
  const v2 = buildPreview({ vtt, rules: [before] });
  assert.strictEqual(v2.totalHits, 0, 'cue 开头之前无字符可取');
  assert.strictEqual(v2.contextFilters[0].beforeFiltered, 1);
});

test('上下文条件：被过滤的高优先级命中不压制低优先级结果', () => {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
我的手机号是13812345678。
`;
  // 高优先级规则要求「验证码」上下文 → 该候选先被上下文过滤；
  const high = contextPhoneRule({
    id: 'high',
    name: '手机号-需验证码上下文',
    priority: 90,
    beforePattern: '验证码',
    beforeChars: 10,
  });
  // 低优先级的完整号码规则与高优先级候选同区间：高优先级被过滤后它应正常胜出
  const tail: MaskRule = {
    id: 'tail',
    name: '尾号',
    pattern: '(?<!\\d)1[3-9]\\d{9}(?!\\d)',
    flags: 'g',
    replacement: '****',
    priority: 10,
    enabled: true,
    mode: 'template',
    aliasPrefix: '',
    crossCue: false,
    maxCueGapMs: 500,
    beforePattern: '',
    afterPattern: '',
    beforeChars: 0,
    afterChars: 0,
  };
  const v = buildPreview({ vtt, rules: [high, tail] });
  assert.strictEqual(v.totalHits, 1);
  assert.strictEqual(v.cues[0].hits[0].ruleId, 'tail', '低优先级命中不再被过滤掉的高优先级压制');
  assert.strictEqual(v.suppressedHits, 0, '没有重叠抑制发生');
  assert.deepStrictEqual(v.contextFilters, [
    { ruleId: 'high', ruleName: '手机号-需验证码上下文', beforeFiltered: 1, afterFiltered: 0 },
  ]);
});

test('上下文条件：跨 cue 规则沿用拼接窗口，跨 cue 边界取上下文', () => {
  const rule = crossPhoneRule({
    beforePattern: '验证码.{0,20}$',
    beforeChars: 20,
    afterPattern: '^.{0,10}谢谢',
    afterChars: 10,
  });
  const vtt = `WEBVTT

c-1
00:00:01.000 --> 00:00:02.000
验证码 1381234

c-2
00:00:02.300 --> 00:00:04.000
5678，谢谢

c-3
00:00:05.000 --> 00:00:06.000
我的号是 1371234

c-4
00:00:05.300 --> 00:00:07.000
5678 而已
`;
  const v = buildPreview({ vtt, rules: [rule] });
  assert.strictEqual(v.totalHits, 1, '只有前两条 cue 拼出的号码同时满足前 / 后上下文');
  assert.strictEqual(v.cues[0].hits[0].match, '13812345678');
  assert.deepStrictEqual(v.cues[0].hits[0].spans.map((s) => s.cueIndex), [0, 1]);
  // 第二组号码：前无「验证码」、后无「谢谢」，两侧各计一次
  assert.deepStrictEqual(v.contextFilters[0], {
    ruleId: 'r-cross',
    ruleName: '手机号-跨字幕',
    beforeFiltered: 1,
    afterFiltered: 1,
  });
});

test('上下文条件：空条件不限制，旧规则缺字段按无条件迁移', () => {
  const legacy = presetRule('手机号') as unknown as Record<string, unknown>;
  delete legacy.beforePattern;
  delete legacy.afterPattern;
  delete legacy.beforeChars;
  delete legacy.afterChars;
  const n = normalizeRule(legacy as unknown as MaskRule);
  assert.strictEqual(n.beforePattern, '');
  assert.strictEqual(n.afterPattern, '');
  assert.strictEqual(n.beforeChars, 0);
  assert.strictEqual(n.afterChars, 0);
  const v = buildPreview({ vtt: SAMPLE_VTT, rules: [n] });
  assert.ok(v.totalHits >= 2, '无条件规则行为与旧版一致');
  assert.deepStrictEqual(v.contextFilters, []);
  // 非法字符数回退 0（不限制），小数取整
  assert.strictEqual(
    normalizeRule({ ...n, beforeChars: -3, afterChars: 3.7 }).afterChars,
    4,
  );
  assert.strictEqual(
    normalizeRule({ ...n, beforeChars: 'x' as unknown as number }).beforeChars,
    0,
  );
});

test('上下文条件：非法上下文正则在预览报错且该规则不参与扫描', () => {
  const bad = contextPhoneRule({ beforePattern: '([0-9]+' });
  const v = buildPreview({ vtt: CTX_VTT, rules: [bad] });
  assert.strictEqual(v.totalHits, 0);
  assert.ok(
    v.parseErrors.some((e) => e.includes('r-ctx') && e.includes('命中前上下文正则无效')),
    `应报告命中前上下文正则错误：${v.parseErrors.join('; ')}`,
  );
  const bad2 = contextPhoneRule({ afterPattern: '*?' });
  const v2 = buildPreview({ vtt: CTX_VTT, rules: [bad2] });
  assert.ok(v2.parseErrors.some((e) => e.includes('命中后上下文正则无效')));
});

test('上下文条件：过滤计数写入导出审计；残留防线同样按条件过滤', () => {
  const rule = contextPhoneRule({ beforePattern: '验证码.{0,8}$', beforeChars: 8 });
  const v = buildPreview({ vtt: CTX_VTT, rules: [rule] });
  assert.strictEqual(v.totalHits, 1);
  // 通过条件的号码正常脱敏，残留防线不再报该规则的二次命中（条件不满足）
  assert.strictEqual(v.safety.kept, 0, '被上下文过滤的候选不进入残留清单');
  const ex = exportResult({ vtt: CTX_VTT, rules: [rule] });
  assert.strictEqual(ex.audit.version, 7);
  assert.deepStrictEqual(ex.audit.contextFilters, [
    { ruleId: 'r-ctx', ruleName: '手机号-上下文', beforeFiltered: 1, afterFiltered: 0 },
  ]);
  assert.ok(ex.vtt.includes('138****5678'));
  assert.ok(ex.vtt.includes('13987654321'), '被过滤的候选保持原文');

  // 撤销唯一通过条件的命中后，残留防线二次扫描：保留号码前有「验证码」→ 条件仍满足 → 人工保留提示
  const key = v.cues[0].hits[0].key;
  const v2 = buildPreview({ vtt: CTX_VTT, rules: [rule], revertedKeys: [key] });
  assert.strictEqual(v2.safety.kept, 1);
  assert.strictEqual(v2.safety.issues[0].match, '13812345678');
});

/* ---------------------------- 抽样复核 ---------------------------- */

/** 构造两条规则各自命中若干次的字幕与规则集 */
function samplingSetup(): { vtt: string; rules: MaskRule[] } {
  const vtt = `WEBVTT

00:00:00.000 --> 00:00:01.000
电话 13800000001 与 13800000002

00:00:02.000 --> 00:00:03.000
电话 13800000003 和 13800000004

00:00:04.000 --> 00:00:05.000
电话 13800000005 还有 13800000006

00:00:06.000 --> 00:00:07.000
邮箱 a1@x.com 与 b2@x.com

00:00:08.000 --> 00:00:09.000
邮箱 c3@x.com 和 d4@x.com
`;
  const phone = presetRule('手机号');
  const email = presetRule('邮箱');
  return { vtt, rules: [phone, email] };
}

function sampleCfg(partial: Partial<SampleConfig> = {}): SampleConfig {
  return { enabled: true, total: 4, perRuleMinimum: {}, ...partial };
}

test('抽样复核：名额先保底再按剩余命中占比最大余数法分配', () => {
  // 池：手机 6、邮箱 4；总数 4；无保底：精确 [2.4, 1.6]，余数 0.6 > 0.4 → 手机 2、邮箱 2
  assert.deepStrictEqual(allocateQuotas([6, 4], [0, 0], 4), [2, 2]);
  // 手机保底 2：保底后余池 [4, 4]、余名额 2 → [0.5, 0.5]，并列余数按规则顺序 → 手机 3、邮箱 1
  assert.deepStrictEqual(allocateQuotas([6, 4], [2, 0], 4), [3, 1]);
  // 总数 10 但池总量 10：各取全部
  assert.deepStrictEqual(allocateQuotas([6, 4], [0, 0], 10), [6, 4]);
  // 总数超过池总量：取满即止，产生缺口由上层统计
  assert.deepStrictEqual(allocateQuotas([6, 4], [0, 0], 20), [6, 4]);
  // 保底超过总名额：按规则顺序先满足（顺序确定）
  assert.deepStrictEqual(allocateQuotas([10, 10], [3, 3], 4), [3, 1]);
  // 某规则池不足保底：保底受池大小限制，名额转给其他层
  assert.deepStrictEqual(allocateQuotas([1, 10], [5, 0], 6), [1, 5]);
  // 最大余数法：7 个名额按 5:5:5 池占比，精确 [2.33…]，并列余数按规则顺序
  assert.deepStrictEqual(allocateQuotas([5, 5, 5], [0, 0, 0], 7), [3, 2, 2]);
});

test('抽样复核：关闭抽样时不产生样本、不阻断导出（分层名额仍可预览）', () => {
  const { vtt, rules } = samplingSetup();
  const v = buildPreview({ vtt, rules, sampleConfig: { enabled: false, total: 4, perRuleMinimum: {} } });
  assert.strictEqual(v.sample.enabled, false);
  assert.strictEqual(v.sample.items.length, 0);
  assert.strictEqual(v.sample.pending, 0);
  // 关闭时仍返回各层命中数与预分配名额，供配置面板参考
  assert.strictEqual(v.sample.totalPoolHits, 10);
  assert.deepStrictEqual(v.sample.strata.map((s) => [s.ruleName, s.poolHits, s.quota]), [
    ['手机号', 6, 2],
    ['邮箱', 4, 2],
  ]);
  const ex = exportResult({ vtt, rules, sampleConfig: { enabled: false, total: 4, perRuleMinimum: {} } });
  assert.strictEqual(ex.audit.sampleReview, undefined);
});

test('抽样复核：确定性分层抽样，同候选集重复预览样本稳定', () => {
  const { vtt, rules } = samplingSetup();
  const cfg = sampleCfg({ total: 4 });
  const v1 = buildPreview({ vtt, rules, sampleConfig: cfg });
  const v2 = buildPreview({ vtt, rules, sampleConfig: cfg });
  assert.strictEqual(v1.sample.sampled, 4);
  assert.strictEqual(v1.sample.pending, 4);
  assert.strictEqual(v1.sample.totalPoolHits, 10);
  // 6:4 占比下 4 个名额：精确 [2.4, 1.6]，邮箱余数更大 → 手机 2、邮箱 2
  const byRule = Object.fromEntries(v1.sample.strata.map((s) => [s.ruleName, s.quota]));
  assert.deepStrictEqual(byRule, { 手机号: 2, 邮箱: 2 });
  // 同一候选集（命中键不变）重复预览：样本键集合完全一致
  assert.deepStrictEqual(
    v1.sample.items.map((i) => i.key).sort(),
    v2.sample.items.map((i) => i.key).sort(),
  );
  // 样本携带 cue / 时间 / 原文 / 替换快照
  const item = v1.sample.items[0];
  assert.ok(item.time.start && item.time.end);
  assert.ok(item.match && item.replacement);
  assert.strictEqual(item.verdict, null);
});

test('抽样复核：先满足每规则最低样本数，再按占比分配', () => {
  const { vtt, rules } = samplingSetup();
  // 总 4，邮箱保底 2：保底（手机 0、邮箱 2）后余池 6:2、余名额 2 → 手机 2、邮箱 0
  const cfg = sampleCfg({ total: 4, perRuleMinimum: { [rules[1].id]: 2 } });
  const v = buildPreview({ vtt, rules, sampleConfig: cfg });
  const email = v.sample.strata.find((s) => s.ruleName === '邮箱')!;
  const phone = v.sample.strata.find((s) => s.ruleName === '手机号')!;
  assert.strictEqual(email.quota, 2);
  assert.strictEqual(email.sampled, 2);
  assert.strictEqual(phone.quota, 2);
  assert.strictEqual(v.sample.sampled, 4);
});

test('抽样复核：逐项通过 / 驳回计数，驳回写入逐条例外后移出候选池并补抽', () => {
  const { vtt, rules } = samplingSetup();
  const cfg = sampleCfg({ total: 4 });
  const v1 = buildPreview({ vtt, rules, sampleConfig: cfg });
  const [first, second] = v1.sample.items;
  const reviews: SampleReview[] = [
    { key: first.key, verdict: 'approve', reviewedAt: '2026-09-20T00:00:00.000Z' },
    { key: second.key, verdict: 'reject', reviewedAt: '2026-09-20T00:00:01.000Z' },
  ];
  // 驳回同时写入逐条例外（与面板行为一致）
  const v2 = buildPreview({
    vtt,
    rules,
    sampleConfig: cfg,
    sampleReviews: reviews,
    hitExceptions: [{ key: second.key, state: 'reverted' }],
  });
  assert.strictEqual(v2.sample.approved, 1);
  assert.strictEqual(v2.sample.rejected, 1);
  assert.strictEqual(v2.sample.pending, v2.sample.sampled - 2);
  // 驳回项仍在样本中（命中变为保留原文），且占用本层名额
  const rejectedItem = v2.sample.items.find((i) => i.key === second.key)!;
  assert.strictEqual(rejectedItem.verdict, 'reject');
  assert.strictEqual(rejectedItem.reverted, true);
  // 驳回后该命中移出候选池：总池命中 -1
  assert.strictEqual(v2.sample.totalPoolHits, 9);
  // 通过项保留
  assert.ok(v2.sample.items.some((i) => i.key === first.key && i.verdict === 'approve'));
});

test('抽样复核：已复核项在命中变化后保留仍有效的并补抽新命中', () => {
  const { vtt, rules } = samplingSetup();
  const cfg = sampleCfg({ total: 4 });
  const v1 = buildPreview({ vtt, rules, sampleConfig: cfg });
  const keepKey = v1.sample.items[0].key;
  const reviews: SampleReview[] = [
    { key: keepKey, verdict: 'approve', reviewedAt: '2026-09-20T00:00:00.000Z' },
  ];
  // 追加一条新字幕（新手机号命中）：已复核样本保留，再补抽至名额
  const more = vtt + '\n00:00:10.000 --> 00:00:11.000\n电话 13800000007\n';
  const v2 = buildPreview({ vtt: more, rules, sampleConfig: cfg, sampleReviews: reviews });
  assert.ok(v2.sample.items.some((i) => i.key === keepKey && i.verdict === 'approve'));
  assert.strictEqual(v2.sample.sampled, 4);
  assert.strictEqual(v2.sample.approved, 1);
  assert.strictEqual(v2.sample.pending, 3);

  // 删除全部邮箱 cue：邮箱层名额转移给手机；已复核的邮箱样本若失效则被清出（由前端按结果裁剪）
  const noEmail = vtt
    .split('\n\n')
    .filter((block) => !block.includes('@'))
    .join('\n\n');
  const v3 = buildPreview({ vtt: noEmail, rules, sampleConfig: cfg, sampleReviews: reviews });
  assert.ok(v3.sample.items.every((i) => i.ruleName === '手机号'));
  assert.strictEqual(v3.sample.sampled, 4);
});

test('抽样复核：候选池不足时报告缺口且 filled=false', () => {
  const { vtt, rules } = samplingSetup();
  const cfg = sampleCfg({ total: 20 });
  const v = buildPreview({ vtt, rules, sampleConfig: cfg });
  assert.strictEqual(v.sample.sampled, 10);
  assert.strictEqual(v.sample.shortfall, 10);
  assert.strictEqual(v.sample.filled, false);
  // 保底超过池大小同样只取池内
  const cfg2 = sampleCfg({ total: 3, perRuleMinimum: { [rules[0].id]: 99 } });
  const v2 = buildPreview({ vtt, rules, sampleConfig: cfg2 });
  assert.ok(v2.sample.strata.find((s) => s.ruleName === '手机号')!.sampled <= 6);
});

test('抽样复核：存在未复核样本时阻断导出，全部复核后放行并写入审计', () => {
  const { vtt, rules } = samplingSetup();
  const cfg = sampleCfg({ total: 3 });
  const v1 = buildPreview({ vtt, rules, sampleConfig: cfg });
  assert.strictEqual(v1.sample.pending, 3);
  assert.throws(
    () => exportResult({ vtt, rules, sampleConfig: cfg }),
    (e: unknown) => {
      assert.ok(e instanceof SampleReviewPendingError);
      assert.strictEqual(e.sample.pending, 3);
      return true;
    },
  );

  // 逐项通过 / 驳回后全部复核完成
  const reviews: SampleReview[] = v1.sample.items.map((h, i) => ({
    key: h.key,
    verdict: i === 0 ? ('reject' as const) : ('approve' as const),
    reviewedAt: new Date(0).toISOString(),
  }));
  const exceptions = v1.sample.items
    .filter((_, i) => i === 0)
    .map((h) => ({ key: h.key, state: 'reverted' as const }));
  const ex = exportResult({
    vtt,
    rules,
    sampleConfig: cfg,
    sampleReviews: reviews,
    hitExceptions: exceptions,
  });
  assert.strictEqual(ex.audit.version, 7);
  const sr = ex.audit.sampleReview!;
  assert.strictEqual(sr.config.total, 3);
  assert.strictEqual(sr.approved, 2);
  assert.strictEqual(sr.rejected, 1);
  assert.strictEqual(sr.items.length, 3);
  assert.ok(sr.strata.every((s) => s.pending === 0));
  // 驳回处保留原文
  const rejectedMatch = v1.sample.items[0].match;
  assert.ok(ex.vtt.includes(rejectedMatch), '驳回样本应保留原文');
});

test('抽样复核：配置规整与旧任务迁移', () => {
  assert.deepStrictEqual(normalizeSampleConfig(undefined), {
    enabled: false,
    total: 10,
    perRuleMinimum: {},
  });
  assert.deepStrictEqual(
    normalizeSampleConfig({ enabled: 1, total: -3, perRuleMinimum: { a: 'x', b: 2 } }),
    { enabled: false, total: 10, perRuleMinimum: { a: 0, b: 2 } },
  );
  const migrated = migrateJobState({
    jobId: 'j1',
    vtt: 'WEBVTT',
    rules: [],
    sampleConfig: { enabled: true, total: 5, perRuleMinimum: { r1: 1 } },
    sampleReviews: [{ key: 'k', verdict: 'approve', reviewedAt: 't' }, { key: 'bad' }],
  } as Partial<JobState>);
  assert.strictEqual(migrated.sampleConfig.enabled, true);
  assert.strictEqual(migrated.sampleConfig.total, 5);
  assert.deepStrictEqual(migrated.sampleReviews, [
    { key: 'k', verdict: 'approve', reviewedAt: 't' },
  ]);
  // 旧任务无抽样字段：默认关闭 + 空记录
  const old = migrateJobState({ jobId: 'j2', vtt: '', rules: [] });
  assert.strictEqual(old.sampleConfig.enabled, false);
  assert.deepStrictEqual(old.sampleReviews, []);
});

console.log(`\n引擎自测全部通过（${passed} 项）`);