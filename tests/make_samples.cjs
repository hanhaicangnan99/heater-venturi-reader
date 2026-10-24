'use strict';
/* 生成 示例/ 下的两种文本导出与 JSON 备份：node tests/make_samples.cjs */
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const X = require('../js/xlsx-lite.js');
const { buildDemoBatch } = require('./demo-data.cjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '示例');
fs.mkdirSync(OUT, { recursive: true });

// 清掉旧格式示例
for (const f of fs.readdirSync(OUT)) {
  if (!/^(文丘里压力_|备份_|导出所有数据_)/.test(f)) fs.unlinkSync(path.join(OUT, f));
}

const b = buildDemoBatch();

fs.writeFileSync(path.join(OUT, '文丘里压力_方式1_示例.txt'), '\ufeff' + C.exportMode1(b), 'utf8');
fs.writeFileSync(path.join(OUT, '文丘里压力_方式2_示例.txt'), '\ufeff' + C.exportMode2(b), 'utf8');
fs.writeFileSync(path.join(OUT, '导出所有数据_示例.xlsx'), Buffer.from(X.build(C.toReportWorkbook(b))));
fs.writeFileSync(path.join(OUT, '备份_示例.json'), JSON.stringify(C.toJSON(b), null, 2), 'utf8');

console.log('已生成：');
for (const f of fs.readdirSync(OUT)) console.log('  示例/' + f);
console.log('\n--- 方式2 预览 ---');
console.log(C.exportMode2(b));
