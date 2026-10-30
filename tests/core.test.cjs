'use strict';
/* 核心逻辑单元测试：node tests/core.test.cjs */

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');

function mk() {
  return C.createBatch({ date: '2026-10-24', operator: '张三' });
}

function fillGroup(batch, id, g, values) {
  values.forEach((v, i) => C.setValue(batch, id, g, i, v));
}

/** 复刻“快捷导出方式2”示例中的 3号炉 数据 */
function exampleFurnace3() {
  const b = mk();
  const data = [
    [0.170, 3], [0.148, 3], [0.148, 3], [0.148, 3],
    [0.170, 4], [0.134, 3], [0.148, 3], [0.148, 3]
  ];
  data.forEach(([max, idx], g) => {
    for (let i = 0; i < 12; i++) C.setValue(b, '3', g, i, 0.1);
    C.setValue(b, '3', g, idx - 1, max);
  });
  C.setHeader(b, '3', 'A', 0.230);
  C.setHeader(b, '3', 'B', 0.220);
  return b;
}

test('createBatch：4 台炉，2号炉每组 2 块，其余 12 块', () => {
  const b = mk();
  assert.deepEqual(b.furnaces.map((f) => f.id), ['2', '3', '4', '5']);
  assert.equal(C.furnaceById(b, '2').perGroup, 2);
  assert.equal(C.furnaceById(b, '3').perGroup, 12);
  assert.equal(C.furnaceById(b, '4').perGroup, 12);
  assert.equal(C.furnaceById(b, '5').perGroup, 12);
  b.furnaces.forEach((f) => {
    assert.equal(f.groups, 8);
    assert.equal(f.cells.length, 8);
    assert.equal(f.cells[0].length, f.perGroup);
    assert.equal(f.side, 'full');
  });
  assert.equal(C.chamberOf(0), 'A');
  assert.equal(C.chamberOf(3), 'A');
  assert.equal(C.chamberOf(4), 'B');
  assert.equal(C.chamberOf(7), 'B');
});

test('groupsInScope：整台 8 组，A/B 炉膛各 4 组', () => {
  const b = mk();
  const f = C.furnaceById(b, '3');
  assert.deepEqual(C.groupsInScope(f), [0, 1, 2, 3, 4, 5, 6, 7]);
  C.setSide(b, '3', 'A');
  assert.deepEqual(C.groupsInScope(f), [0, 1, 2, 3]);
  C.setSide(b, '3', 'B');
  assert.deepEqual(C.groupsInScope(f), [4, 5, 6, 7]);
  assert.equal(C.nextInScopeGroup(f, 5), 6);
  assert.equal(C.nextInScopeGroup(f, 7), -1);
  assert.equal(C.prevInScopeGroup(f, 4), -1);
});

test('parseValue / setValue：现场写法与小数位', () => {
  const b = mk();
  assert.equal(C.parseValue('0.12').value, 0.12);
  assert.equal(C.parseValue(' 0.12 MPa ').value, 0.12);
  assert.equal(C.parseValue('０.１２').value, 0.12);
  assert.equal(C.parseValue('0,12').value, 0.12);
  assert.equal(C.parseValue('abc').ok, false);
  C.setValue(b, '3', 0, 0, '0.1234');
  assert.equal(C.furnaceById(b, '3').cells[0][0].v, 0.123);
  C.setValue(b, '3', 0, 1, '');
  assert.equal(C.furnaceById(b, '3').cells[0][1].v, null);
});

test('groupStat：剔除值不参与最高值', () => {
  const b = mk();
  const f = C.furnaceById(b, '3');
  C.setValue(b, '3', 0, 0, 0.12);
  C.setValue(b, '3', 0, 1, 0.30);
  C.setExcluded(b, '3', 0, 1, true);
  C.setValue(b, '3', 0, 2, 0.25);
  const s = C.groupStat(f, 0);
  assert.equal(s.count, 12);
  assert.equal(s.filled, 3);
  assert.equal(s.valid, 2);
  assert.equal(s.excluded, 1);
  assert.equal(s.missing, 9);
  assert.equal(s.max, 0.25);
  assert.equal(s.maxIndex, 2);
  assert.equal(s.chamber, 'A');
});

test('chamberStat：跨 4 组取单炉膛最高，并给组号/表号', () => {
  const b = mk();
  const f = C.furnaceById(b, '3');
  C.setValue(b, '3', 0, 2, 0.11);
  C.setValue(b, '3', 3, 7, 0.148);
  C.setValue(b, '3', 1, 0, 0.13);
  const cs = C.chamberStat(f, 'A');
  assert.equal(cs.max, 0.148);
  assert.equal(cs.maxGroup, 3);
  assert.equal(cs.maxIndex, 7);
  assert.equal(cs.valid, 3);
});

test('绝压比：复刻示例 3号炉，B 炉膛 0.84375 最大', () => {
  const b = exampleFurnace3();
  const f = C.furnaceById(b, '3');
  const a = C.ratioOf(f, 'A');
  const bb = C.ratioOf(f, 'B');
  assert.ok(Math.abs(a.ratio - 0.270 / 0.330) < 1e-12);
  assert.equal(bb.ratio, 0.84375);
  const best = C.bestRatioOf(f);
  assert.equal(best.ratio, 0.84375);
  assert.equal(best.chamber, 'B');
  assert.equal(best.maxGroup, 4);
  assert.equal(best.maxIndex, 3);
  assert.equal(C.formatRatio(best.ratio), '0.84375');
});

test('exportMode2：与示例文本一致', () => {
  const b = exampleFurnace3();
  const text = C.exportMode2(b);
  assert.equal(text, [
    '3号炉',
    '①<3>0.170 ②<3>0.148 ③<3>0.148 ④<3>0.148 A集合管 0.230',
    '⑤<4>0.170 ⑥<3>0.134 ⑦<3>0.148 ⑧<3>0.148 B集合管 0.220',
    '最大绝压比 ⑤ 0.84375'
  ].join('\n'));
});

test('exportMode2：半台炉膛只输出对应一行', () => {
  const b = exampleFurnace3();
  C.setSide(b, '3', 'B');
  const text = C.exportMode2(b);
  assert.equal(text, [
    '3号炉 B炉膛',
    '⑤<4>0.170 ⑥<3>0.134 ⑦<3>0.148 ⑧<3>0.148 B集合管 0.220',
    '最大绝压比 ⑤ 0.84375'
  ].join('\n'));
});

test('exportMode1：2号炉每组 2 块，按组一行', () => {
  const b = mk();
  const vals = [
    [0.183, 0.100], [0.100, 0.136], [0.148, 0.100], [0.100, 0.137],
    [0.125, 0.100], [0.100, 0.132], [0.126, 0.100], [0.100, 0.120]
  ];
  vals.forEach((pair, g) => fillGroup(b, '2', g, pair));
  const text = C.exportMode1(b);
  assert.equal(text, [
    '文丘里压力',
    '',
    '2号炉',
    '1 0.183',
    '2 0.136',
    '1 0.148',
    '2 0.137',
    '1 0.125',
    '2 0.132',
    '1 0.126',
    '2 0.120'
  ].join('\n'));
});

test('exportMode1：半台标题与空组占位', () => {
  const b = mk();
  const f = C.furnaceById(b, '4');
  C.setSide(b, '4', 'B');
  fillGroup(b, '4', 4, [0.1, 0.111]);
  fillGroup(b, '4', 5, [0.115]);
  // 第 7、8 组留空
  const text = C.exportMode1(b);
  assert.equal(text, [
    '文丘里压力',
    '',
    '4号炉 B炉膛',
    '2 0.111',
    '1 0.115',
    '- -',
    '- -'
  ].join('\n'));
});

test('exportMode1：无数据时给出提示', () => {
  const b = mk();
  assert.equal(C.exportMode1(b), '文丘里压力\n\n（暂无读数）');
});

test('formatReading 去尾零、formatFixed 补零', () => {
  assert.equal(C.formatReading(0.12, 3), '0.12');
  assert.equal(C.formatReading(0.4, 3), '0.4');
  assert.equal(C.formatReading(0, 3), '0');
  assert.equal(C.formatFixed(0.12, 3), '0.120');
  assert.equal(C.formatRatio(0.84375), '0.84375');
});

test('side 切换不影响未选炉膛的数据（只影响统计与导出）', () => {
  const b = exampleFurnace3();
  C.setSide(b, '3', 'A');
  const st = C.furnaceStat(C.furnaceById(b, '3'));
  assert.equal(st.total, 48);
  assert.equal(st.groups.length, 4);
  assert.equal(st.chambers.B.inScope, false);
  assert.equal(st.best.chamber, 'A');
  C.setSide(b, '3', 'full');
  assert.equal(C.furnaceStat(C.furnaceById(b, '3')).best.chamber, 'B');
});

test('nextEmptyIndex / 顺序填入', () => {
  const b = mk();
  const f = C.furnaceById(b, '5');
  assert.equal(C.nextEmptyIndex(f, 0), 0);
  C.setValue(b, '5', 0, 0, 0.12);
  assert.equal(C.nextEmptyIndex(f, 0), 1);
  for (let i = 0; i < 12; i++) C.setValue(b, '5', 0, i, 0.1);
  assert.equal(C.nextEmptyIndex(f, 0), -1);
  assert.equal(C.nextEmptyIndex(f, 1), 0);
});

test('batchStat：跨炉取最大绝压比', () => {
  const b = exampleFurnace3();
  C.setHeader(b, '2', 'A', 0.2);
  C.setHeader(b, '2', 'B', 0.2);
  fillGroup(b, '2', 0, [0.15, 0.1]);
  const st = C.batchStat(b);
  assert.equal(st.measured, 2);
  assert.equal(st.bestFurnace.id, '3');
  assert.equal(st.best.ratio, 0.84375);
});

test('JSON 往返一致', () => {
  const b = exampleFurnace3();
  C.setSide(b, '3', 'A');
  C.setExcluded(b, '3', 0, 0, true);
  const again = C.normalizeBatch(JSON.parse(JSON.stringify(C.toJSON(b))));
  const f = C.furnaceById(again, '3');
  assert.equal(f.side, 'A');
  assert.equal(f.headerA, 0.23);
  assert.equal(f.headerB, 0.22);
  assert.equal(f.cells[0][2].v, 0.17);
  assert.equal(f.cells[0][0].ex, true);
  assert.equal(C.exportMode2(b), C.exportMode2(again));
});

test('normalizeBatch 容错：空对象、缺字段', () => {
  const b = C.normalizeBatch({});
  assert.equal(b.furnaces.length, 4);
  assert.equal(C.hasBatchData(b), false);
  const b2 = C.normalizeBatch({ furnaces: [{ id: '5', side: 'B', headerA: '', headerB: '0.22', cells: [[{}, { v: '0.1' }]] }] });
  const f = C.furnaceById(b2, '5');
  assert.equal(f.side, 'B');
  assert.equal(f.headerB, 0.22);
  assert.equal(f.cells[0][1].v, 0.1);
});

test('createBatch 带日期时间，JSON 往返保留时间', () => {
  const b = C.createBatch({ date: '2026-10-24', time: '14:30' });
  assert.equal(b.meta.time, '14:30');
  const again = C.normalizeBatch({ meta: { date: '2026-10-24', time: '08:05' } });
  assert.equal(again.meta.time, '08:05');
  const json = C.toJSON(b);
  assert.equal(json.meta.time, '14:30');
});

test('toReportWorkbook：一台一炉一块、AB集合管、最大绝压比注明组块', () => {
  const b = exampleFurnace3();
  b.meta.time = '14:30';
  C.setValue(b, '3', 0, 0, null);        // 空位
  C.setExcluded(b, '3', 0, 1, true);    // 剔除 2#
  const wb = C.toReportWorkbook(b);

  assert.deepEqual(wb.sheets.map((s) => s.name), ['读数']);
  const rows = wb.sheets[0].rows;
  assert.ok(wb.sheets[0].merges.indexOf('A1:O1') >= 0);

  const title = rows.find((r) => r[0] && r[0].v === '3号炉（整台）');
  assert.ok(title);
  assert.equal(title[0].s, 5);

  const g1 = rows.find((r) => r[0] && r[0].v === '第1组');
  assert.ok(g1);
  assert.equal(g1[1].v, null);          // 1# 空位
  assert.equal(g1[2].v, 0.1);           // 2# 剔除
  assert.equal(g1[2].s, 4);             // 划线样式
  assert.equal(g1[3].v, 0.17);          // 3# 组最高
  assert.equal(g1[3].s, 3);             // 加粗样式
  assert.equal(g1[13].v, 0.17);         // 最高值列
  assert.equal(g1[13].s, 3);
  assert.equal(g1[14].v, '3#');

  const hdr = rows.find((r) => r[0] && r[0].v === 'A集合管压力');
  assert.ok(hdr);
  assert.equal(hdr[1].v, 0.23);
  assert.equal(hdr[2].v, 'B集合管压力');
  assert.equal(hdr[4].v, 0.22);

  const maxRow = rows.find((r) => r[0] && r[0].v === '最大绝压比');
  assert.ok(maxRow);
  assert.equal(maxRow[1].v, 0.84375);
  assert.equal(maxRow[1].s, 9);         // 加粗，但不放大字号
  assert.equal(maxRow[2].v, '第5组第4块');
  assert.ok(!rows.some((r) => r.some((c) => c && c.v === '5-4')));

  assert.ok(!rows.some((r) => r[0] && r[0].v === '全厂最高绝压比'));
});

test('parseReportWorkbook：导入自己导出的 Excel 能还原读数/剔除/集合管', () => {
  const b = exampleFurnace3();
  b.meta.time = '14:30';
  C.setValue(b, '3', 0, 0, null);
  C.setExcluded(b, '3', 0, 1, true);
  const wb = C.toReportWorkbook(b);
  const read = {
    sheets: wb.sheets.map((s) => ({
      name: s.name,
      rows: s.rows.map((row) => row.map((c) => (c ? { v: c.v, s: c.s, strike: c.s === 4, bold: c.s === 3 || c.s === 9 } : null)))
    }))
  };
  const back = C.parseReportWorkbook(read);
  assert.equal(back.meta.date, '2026-10-24');
  assert.equal(back.meta.time, '14:30');
  assert.equal(back.meta.operator, '张三');
  const f = C.furnaceById(back, '3');
  assert.equal(f.side, 'full');
  assert.equal(f.cells[0][1].v, 0.1);
  assert.equal(f.cells[0][1].ex, true);
  assert.equal(f.cells[0][2].v, 0.17);
  assert.equal(C.headerOf(f, 'A'), 0.23);
  assert.equal(C.headerOf(f, 'B'), 0.22);
  assert.equal(C.groupStat(f, 0).max, 0.17);
});

test('送检跳过：不参与最高值、不计缺失、正反向取空位都跳过', () => {
  const b = mk();
  const f = C.furnaceById(b, '3');
  C.setValue(b, '3', 0, 0, 0.1);
  C.setValue(b, '3', 0, 1, 0.2);
  C.setSkipped(b, '3', 0, 2, true);
  const s = C.groupStat(f, 0);
  assert.equal(s.filled, 2);
  assert.equal(s.skipped, 1);
  assert.equal(s.handled, 3);
  assert.equal(s.valid, 2);
  assert.equal(s.max, 0.2);
  assert.equal(s.missing, 9);
  assert.equal(s.complete, false);
  assert.equal(C.nextEmptyIndex(f, 0), 3);
  assert.equal(C.nextEmptyIndex(f, 0, true), 11);
  assert.equal(f.cells[0][2].skip, true);
  assert.equal(f.cells[0][2].v, null);
  assert.equal(C.toJSON(b).furnaces[1].cells[0][2].skip, true);
});

test('送检在 Excel 导出/导入中保留', () => {
  const b = exampleFurnace3();
  b.meta.time = '14:30';
  C.setSkipped(b, '3', 0, 4, true);
  const wb = C.toReportWorkbook(b);
  const g1 = wb.sheets[0].rows.find((r) => r[0] && r[0].v === '第1组');
  assert.equal(g1[5].v, '送检');
  const read = {
    sheets: wb.sheets.map((s) => ({
      name: s.name,
      rows: s.rows.map((row) => row.map((c) => (c ? { v: c.v, s: c.s, strike: c.s === 4, bold: c.s === 3 || c.s === 9 } : null)))
    }))
  };
  const back = C.parseReportWorkbook(read);
  assert.equal(C.furnaceById(back, '3').cells[0][4].skip, true);
  assert.equal(C.furnaceById(back, '3').cells[0][4].v, null);
});

test('超量程标记', () => {
  const b = mk();
  C.setValue(b, '3', 0, 0, 0.45);
  assert.equal(C.groupStat(C.furnaceById(b, '3'), 0).over, 1);
});

test('parseMode1 + 转换：方式1 文本还原成方式2（3号炉示例）', () => {
  const text = [
    '文丘里压力',
    '',
    '3号炉',
    '3 0.170',
    '3 0.148',
    '3 0.148',
    '3 0.148',
    '4 0.170',
    '3 0.134',
    '3 0.148',
    '3 0.148'
  ].join('\n');
  const r = C.parseMode1(text);
  assert.equal(r.furnaces.length, 1);
  assert.equal(r.furnaces[0].side, 'full');
  assert.equal(r.issues.length, 0);
  r.furnaces[0].headerA = 0.230;
  r.furnaces[0].headerB = 0.220;
  const out = C.exportMode2(C.converterToBatch(r.furnaces));
  assert.equal(out, [
    '3号炉',
    '①<3>0.170 ②<3>0.148 ③<3>0.148 ④<3>0.148 A集合管 0.230',
    '⑤<4>0.170 ⑥<3>0.134 ⑦<3>0.148 ⑧<3>0.148 B集合管 0.220',
    '最大绝压比 ⑤ 0.84375'
  ].join('\n'));
});

test('parseMode1：半台 B 炉膛、空组与表号', () => {
  const text = [
    '文丘里压力',
    '',
    '4号炉 B炉膛',
    '9 0.111',
    '2 0.115',
    '1 0.121',
    '7 0.110'
  ].join('\n');
  const r = C.parseMode1(text);
  assert.equal(r.furnaces.length, 1);
  assert.equal(r.furnaces[0].side, 'B');
  assert.deepEqual(r.furnaces[0].groups.map((g) => g.index), [4, 5, 6, 7]);
  r.furnaces[0].headerB = 0.230;
  const out = C.exportMode2(C.converterToBatch(r.furnaces));
  assert.ok(out.indexOf('4号炉 B炉膛') >= 0);
  assert.ok(out.indexOf('⑤<9>0.111 ⑥<2>0.115 ⑦<1>0.121 ⑧<7>0.110 B集合管 0.230') >= 0);
  assert.ok(out.indexOf('最大绝压比 ⑦ 0.66970') >= 0);
});

test('parseMode1：4 行未标炉膛 → 默认 A + 可切换 B', () => {
  const text = [
    '3号炉',
    '1 0.100',
    '2 0.200',
    '3 0.300',
    '4 0.400'
  ].join('\n');
  const r = C.parseMode1(text);
  assert.equal(r.furnaces[0].side, 'A');
  assert.equal(r.furnaces[0].ambiguous, true);
  assert.ok(r.issues.some((x) => x.level === 'warn' && x.msg.indexOf('A 炉膛') >= 0));
  const it = r.furnaces[0];
  assert.equal(C.converterSetSide(it, 'B'), true);
  assert.equal(it.side, 'B');
  assert.deepEqual(it.groups.map((g) => g.index), [4, 5, 6, 7]);
  it.headerB = 0.200;
  const out = C.exportMode2(C.converterToBatch([it]));
  assert.ok(out.indexOf('⑤<1>0.100 ⑥<2>0.200 ⑦<3>0.300 ⑧<4>0.400 B集合管 0.200') >= 0);
  assert.ok(out.indexOf('最大绝压比 ⑧ 1.66667') >= 0);
});

test('parseMode1：兼容 # / 块 / 全角空格 / - - / 2号炉 2 块', () => {
  const text = [
    '文丘里压力',
    '2号炉',
    '1# 0.183',
    '第2块　0.136',
    '2 0.148',
    '- -',
    '1 0.120',
    '2 0.132',
    '1 0.126',
    '2 0.120'
  ].join('\n');
  const r = C.parseMode1(text);
  assert.equal(r.issues.filter((x) => x.level === 'error').length, 0);
  const it = r.furnaces[0];
  assert.equal(it.groups.length, 8);
  assert.equal(it.groups[0].gauge, 1);
  assert.equal(it.groups[0].value, 0.183);
  assert.equal(it.groups[1].gauge, 2);
  assert.equal(it.groups[3].value, null);
  it.headerA = 0.240;
  it.headerB = 0.230;
  const out = C.exportMode2(C.converterToBatch([it]));
  assert.ok(out.indexOf('④<->-') >= 0);
  assert.ok(out.indexOf('A集合管 0.240') >= 0);
});

test('parseMode1：炉膛写法宽松（4号炉A / 4号炉 A / 4号炉Ａ / 4号炉A炉膛 / 4号炉B侧）', () => {
  const lines4 = ['1 0.111', '2 0.115', '1 0.121', '7 0.110'];
  ['4号炉A', '4号炉 A', '4号炉Ａ', '4号炉A炉膛', '4号炉 a', '4号炉A侧'].forEach((title) => {
    const r = C.parseMode1([title, ...lines4].join('\n'));
    assert.equal(r.furnaces.length, 1, title);
    assert.equal(r.furnaces[0].side, 'A', title);
    assert.deepEqual(r.furnaces[0].groups.map((g) => g.index), [0, 1, 2, 3], title);
  });
  const rb = C.parseMode1(['4号炉B', ...lines4].join('\n'));
  assert.equal(rb.furnaces[0].side, 'B');
  assert.deepEqual(rb.furnaces[0].groups.map((g) => g.index), [4, 5, 6, 7]);
  const out = C.exportMode2(C.converterToBatch([(() => {
    rb.furnaces[0].headerB = 0.230;
    return rb.furnaces[0];
  })()]));
  assert.ok(out.indexOf('4号炉 B炉膛') >= 0);
});

test('parseMode1：表号与读数之间可以没有空格', () => {
  const text = [
    '2号炉',
    '1#0.183',
    '第2块0.136',
    '2 0.148',
    '- -',
    '1#0.120',
    '第2块 0.132',
    '1# 0.126',
    '第2块0.120'
  ].join('\n');
  const r = C.parseMode1(text);
  assert.equal(r.issues.filter((x) => x.level === 'error').length, 0);
  const gs = r.furnaces[0].groups;
  assert.equal(gs[0].gauge, 1);
  assert.equal(gs[0].value, 0.183);
  assert.equal(gs[1].gauge, 2);
  assert.equal(gs[1].value, 0.136);
  assert.equal(gs[2].value, 0.148);
  assert.equal(gs[3].value, null);
  assert.equal(gs[4].value, 0.12);
});

test('parseMode1：标题写了 A 但给 8 行 → 按整台处理并提示', () => {
  const lines = ['1 0.100', '2 0.110', '3 0.120', '4 0.130', '5 0.140', '6 0.150', '7 0.160', '8 0.170'];
  const r = C.parseMode1(['4号炉A', ...lines].join('\n'));
  assert.equal(r.furnaces.length, 1);
  assert.equal(r.furnaces[0].side, 'full');
  assert.deepEqual(r.furnaces[0].groups.map((g) => g.index), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(r.issues.some((x) => x.level === 'warn' && x.msg.indexOf('整台处理') >= 0));
});

test('parseMode1：错误提示（未知炉号、行数不符、表号越界）', () => {
  const r1 = C.parseMode1('1号炉\n1 0.1');
  assert.equal(r1.furnaces.length, 0);
  assert.ok(r1.issues.some((x) => x.msg.indexOf('不认识的炉号') >= 0));

  const r2 = C.parseMode1('3号炉\n1 0.1\n2 0.2\n3 0.3');
  assert.equal(r2.furnaces.length, 0);
  assert.ok(r2.issues.some((x) => x.msg.indexOf('应有 8 行') >= 0 || x.msg.indexOf('行数应为') >= 0));

  const r3 = C.parseMode1('2号炉\n3 0.1\n1 0.1\n2 0.1\n1 0.1\n2 0.1\n1 0.1\n2 0.1\n1 0.1');
  assert.equal(r3.furnaces.length, 0);
  assert.ok(r3.issues.some((x) => x.msg.indexOf('超出 1~2') >= 0));
});

test('parseMode1：多台炉、无集合管压力时方式2显示 —', () => {
  const text = [
    '文丘里压力',
    '',
    '2号炉',
    '1 0.100',
    '2 0.110',
    '1 0.120',
    '2 0.130',
    '1 0.140',
    '2 0.150',
    '1 0.160',
    '2 0.170',
    '',
    '5号炉',
    '1 0.200',
    '2 0.210',
    '3 0.220',
    '4 0.230',
    '5 0.240',
    '6 0.250',
    '7 0.260',
    '8 0.270'
  ].join('\n');
  const r = C.parseMode1(text);
  assert.equal(r.furnaces.length, 2);
  const out = C.exportMode2(C.converterToBatch(r.furnaces));
  assert.ok(out.indexOf('2号炉') >= 0);
  assert.ok(out.indexOf('5号炉') >= 0);
  assert.ok(out.indexOf('A集合管 —') >= 0);
  assert.ok(out.indexOf('最大绝压比 — —') >= 0);
});

test('清空组 / 清空炉', () => {
  const b = exampleFurnace3();
  C.clearGroup(b, '3', 0);
  assert.equal(C.groupStat(C.furnaceById(b, '3'), 0).filled, 0);
  C.clearFurnace(b, '3');
  assert.equal(C.hasFurnaceData(C.furnaceById(b, '3')), false);
  assert.equal(C.furnaceById(b, '3').headerA, null);
});

test('applyQuickUpdate：只换最高表读数，其他表保留', () => {
  const b = mk();
  fillGroup(b, '3', 0, [0.100, 0.101, 0.102, 0.103, 0.150, 0.105, 0.106, 0.107, 0.108, 0.109, 0.110, 0.111]);
  const res = C.applyQuickUpdate(b, [{
    id: '3',
    side: 'full',
    groups: [{ group: 0, gauge: 5, value: 0.170 }]
  }]);
  const f = C.furnaceById(b, '3');
  assert.equal(res.updated, 1);
  assert.equal(f.cells[0][4].v, 0.170);
  assert.equal(f.cells[0][0].v, 0.100);
  assert.equal(C.groupStat(f, 0).maxIndex, 4);
});

test('applyQuickUpdate：最高表换位时清掉旧最高表，避免旧值压住新值', () => {
  const b = mk();
  fillGroup(b, '3', 0, [0.200, 0.100, 0.100, 0.100, 0.100, 0.100, 0.100, 0.100, 0.100, 0.100, 0.100, 0.100]);
  const res = C.applyQuickUpdate(b, [{
    id: '3',
    side: 'full',
    groups: [{ group: 0, gauge: 5, value: 0.170 }]
  }]);
  const f = C.furnaceById(b, '3');
  assert.equal(res.updated, 1);
  assert.equal(f.cells[0][0].v, null);
  assert.equal(f.cells[0][4].v, 0.170);
  assert.equal(C.groupStat(f, 0).maxIndex, 4);
});

test('applyQuickUpdate：其他表仍更高时给出提醒', () => {
  const b = mk();
  fillGroup(b, '3', 0, [0.200, 0.190, 0.100, 0.100, 0.100, 0.100, 0.100, 0.100, 0.100, 0.100, 0.100, 0.100]);
  const res = C.applyQuickUpdate(b, [{
    id: '3',
    side: 'full',
    groups: [{ group: 0, gauge: 5, value: 0.170 }]
  }]);
  assert.equal(res.warnings.length, 1);
  assert.ok(res.warnings[0].msg.indexOf('其他表读数更高') >= 0);
});
