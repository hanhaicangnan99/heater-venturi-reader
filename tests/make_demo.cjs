'use strict';
/*
 * 生成 tests/demo.html：带模拟数据，可按 ?view=home|furnace|export|side 截图。
 * 用法：node tests/make_demo.cjs
 */
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');
const { buildDemoBatch } = require('./demo-data.cjs');

const ROOT = path.join(__dirname, '..');

const batch = buildDemoBatch();
const seed = JSON.stringify(C.toJSON(batch));

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
html = html.replace(/href="assets\//g, 'href="../assets/');
html = html.replace(/src="js\//g, 'src="../js/');

const headScript = `
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var theme = params.get('theme') === 'dark' ? 'dark' : 'light';
  window.confirm = function () { return true; };
  try {
    localStorage.setItem('hvp.batch.v1', ${JSON.stringify(seed)});
    localStorage.setItem('hvp.theme', theme);
  } catch (e) {}
})();
</script>
`;
html = html.replace('<head>', '<head>' + headScript);

const driver = `
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var view = params.get('view') || 'home';
  if (view === 'furnace' || view === 'side') {
    window.GaugeApp.openFurnace(params.get('id') || '3');
    var g = params.get('group');
    if (g != null) {
      var chip = document.querySelector('.group-chip[data-g="' + g + '"]');
      if (chip) chip.click();
    }
    if (view === 'side') {
      var label = (params.get('side') || 'A') + '炉膛';
      Array.prototype.forEach.call(document.querySelectorAll('.seg-btn'), function (b) {
        if (b.textContent === label) b.click();
      });
    }
  } else if (view === 'export') {
    document.getElementById('btnExport').click();
  } else if (view === 'mode1') {
    document.querySelector('.page-actions .btn').click();
  } else if (view === 'convert') {
    document.getElementById('btnRatioHome').click();
    var vals = [0.240, 0.230, 0.230, 0.220, 0.230, 0.230, 0.220];
    var inputs = document.querySelectorAll('.cf-header input');
    vals.forEach(function (v, i) {
      if (!inputs[i]) return;
      inputs[i].value = v.toFixed(3);
      inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
    });
  } else if (view === 'quick') {
    document.getElementById('btnQuick').click();
  } else if (view === 'quickSelect' || view === 'quickFurnace') {
    document.getElementById('btnQuick').click();
    var qt = document.getElementById('quickText');
    qt.value = '文丘里压力\\n\\n3号炉\\n3 0.199\\n4 0.148\\n3 0.148\\n3 0.148\\n4 0.170\\n3 0.134\\n3 0.148\\n3 0.148';
    qt.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btnQuickParse').click();
    if (view === 'quickFurnace') {
      document.querySelector('.quick-select-card').click();
    }
  } else if (view === 'quickEmpty') {
    document.getElementById('btnQuick').click();
    document.getElementById('btnQuickManual').click();
    document.querySelector('.quick-select-card[data-quick-furnace="2"]').click();
  }
})();
</script>
`;
html = html.replace('</body>', driver + '</body>');

fs.writeFileSync(path.join(__dirname, 'demo.html'), html, 'utf8');
console.log('written tests/demo.html');
