'use strict';
/*
 * 生成 tests/selftest.html：注入真实浏览器交互测试，用 Chrome headless 跑并读回 #rst。
 * 用法：node tests/make_selftest.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

html = html.replace(/href="assets\//g, 'href="../assets/');
html = html.replace(/src="js\//g, 'src="../js/');

const errorHook = `
<script>
window.__err = [];
window.addEventListener('error', function (e) { window.__err.push('error: ' + (e.message || e.type)); });
window.addEventListener('unhandledrejection', function (e) { window.__err.push('rejection: ' + e.reason); });
window.confirm = function () { return true; };
</script>
`;
html = html.replace('<head>', '<head>' + errorHook);

const driver = `
<script>
(async function () {
  var results = [];
  function ok(name, cond, extra) {
    results.push((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra !== undefined ? ' :: ' + extra : ''));
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function q(s) { return document.querySelector(s); }
  function qa(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function pressKey(el, key) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: key, bubbles: true }));
  }
  function setCell(idx, val) {
    var inp = qa('.cell-input')[idx];
    inp.focus();
    inp.value = val;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    pressKey(inp, 'Enter');
  }
  function chipText() {
    return qa('#groupChips .chip').map(function (c) { return c.textContent; }).join(' | ');
  }
  function cellVal(idx) { return qa('.cell-input')[idx].value; }
  function clickSide(label) {
    Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
      if (b.textContent === label) b.click();
    });
  }
  function fillHeader(idx, val) {
    var input = qa('.cf-header input')[idx];
    input.value = val;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function fireTouch(el, type, x, y) {
    var e = new Event(type, { bubbles: true });
    e.touches = type === 'touchend' ? [] : [{ clientX: x, clientY: y }];
    e.changedTouches = [{ clientX: x, clientY: y }];
    el.dispatchEvent(e);
  }

  try {
    ok('首页 4 台炉', qa('.furnace-card').length === 4, qa('.furnace-card').length);
    ok('顶部按钮为导出所有数据', q('#btnExport').textContent === '导出所有数据', q('#btnExport').textContent);
    ok('导入按钮为 Excel', q('#btnImport').textContent === '导入 Excel', q('#btnImport').textContent);
    ok('Excel 读取组件已加载', !!window.XlsxRead);
    ok('首页没有指标卡', !q('.kpis'));
    ok('首页没有说明行', !q('.hint-line'));
    ok('日期后有时间和记录人', !!q('#metaTime') && !!q('#metaOperator'));

    // ---- 绝压比计算：粘贴方式1（无当前数据）----
    document.getElementById('btnRatioHome').click();
    await sleep(30);
    ok('打开绝压比计算', q('.page-title').textContent === '绝压比计算', q('.page-title').textContent);
    var sample = [
      '文丘里压力', '',
      '3号炉', '3 0.170', '3 0.148', '3 0.148', '3 0.148', '4 0.170', '3 0.134', '3 0.148', '3 0.148', '',
      '4号炉 B炉膛', '9 0.111', '2 0.115', '1 0.121', '7 0.110'
    ].join('\\n');
    q('#convText').value = sample;
    q('#btnConvParse').click();
    await sleep(30);
    ok('粘贴方式1解析到 2 台炉', qa('.conv-furnace').length === 2, qa('.conv-furnace').length);
    ok('提示未填集合管', q('#convMissing').textContent.indexOf('未填集合管压力') >= 0, q('#convMissing').textContent);
    fillHeader(0, '0.230');
    fillHeader(1, '0.220');
    fillHeader(2, '0.230');
    await sleep(20);
    var cpv = q('#convPreview').textContent;
    ok('粘贴转换含 0.84375', cpv.indexOf('最大绝压比 ⑤ 0.84375') >= 0, cpv.split('\\n').slice(-2).join(' / '));
    ok('粘贴转换含 4号炉 B炉膛', cpv.indexOf('4号炉 B炉膛') >= 0);

    q('#convText').value = '4号炉A\\n1 0.111\\n2 0.115\\n1 0.121\\n7 0.110';
    q('#btnConvParse').click();
    await sleep(20);
    ok('4号炉A 识别为 A炉膛', q('.conv-furnace .tag').textContent.indexOf('A炉膛') >= 0, q('.conv-furnace .tag').textContent);
    ok('4号炉A 生成 ①<1>0.111', q('#convPreview').textContent.indexOf('①<1>0.111') >= 0, q('#convPreview').textContent);
    ok('4号炉A 只有 A 集合管输入', qa('.cf-header input').length === 1, qa('.cf-header input').length);

    q('#convText').value = '3号炉\\n1 0.100\\n2 0.200\\n3 0.300\\n4 0.400';
    q('#btnConvParse').click();
    await sleep(20);
    ok('4 行未标炉膛默认 A', q('#convPreview').textContent.indexOf('①<1>0.100') >= 0, q('#convPreview').textContent);
    var bBtn = qa('.cf-head .seg-btn').filter(function (b) { return b.textContent === 'B炉膛'; })[0];
    ok('出现 A/B 切换', !!bBtn);
    bBtn.click();
    await sleep(20);
    ok('切 B 后从 ⑤ 开始', q('#convPreview').textContent.indexOf('⑤<1>0.100') >= 0, q('#convPreview').textContent);
    q('.page-actions .btn').click();
    await sleep(30);
    ok('返回首页', qa('.furnace-card').length === 4);

    // ---- 3号炉录入 ----
    qa('.furnace-card')[1].click();
    await sleep(40);
    ok('进入 3号炉', q('.fh-name').textContent === '3号炉', q('.fh-name').textContent);
    var backRect = q('.furnace-head .back').getBoundingClientRect();
    ok('返回按钮加大', backRect.height >= 40 && backRect.width >= 150, Math.round(backRect.width) + 'x' + Math.round(backRect.height));
    ok('默认未开始识别', window.GaugeApp.isPaused());
    ok('大按钮为开始识别', q('#btnRecognize').textContent === '开始识别', q('#btnRecognize').textContent);
    q('#btnRecognize').click();
    await sleep(30);
    ok('开始识别后状态为运行', !window.GaugeApp.isPaused());
    ok('大按钮变为暂停识别', q('#btnRecognize').textContent === '暂停识别', q('#btnRecognize').textContent);
    ok('8 个组页签', qa('.group-chip').length === 8, qa('.group-chip').length);
    ok('当前组 12 块表', qa('.cell').length === 12, qa('.cell').length);
    var cols = getComputedStyle(q('.cell-grid')).gridTemplateColumns.split(' ').length;
    ok('每行 6 列', cols === 6, cols);
    ok('录入页没有绝压比面板', !q('.ratio-panel') && !q('.ratio-input'));

    var first = qa('.cell-input')[0];
    first.focus();
    first.value = '0.1';
    first.dispatchEvent(new Event('input', { bubbles: true }));
    pressKey(first, 'Enter');
    await sleep(20);
    ok('回车后焦点到第 2 块', document.activeElement === qa('.cell-input')[1]);
    ok('读数格式化为 0.100', cellVal(0) === '0.100', cellVal(0));

    setCell(2, '0.17');
    await sleep(20);
    ok('第 3 块为 0.170', cellVal(2) === '0.170', cellVal(2));
    ok('组内最高 0.170 · 3#', chipText().indexOf('最高 0.170 · 3#') >= 0, chipText());

    var third = qa('.cell-input')[2];
    third.focus();
    pressKey(third, 'x');
    await sleep(20);
    ok('X 剔除后最高变 0.100', chipText().indexOf('最高 0.100 · 1#') >= 0, chipText());
    pressKey(third, 'x');
    await sleep(20);

    qa('.group-chip')[4].click();
    await sleep(30);
    setCell(3, '0.17');
    await sleep(20);
    ok('第 5 组最高 0.170 · 4#', chipText().indexOf('最高 0.170 · 4#') >= 0, chipText());

    clickSide('A炉膛');
    await sleep(40);
    ok('切 A 炉膛后 4 个组', qa('.group-chip').length === 4, qa('.group-chip').length);
    ok('标题显示 A炉膛', q('.furnace-head').textContent.indexOf('A炉膛') >= 0);
    ok('A 半台汇总 4 行', qa('.summary-table tbody tr').length === 4, qa('.summary-table tbody tr').length);
    clickSide('整台');
    await sleep(40);
    ok('切回整台 8 个组', qa('.group-chip').length === 8, qa('.group-chip').length);

    qa('.group-chip')[4].click();
    await sleep(20);
    var res = window.GaugeApp.pushReading(0.123);
    await sleep(20);
    ok('识别接口返回目标组', res && res.group === 4, JSON.stringify(res));
    ok('识别值顺序填入第 1 块', cellVal(0) === '0.123', cellVal(0));

    // ---- 回主界面 → 导出文丘里压力（方式1）----
    q('.furnace-head .back').click();
    await sleep(30);
    q('.page-actions .btn').click();
    await sleep(30);
    ok('方式1 弹窗打开', !!q('#dlgExport').open);
    ok('方式1 弹窗标题正确', q('#dlgExport h2').textContent === '导出文丘里压力', q('#dlgExport h2').textContent);
    var ev = q('#exportPreview').textContent;
    ok('方式1 含文丘里压力', ev.indexOf('文丘里压力') >= 0);
    ok('方式1 含 3号炉', ev.indexOf('3号炉') >= 0);
    ok('方式1 弹窗有绝压比入口', !!q('#btnOpenRatio'));
    q('[data-close="dlgExport"]').click();
    await sleep(20);

    // ---- 绝压比计算自动载入当前读数 ----
    document.getElementById('btnRatioHome').click();
    await sleep(30);
    ok('自动载入当前读数', q('#convText').value.indexOf('3号炉') >= 0, q('#convText').value.slice(0, 20));
    ok('当前读数解析出 1 台炉', qa('.conv-furnace').length === 1 && q('.conv-furnace').textContent.indexOf('3号炉') >= 0, qa('.conv-furnace').length);
    fillHeader(0, '0.230');
    fillHeader(1, '0.220');
    await sleep(20);
    ok('当前数据算出 0.84375', q('#convPreview').textContent.indexOf('最大绝压比 ⑤ 0.84375') >= 0, q('#convPreview').textContent.split('\\n').slice(-1)[0]);

    // ---- 导出所有数据（Excel：日期时间、绝压比、格式）----
    document.getElementById('btnExport').click();
    await sleep(30);
    ok('导出所有数据弹窗打开', !!q('#dlgExportAll').open);
    ok('弹窗标题为导出所有数据', q('#dlgExportAll h2').textContent === '导出所有数据', q('#dlgExportAll h2').textContent);
    ok('Excel 组件已加载', !!window.XlsxLite);
    var xb = window.XlsxLite.build({ sheets: [{ name: 't', rows: [[{ v: 'x', s: 5 }]] }] });
    ok('Excel 生成器输出 ZIP', xb && xb.length > 500 && xb[0] === 0x50 && xb[1] === 0x4b, xb && xb.length);
    var summary = q('#exportAllSummary').textContent;
    var metaDate = window.GaugeApp.getBatch().meta.date;
    ok('摘要含日期时间', summary.indexOf(metaDate) >= 0, summary.slice(0, 40));
    ok('摘要含 3号炉', summary.indexOf('3号炉') >= 0);
    ok('摘要含最高绝压比', summary.indexOf('0.84375') >= 0, summary);
    ok('最高绝压比注明第几组第几块', summary.indexOf('第5组第4块') >= 0, summary);
    ok('最大绝压比仅加粗不放大', !!q('#exportAllSummary .es-max') && !q('#exportAllSummary .es-big'));
    ok('下载按钮为 .xlsx', q('#btnDownloadExportAll').textContent.indexOf('.xlsx') >= 0, q('#btnDownloadExportAll').textContent);
    q('[data-close="dlgExportAll"]').click();
    await sleep(20);

    q('.page-actions .btn').click();
    await sleep(30);

    await sleep(500);
    var stored = localStorage.getItem('hvp.batch.v1');
    ok('自动保存已写入', !!stored && stored.indexOf('3号炉') >= 0);

    // ---- 2号炉 ----
    qa('.furnace-card')[0].click();
    await sleep(30);
    ok('2号炉每组 2 块', qa('.cell').length === 2, qa('.cell').length);
    ok('2号炉单行双列', q('.cell-grid').classList.contains('cols-2'));
    ok('2号炉 8 个组', qa('.group-chip').length === 8, qa('.group-chip').length);

    // ---- 主界面清空单台炉子 ----
    q('.furnace-head .back').click();
    await sleep(30);
    var clearBtn = qa('.furnace-card')[1].querySelector('.fc-clear');
    ok('主界面有清空按钮', !!clearBtn);
    clearBtn.click();
    await sleep(30);
    ok('清空后仍在主界面', qa('.furnace-card').length === 4);
    ok('3号炉已清空为 0/96', qa('.furnace-card')[1].textContent.indexOf('0/96') >= 0, qa('.furnace-card')[1].textContent.slice(0, 40));

    // ---- 导入 Excel（用同一套生成器造一个 2号炉文件）----
    var irows = [
      ['加热炉文丘里压力'],
      ['日期', '2026-10-24'],
      ['时间', '08:30'],
      ['记录人', '李四'],
      ['导出时间', '2026-10-24 09:00'],
      ['A炉膛 = 第1～4组，B炉膛 = 第5～8组；最大绝压比后注明第几组第几块'],
      [],
      ['2号炉（整台）'],
      ['组', '1#', '2#', '最高值', '表号']
    ];
    for (var gi = 1; gi <= 8; gi++) {
      irows.push(['第' + gi + '组', { v: 0.18, s: 3 }, { v: 0.11, s: gi === 1 ? 4 : 1 }, 0.18, '1#']);
    }
    irows.push(['A集合管压力', 0.24, 'B集合管压力', null, 0.23]);
    irows.push(['最大绝压比', 0.83235, '第1组第1块']);
    irows.push([]);

    var ibytes = window.XlsxLite.build({ sheets: [{ name: '读数', rows: irows }] });
    var ifile = new File([ibytes], 'import-test.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var idt = new DataTransfer();
    idt.items.add(ifile);
    var iinput = q('#fileInput');
    iinput.files = idt.files;
    iinput.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1200);

    ok('Excel 导入后仍 4 台炉', qa('.furnace-card').length === 4);
    ok('Excel 导入 2号炉 16/16', qa('.furnace-card')[0].textContent.indexOf('16/16') >= 0, qa('.furnace-card')[0].textContent.slice(0, 40));
    ok('Excel 导入日期', q('#metaDate').value === '2026-10-24', q('#metaDate').value);
    ok('Excel 导入时间', q('#metaTime').value === '08:30', q('#metaTime').value);
    ok('Excel 导入记录人', q('#metaOperator').value === '李四', q('#metaOperator').value);

    qa('.furnace-card')[0].click();
    await sleep(40);
    ok('Excel 导入剔除标记', qa('.cell')[1].classList.contains('is-excluded'), qa('.cell')[1].className);

    // ---- 送检跳过 / 倒序 / 暂停续读 ----
    q('.furnace-head .back').click();
    await sleep(30);
    qa('.furnace-card')[3].click();
    await sleep(40);
    ok('进入 5号炉', q('.fh-name').textContent === '5号炉', q('.fh-name').textContent);
    q('#btnRecognize').click();
    await sleep(30);
    ok('5号炉开始识别', !window.GaugeApp.isPaused());

    document.getElementById('btnSkip').click();
    await sleep(30);
    ok('送检标记在格子上', qa('.cell')[0].classList.contains('is-skipped'), qa('.cell')[0].className);
    ok('组页签显示送检 1', q('#groupChips').textContent.indexOf('送检 1') >= 0, q('#groupChips').textContent);

    var skipRes = window.GaugeApp.pushReading(0.1);
    await sleep(20);
    ok('跳过后填下一块', skipRes && skipRes.index === 1, JSON.stringify(skipRes));
    ok('第 2 块为 0.100', cellVal(1) === '0.100', cellVal(1));

    document.getElementById('btnReverse').click();
    await sleep(30);
    var rt = window.GaugeApp.getTarget();
    ok('倒序从最后一组最后一块开始', rt && rt.reverse && rt.group === 7 && rt.index === 11, JSON.stringify(rt));
    window.GaugeApp.pushReading(0.12);
    await sleep(20);
    ok('倒序填入 12#', cellVal(11) === '0.120', cellVal(11));

    document.getElementById('btnRecognize').click();
    await sleep(20);
    ok('识别已暂停', window.GaugeApp.isPaused());
    ok('暂停时不填入', window.GaugeApp.pushReading(0.2) === null);

    qa('.cell')[4].click();
    await sleep(20);
    var rtPick = window.GaugeApp.getTarget();
    ok('点击格子设为起点', rtPick && rtPick.index === 4, JSON.stringify(rtPick));
    ok('起点格高亮', qa('.cell')[4].classList.contains('is-start'), qa('.cell')[4].className);
    ok('选起点后大按钮为开始识别', q('#btnRecognize').textContent === '开始识别', q('#btnRecognize').textContent);
    q('#btnRecognize').click();
    await sleep(30);
    var rt2 = window.GaugeApp.getTarget();
    ok('从第 5 块开始识别', rt2 && !rt2.paused && rt2.index === 4, JSON.stringify(rt2));
    window.GaugeApp.pushReading(0.2);
    await sleep(20);
    ok('从指定块填入 0.200', cellVal(4) === '0.200', cellVal(4));

    // ---- 手机右划返回主界面 ----
    var swipeTarget = q('.camera-panel') || q('.furnace-head');
    fireTouch(swipeTarget, 'touchstart', 60, 300);
    fireTouch(swipeTarget, 'touchend', 180, 310);
    await sleep(50);
    ok('右划返回主界面', qa('.furnace-card').length === 4);

    // ---- 手动快捷输入：导入 → 选炉 → 单炉逐组 ----
    q('#btnQuick').click();
    await sleep(40);
    ok('进入快捷导入页', q('.page-title').textContent === '手动快捷输入', q('.page-title').textContent);
    ok('导入页有粘贴框', !!q('#quickText'));

    q('#btnQuickManual').click();
    await sleep(30);
    ok('无导入也显示全部 4 台炉', qa('.quick-select-card').length === 4, qa('.quick-select-card').length);
    ok('无导入全部标为手动', qa('.quick-select-card.is-empty').length === 4, qa('.quick-select-card.is-empty').length);
    qa('.page-actions .btn').filter(function (b) { return b.textContent.indexOf('返回导入') >= 0; })[0].click();
    await sleep(30);

    qa('.quick-paste-actions .btn').filter(function (b) { return b.textContent === '清空'; })[0].click();
    await sleep(20);
    var qText = q('#quickText');
    qText.value = '文丘里压力\\n\\n3号炉\\n3 0.199\\n4 0.148\\n3 0.148\\n3 0.148\\n4 0.170\\n3 0.134\\n3 0.148\\n3 0.148';
    qText.dispatchEvent(new Event('input', { bubbles: true }));
    q('#btnQuickParse').click();
    await sleep(40);
    ok('解析后进入选炉页', q('.page-title').textContent === '选择需要增补的炉子', q('.page-title').textContent);
    ok('选炉页显示全部 4 台炉', qa('.quick-select-card').length === 4, qa('.quick-select-card').length);
    ok('未导入的 3 台有区分', qa('.quick-select-card.is-empty').length === 3, qa('.quick-select-card.is-empty').length);

    q('.quick-select-card[data-quick-furnace="3"]').click();
    await sleep(40);
    ok('进入 3号炉手动页', q('.page-title').textContent.indexOf('3号炉') >= 0, q('.page-title').textContent);
    ok('单炉页只显示一组', qa('.quick-group').length === 1 && !!q('.quick-group-single'), qa('.quick-group').length);
    ok('单炉页第 1 组', q('.quick-progress strong').textContent === '第 1 组', q('.quick-progress strong').textContent);
    ok('单炉页首组位号 3#', q('.quick-group-single .quick-gauge-value').textContent === '3#', q('.quick-group-single .quick-gauge-value').textContent);

    q('.quick-group-single .quick-gauge .qstep').click();
    await sleep(20);
    ok('快捷位号可增加到 4#', q('.quick-group-single .quick-gauge-value').textContent === '4#', q('.quick-group-single .quick-gauge-value').textContent);
    qa('.quick-group-single .quick-gauge .qstep')[1].click();
    await sleep(20);
    ok('快捷位号可减回 3#', q('.quick-group-single .quick-gauge-value').textContent === '3#', q('.quick-group-single .quick-gauge-value').textContent);

    qa('.quick-group-single .q-digit')[2].querySelectorAll('.qstep')[0].click();
    await sleep(20);
    ok('快捷千分位 0.199 → 0.200', qa('.quick-group-single .quick-field')[1].title.indexOf('0.200') >= 0, qa('.quick-group-single .quick-field')[1].title);

    q('#btnQuickNext').click();
    await sleep(30);
    ok('下一组切到第 2 组', q('.quick-progress strong').textContent === '第 2 组', q('.quick-progress strong').textContent);
    ok('第 2 组位号 4#', q('.quick-group-single .quick-gauge-value').textContent === '4#', q('.quick-group-single .quick-gauge-value').textContent);

    q('#btnQuickReverse').click();
    await sleep(30);
    ok('反向输入已打开', q('#btnQuickReverse').textContent.indexOf('开') >= 0, q('#btnQuickReverse').textContent);
    ok('反向从第 8 组开始', q('.quick-progress strong').textContent === '第 8 组', q('.quick-progress strong').textContent);
    q('#btnQuickNext').click();
    await sleep(30);
    ok('反向下一组第 7 组', q('.quick-progress strong').textContent === '第 7 组', q('.quick-progress strong').textContent);
    q('#btnQuickReverse').click();
    await sleep(30);
    ok('反向关闭回到第 1 组', q('.quick-progress strong').textContent === '第 1 组', q('.quick-progress strong').textContent);

    q('#btnQuickApplyFurnace').click();
    await sleep(50);
    ok('单炉应用提示已更新', q('.quick-success') && q('.quick-success').textContent.indexOf('已更新') >= 0, q('.quick-success') ? q('.quick-success').textContent : 'no');
    var qb = window.GaugeApp.getBatch();
    var qf = qb.furnaces.filter(function (x) { return x.id === '3'; })[0];
    ok('快捷写回 3号炉 1组 3# 0.200', qf && qf.cells[0][2] && Math.abs(qf.cells[0][2].v - 0.2) < 1e-9, qf ? JSON.stringify(qf.cells[0][2]) : 'no');

    qa('.page-actions .btn').filter(function (b) { return b.textContent.indexOf('返回选炉') >= 0; })[0].click();
    await sleep(30);
    ok('从单炉页返回选炉页', q('.page-title').textContent === '选择需要增补的炉子', q('.page-title').textContent);
    qa('.page-actions .btn').filter(function (b) { return b.textContent.indexOf('返回导入') >= 0; })[0].click();
    await sleep(30);

    q('#quickText').value = '3号炉\\n1 0.100\\n2 0.200\\n3 0.300\\n4 0.400';
    q('#quickText').dispatchEvent(new Event('input', { bubbles: true }));
    q('#btnQuickParse').click();
    await sleep(30);
    q('.quick-select-card[data-quick-furnace="3"]').click();
    await sleep(30);
    ok('快捷 4 行出现炉膛选择', !!q('.quick-bar-actions .seg'), qa('.quick-bar-actions .seg').length);
    qa('.quick-bar-actions .seg-btn').filter(function (b) { return b.textContent === 'B炉膛'; })[0].click();
    await sleep(30);
    ok('快捷切 B 后从第 5 组开始', q('.quick-progress strong').textContent === '第 5 组', q('.quick-progress strong').textContent);

    qa('.page-actions .btn').filter(function (b) { return b.textContent.indexOf('返回选炉') >= 0; })[0].click();
    await sleep(30);
    q('.quick-select-card[data-quick-furnace="2"]').click();
    await sleep(30);
    ok('未导入 2号炉也可进入', q('.page-title').textContent.indexOf('2号炉') >= 0, q('.page-title').textContent);
    ok('未导入 2号炉默认 1#', q('.quick-group-single .quick-gauge-value').textContent === '1#', q('.quick-group-single .quick-gauge-value').textContent);
    ok('未导入 2号炉首组默认 0.000', qa('.quick-group-single .quick-field')[1].title.indexOf('0.000') >= 0, qa('.quick-group-single .quick-field')[1].title);
    qa('.quick-group-single .q-digit')[2].querySelectorAll('.qstep')[0].click();
    await sleep(20);
    ok('未导入首组可改为 0.001', qa('.quick-group-single .quick-field')[1].title.indexOf('0.001') >= 0, qa('.quick-group-single .quick-field')[1].title);
    q('#btnQuickNext').click();
    await sleep(30);
    ok('未导入后组跟随第一组 0.001', qa('.quick-group-single .quick-field')[1].title.indexOf('0.001') >= 0, qa('.quick-group-single .quick-field')[1].title);

    qa('.page-actions .btn').filter(function (b) { return b.textContent === '返回主界面'; })[0].click();
    await sleep(30);
    ok('快捷返回首页', qa('.furnace-card').length === 4);
  } catch (err) {
    results.push('FAIL 测试异常 :: ' + err.message);
  }

  var pre = document.createElement('pre');
  pre.id = 'rst';
  pre.textContent = results.join('\\n') + '\\nERRORS: ' + JSON.stringify(window.__err || []);
  document.body.appendChild(pre);
  document.title = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length ? 'SELFTEST-FAIL' : 'SELFTEST-PASS';
})();
</script>
`;
html = html.replace('</body>', driver + '</body>');

fs.writeFileSync(path.join(__dirname, 'selftest.html'), html, 'utf8');
console.log('written tests/selftest.html');
