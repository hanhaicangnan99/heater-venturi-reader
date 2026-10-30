/*!
 * app.js — 加热炉文丘里压力 · 界面逻辑
 * 版本 2.0.0
 *
 * 页面结构：首页选炉 → 单炉页面（组步进 + 6 列读数格 + 集合管压力/绝压比 + 汇总）。
 * 识别模块通过 window.GaugeApp.pushReading(value) 顺序填入下一个空位。
 */
(function () {
  'use strict';

  var C = window.GaugeCore;

  var KEYS = { batch: 'hvp.batch.v1', theme: 'hvp.theme' };

  var batch = null;
  var ui = { view: 'home', furnaceId: null, group: 0, reverse: false, paused: true, started: false, cursor: null };
  var cameraStream = null;
  var cameraTried = false;
  var deferredInstall = null;
  var convText = '';
  var conv = null;
  var pickExport = null;
  var pickRatio = null;
  var exportPageText = '';
  var exportPageLabel = '';
  var quick = {
    text: '', parsedText: '', model: null, issues: [], message: '', applyIssues: [],
    selectedId: null, group: 0, reverse: {}
  };
  var saveTimer = null;
  var storageOk = true;
  var warnedStorage = false;

  /* ================================================================== *
   * 一、通用工具
   * ================================================================== */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'dataset') { Object.keys(v).forEach(function (dk) { node.dataset[dk] = v[dk]; }); }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'value') node.value = v;
        else if (k === 'style') node.setAttribute('style', v);
        else if (v === true) node.setAttribute(k, '');
        else if (v !== false) node.setAttribute(k, v);
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clockStr() {
    var d = new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function readStore(key) {
    try { return window.localStorage.getItem(key); }
    catch (e) { storageOk = false; return null; }
  }

  function writeStore(key, value) {
    try { window.localStorage.setItem(key, value); return true; }
    catch (e) { storageOk = false; return false; }
  }

  function toast(msg, kind, ms) {
    var host = $('#toasts');
    var t = el('div', { class: 'toast' + (kind ? ' ' + kind : ''), role: 'status' }, [msg]);
    host.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }, ms || 2400);
  }

  function scrollTop() {
    try { window.scrollTo({ top: 0, behavior: 'auto' }); } catch (e) { window.scrollTo(0, 0); }
  }

  /* ================================================================== *
   * 二、持久化 / 启动
   * ================================================================== */

  function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      var ok = writeStore(KEYS.batch, JSON.stringify(C.toJSON(batch)));
      if (!ok && !warnedStorage) {
        warnedStorage = true;
        toast('浏览器禁止了本地存储，请及时导出备份', 'error', 6000);
      }
      var hint = $('#saveHint');
      if (hint) hint.textContent = '已自动保存 ' + clockStr();
    }, 300);
  }

  function loadBatch() {
    var raw = readStore(KEYS.batch);
    if (raw) {
      try {
        var b = C.normalizeBatch(JSON.parse(raw));
        if (C.hasBatchData(b) || b.meta.operator) return { batch: b, restored: true };
      } catch (e) { /* 缓存损坏则忽略 */ }
    }
    return { batch: C.createBatch(), restored: false };
  }

  function currentFurnace() {
    return ui.furnaceId ? C.furnaceById(batch, ui.furnaceId) : null;
  }

  function syncMeta() {
    $('#metaDate').value = batch.meta.date;
    $('#metaTime').value = batch.meta.time || C.nowTimeStr();
    $('#metaOperator').value = batch.meta.operator;
  }

  /* ================================================================== *
   * 三、首页
   * ================================================================== */

  function render() {
    if (ui.view === 'convert') {
      renderConverter();
    } else if (ui.view === 'exportSelect') {
      renderPickPage('export');
    } else if (ui.view === 'exportPreview') {
      renderExportPreviewPage();
    } else if (ui.view === 'ratioSelect') {
      renderPickPage('ratio');
    } else if (ui.view === 'visual') {
      renderVisualSelect();
    } else if (ui.view === 'quickImport') {
      renderQuickImport();
    } else if (ui.view === 'quickSelect') {
      renderQuickSelect();
    } else if (ui.view === 'quickFurnace') {
      renderQuickFurnace();
    } else if (ui.view === 'furnace' && currentFurnace()) {
      renderFurnace();
    } else {
      ui.view = 'home';
      ui.furnaceId = null;
      renderHome();
    }
    syncMeta();
    document.body.classList.toggle('furnace-mode', ui.view === 'furnace' && !!currentFurnace());
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function canInstall() {
    if (isStandalone()) return false;
    if (location.protocol === 'https:') return true;
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  function installPwa() {
    var prompt = deferredInstall || window.__hvpInstallPrompt;
    if (prompt && prompt.prompt) {
      deferredInstall = null;
      window.__hvpInstallPrompt = null;
      prompt.prompt();
      if (prompt.userChoice && prompt.userChoice.then) {
        prompt.userChoice.then(function (choice) {
          if (choice && choice.outcome === 'accepted') toast('已添加到手机桌面', 'ok', 2400);
        });
      }
      return;
    }
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
      alert('iPhone / iPad：用 Safari 打开后，点底部分享按钮 → 添加到主屏幕。');
    } else {
      alert('Chrome：点右上角 ⋮ → 安装应用 / 添加到主屏幕。');
    }
  }

  function initInstall() {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredInstall = e;
      window.__hvpInstallPrompt = e;
    });
    window.addEventListener('appinstalled', function () {
      deferredInstall = null;
      window.__hvpInstallPrompt = null;
      var b = $('#btnInstall');
      if (b) b.remove();
      toast('已添加到手机桌面', 'ok', 2400);
    });
    if (window.__hvpInstallPrompt) deferredInstall = window.__hvpInstallPrompt;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    navigator.serviceWorker.register('sw.js').then(function (reg) {
      if (reg && reg.update) reg.update();
    }).catch(function () { /* 离线能力失败不影响使用 */ });
  }

  function renderHome() {
    var st = C.batchStat(batch);
    var host = $('#view');
    host.innerHTML = '';

    if (location.protocol === 'file:') {
      host.appendChild(el('div', { class: 'file-warning' }, [
        el('strong', { text: '当前是本地文件模式' }),
        el('span', { text: '录入、导入导出、绝压比计算都能用；手机浏览器只在 HTTPS 网址（https:// 开头）下允许摄像头，file:// 和 http://192.168… 都不行。需要实时相机，请把单文件放到 HTTPS 网站，或打包成 App。' })
      ]));
    }

    host.appendChild(el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h2', { class: 'page-title', text: '选择录入方式' }),
        el('p', { class: 'page-sub', text: '两种方式并行：视觉录入全部炉子的原始读数，或手动只记每组最高表。' })
      ]),
      el('div', { class: 'page-actions' }, [
        el('button', { class: 'btn', type: 'button', text: '导出文丘里压力', onclick: openExportSelect }),
        el('button', { class: 'btn primary', type: 'button', id: 'btnRatioHome', text: '绝压比计算', onclick: openRatioSelect }),
        canInstall() ? el('button', { class: 'btn install-btn', type: 'button', id: 'btnInstall', text: '安装到桌面', onclick: installPwa }) : null
      ])
    ]));

    var grid = el('div', { class: 'mode-grid' });
    grid.appendChild(el('article', {
      class: 'mode-card', id: 'btnVisual', tabindex: 0, role: 'button',
      onclick: openVisual
    }, [
      el('span', { class: 'mode-kicker', text: '完整录入' }),
      el('h3', { text: '视觉录入' }),
      el('p', { text: '相机逐块识别 2/3/4/5 号炉的全部读数，保留每组每块原始数据。' }),
      el('span', { class: 'mode-status', text: '已录 ' + st.measured + ' / 4 台 · 已处理 ' + st.handled + ' / ' + st.total + ' 块' }),
      el('span', { class: 'mode-go', text: '进入视觉录入 ›' })
    ]));
    grid.appendChild(el('article', {
      class: 'mode-card', id: 'btnQuick', tabindex: 0, role: 'button',
      onclick: openQuick
    }, [
      el('span', { class: 'mode-kicker', text: '日常更新' }),
      el('h3', { text: '手动快捷录入' }),
      el('p', { text: '只记每组最高表位号和读数，适合视觉识别不能用时的快速更新。' }),
      el('span', { class: 'mode-status', text: '每组只改最高表 · 不必逐块录' }),
      el('span', { class: 'mode-go', text: '进入手动录入 ›' })
    ]));
    host.appendChild(grid);
  }

  function openVisual() {
    stopCamera();
    ui.view = 'visual';
    render();
    scrollTop();
  }

  function renderVisualSelect() {
    var st = C.batchStat(batch);
    var host = $('#view');
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h2', { class: 'page-title', text: '视觉录入 · 全部炉子' }),
        el('p', { class: 'page-sub', text: '录入全部原始读数；A 炉膛 = 1～4 组，B 炉膛 = 5～8 组。' })
      ]),
      el('div', { class: 'page-actions' }, [
        el('button', { class: 'btn ghost', type: 'button', text: '‹ 录入方式', onclick: goHome }),
        el('button', { class: 'btn ghost danger-text', type: 'button', text: '一键清空所有数据', onclick: function () { clearAllData('visual'); } }),
        el('button', { class: 'btn', type: 'button', id: 'btnQuick', text: '手动快捷录入', onclick: openQuick })
      ])
    ]));
    var grid = el('div', { class: 'furnace-grid' });
    st.furnaces.forEach(function (fs) { grid.appendChild(furnaceCard(fs)); });
    host.appendChild(grid);
  }

  function openQuick() {
    stopCamera();
    ui.view = 'quickImport';
    quick.model = null;
    quick.selectedId = null;
    quick.text = C.hasBatchData(batch) ? C.exportMode1(batch) : '';
    quick.parsedText = quick.text;
    quick.issues = [];
    quick.message = '';
    quick.applyIssues = [];
    render();
    scrollTop();
  }

  function quickDigits(value) {
    var milli = value == null ? 0 : Math.round(value * 1000);
    milli = Math.max(0, Math.min(400, milli));
    return [Math.floor(milli / 100), Math.floor(milli / 10) % 10, milli % 10];
  }

  function quickEmptyRows(n) {
    var out = [];
    for (var i = 0; i < n; i++) {
      out.push({ gauge: 1, value: 0, synced: i !== 0, placeholder: false, active: false });
    }
    return out;
  }

  function quickEmptyFurnace(def) {
    return {
      id: def.id,
      label: def.label,
      side: 'full',
      perGroup: def.perGroup,
      ambiguous: false,
      imported: false,
      rows: quickEmptyRows(def.groups)
    };
  }

  function quickEnsureAllFurnaces() {
    var byId = {};
    (quick.model || []).forEach(function (f) { byId[f.id] = f; });
    quick.model = C.FURNACE_DEFS.map(function (def) {
      return byId[def.id] || quickEmptyFurnace(def);
    });
  }

  function quickHasImported() {
    return !!(quick.model || []).some(function (f) { return f.imported; });
  }

  function parseQuick(silent) {
    var ta = $('#quickText');
    if (ta) quick.text = ta.value;
    var res = C.parseMode1(quick.text || '');
    var parsed = res.furnaces || [];
    var byId = {};
    parsed.forEach(function (pf) { byId[pf.id] = pf; });
    quick.issues = res.issues || [];
    quick.model = C.FURNACE_DEFS.map(function (def) {
      var pf = byId[def.id];
      if (!pf) return quickEmptyFurnace(def);
      var bf = C.furnaceById(batch, pf.id);
      var rows = quickEmptyRows(def.groups).map(function (r) {
        r.synced = true;
        r.placeholder = true;
        r.active = false;
        return r;
      });
      var scope = pf.side === 'A' ? [0, 1, 2, 3] : pf.side === 'B' ? [4, 5, 6, 7] : [0, 1, 2, 3, 4, 5, 6, 7];
      (pf.rawLines || []).forEach(function (r, k) {
        var g = scope[k];
        if (g == null) return;
        rows[g] = {
          gauge: r.gauge == null ? null : Number(r.gauge),
          value: r.value == null ? null : Number(r.value),
          synced: false,
          placeholder: false,
          active: true
        };
      });
      var halfRows = null;
      if (pf.side === 'A' || pf.side === 'B') {
        halfRows = scope.map(function (g) {
          return { gauge: rows[g].gauge, value: rows[g].value };
        });
      }
      return {
        id: pf.id,
        label: pf.label,
        side: pf.side || 'full',
        perGroup: bf ? bf.perGroup : def.perGroup,
        ambiguous: !!pf.ambiguous,
        imported: true,
        halfRows: halfRows,
        halfSide: halfRows ? pf.side : null,
        rows: rows
      };
    });
    quick.message = '';
    quick.applyIssues = [];
    quick.parsedText = quick.text;
    quickCommitAll();
    if (!silent) {
      if (parsed.length) {
        quick.selectedId = null;
        ui.view = 'quickSelect';
        render();
        scrollTop();
      } else {
        renderQuickImport();
      }
    }
  }

  function loadQuickCurrent() {
    if (!C.hasBatchData(batch)) {
      toast('当前还没有读数，先粘贴方式1文本', 'warn', 2400);
      return;
    }
    quick.text = C.exportMode1(batch);
    parseQuick(false);
    toast('已载入当前读数', 'ok', 1600);
  }

  function clearQuick() {
    quick.text = '';
    quick.model = null;
    quick.issues = [];
    quick.message = '';
    quick.applyIssues = [];
    quick.selectedId = null;
    ui.view = 'quickImport';
    render();
  }

  function quickFind(id) {
    var out = null;
    (quick.model || []).forEach(function (f) { if (f.id === String(id)) out = f; });
    return out;
  }

  function quickStepBtn(text, label, fn) {
    return el('button', {
      class: 'qstep', type: 'button', text: text,
      title: label, 'aria-label': label,
      onclick: fn
    });
  }

  function renderQuickPage() {
    if (ui.view === 'quickFurnace') renderQuickFurnace();
    else if (ui.view === 'quickSelect') renderQuickSelect();
    else if (ui.view === 'quickImport') renderQuickImport();
    else renderQuickSelect();
  }

  function stepQuickGauge(id, rowIndex, delta) {
    var f = quickFind(id);
    if (!f || !f.rows[rowIndex]) return;
    var row = f.rows[rowIndex];
    row.synced = false;
    row.placeholder = false;
    row.active = true;
    var pg = f.perGroup;
    if (row.gauge == null) row.gauge = delta > 0 ? 1 : pg;
    else {
      row.gauge += delta;
      if (row.gauge < 1) row.gauge = pg;
      if (row.gauge > pg) row.gauge = 1;
    }
    quickRememberHalfRow(f, rowIndex);
    quickCommit(f);
    var hadNotice = quick.message || (quick.applyIssues && quick.applyIssues.length);
    quick.message = '';
    quick.applyIssues = [];
    if (hadNotice) renderQuickPage();
    else refreshQuickCard(id, rowIndex);
  }

  function stepQuickDigit(id, rowIndex, pos, delta) {
    var f = quickFind(id);
    if (!f || !f.rows[rowIndex]) return;
    var row = f.rows[rowIndex];
    row.synced = false;
    row.placeholder = false;
    row.active = true;
    if (row.gauge == null) row.gauge = 1;
    var milli = row.value == null ? 0 : Math.round(row.value * 1000);
    var step = pos === 0 ? 100 : pos === 1 ? 10 : 1;
    var next = milli + delta * step;
    if (delta > 0) {
      if (next > 400) next = 0;
    } else if (next < 0) {
      if (pos === 0) next = 400;
      else if (pos === 1) next = 90 + (milli % 10);
      else next = (milli - (milli % 10)) + 9;
    }
    row.value = next / 1000;
    quickFurnaceGroups(f).forEach(function (g) {
      if (g !== rowIndex && f.rows[g].synced) {
        f.rows[g].value = row.value;
        f.rows[g].placeholder = false;
        f.rows[g].active = true;
      }
    });
    quickRememberHalfRow(f, rowIndex);
    quickCommit(f);
    var hadNotice = quick.message || (quick.applyIssues && quick.applyIssues.length);
    quick.message = '';
    quick.applyIssues = [];
    if (hadNotice) renderQuickPage();
    else refreshQuickCard(id, rowIndex);
  }

  function quickCaptureHalf(f) {
    if (!f.halfRows || (f.side !== 'A' && f.side !== 'B')) return;
    var scope = f.side === 'A' ? [0, 1, 2, 3] : [4, 5, 6, 7];
    f.halfRows = scope.map(function (g) {
      return { gauge: f.rows[g].gauge, value: f.rows[g].value };
    });
    f.halfSide = f.side;
  }

  function quickRebuildHalf(f, side) {
    if (!f.halfRows || (side !== 'A' && side !== 'B')) return;
    var scope = side === 'A' ? [0, 1, 2, 3] : [4, 5, 6, 7];
    var rows = quickEmptyRows(8).map(function (r) {
      r.synced = true;
      r.placeholder = true;
      r.active = false;
      return r;
    });
    scope.forEach(function (g, k) {
      var r = f.halfRows[k] || { gauge: null, value: null };
      rows[g] = { gauge: r.gauge, value: r.value, synced: false, placeholder: false, active: true };
    });
    f.rows = rows;
    f.halfSide = side;
  }

  function quickRememberHalfRow(f, g) {
    if (!f.halfRows || !f.halfSide) return;
    var off = f.halfSide === 'A' ? 0 : 4;
    if (g >= off && g < off + 4) {
      f.halfRows[g - off] = { gauge: f.rows[g].gauge, value: f.rows[g].value };
    }
  }

  function quickSwitchSide(f, side) {
    if (f.side === side) return;
    if (f.halfRows) quickCaptureHalf(f);
    f.side = side;
    if (f.halfRows && (side === 'A' || side === 'B')) quickRebuildHalf(f, side);
    quick.group = quickFirstGroup(f);
    quick.message = '';
    quick.applyIssues = [];
    if (ui.view === 'quickSelect') renderQuickSelect();
    else renderQuickFurnace();
  }

  function quickSideBtn(f, side) {
    return el('button', {
      class: 'seg-btn' + (f.side === side ? ' active' : ''),
      type: 'button', text: side === 'full' ? '整台' : side + '炉膛',
      onclick: function () { quickSwitchSide(f, side); }
    });
  }

  function quickField(label, body, extraClass) {
    return el('div', { class: 'quick-field' + (extraClass ? ' ' + extraClass : '') }, [
      el('span', { class: 'quick-label', text: label }),
      body
    ]);
  }

  function quickSetGauge(id, g, value, refresh) {
    var f = quickFind(id);
    if (!f || !f.rows[g]) return;
    var n = Number(value);
    if (!isFinite(n)) n = 1;
    n = Math.max(1, Math.min(f.perGroup, Math.round(n)));
    var row = f.rows[g];
    row.gauge = n;
    row.placeholder = false;
    row.active = true;
    row.synced = false;
    quickRememberHalfRow(f, g);
    quickCommit(f);
    var card = document.querySelector('.quick-group[data-quick-id="' + id + '"][data-quick-row="' + g + '"]');
    if (card) {
      var v = card.querySelector('.quick-gauge-value');
      if (v) {
        v.textContent = n + '#';
        v.classList.remove('is-empty');
      }
    }
    quick.message = '';
    quick.applyIssues = [];
    if (refresh) renderQuickFurnace();
  }

  function quickGroup(f, row, g, single) {
    var chamber = C.chamberOf(g);
    var empty = row.gauge == null || row.value == null;
    var digits = quickDigits(row.value);

    var gaugeBox = el('div', { class: 'quick-gauge' }, [
      quickStepBtn('▲', '增大最高表位号', function () { stepQuickGauge(f.id, g, 1); }),
      el('strong', {
        class: 'quick-gauge-value' + (row.gauge == null ? ' is-empty' : ''),
        text: row.gauge == null ? '—' : row.gauge + '#'
      }),
      quickStepBtn('▼', '减小最高表位号', function () { stepQuickGauge(f.id, g, -1); })
    ]);

    var gaugeSlider = el('input', {
      class: 'quick-gauge-slider', type: 'range',
      min: 1, max: f.perGroup, step: 1,
      value: row.gauge == null ? 1 : row.gauge,
      'aria-label': '快速选择最高表位号'
    });
    gaugeSlider.addEventListener('input', function () {
      quickSetGauge(f.id, g, this.value, false);
    });
    gaugeSlider.addEventListener('change', function () {
      quickSetGauge(f.id, g, this.value, true);
    });
    var gaugeRow = el('div', { class: 'quick-gauge-row' }, [
      gaugeBox,
      el('div', { class: 'quick-gauge-slider-wrap' }, [
        gaugeSlider,
        el('div', { class: 'quick-gauge-scale' }, [
          el('span', { text: '1#' }),
          el('span', { text: f.perGroup + '#' })
        ])
      ])
    ]);

    var digitWrap = el('div', { class: 'quick-digits' });
    digitWrap.appendChild(el('span', { class: 'quick-int', text: '0.' }));
    digits.forEach(function (d, pos) {
      var label = ['十分位', '百分位', '千分位'][pos];
      digitWrap.appendChild(el('div', { class: 'q-digit' + (row.value == null ? ' is-empty' : '') }, [
        quickStepBtn('▲', '增加' + label, function () { stepQuickDigit(f.id, g, pos, 1); }),
        el('strong', { text: String(d) }),
        quickStepBtn('▼', '减少' + label, function () { stepQuickDigit(f.id, g, pos, -1); }),
        el('span', { class: 'q-digit-label', text: label })
      ]));
    });

    var readBox = el('div', { class: 'quick-field' }, [
      el('span', { class: 'quick-label', text: '最高读数' }),
      digitWrap
    ]);
    readBox.title = '当前读数 ' + (row.value == null ? '—' : row.value.toFixed(3));

    return el('div', {
      class: 'quick-group' + (single ? ' quick-group-single' : '') + (empty ? ' is-empty' : ''),
      'data-quick-id': f.id,
      'data-quick-row': g
    }, [
      el('div', { class: 'quick-group-head' }, [
        el('strong', { text: '第' + (g + 1) + '组' }),
        el('span', { class: 'tag small', text: chamber + '炉膛' })
      ]),
      el('div', { class: 'quick-editors' }, [
        quickField('最高表位号', gaugeRow),
        readBox
      ])
    ]);
  }

  function refreshQuickCard(id, rowIndex) {
    var f = quickFind(id);
    if (!f || !f.rows[rowIndex]) { renderQuickPage(); return; }
    var old = document.querySelector('.quick-group[data-quick-id="' + id + '"][data-quick-row="' + rowIndex + '"]');
    if (!old) { renderQuickFurnace(); return; }
    var single = old.classList.contains('quick-group-single');
    old.replaceWith(quickGroup(f, f.rows[rowIndex], rowIndex, single));
  }

  function quickFurnaceGroups(f) {
    var out = [];
    if (f.side === 'A') {
      for (var a = 0; a < 4; a++) out.push(a);
    } else if (f.side === 'B') {
      for (var b = 4; b < 8; b++) out.push(b);
    } else {
      for (var g = 0; g < 8; g++) out.push(g);
    }
    return out;
  }

  function quickFirstGroup(f) {
    var list = quickFurnaceGroups(f);
    return quick.reverse[f.id] ? list[list.length - 1] : list[0];
  }

  function quickGroupRow(f, g) {
    return f.side === 'full' ? g : f.side === 'A' ? g : g - 4;
  }

  function quickUpdateFor(f) {
    var groups = [];
    f.rows.forEach(function (row, g) {
      if (row.placeholder || !row.active) return;
      groups.push({ group: g, gauge: row.gauge, value: row.value });
    });
    return { id: f.id, side: f.side, groups: groups };
  }

  function quickSelectFurnace(id) {
    var f = quickFind(id);
    if (!f) return;
    quick.selectedId = f.id;
    quick.group = quickFirstGroup(f);
    quick.message = '';
    quick.applyIssues = [];
    ui.view = 'quickFurnace';
    render();
    scrollTop();
  }

  function quickBackToSelect() {
    quick.message = '';
    quick.applyIssues = [];
    ui.view = 'quickSelect';
    render();
    scrollTop();
  }

  function quickBackToImport() {
    quick.message = '';
    quick.applyIssues = [];
    ui.view = 'quickImport';
    render();
    scrollTop();
  }

  function quickDirection(f) {
    return !!quick.reverse[f.id];
  }

  function toggleQuickDirection() {
    var f = quickFind(quick.selectedId);
    if (!f) return;
    quick.reverse[f.id] = !quickDirection(f);
    quick.group = quickFirstGroup(f);
    quick.message = '';
    quick.applyIssues = [];
    renderQuickFurnace();
  }

  function quickMoveGroup(step) {
    var f = quickFind(quick.selectedId);
    if (!f) return;
    var list = quickFurnaceGroups(f);
    var pos = list.indexOf(quick.group);
    var next = pos + step;
    if (next < 0 || next >= list.length) return;
    quick.group = list[next];
    quick.message = '';
    quick.applyIssues = [];
    renderQuickFurnace();
  }

  function quickNotices() {
    var wrap = el('div');
    if (quick.message) wrap.appendChild(el('div', { class: 'quick-success', text: quick.message }));
    if (quick.applyIssues && quick.applyIssues.length) wrap.appendChild(quickApplyWarnings());
    return wrap;
  }

  function quickCommit(f) {
    if (!f) return;
    C.applyQuickUpdate(batch, [quickUpdateFor(f)]);
    persist();
  }

  function quickCommitAll() {
    if (!quick.model) return;
    var updates = [];
    quick.model.forEach(function (f) {
      var u = quickUpdateFor(f);
      if (u.groups.length) updates.push(u);
    });
    if (updates.length) C.applyQuickUpdate(batch, updates);
    persist();
  }

  function quickActiveGroups(f) {
    var scope = quickFurnaceGroups(f);
    return scope.filter(function (g) {
      var row = f.rows[g];
      return row && row.active && !row.placeholder;
    }).length;
  }

  function quickResetFurnaceModel(id) {
    if (!quick.model) return;
    var f = quickFind(id);
    if (!f) return;
    f.rows = quickEmptyRows(8);
    f.side = 'full';
    f.imported = false;
    f.halfRows = null;
    f.halfSide = null;
  }

  function clearAllData(where) {
    if (!confirm('清空所有炉子的全部数据？此操作不可撤销。')) return;
    batch.furnaces.forEach(function (f) { C.clearFurnace(batch, f.id); });
    quick.model = null;
    quick.selectedId = null;
    quick.text = '';
    quick.message = '';
    quick.applyIssues = [];
    persist();
    if (where === 'quick') {
      quickEnsureAllFurnaces();
      renderQuickSelect();
    } else {
      renderVisualSelect();
    }
    toast('已清空所有炉子数据', 'ok', 1800);
  }

  function clearOneFurnace(id, where) {
    var bf = C.furnaceById(batch, id);
    if (!bf) return;
    if (!confirm('清空 ' + bf.label + ' 的全部数据？')) return;
    C.clearFurnace(batch, id);
    quickResetFurnaceModel(id);
    persist();
    if (where === 'quick') renderQuickSelect();
    else renderVisualSelect();
    toast('已清空 ' + bf.label, 'ok', 1500);
  }

  function quickSelectCard(f) {
    var side = f.side === 'full' ? '整台' : f.side + '炉膛';
    var count = quickFurnaceGroups(f).length;
    var done = quickActiveGroups(f);
    var pct = count ? Math.round((done / count) * 100) : 0;
    var seg = el('div', { class: 'seg', role: 'group', 'aria-label': '录入炉膛范围' }, [
      ['full', '整台'], ['A', 'A炉膛'], ['B', 'B炉膛']
    ].map(function (pair) {
      return el('button', {
        class: 'seg-btn' + (f.side === pair[0] ? ' active' : ''),
        type: 'button', text: pair[1],
        onclick: function (e) {
          e.stopPropagation();
          quickSwitchSide(f, pair[0]);
        }
      });
    }));
    var controls = el('div', { class: 'quick-select-controls', onclick: function (e) { e.stopPropagation(); } }, [
      el('button', {
        class: 'btn sm ghost danger-text fc-clear', type: 'button', text: '清空本炉',
        onclick: function (e) { e.stopPropagation(); clearOneFurnace(f.id, 'quick'); }
      }),
      seg
    ]);

    return el('article', {
      class: 'quick-select-card' + (done ? '' : ' is-empty'),
      tabindex: 0, role: 'button',
      'data-quick-furnace': f.id,
      'aria-label': f.label + ' 手动快捷输入',
      onclick: function () { quickSelectFurnace(f.id); }
    }, [
      el('div', { class: 'quick-select-head' }, [
        el('h3', { text: f.label }),
        el('span', { class: 'tag', text: side }),
        el('span', { class: 'tag' + (done ? ' ok' : ''), text: done ? '已有数据' : '未录入' }),
        f.ambiguous ? el('span', { class: 'tag', text: '文本未写炉膛' }) : null
      ]),
      el('p', { class: 'quick-select-sub', text: '已录 ' + done + '/' + count + ' 组 · 每组只改最高表' }),
      el('div', { class: 'fc-bar' }, [el('span', { style: 'width:' + pct + '%' })]),
      controls,
      el('span', { class: 'fc-go', text: f.imported ? '进入 ›' : '手动录入 ›' })
    ]);
  }

  function renderQuickImport() {
    var host = $('#view');
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h2', { class: 'page-title', text: '手动快捷输入' }),
        el('p', { class: 'page-sub', text: '视觉识别不能用时的备用方式：每组只记最高表；粘贴已有的方式1文本可快速带入。' })
      ]),
      el('div', { class: 'page-actions' }, [
        quickHasImported()
          ? el('button', { class: 'btn', type: 'button', text: '继续选择炉子', onclick: function () { quickEnsureAllFurnaces(); ui.view = 'quickSelect'; render(); } })
          : null,
        el('button', {
          class: 'btn', type: 'button', id: 'btnQuickManual', text: '不导入，直接手动',
          onclick: function () {
            if (C.hasBatchData(batch)) {
              quick.text = C.exportMode1(batch);
              parseQuick(false);
            } else {
              quick.model = null;
              quickEnsureAllFurnaces();
            }
            ui.view = 'quickSelect';
            render();
            scrollTop();
          }
        }),
        el('button', { class: 'btn ghost', type: 'button', text: '‹ 返回主界面', onclick: goHome })
      ])
    ]));
    host.appendChild(quickPastePanel());
    if (quick.issues && quick.issues.length) host.appendChild(quickIssuesPanel());
    if (!quickHasImported()) {
      host.appendChild(el('div', { class: 'quick-empty', text: '粘贴文本后点「解析文本」；也可以直接点「不导入，直接手动」，第二页仍会显示全部 2/3/4/5 号炉。' }));
    }
  }

  function renderQuickSelect() {
    quickEnsureAllFurnaces();
    var host = $('#view');
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h2', { class: 'page-title', text: '手动快捷录入 · 选择炉子' }),
        el('p', { class: 'page-sub', text: '只记每组最高表；改动会立即保存，不需要再点应用。导出/绝压比页面里再选要计算的炉子。' })
      ]),
      el('div', { class: 'page-actions' }, [
        el('button', { class: 'btn ghost', type: 'button', text: '‹ 返回导入', onclick: quickBackToImport }),
        el('button', { class: 'btn ghost danger-text', type: 'button', text: '一键清空所有数据', onclick: function () { clearAllData('quick'); } }),
        el('button', { class: 'btn ghost', type: 'button', text: '返回主界面', onclick: goHome })
      ])
    ]));
    if (quick.message || (quick.applyIssues && quick.applyIssues.length)) {
      host.appendChild(quickNotices());
    }
    if (quick.issues && quick.issues.length) host.appendChild(quickIssuesPanel());
    var grid = el('div', { class: 'quick-select-grid' });
    quick.model.forEach(function (f) { grid.appendChild(quickSelectCard(f)); });
    host.appendChild(grid);
    host.appendChild(el('div', { class: 'quick-select-footer' }, [
      el('button', { class: 'btn', type: 'button', id: 'btnQuickExport', text: '导出文丘里压力', onclick: quickApplyAndExport }),
      el('button', { class: 'btn ghost', type: 'button', text: '返回主界面', onclick: goHome }),
      el('button', { class: 'btn', type: 'button', id: 'btnQuickRatio', text: '计算绝压比', onclick: quickApplyAndRatio })
    ]));
  }

  function renderQuickFurnace() {
    var f = quickFind(quick.selectedId);
    if (!f) {
      quickBackToSelect();
      return;
    }
    var list = quickFurnaceGroups(f);
    if (list.indexOf(quick.group) < 0) quick.group = quickFirstGroup(f);
    var pos = list.indexOf(quick.group);
    var reverse = quickDirection(f);
    var atStart = reverse ? pos >= list.length - 1 : pos <= 0;
    var atEnd = reverse ? pos <= 0 : pos >= list.length - 1;
    var rowIndex = quick.group;
    var row = f.rows[rowIndex];

    var host = $('#view');
    host.innerHTML = '';

    host.appendChild(el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h2', { class: 'page-title', text: f.label + ' · 手动快捷输入' }),
        el('p', { class: 'page-sub', text: '第 3 步：每组只改最高表，完成一组点「下一组」。' })
      ]),
      el('div', { class: 'page-actions' }, [
        el('button', { class: 'btn ghost', type: 'button', text: '‹ 返回选炉', onclick: quickBackToSelect }),
        el('button', { class: 'btn ghost', type: 'button', text: '返回主界面', onclick: goHome })
      ])
    ]));

    var bar = el('div', { class: 'quick-furnace-bar' }, [
      el('div', { class: 'quick-progress' }, [
        el('strong', { text: '第 ' + (quick.group + 1) + ' 组' }),
        el('span', { text: ' / 共 ' + list.length + ' 组 · ' + C.chamberOf(quick.group) + '炉膛' })
      ]),
      el('div', { class: 'quick-bar-actions' }, [
        el('div', { class: 'seg', role: 'group', 'aria-label': '炉膛选择' }, [
          quickSideBtn(f, 'full'),
          quickSideBtn(f, 'A'),
          quickSideBtn(f, 'B')
        ]),
        el('button', {
          class: 'btn quick-reverse' + (reverse ? ' active' : ''),
          type: 'button', id: 'btnQuickReverse',
          text: '反向输入：' + (reverse ? '开' : '关'),
          onclick: toggleQuickDirection
        })
      ])
    ]);
    host.appendChild(bar);

    if (!f.imported) {
      host.appendChild(el('div', {
        class: 'quick-default-hint',
        text: '未导入：每组默认 1# / 0.000；改任意一组后，没改过的组会自动跟随最近改过的那一组。'
      }));
    } else if (f.rows.some(function (r) { return r.placeholder; })) {
      host.appendChild(el('div', {
        class: 'quick-default-hint',
        text: '导入的是半台：切到整台后，空白半台默认跟随第一组；没跟过也没改过的占位组不会写入。'
      }));
    }

    if (quick.message || (quick.applyIssues && quick.applyIssues.length)) {
      host.appendChild(quickNotices());
    }

    var cardWrap = el('div', { class: 'quick-single-wrap' });
    cardWrap.appendChild(quickGroup(f, row, quick.group, true));
    host.appendChild(cardWrap);

    var nav = el('div', { class: 'quick-nav' }, [
      el('button', {
        class: 'btn', type: 'button', id: 'btnQuickPrev',
        text: '‹ 上一组', disabled: atStart,
        onclick: function () { quickMoveGroup(reverse ? 1 : -1); }
      }),
      el('button', {
        class: 'btn primary', type: 'button', id: 'btnQuickNext',
        text: atEnd ? '完成本炉 ›' : '下一组 ›',
        onclick: atEnd ? quickBackToSelect : function () { quickMoveGroup(reverse ? -1 : 1); }
      })
    ]);
    host.appendChild(nav);
    host.appendChild(el('div', { class: 'quick-nav-hint', text: (reverse ? '反向输入：组 8→1，下一组往编号小的方向走。' : '正序输入：组 1→8，下一组往编号大的方向走。') + ' 位号/读数箭头循环。' }));

    host.appendChild(el('div', { class: 'quick-furnace-apply' }, [
      el('div', { class: 'quick-apply-hint', text: '改动会立即保存到当前数据；其他表读数保留。' }),
      el('button', { class: 'btn ghost', type: 'button', text: '返回选炉', onclick: quickBackToSelect })
    ]));
  }

  function quickFurnace(f) {
    var head = el('div', { class: 'quick-f-head' }, [
      el('h3', { text: f.label })
    ]);
    if (f.rows.length === 4) {
      head.appendChild(el('div', { class: 'seg', role: 'group', 'aria-label': '炉膛选择' }, [
        quickSideBtn(f, 'A'),
        quickSideBtn(f, 'B')
      ]));
      if (f.ambiguous) head.appendChild(el('span', { class: 'tag', text: '文本未写炉膛，请选择 A/B' }));
    } else {
      head.appendChild(el('span', { class: 'tag', text: '整台（A+B）' }));
    }

    var grid = el('div', { class: 'quick-groups' });
    f.rows.forEach(function (row, k) { grid.appendChild(quickGroup(f, row, k)); });

    return el('section', { class: 'quick-furnace' }, [head, grid]);
  }

  function quickIssuesPanel() {
    var box = el('div', { class: 'quick-issues' });
    quick.issues.forEach(function (it) {
      box.appendChild(el('div', { class: 'quick-issue ' + (it.level || 'warn') }, [
        it.line ? el('b', { text: '第 ' + it.line + ' 行：' }) : null,
        el('span', { text: it.msg })
      ]));
    });
    return box;
  }

  function quickApplyWarnings() {
    var box = el('div', { class: 'quick-issues' });
    quick.applyIssues.forEach(function (w) {
      var f = C.furnaceById(batch, w.id);
      box.appendChild(el('div', { class: 'quick-issue warn' }, [
        el('span', { text: (f ? f.label : w.id) + ' 第 ' + (w.group + 1) + ' 组：' + w.msg })
      ]));
    });
    return box;
  }

  function quickApplyAndRatio() {
    openRatioSelect();
  }

  function quickApplyAndExport() {
    openExportSelect();
  }

  function quickPastePanel() {
    var ta = el('textarea', {
      class: 'quick-text', id: 'quickText', rows: 7,
      placeholder: '文丘里压力\n\n3号炉\n1 0.183\n2 0.136\n...'
    });
    ta.value = quick.text || '';
    ta.addEventListener('input', function () { quick.text = ta.value; });

    return el('section', { class: 'quick-paste' }, [
      el('div', { class: 'quick-paste-head' }, [
        el('strong', { text: '粘贴「导出文丘里压力」文本' }),
        el('span', { class: 'hint', text: '空组写 - - 也可以；解析后每组只保留最高表和读数。' })
      ]),
      ta,
      el('div', { class: 'quick-paste-actions' }, [
        el('button', { class: 'btn primary', type: 'button', id: 'btnQuickParse', text: '解析文本', onclick: function () { parseQuick(false); } }),
        el('button', { class: 'btn ghost', type: 'button', text: '载入当前数据', onclick: loadQuickCurrent }),
        el('button', { class: 'btn ghost', type: 'button', text: '清空', onclick: clearQuick })
      ])
    ]);
  }

  function clearFurnaceFromHome(f) {
    clearOneFurnace(f.id, 'visual');
  }

  function furnaceCard(st) {
    var f = st.furnace;
    var pct = st.total ? Math.round((st.handled / st.total) * 100) : 0;
    var sideSeg = el('div', { class: 'seg fc-side' }, [['full', '整台'], ['A', 'A炉膛'], ['B', 'B炉膛']].map(function (pair) {
      return el('button', {
        class: 'seg-btn' + (f.side === pair[0] ? ' active' : ''), type: 'button', text: pair[1],
        onclick: function (e) {
          e.stopPropagation();
          C.setSide(batch, f.id, pair[0]);
          persist();
          renderVisualSelect();
        }
      });
    }));
    var card = el('article', {
      class: 'furnace-card' + (st.complete ? ' done' : '') + (st.handled ? ' started' : ''),
      tabindex: '0',
      role: 'button',
      'aria-label': f.label + ' 进入录入',
      onclick: function (e) {
        if (e.target.closest && e.target.closest('.fc-clear, .fc-side')) return;
        openFurnace(f.id);
      },
      onkeydown: function (e) {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFurnace(f.id); }
      }
    }, [
      el('div', { class: 'fc-top' }, [
        el('strong', { class: 'fc-title', text: f.label }),
        el('span', { class: 'tag', text: f.perGroup === 2 ? '8 组 × 2 块' : '8 组 × 12 块' }),
        f.side !== 'full' ? el('span', { class: 'tag side', text: C.sideLabel(f.side) }) : null,
        st.complete ? el('span', { class: 'tag ok', text: '已完成' }) : null
      ]),
      el('div', { class: 'fc-bar' }, [el('span', { style: 'width:' + pct + '%' })]),
      el('div', { class: 'fc-stats' }, [
        el('span', {}, ['已处理 ', el('b', { text: st.handled + '/' + st.total })]),
        el('span', {}, ['最高 ', el('b', { text: st.max == null ? '—' : C.formatFixed(st.max, batch.config.decimals) })]),
        el('span', { text: '有效 ' + st.valid + (st.excluded ? ' · 剔除 ' + st.excluded : '') + (st.skipped ? ' · 送检 ' + st.skipped : '') })
      ]),
      el('div', { class: 'fc-actions' }, [
        sideSeg,
        el('button', {
          class: 'btn sm ghost danger-text fc-clear', type: 'button', text: '清空',
          title: '清空这台炉子的全部读数',
          onclick: function (e) { e.stopPropagation(); clearFurnaceFromHome(f); }
        }),
        el('span', { class: 'fc-go', text: st.handled ? '继续录入 ›' : '开始录入 ›' })
      ])
    ]);
    return card;
  }

  function openFurnace(id) {
    var f = C.furnaceById(batch, id);
    if (!f) return;
    ui.view = 'furnace';
    ui.furnaceId = id;
    var list = C.groupsInScope(f);
    ui.group = list.length ? list[0] : 0;
    ui.reverse = false;
    ui.paused = true;
    ui.started = false;
    ui.cursor = null;
    render();
    scrollTop();
  }

  function goHome() {
    if (ui.view === 'quickImport' && quick.text.trim() && quick.text !== quick.parsedText) {
      if (confirm('粘贴的文本已修改但还没解析，是否先解析再返回主界面？')) parseQuick(true);
    }
    stopCamera();
    ui.view = 'home';
    ui.furnaceId = null;
    render();
    scrollTop();
  }

  /* ================================================================== *
   * 四、绝压比计算（方式1 → 方式2）
   * ================================================================== */

  function openRatioCalc() {
    stopCamera();
    ui.view = 'convert';
    if (!pickRatio) pickRatio = defaultPick();
    var picked = pickedBatchData(pickRatio);
    if (C.hasBatchData(batch) && picked.ids.length) {
      convText = C.exportMode1(picked.batch, picked.ids);
      conv = C.parseMode1(convText);
      conv.fromCurrent = true;
      syncConvHeaders();
    } else {
      convText = '';
      conv = null;
    }
    render();
    scrollTop();
  }

  function syncConvHeaders() {
    if (!conv) return;
    conv.furnaces.forEach(function (it) {
      var f = C.furnaceById(batch, it.id);
      if (!f) return;
      it.headerA = f.headerA;
      it.headerB = f.headerB;
    });
  }

  function defaultPick() {
    var pick = {};
    C.FURNACE_DEFS.forEach(function (def) {
      var f = C.furnaceById(batch, def.id);
      pick[def.id] = {
        checked: !!(f && C.hasFurnaceData(f)),
        side: f ? f.side : 'full'
      };
    });
    return pick;
  }

  function pickedBatchData(pick) {
    var copy = C.toJSON(batch);
    var ids = [];
    var labels = [];
    C.FURNACE_DEFS.forEach(function (def) {
      var p = pick && pick[def.id];
      if (!p || !p.checked) return;
      ids.push(def.id);
      C.setSide(copy, def.id, p.side);
      labels.push(def.label + ' ' + C.sideLabel(p.side));
    });
    return { batch: copy, ids: ids, label: labels.join('、') };
  }

  function openExportSelect() {
    pickExport = defaultPick();
    ui.view = 'exportSelect';
    render();
    scrollTop();
  }

  function openRatioSelect() {
    pickRatio = defaultPick();
    ui.view = 'ratioSelect';
    render();
    scrollTop();
  }

  function openRatioPaste() {
    pickRatio = null;
    convText = '';
    conv = null;
    ui.view = 'convert';
    render();
    scrollTop();
  }

  function renderPickPage(kind) {
    var isExport = kind === 'export';
    var pick = isExport ? pickExport : pickRatio;
    var host = $('#view');
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h2', { class: 'page-title', text: isExport ? '选择导出炉子' : '选择计算炉子' }),
        el('p', { class: 'page-sub', text: '2/3/4/5 号炉全部列出，不受是否已导入限制；每台可自由选整台 / A炉膛 / B炉膛，下一步再生成。' })
      ]),
      el('div', { class: 'page-actions' }, [
        el('button', { class: 'btn ghost', type: 'button', text: '返回主界面', onclick: goHome })
      ])
    ]));

    var sec = el('section', { class: 'panel' });
    sec.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { class: 'panel-title', text: '炉子和炉膛范围' }),
      el('span', { class: 'panel-note', text: '勾选后才参与下一步；无数据的炉子也可以选单炉膛' })
    ]));
    var body = el('div', { class: 'panel-body' });
    var tools = el('div', { class: 'pick-tools' }, [
      el('button', { class: 'btn ghost small', type: 'button', text: '全选', onclick: function () {
        C.FURNACE_DEFS.forEach(function (def) { pick[def.id].checked = true; });
        renderPickPage(kind);
      } }),
      el('button', { class: 'btn ghost small', type: 'button', text: '全不选', onclick: function () {
        C.FURNACE_DEFS.forEach(function (def) { pick[def.id].checked = false; });
        renderPickPage(kind);
      } })
    ]);
    body.appendChild(tools);

    C.FURNACE_DEFS.forEach(function (def) {
      var p = pick[def.id];
      var f = C.furnaceById(batch, def.id);
      var hasData = !!(f && C.hasFurnaceData(f));
      var scopeGroups = f ? C.groupsInScope(f) : [];
      var doneGroups = f ? scopeGroups.filter(function (g) { return C.groupStat(f, g).max !== null; }).length : 0;
      var cb = el('input', { type: 'checkbox', class: 'pick-check' });
      cb.checked = p.checked;
      cb.addEventListener('change', function () {
        p.checked = cb.checked;
        renderPickPage(kind);
      });
      var seg = el('div', { class: 'seg' }, [['full', '整台'], ['A', 'A炉膛'], ['B', 'B炉膛']].map(function (pair) {
        return el('button', {
          class: 'seg-btn' + (p.side === pair[0] ? ' active' : ''), type: 'button', text: pair[1],
          onclick: function () {
            p.side = pair[0];
            renderPickPage(kind);
          }
        });
      }));
      body.appendChild(el('div', { class: 'pick-row' }, [
        el('label', { class: 'pick-main' }, [
          cb,
          el('strong', { text: def.label }),
          el('span', { class: 'tag' + (hasData ? ' ok' : ''), text: hasData ? '有数据' : '无数据' }),
          el('span', { class: 'pick-progress', text: '已录 ' + doneGroups + '/' + scopeGroups.length + ' 组' })
        ]),
        seg
      ]));
    });
    sec.appendChild(body);

    var selected = C.FURNACE_DEFS.filter(function (def) { return pick[def.id].checked; }).length;
    var next = el('button', {
      class: 'btn primary', type: 'button', id: isExport ? 'btnPickExportNext' : 'btnPickRatioNext',
      text: (isExport ? '下一步：预览导出' : '下一步：计算绝压比') + '（' + selected + ' 台）',
      disabled: selected === 0,
      onclick: function () {
        if (!selected) {
          toast('至少勾选一台炉子', 'warn', 2200);
          return;
        }
        if (isExport) openExportPreviewPage();
        else openRatioCalc();
      }
    });
    host.appendChild(sec);
    var actions = [el('button', { class: 'btn ghost', type: 'button', text: '返回主界面', onclick: goHome })];
    if (!isExport) {
      actions.push(el('button', { class: 'btn ghost', type: 'button', id: 'btnRatioPaste', text: '直接粘贴方式1', onclick: openRatioPaste }));
    }
    actions.push(next);
    host.appendChild(el('div', { class: 'pick-actions' }, actions));
  }

  function openExportPreviewPage() {
    var picked = pickedBatchData(pickExport);
    if (!picked.ids.length) {
      toast('至少勾选一台炉子', 'warn', 2200);
      return;
    }
    exportPageText = C.exportMode1(picked.batch, picked.ids);
    exportPageLabel = picked.label;
    ui.view = 'exportPreview';
    render();
    scrollTop();
  }

  function renderExportPreviewPage() {
    var host = $('#view');
    host.innerHTML = '';
    host.appendChild(el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h2', { class: 'page-title', text: '导出文丘里压力' }),
        el('p', { class: 'page-sub', text: '已选：' + (exportPageLabel || '—') })
      ]),
      el('div', { class: 'page-actions' }, [
        el('button', { class: 'btn ghost', type: 'button', text: '‹ 返回选择', onclick: function () {
          ui.view = 'exportSelect';
          render();
          scrollTop();
        } }),
        el('button', { class: 'btn ghost', type: 'button', text: '返回主界面', onclick: goHome })
      ])
    ]));
    var sec = el('section', { class: 'panel' });
    sec.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { class: 'panel-title', text: '方式1 文本预览' }),
      el('span', { class: 'panel-note', text: '每台炉一个标题，每组一行：最高值表号 最高值' })
    ]));
    var body = el('div', { class: 'panel-body' });
    var pre = el('pre', { class: 'export-preview export-page-preview', id: 'exportPagePreview', tabindex: '-1' });
    pre.textContent = exportPageText;
    body.appendChild(pre);
    body.appendChild(el('div', { class: 'conv-actions' }, [
      el('button', { class: 'btn', type: 'button', id: 'btnCopyExportPage', text: '复制', onclick: copyExportPage }),
      el('button', { class: 'btn primary', type: 'button', id: 'btnDownloadExportPage', text: '下载 .txt', onclick: downloadExportPage })
    ]));
    sec.appendChild(body);
    host.appendChild(sec);
  }

  function copyExportPage() {
    copyText(exportPageText).then(function (ok) {
      toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本', ok ? 'ok' : 'error', 2200);
    });
  }

  function downloadExportPage() {
    var name = '文丘里压力_' + batch.meta.date.replace(/-/g, '') + '.txt';
    downloadText(name, exportPageText);
    toast('已下载 ' + name, 'ok');
  }

  function renderConverter() {
    var host = $('#view');
    host.innerHTML = '';

    host.appendChild(el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h2', { class: 'page-title', text: '绝压比计算' }),
        el('p', { class: 'page-sub', text: '从选择页带入的炉子和炉膛；可在方式1文本里粘贴老记录，也可返回上一步重新选炉子。' })
      ]),
      el('div', { class: 'page-actions' }, [
        el('button', { class: 'btn ghost', type: 'button', text: '‹ 选择炉子', onclick: openRatioSelect }),
        el('button', { class: 'btn', type: 'button', text: '‹ 返回炉子列表', onclick: goHome })
      ])
    ]));

    host.appendChild(convPastePanel());
    if (conv && conv.furnaces.length) {
      host.appendChild(convResultPanel());
      host.appendChild(convOutputPanel());
    }
    updateConvIssues();
    if (conv && conv.furnaces.length) updateConvPreview();
  }

  function convPastePanel() {
    var sec = el('section', { class: 'panel' });
    sec.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { class: 'panel-title', text: '方式1 文本' }),
      el('span', { class: 'panel-note', text: '已自动载入当前读数；也可整段替换成老记录后重新解析' })
    ]));
    var body = el('div', { class: 'panel-body' });
    var ta = el('textarea', {
      class: 'textarea conv-textarea', id: 'convText', rows: '10',
      spellcheck: 'false',
      placeholder: '文丘里压力 ... 整段粘贴到这里'
    });
    ta.value = convText;
    ta.addEventListener('input', function () { convText = ta.value; });
    body.appendChild(ta);
    body.appendChild(el('div', { class: 'conv-actions' }, [
      el('button', { class: 'btn primary', type: 'button', id: 'btnConvParse', text: '解析文本', onclick: parseConv }),
      el('button', { class: 'btn', type: 'button', id: 'btnLoadCurrent', text: '载入当前读数', onclick: loadCurrentConv }),
      el('button', { class: 'btn', type: 'button', id: 'btnCopyConvText', text: '复制方式1', onclick: copyConvText }),
      el('button', {
        class: 'btn ghost', type: 'button', id: 'btnConvClear', text: '清空',
        onclick: function () { convText = ''; conv = null; renderConverter(); }
      })
    ]));
    body.appendChild(el('div', { class: 'conv-issues', id: 'convIssues' }));
    sec.appendChild(body);
    return sec;
  }

  function copyConvText() {
    var ta = $('#convText');
    var text = ta ? ta.value : convText;
    copyText(text).then(function (ok) {
      toast(ok ? '方式1 文本已复制' : '复制失败，请手动选择文本', ok ? 'ok' : 'error', 2200);
    });
  }

  function parseConv(isCurrent) {
    var ta = $('#convText');
    if (ta) convText = ta.value;
    conv = C.parseMode1(convText);
    conv.fromCurrent = !!isCurrent;
    if (conv.fromCurrent) syncConvHeaders();
    renderConverter();
    if (conv.furnaces.length) toast('解析到 ' + conv.furnaces.length + ' 台炉', 'ok', 1800);
    else toast('没有解析到可用炉子，请检查格式', 'error', 3200);
  }

  function loadCurrentConv() {
    if (!C.hasBatchData(batch)) {
      toast('当前还没有录入任何炉子读数', 'warn', 2600);
      return;
    }
    if (!pickRatio) pickRatio = defaultPick();
    var picked = pickedBatchData(pickRatio);
    convText = C.exportMode1(picked.batch, picked.ids);
    var ta = $('#convText');
    if (ta) ta.value = convText;
    parseConv(true);
  }

  function updateConvIssues() {
    var host = $('#convIssues');
    if (!host || !conv) return;
    host.innerHTML = '';
    var errors = conv.issues.filter(function (x) { return x.level === 'error'; });
    var warns = conv.issues.filter(function (x) { return x.level === 'warn'; });
    if (conv.furnaces.length && !errors.length && !warns.length) {
      var groups = 0;
      conv.furnaces.forEach(function (it) { groups += it.groups.length; });
      host.appendChild(el('div', { class: 'conv-msg ok', text: '解析成功：' + conv.furnaces.length + ' 台炉，共 ' + groups + ' 组' }));
      return;
    }
    conv.issues.forEach(function (issue) {
      host.appendChild(el('div', { class: 'conv-msg ' + (issue.level === 'error' ? 'error' : 'warn') }, [
        (issue.line ? '第 ' + issue.line + ' 行：' : '') + issue.msg
      ]));
    });
  }

  function convResultPanel() {
    var sec = el('section', { class: 'panel' });
    sec.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { class: 'panel-title', text: '解析结果' }),
      el('span', { class: 'panel-note', text: '填集合管压力后，下方实时生成方式2' })
    ]));
    var body = el('div', { class: 'panel-body conv-furnaces', id: 'convFurnaces' });
    conv.furnaces.forEach(function (it) { body.appendChild(convFurnaceCard(it)); });
    sec.appendChild(body);
    return sec;
  }

  function convFurnaceCard(it) {
    var head = el('div', { class: 'cf-head' }, [
      el('strong', { class: 'cf-title', text: it.label }),
      el('span', { class: 'tag', text: C.sideLabel(it.side) }),
      el('span', { class: 'tag', text: it.groups.length + ' 组' }),
      it.ambiguous ? convSideSeg(it) : null
    ]);

    var groups = el('div', { class: 'cf-groups' });
    it.groups.forEach(function (g) {
      groups.appendChild(el('span', { class: 'cf-group' }, [
        el('i', { text: C.CIRCLED[g.index] }),
        el('b', { text: g.value == null ? '—' : C.formatFixed(g.value, 3) }),
        g.gauge ? el('em', { text: g.gauge + '#' }) : null
      ]));
    });

    var headers = el('div', { class: 'cf-headers' });
    ['A', 'B'].forEach(function (ch) {
      if (it.side !== 'full' && it.side !== ch) return;
      var input = el('input', {
        class: 'ratio-input', type: 'text', inputmode: 'decimal',
        placeholder: '如 0.230', value: headerText(it, ch),
        'aria-label': it.label + ' ' + ch + ' 集合管压力'
      });
      input.addEventListener('input', function () {
        var p = C.parseValue(input.value);
        var v = p.ok && !p.empty ? C.roundTo(p.value, batch.config.decimals) : null;
        if (ch === 'A') it.headerA = v;
        else it.headerB = v;
        if (conv.fromCurrent) {
          C.setHeader(batch, it.id, ch, v);
          persist();
        }
        refreshConvRatio(it);
        updateConvPreview();
      });
      input.addEventListener('blur', function () { input.value = headerText(it, ch); });
      headers.appendChild(el('label', { class: 'cf-header' }, [
        el('span', { text: ch + ' 集合管压力' }),
        input
      ]));
    });

    return el('div', { class: 'conv-furnace', dataset: { id: it.id } }, [
      head,
      groups,
      headers,
      el('div', { class: 'cf-ratio', dataset: { ratioFor: it.id }, text: convItemRatioText(it) })
    ]);
  }

  function convSideSeg(it) {
    var wrap = el('div', { class: 'seg seg-sm', role: 'group', 'aria-label': '这 4 行属于哪个炉膛' });
    ['A', 'B'].forEach(function (ch) {
      wrap.appendChild(el('button', {
        class: 'seg-btn' + (it.side === ch ? ' active' : ''),
        type: 'button',
        text: ch + '炉膛',
        onclick: function () {
          if (C.converterSetSide(it, ch)) {
            renderConverter();
            toast('已按 ' + ch + ' 炉膛重新对应', 'ok', 1500);
          }
        }
      }));
    });
    return wrap;
  }

  function headerText(it, ch) {
    var v = ch === 'A' ? it.headerA : it.headerB;
    return v == null ? '' : C.formatFixed(v, batch.config.decimals);
  }

  function convItemRatioText(it) {
    var b = C.converterToBatch([it]);
    var f = C.furnaceById(b, it.id);
    var parts = [];
    ['A', 'B'].forEach(function (ch) {
      var r = C.ratioOf(f, ch);
      if (!r.inScope) return;
      parts.push(ch + ' ' + (r.ratio == null ? '—' : C.formatRatio(r.ratio)));
    });
    var best = C.bestRatioOf(f);
    if (best) parts.push('最大 ' + C.formatRatio(best.ratio) + '（' + C.CIRCLED[best.maxGroup] + '）');
    return parts.join(' · ');
  }

  function refreshConvRatio(it) {
    var el2 = $('[data-ratio-for="' + it.id + '"]');
    if (el2) el2.textContent = convItemRatioText(it);
  }

  function convOutputPanel() {
    var sec = el('section', { class: 'panel' });
    sec.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { class: 'panel-title', text: '方式2 预览' }),
      el('span', { class: 'panel-note', text: '可直接复制或下载' })
    ]));
    var body = el('div', { class: 'panel-body' });
    body.appendChild(el('pre', { class: 'export-preview', id: 'convPreview', text: '' }));
    body.appendChild(el('p', { class: 'hint', id: 'convMissing', text: '' }));
    body.appendChild(el('div', { class: 'conv-actions' }, [
      el('button', {
        class: 'btn', type: 'button', id: 'btnConvCopy', text: '复制',
        onclick: function () {
          copyText($('#convPreview').textContent).then(function (ok) {
            toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本', ok ? 'ok' : 'error', 2200);
          });
        }
      }),
      el('button', {
        class: 'btn primary', type: 'button', id: 'btnConvDownload', text: '下载 .txt',
        onclick: function () {
          var name = '文丘里压力_方式2_转换_' + C.todayStr().replace(/-/g, '') + '.txt';
          downloadText(name, $('#convPreview').textContent);
          toast('已下载 ' + name, 'ok');
        }
      })
    ]));
    sec.appendChild(body);
    return sec;
  }

  function updateConvPreview() {
    if (!conv || !conv.furnaces.length) return;
    var pre = $('#convPreview');
    if (!pre) return;
    pre.textContent = C.exportMode2(C.converterToBatch(conv.furnaces));
    var missing = [];
    conv.furnaces.forEach(function (it) {
      var chs = it.side === 'full' ? ['A', 'B'] : [it.side];
      chs.forEach(function (ch) {
        var h = ch === 'A' ? it.headerA : it.headerB;
        if (h == null) missing.push(it.label + ' ' + ch);
      });
    });
    var note = $('#convMissing');
    if (note) {
      note.textContent = missing.length
        ? '未填集合管压力：' + missing.join('、') + '（这些炉膛的绝压比显示为 —）'
        : '';
    }
  }

  /* ================================================================== *
   * 四、单炉页面
   * ================================================================== */

  function renderFurnace() {
    var f = currentFurnace();
    if (!f) { goHome(); return; }
    document.body.classList.add('furnace-mode');
    if (!C.isGroupInScope(f, ui.group)) {
      var list = C.groupsInScope(f);
      ui.group = list.length ? list[0] : 0;
    }
    var host = $('#view');
    host.innerHTML = '';

    host.appendChild(furnaceHeader(f));
    host.appendChild(cameraPanel(f));
    host.appendChild(controlPanel(f));
    host.appendChild(groupSection(f));
    host.appendChild(el('div', { class: 'furnace-foot-tools' }, [
      el('button', {
        class: 'btn sm ghost', type: 'button', id: 'btnReverse',
        text: '方向：' + (ui.reverse ? '倒序' : '正序'),
        onclick: toggleDirection
      })
    ]));
    host.appendChild(stepper(f));
    host.appendChild(summaryPanel(f));

    refreshCurrentGroup(f);
    ensureCamera();
  }

  function furnaceHeader(f) {
    return el('div', { class: 'furnace-head compact' }, [
      el('div', { class: 'fh-line1' }, [
        el('h2', { class: 'fh-name', text: f.label }),
        sideSeg(f)
      ]),
      el('div', { class: 'fh-line2' }, [
        el('button', {
          class: 'btn back', type: 'button', text: '‹ 返回炉子列表',
          title: '返回视觉录入的炉子列表；手机可从页面中间向右划',
          onclick: openVisual
        }),
        el('span', { class: 'swipe-hint', text: '手机右划也可返回' })
      ])
    ]);
  }

  function cameraPanel(f) {
    var target = targetIndex(f, ui.group);
    var targetLabel = target < 0 ? '本组已处理完' : '第 ' + (ui.group + 1) + ' 组 · 第 ' + (target + 1) + ' 块';
    return el('section', { class: 'camera-panel', id: 'cameraPanel' }, [
      el('video', { id: 'cameraFeed', autoplay: 'autoplay', playsinline: 'playsinline', muted: 'muted' }),
      el('div', { class: 'camera-placeholder', id: 'cameraPlaceholder' }, [
        el('span', { class: 'cam-icon', text: '◎' }),
        el('strong', { text: '相机实时画面' }),
        el('span', { id: 'cameraMsg', text: '需要摄像头权限；手机需 https:// 网址' }),
        el('button', { class: 'btn sm', type: 'button', text: '打开相机', onclick: function () { ensureCamera(true); } })
      ]),
      el('div', { class: 'camera-overlay' }, [
        el('span', { class: 'cam-target', id: 'camTarget', text: targetLabel }),
        el('span', { class: 'cam-state', id: 'camState', text: ui.paused ? (ui.started ? '已暂停' : '未开始') : '识别中' })
      ]),
      el('div', { class: 'scan-frame' })
    ]);
  }

  function ensureCamera(force) {
    var video = $('#cameraFeed');
    if (cameraStream) {
      if (video) {
        video.srcObject = cameraStream;
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      }
      var ph0 = $('#cameraPlaceholder');
      if (ph0) ph0.classList.add('hidden');
      return;
    }
    if (cameraTried && !force) return;
    cameraTried = true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setCameraError('当前浏览器不支持相机');
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(function (stream) {
        cameraStream = stream;
        var v = $('#cameraFeed');
        if (v) {
          v.srcObject = stream;
          var play = v.play();
          if (play && play.catch) play.catch(function () {});
        }
        var ph = $('#cameraPlaceholder');
        if (ph) ph.classList.add('hidden');
        var s = $('#camState');
        if (s) s.textContent = ui.paused ? (ui.started ? '已暂停' : '未开始') : '识别中';
      })
      .catch(function (err) {
        setCameraError('无法打开相机：' + (err && (err.message || err.name) ? (err.message || err.name) : '权限被拒绝'));
      });
  }

  function setCameraError(msg) {
    var ph = $('#cameraPlaceholder');
    if (ph) ph.classList.remove('hidden');
    var m = $('#cameraMsg');
    if (m) m.textContent = msg;
    var s = $('#camState');
    if (s) s.textContent = '相机不可用';
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* ignore */ } });
      cameraStream = null;
    }
    var v = $('#cameraFeed');
    if (v) v.srcObject = null;
    var ph = $('#cameraPlaceholder');
    if (ph) ph.classList.remove('hidden');
    cameraTried = false;
  }

  function controlPanel(f) {
    var g = ui.group;
    var nextG = nextGroupInDirection(f, g);
    var prevG = prevGroupInDirection(f, g);
    return el('div', { class: 'control-panel' }, [
      el('div', { class: 'nav-big' }, [
        el('button', {
          class: 'btn nav-side', type: 'button', text: '‹ 上一组',
          disabled: prevG < 0, onclick: prevGroup
        }),
        el('button', {
          class: 'btn primary btn-recognize', type: 'button', id: 'btnRecognize',
          text: ui.paused ? '开始识别' : '暂停识别',
          onclick: togglePause
        }),
        el('button', {
          class: 'btn nav-side', type: 'button',
          text: nextG < 0 ? '完成本炉' : '下一组 ›',
          onclick: nextGroup
        })
      ]),
      el('div', { class: 'action-row' }, [
        el('button', { class: 'btn', type: 'button', id: 'btnSkip', text: '跳过（送检）', onclick: skipCurrent }),
        el('button', { class: 'btn danger-text', type: 'button', id: 'btnExclude', text: '剔除本块', onclick: excludeCurrent })
      ])
    ]);
  }

  function sideSeg(f) {
    var wrap = el('div', { class: 'seg', role: 'group', 'aria-label': '测量范围' });
    [['full', '整台'], ['A', 'A炉膛'], ['B', 'B炉膛']].forEach(function (pair) {
      wrap.appendChild(el('button', {
        class: 'seg-btn' + (f.side === pair[0] ? ' active' : ''),
        type: 'button',
        text: pair[1],
        onclick: function () { changeSide(pair[0]); }
      }));
    });
    return wrap;
  }

  function groupsForSide(f, side) {
    var out = [];
    for (var g = 0; g < f.groups; g++) {
      if (side === 'full' || (side === 'A' && g < 4) || (side === 'B' && g >= 4)) out.push(g);
    }
    return out;
  }

  function changeSide(side) {
    var f = currentFurnace();
    if (!f || f.side === side) return;
    var newGroups = groupsForSide(f, side);
    var hidden = 0;
    for (var g = 0; g < f.groups; g++) {
      if (newGroups.indexOf(g) >= 0) continue;
      f.cells[g].forEach(function (c) { if (c.v != null) hidden++; });
    }
    if (hidden > 0 && !confirm('切到「' + C.sideLabel(side) + '」后，另半个炉膛的 ' + hidden +
      ' 个读数不参与统计和导出（数据仍保留在本机）。继续？')) return;
    C.setSide(batch, f.id, side);
    ui.group = C.groupsInScope(f)[0];
    ui.cursor = null;
    persist();
    renderFurnace();
    toast('已切换到 ' + C.sideLabel(side), 'ok', 1600);
  }

  function stepper(f) {
    var wrap = el('div', { class: 'stepper' });
    ['A', 'B'].forEach(function (ch) {
      var groups = C.groupsInScope(f).filter(function (g) { return C.chamberOf(g) === ch; });
      if (!groups.length) return;
      var band = el('div', { class: 'band' }, [
        el('span', { class: 'band-label', text: ch + '炉膛' }),
        el('div', { class: 'band-groups' })
      ]);
      var host = $('.band-groups', band);
      groups.forEach(function (g) {
        var s = C.groupStat(f, g);
        host.appendChild(el('button', {
          class: 'group-chip' + (g === ui.group ? ' active' : '') + (s.filled === s.count ? ' full' : ''),
          type: 'button',
          dataset: { g: g },
          title: '第 ' + (g + 1) + ' 组',
          onclick: function () { selectGroup(g); }
        }, [
          el('span', { class: 'gc-num', text: C.CIRCLED[g] }),
          el('span', { class: 'gc-max', text: s.max == null ? '—' : C.formatFixed(s.max, 3) })
        ]));
      });
      wrap.appendChild(band);
    });
    return wrap;
  }

  function groupChips(f, g) {
    var s = C.groupStat(f, g);
    var list = [];
    list.push(chip('已处理 ' + s.handled + '/' + s.count, s.complete ? 'ok' : (s.handled ? '' : 'muted')));
    list.push(chip('有效 ' + s.valid, s.valid ? '' : 'muted'));
    if (s.excluded) list.push(chip('剔除 ' + s.excluded, 'warn'));
    if (s.skipped) list.push(chip('送检 ' + s.skipped, 'warn'));
    list.push(chip('最高 ' + (s.max == null ? '—' : C.formatFixed(s.max, 3) + ' · ' + (s.maxIndex + 1) + '#'),
      s.max == null ? 'muted' : 'max'));
    return list;
  }

  function chip(text, kind) {
    return el('span', { class: 'chip' + (kind ? ' ' + kind : ''), text: text });
  }

  function scanEmpty(f, g, start, reverse) {
    var row = f.cells[g] || [];
    for (var i = start; reverse ? i >= 0 : i < row.length; i += reverse ? -1 : 1) {
      if (row[i] && row[i].v == null && !row[i].skip) return i;
    }
    return -1;
  }

  function targetIndex(f, g) {
    if (ui.cursor && ui.cursor.group === g) {
      var c = f.cells[g] && f.cells[g][ui.cursor.index];
      // 指定起点即使已有旧读数也返回该格，便于换表后重读覆盖
      if (c && !c.skip) return ui.cursor.index;
      return scanEmpty(f, g, ui.cursor.index + (ui.reverse ? -1 : 1), ui.reverse);
    }
    return C.nextEmptyIndex(f, g, ui.reverse);
  }

  function nextGroupInDirection(f, g) {
    return ui.reverse ? C.prevInScopeGroup(f, g) : C.nextInScopeGroup(f, g);
  }

  function prevGroupInDirection(f, g) {
    return ui.reverse ? C.nextInScopeGroup(f, g) : C.prevInScopeGroup(f, g);
  }

  function targetText(f, g) {
    var dir = ui.reverse ? ' · 倒序' : '';
    if (ui.paused) {
      var head = ui.started ? '识别已暂停' : '识别未开始';
      if (ui.cursor) return head + '：起点为第 ' + (ui.cursor.index + 1) + ' 块；点「开始识别」从这里开始' + dir;
      return head + '：点下面任意一块表选起点，再点「开始识别」' + dir;
    }
    var i = targetIndex(f, g);
    if (i < 0) return '本组已处理完，点「下一组」继续' + dir;
    return '待录入：第 ' + (i + 1) + ' 块' + dir + (ui.cursor ? '（指定起点）' : '') + '（识别到读数会自动填入）';
  }

  function groupSection(f) {
    var g = ui.group;
    var sec = el('section', { class: 'group-card' });

    sec.appendChild(el('div', { class: 'group-head' }, [
      el('div', { class: 'gh-title' }, [
        el('span', { class: 'circled', text: C.CIRCLED[g] }),
        el('h3', { text: '第 ' + (g + 1) + ' 组' }),
        el('span', { class: 'tag', text: C.chamberOf(g) + '炉膛' })
      ]),
      el('div', { class: 'gh-chips', id: 'groupChips' }, groupChips(f, g)),
      el('div', { class: 'gh-actions' }, [
        el('button', { class: 'btn sm', type: 'button', text: '识别填入', onclick: openFill }),
        el('button', { class: 'btn sm ghost', type: 'button', text: '清空本组', onclick: clearGroupConfirm })
      ])
    ]));

    sec.appendChild(el('div', { class: 'target-line', id: 'targetLine', text: targetText(f, g) }));

    var grid = el('div', { class: 'cell-grid' + (f.perGroup <= 2 ? ' cols-2' : '') });
    for (var i = 0; i < f.perGroup; i++) grid.appendChild(cellView(f, g, i));
    sec.appendChild(grid);

    return sec;
  }

  function cellView(f, g, i) {
    var c = f.cells[g][i];
    var input = el('input', {
      class: 'cell-input', type: 'text', inputmode: 'decimal', autocomplete: 'off',
      spellcheck: 'false', placeholder: '—',
      value: c.v == null ? '' : C.formatFixed(c.v, batch.config.decimals),
      'aria-label': f.label + ' 第' + (g + 1) + '组 第' + (i + 1) + '块读数'
    });
    var exBtn = el('button', {
      class: 'cell-ex', type: 'button', tabindex: '-1',
      title: '剔除 / 恢复该读数', text: '剔'
    });
    var skipBtn = el('button', {
      class: 'cell-skip', type: 'button', tabindex: '-1',
      title: '送检 / 恢复该表', text: '送'
    });
    var actions = el('div', { class: 'cell-actions' }, [
      el('span', { class: 'cell-idx', text: (i + 1) + '#' }),
      exBtn,
      skipBtn
    ]);
    var box = el('div', { class: 'cell', dataset: { i: i } }, [input, actions]);

    input.addEventListener('input', function () { onCellInput(g, i, input); });
    input.addEventListener('blur', function () { flushCell(g, i, input, false); });
    input.addEventListener('keydown', onCellKeydown);
    exBtn.addEventListener('click', function () { toggleExclude(g, i); });
    skipBtn.addEventListener('click', function () { toggleSkip(g, i); });
    box.addEventListener('click', function (e) {
      if (e.target.closest && (e.target.closest('.cell-ex') || e.target.closest('.cell-skip'))) return;
      selectStartCell(g, i);
    });

    patchCell(f, g, i);
    return box;
  }

  function summaryPanel(f) {
    var sec = el('section', { class: 'panel summary-panel' });
    sec.appendChild(el('div', { class: 'panel-head' }, [
      el('h2', { class: 'panel-title', text: '本炉分组汇总' }),
      el('span', { class: 'panel-note', text: '剔除和送检的表都不参与最高值' })
    ]));
    var table = el('table', { class: 'data-table summary-table' });
    var thead = el('thead');
    var tr = el('tr');
    ['组', '炉膛', '最高值', '表号', '有效', '剔除', '送检'].forEach(function (h, idx) {
      tr.appendChild(el('th', { text: h, class: idx >= 2 ? 'num' : '' }));
    });
    thead.appendChild(tr);
    table.appendChild(thead);
    var tbody = el('tbody');
    C.groupsInScope(f).forEach(function (g) {
      var s = C.groupStat(f, g);
      var row = el('tr', { dataset: { g: g } });
      row.appendChild(el('td', { text: C.CIRCLED[g] + ' 第' + (g + 1) + '组' }));
      row.appendChild(el('td', { text: C.chamberOf(g) + '炉膛' }));
      row.appendChild(el('td', { class: 'num strong', 'data-field': 'max', text: s.max == null ? '—' : C.formatFixed(s.max, 3) }));
      row.appendChild(el('td', { class: 'num', 'data-field': 'gauge', text: s.maxIndex >= 0 ? (s.maxIndex + 1) + '#' : '—' }));
      row.appendChild(el('td', { class: 'num', 'data-field': 'valid', text: String(s.valid) }));
      row.appendChild(el('td', { class: 'num' + (s.excluded ? ' warn-text' : ''), 'data-field': 'excluded', text: String(s.excluded) }));
      row.appendChild(el('td', { class: 'num' + (s.skipped ? ' warn-text' : ''), 'data-field': 'skipped', text: String(s.skipped) }));
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    sec.appendChild(el('div', { class: 'table-wrap' }, [table]));
    return sec;
  }

  /* ================================================================== *
   * 五、单元格交互
   * ================================================================== */

  function onCellInput(g, i, input) {
    var f = currentFurnace();
    if (f.cells[g][i].skip) return;
    var r = C.parseValue(input.value);
    if (r.empty) {
      f.cells[g][i].v = null;
      f.cells[g][i].skip = false;
      input.classList.remove('invalid');
      afterEdit(f, g, i);
    } else if (r.ok) {
      f.cells[g][i].v = C.roundTo(r.value, batch.config.decimals);
      f.cells[g][i].skip = false;
      input.classList.remove('invalid');
      afterEdit(f, g, i);
    } else {
      input.classList.add('invalid');
    }
  }

  /** 把输入框内容写回数据；格式无效时还原，返回是否有效 */
  function flushCell(g, i, input, warn) {
    var f = currentFurnace();
    var cell = f.cells[g][i];
    if (cell.skip) {
      input.value = '';
      input.classList.remove('invalid');
      return true;
    }
    var r = C.parseValue(input.value);
    var ok = true;
    if (r.empty) {
      cell.v = null;
      cell.skip = false;
      input.value = '';
      input.classList.remove('invalid');
    } else if (r.ok) {
      cell.v = C.roundTo(r.value, batch.config.decimals);
      cell.skip = false;
      input.value = C.formatFixed(cell.v, batch.config.decimals);
      input.classList.remove('invalid');
    } else {
      ok = false;
      input.value = cell.v == null ? '' : C.formatFixed(cell.v, batch.config.decimals);
      input.classList.add('invalid');
      setTimeout(function () { input.classList.remove('invalid'); }, 1200);
      if (warn) toast('读数格式无法识别，已还原', 'error');
    }
    afterEdit(f, g, i);
    return ok;
  }

  function toggleExclude(g, i) {
    var f = currentFurnace();
    var cell = f.cells[g][i];
    if (cell.skip) C.setSkipped(batch, f.id, g, i, false);
    C.setExcluded(batch, f.id, g, i, !cell.ex);
    ui.cursor = null;
    afterEdit(f, g, i);
    toast((cell.ex ? '已剔除 ' : '已恢复 ') + '第' + (i + 1) + '块', cell.ex ? 'warn' : 'ok', 1400);
  }

  function toggleSkip(g, i) {
    var f = currentFurnace();
    var cell = f.cells[g][i];
    if (!cell.skip && cell.v != null && !confirm('第 ' + (i + 1) + ' 块已有读数，标记送检会清空该读数，是否继续？')) return;
    C.setSkipped(batch, f.id, g, i, !cell.skip);
    ui.cursor = null;
    afterEdit(f, g, i);
    toast(cell.skip ? '第' + (i + 1) + '块标记送检，已跳过' : '第' + (i + 1) + '块已恢复', cell.skip ? 'warn' : 'ok', 1600);
  }

  function selectStartCell(g, i) {
    var f = currentFurnace();
    if (!f) return;
    var cell = f.cells[g][i];
    if (cell.skip) {
      toast('该块已送检，不能作为起点', 'warn', 1800);
      return;
    }
    ui.cursor = { group: g, index: i };
    if (!ui.paused) ui.paused = true;
    $$('.cell').forEach(function (node) { node.classList.remove('is-start'); });
    var node = $('.cell[data-i="' + i + '"]');
    if (node) node.classList.add('is-start');
    var btn = $('#btnRecognize');
    if (btn) btn.textContent = ui.paused ? '开始识别' : '暂停识别';
    updateTarget(f, g);
  }

  function onCellKeydown(e) {
    var input = e.target;
    var cell = input.closest('.cell');
    if (!cell) return;
    var i = parseInt(cell.dataset.i, 10);
    var g = ui.group;
    var fnow = currentFurnace();
    if (fnow && fnow.cells[g][i].skip) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      if (!flushCell(g, i, input, true)) return;
      var next = $('.cell[data-i="' + (i + 1) + '"] .cell-input');
      if (next) focusInput(next);
      else toast('本组最后一格，点「下一组」继续', 'warn', 1600);
      return;
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      flushCell(g, i, input, false);
      var target = spatialNeighbor(input, e.key);
      if (target) focusInput(target);
      return;
    }

    if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      toggleExclude(g, i);
      return;
    }

    if (e.key === 'Escape') input.blur();
  }

  function spatialNeighbor(cur, key) {
    var inputs = $$('.cell-input');
    var cr = cur.getBoundingClientRect();
    var cx = cr.left + cr.width / 2;
    var cy = cr.top + cr.height / 2;
    var best = null;
    var bestScore = Infinity;
    inputs.forEach(function (node) {
      if (node === cur) return;
      var r = node.getBoundingClientRect();
      var dx = (r.left + r.width / 2) - cx;
      var dy = (r.top + r.height / 2) - cy;
      if (key === 'ArrowDown' && dy < 8) return;
      if (key === 'ArrowUp' && dy > -8) return;
      if (key === 'ArrowRight' && dx < 8) return;
      if (key === 'ArrowLeft' && dx > -8) return;
      var vertical = key === 'ArrowDown' || key === 'ArrowUp';
      var primary = vertical ? Math.abs(dy) : Math.abs(dx);
      var secondary = vertical ? Math.abs(dx) : Math.abs(dy);
      var score = primary * 4 + secondary;
      if (score < bestScore) { bestScore = score; best = node; }
    });
    return best;
  }

  function focusInput(input) {
    if (!input) return;
    input.focus();
    try { input.select(); } catch (e) { /* ignore */ }
    if (input.scrollIntoView) input.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /* ================================================================== *
   * 六、局部刷新
   * ================================================================== */

  function patchCell(f, g, i) {
    var cell = $('.cell[data-i="' + i + '"]');
    if (!cell) return;
    var c = f.cells[g][i];
    var input = $('.cell-input', cell);
    input.readOnly = !!c.skip;
    input.placeholder = c.skip ? '送检' : '—';
    if (c.skip) {
      input.value = '';
    } else if (document.activeElement !== input) {
      input.value = c.v == null ? '' : C.formatFixed(c.v, batch.config.decimals);
    }
    cell.classList.toggle('is-excluded', c.ex);
    cell.classList.toggle('is-skipped', !!c.skip);
    cell.classList.toggle('is-start', !!(ui.cursor && ui.cursor.group === g && ui.cursor.index === i));
    cell.classList.toggle('is-over', !c.skip && c.v != null && c.v > batch.config.max);
    var ex = $('.cell-ex', cell);
    if (ex) ex.classList.toggle('active', c.ex);
    var sk = $('.cell-skip', cell);
    if (sk) sk.classList.toggle('active', !!c.skip);
  }

  function updateMaxHighlight(f, g) {
    $$('.cell').forEach(function (c) { c.classList.remove('is-max'); });
    var s = C.groupStat(f, g);
    if (s.max == null) return;
    var cell = $('.cell[data-i="' + s.maxIndex + '"]');
    if (cell) cell.classList.add('is-max');
  }

  function updateGroupStats(f, g) {
    var host = $('#groupChips');
    if (!host) return;
    host.innerHTML = '';
    groupChips(f, g).forEach(function (c) { host.appendChild(c); });
  }

  function updateTarget(f, g) {
    var line = $('#targetLine');
    if (line) line.textContent = targetText(f, g);
    var ct = $('#camTarget');
    if (ct) {
      var ci = targetIndex(f, g);
      ct.textContent = ci < 0 ? '本组已处理完' : '第 ' + (g + 1) + ' 组 · 第 ' + (ci + 1) + ' 块';
    }
    var cs = $('#camState');
    if (cs) cs.textContent = ui.paused ? (ui.started ? '已暂停' : '未开始') : '识别中';
  }

  function updateStepperChip(f, g) {
    var chip = $('.group-chip[data-g="' + g + '"]');
    if (!chip) return;
    var s = C.groupStat(f, g);
    var max = $('.gc-max', chip);
    if (max) max.textContent = s.max == null ? '—' : C.formatFixed(s.max, 3);
    chip.classList.toggle('full', s.complete);
  }

  function updateSummaryRow(f, g) {
    var tr = $('.summary-table tr[data-g="' + g + '"]');
    if (!tr) return;
    var s = C.groupStat(f, g);
    setField(tr, 'max', s.max == null ? '—' : C.formatFixed(s.max, batch.config.decimals));
    setField(tr, 'gauge', s.maxIndex >= 0 ? (s.maxIndex + 1) + '#' : '—');
    setField(tr, 'valid', String(s.valid));
    setField(tr, 'excluded', String(s.excluded));
    setField(tr, 'skipped', String(s.skipped));
  }

  function setField(tr, name, text) {
    var td = $('[data-field="' + name + '"]', tr);
    if (td) td.textContent = text;
  }

  function afterEdit(f, g, i) {
    patchCell(f, g, i);
    updateMaxHighlight(f, g);
    updateGroupStats(f, g);
    updateTarget(f, g);
    updateStepperChip(f, g);
    updateSummaryRow(f, g);
    persist();
  }

  function refreshCurrentGroup(f) {
    var g = ui.group;
    for (var i = 0; i < f.perGroup; i++) patchCell(f, g, i);
    updateMaxHighlight(f, g);
    updateGroupStats(f, g);
    updateTarget(f, g);
    updateStepperChip(f, g);
    updateSummaryRow(f, g);
  }

  /* ================================================================== *
   * 七、组 / 炉切换
   * ================================================================== */

  function selectGroup(g) {
    var f = currentFurnace();
    if (!f || !C.isGroupInScope(f, g)) return;
    ui.group = g;
    ui.cursor = null;
    renderFurnace();
    scrollTop();
  }

  function prevGroup() {
    var f = currentFurnace();
    var g = prevGroupInDirection(f, ui.group);
    if (g >= 0) selectGroup(g);
  }

  function nextGroup() {
    var f = currentFurnace();
    var g = nextGroupInDirection(f, ui.group);
    if (g >= 0) { selectGroup(g); return; }
    var st = C.furnaceStat(f);
    if (!st.complete && !confirm('本炉还有 ' + (st.total - st.handled) + ' 块未录，仍返回炉子列表？')) return;
    goHome();
    toast(st.complete ? f.label + ' 已全部处理完' : '已返回炉子列表', st.complete ? 'ok' : '', 1800);
  }

  function clearGroupConfirm() {
    var f = currentFurnace();
    var s = C.groupStat(f, ui.group);
    if ((s.filled || s.skipped) && !confirm('清空第 ' + (ui.group + 1) + ' 组的全部读数/送检标记？')) return;
    C.clearGroup(batch, f.id, ui.group);
    renderFurnace();
    persist();
    toast('已清空第 ' + (ui.group + 1) + ' 组', 'ok', 1500);
  }

  function clearFurnaceConfirm() {
    var f = currentFurnace();
    if (!confirm('清空 ' + f.label + ' 的全部读数与集合管压力？')) return;
    C.clearFurnace(batch, f.id);
    persist();
    renderFurnace();
    toast('已清空 ' + f.label, 'ok', 1500);
  }

  /* ================================================================== *
   * 八、识别 / 顺序填入
   * ================================================================== */

  function openFill() {
    var f = currentFurnace();
    if (!f) return;
    $('#fillTitle').textContent = '识别填入 · ' + f.label + ' 第 ' + (ui.group + 1) + ' 组';
    $('#fillText').value = '';
    $('#fillAdvance').checked = true;
    $('#dlgFill').showModal();
    setTimeout(function () { $('#fillText').focus(); }, 40);
  }

  function doFill() {
    var values = C.parseReadings($('#fillText').value);
    if (!values.length) { toast('没有解析到读数', 'error'); return; }
    var filled = pushReadings(values, { advance: $('#fillAdvance').checked, manual: true });
    $('#dlgFill').close();
    if (!filled) toast('本组已录满，未填入', 'warn');
    else toast('已填入 ' + filled + ' 个读数', 'ok');
  }

  function toggleDirection() {
    var f = currentFurnace();
    if (!f) return;
    ui.reverse = !ui.reverse;
    var list = C.groupsInScope(f);
    ui.group = ui.reverse ? list[list.length - 1] : list[0];
    ui.cursor = null;
    renderFurnace();
    toast('已切换为' + (ui.reverse ? '倒序' : '正序') + '读取', 'ok', 1600);
  }

  function togglePause() {
    var f = currentFurnace();
    if (!f) return;
    ui.paused = !ui.paused;
    if (!ui.paused) {
      ui.started = true;
      ensureCamera();
    }
    renderFurnace();
    toast(ui.paused ? '识别已暂停' : '识别已开始', ui.paused ? 'warn' : 'ok', 1600);
  }

  function skipCurrent() {
    var f = currentFurnace();
    if (!f) return;
    var g = ui.group;
    var i = targetIndex(f, g);
    if (i < 0) {
      toast('本组已处理完；先切到要跳过的那组，再点跳过', 'warn', 2400);
      return;
    }
    C.setSkipped(batch, f.id, g, i, true);
    ui.cursor = null;
    persist();
    renderFurnace();
    toast('第 ' + (g + 1) + ' 组第 ' + (i + 1) + ' 块已标记送检', 'warn', 1800);
  }

  function excludeCurrent() {
    var f = currentFurnace();
    if (!f) return;
    var g = ui.group;
    var i = targetIndex(f, g);
    if (i < 0) {
      toast('本组已处理完；先切到要剔除的那组', 'warn', 2200);
      return;
    }
    if (f.cells[g][i].v == null) {
      toast('该块还没有读数；要跳过请用「跳过（送检）」', 'warn', 2400);
      return;
    }
    toggleExclude(g, i);
  }

  /**
   * 顺序填入：从当前组第一个空位开始，填满后按需进入下一组。
   * 摄像头识别模块每识别到一个读数调用一次即可。
   */
  function pushReadings(values, opts) {
    var f = currentFurnace();
    if (!f || (ui.paused && !(opts && opts.manual))) return 0;
    var advance = !opts || opts.advance !== false;
    var filled = 0;
    var switched = false;

    for (var k = 0; k < values.length; k++) {
      var v = values[k];
      if (v == null || !isFinite(v)) continue;
      var g = ui.group;
      var i = targetIndex(f, g);
      if (i < 0) {
        if (!advance) break;
        var ng = nextGroupInDirection(f, g);
        if (ng < 0) break;
        g = ng;
        ui.group = ng;
        ui.cursor = null;
        switched = true;
        i = targetIndex(f, ng);
        if (i < 0) break;
      }
      C.setValue(batch, f.id, g, i, v);
      ui.cursor = null;
      filled++;
    }

    if (filled) {
      persist();
      if (switched) renderFurnace();
      else refreshCurrentGroup(f);
    }
    return filled;
  }

  function pushReading(value) {
    var f = currentFurnace();
    if (!f || ui.paused) return null;
    var g0 = ui.group;
    var i0 = targetIndex(f, g0);
    if (i0 < 0) {
      var ng = nextGroupInDirection(f, g0);
      if (ng < 0) return null;
      g0 = ng;
      ui.group = ng;
      ui.cursor = null;
      i0 = targetIndex(f, ng);
      if (i0 < 0) return null;
    }
    var n = pushReadings([value], { advance: true });
    if (!n) return null;
    if (targetIndex(f, ui.group) < 0) {
      toast('第 ' + (ui.group + 1) + ' 组已录/送检完，点「下一组」继续', 'ok', 2000);
    }
    return { furnace: f.id, group: g0, index: i0 };
  }

  window.GaugeApp = {
    version: C.VERSION,
    pushReading: pushReading,
    pushReadings: function (list, opts) { return pushReadings(list, opts || {}); },
    getTarget: function () {
      var f = currentFurnace();
      if (!f) return null;
      return {
        furnace: f.id,
        group: ui.group,
        index: targetIndex(f, ui.group),
        reverse: !!ui.reverse,
        paused: !!ui.paused
      };
    },
    setDirection: function (reverse) {
      if (!!reverse !== !!ui.reverse) toggleDirection();
      return !!ui.reverse;
    },
    pauseRecognition: function () {
      if (!ui.paused) { ui.paused = true; renderFurnace(); }
      return true;
    },
    resumeRecognition: function (index) {
      var f = currentFurnace();
      if (!f) return false;
      if (typeof index === 'number' && !(index >= 0 && index < f.perGroup)) return false;
      ui.paused = false;
      ui.started = true;
      ui.cursor = typeof index === 'number' ? { group: ui.group, index: index } : null;
      ensureCamera();
      renderFurnace();
      return true;
    },
    isPaused: function () { return !!ui.paused; },
    skipGauge: function (group, index) {
      var f = currentFurnace();
      if (!f) return false;
      var g = typeof group === 'number' ? group : ui.group;
      var i = typeof index === 'number' ? index : targetIndex(f, g);
      if (i < 0) return false;
      C.setSkipped(batch, f.id, g, i, true);
      ui.cursor = null;
      persist();
      renderFurnace();
      return true;
    },
    skipCurrent: function () { skipCurrent(); return true; },
    getVideo: function () { return $('#cameraFeed'); },
    getStream: function () { return cameraStream; },
    startCamera: function () { ensureCamera(true); return true; },
    stopCamera: stopCamera,
    openFurnace: openFurnace,
    getBatch: function () { return C.toJSON(batch); }
  };

  /* ================================================================== *
   * 九、导出文丘里压力（方式1）
   * ================================================================== */

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () {
        return fallbackCopy(text);
      });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    var ta = el('textarea', { style: 'position:fixed;left:-9999px;top:0;opacity:0' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function openExportAll() {
    var list = C.furnacesWithData(batch);
    if (!list.length) {
      toast(C.hasBatchData(batch) ? '当前炉膛范围内还没有读数（可切回整台）' : '还没有录入任何读数', 'warn', 3200);
      return;
    }

    var html = '<div class="es-meta">' + esc(batch.meta.date) + ' ' + esc(batch.meta.time || C.nowTimeStr()) +
      (batch.meta.operator ? ' · ' + esc(batch.meta.operator) : '') + '</div>';
    html += '<table class="es-table"><thead><tr><th>炉号</th><th>范围</th><th>已处理</th><th>最高</th><th>最大绝压比</th></tr></thead><tbody>';
    list.forEach(function (f) {
      var st = C.furnaceStat(f);
      var best = C.bestRatioOf(f);
      var pos = best ? '第' + (best.maxGroup + 1) + '组第' + (best.maxIndex + 1) + '块' : '';
      html += '<tr><td><b>' + esc(f.label) + '</b></td><td>' + esc(C.sideLabel(f.side)) + '</td><td>' +
        st.handled + '/' + st.total + (st.skipped ? '（送检' + st.skipped + '）' : '') + '</td><td>' + (st.max == null ? '—' : C.formatFixed(st.max, batch.config.decimals)) + '</td><td>' +
        (best
          ? '<span class="es-ratio es-max">' + C.formatRatio(best.ratio) + ' ' + pos + '</span>'
          : '—') +
        '</td></tr>';
    });
    html += '</tbody></table>';
    $('#exportAllSummary').innerHTML = html;

    var missing = [];
    list.forEach(function (f) {
      ['A', 'B'].forEach(function (ch) {
        var hasGroup = C.groupsInScope(f).some(function (g) { return C.chamberOf(g) === ch; });
        if (hasGroup && C.headerOf(f, ch) == null) missing.push(f.label + ' ' + ch);
      });
    });
    $('#exportAllNote').textContent = missing.length
      ? '未填集合管压力：' + missing.join('、') + '（这些炉膛的绝压比为空，可在「绝压比计算」里补）'
      : '每台炉会附 A/B 集合管压力；最大绝压比后面注明第几组第几块。';
    $('#dlgExportAll').showModal();
  }

  function downloadBlob(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob(['\ufeff' + text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }

  /* ================================================================== *
   * 十、导入 / 新建 / 主题
   * ================================================================== */

  function newBatch() {
    if (C.hasBatchData(batch) && !confirm('新建会清空当前所有炉子的读数，是否继续？')) return;
    stopCamera();
    batch = C.createBatch({ date: C.todayStr(), operator: batch.meta.operator });
    ui = { view: 'home', furnaceId: null, group: 0, reverse: false, paused: true, started: false, cursor: null };
    persist();
    render();
    toast('已新建空白任务', 'ok');
  }

  function readImportFile(file) {
    var name = String(file.name || '').toLowerCase();
    var type = String(file.type || '');
    if (name.slice(-5) === '.xlsx' || type.indexOf('spreadsheet') >= 0) {
      readExcelFile(file);
      return;
    }
    readJsonFile(file);
  }

  function readJsonFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var obj;
      try { obj = JSON.parse(String(reader.result)); }
      catch (e) { toast('导入失败：不是有效的 JSON', 'error', 4000); return; }
      if (C.hasBatchData(batch) && !confirm('导入会覆盖当前数据，是否继续？')) return;
      stopCamera();
      batch = C.normalizeBatch(obj);
      ui = { view: 'home', furnaceId: null, group: 0, reverse: false, paused: true, started: false, cursor: null };
      persist();
      render();
      toast('已导入：' + (file.name || 'JSON'), 'ok');
    };
    reader.onerror = function () { toast('读取文件失败', 'error'); };
    reader.readAsText(file, 'utf-8');
  }

  function readExcelFile(file) {
    if (!window.XlsxRead) {
      toast('Excel 读取组件未加载，请刷新页面', 'error', 3200);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      window.XlsxRead.readWorkbook(reader.result).then(function (wb) {
        var next;
        try { next = C.parseReportWorkbook(wb); }
        catch (e) { toast('导入 Excel 失败：' + e.message, 'error', 5000); return; }
        if (C.hasBatchData(batch) && !confirm('导入会覆盖当前数据，是否继续？')) return;
        stopCamera();
        batch = next;
        ui = { view: 'home', furnaceId: null, group: 0, reverse: false, paused: true, started: false, cursor: null };
        persist();
        render();
        toast('已导入 Excel：' + (file.name || ''), 'ok', 2600);
      }).catch(function (e) {
        toast('读取 Excel 失败：' + (e && e.message ? e.message : e), 'error', 5000);
      });
    };
    reader.onerror = function () { toast('读取文件失败', 'error'); };
    reader.readAsArrayBuffer(file);
  }

  function applyTheme(theme) {
    var t = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    writeStore(KEYS.theme, t);
    var b = $('#btnTheme');
    if (b) {
      b.textContent = t === 'dark' ? '☀' : '☾';
      b.title = t === 'dark' ? '切换到浅色' : '切换到深色';
      b.setAttribute('aria-label', b.title);
    }
  }

  /* ================================================================== *
   * 十一、事件绑定与启动
   * ================================================================== */

  function bindSwipeBack() {
    var start = null;
    document.addEventListener('touchstart', function (e) {
      start = null;
      if (ui.view !== 'furnace') return;
      if (document.querySelector('dialog[open]')) return;
      if (!e.touches || e.touches.length !== 1) return;
      var target = e.target;
      if (target && target.closest && target.closest('input,textarea,select,button,a,.table-wrap')) return;
      var t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, t: Date.now() };
    }, { passive: true });

    document.addEventListener('touchend', function (e) {
      if (!start || ui.view !== 'furnace') { start = null; return; }
      var t = e.changedTouches && e.changedTouches[0];
      var s = start;
      start = null;
      if (!t) return;
      var dx = t.clientX - s.x;
      var dy = t.clientY - s.y;
      if (dx >= 80 && Math.abs(dy) <= 60 && Date.now() - s.t <= 900) openVisual();
    }, { passive: true });

    document.addEventListener('touchcancel', function () { start = null; }, { passive: true });
  }

  function bind() {
    $('#metaDate').addEventListener('change', function (e) {
      batch.meta.date = /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) ? e.target.value : C.todayStr();
      e.target.value = batch.meta.date;
      persist();
    });
    $('#metaTime').addEventListener('change', function (e) {
      var t = e.target.value;
      batch.meta.time = /^\d{1,2}:\d{2}/.test(t) ? t.slice(0, 5) : C.nowTimeStr();
      e.target.value = batch.meta.time;
      persist();
    });
    $('#metaOperator').addEventListener('input', function (e) {
      batch.meta.operator = e.target.value.slice(0, 40);
      persist();
    });

    $('#btnNew').addEventListener('click', newBatch);
    $('#btnImport').addEventListener('click', function () { $('#fileInput').click(); });
    $('#btnExport').addEventListener('click', openExportAll);
    $('#btnExportAllRatio').addEventListener('click', function () {
      $('#dlgExportAll').close();
      openRatioSelect();
    });
    $('#btnDownloadExportAll').addEventListener('click', function () {
      if (!window.XlsxLite) {
        toast('Excel 组件未加载，请刷新页面', 'error', 2600);
        return;
      }
      var bytes = window.XlsxLite.build(C.toReportWorkbook(batch));
      var blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var t = batch.meta.time || C.nowTimeStr();
      var name = '加热炉文丘里压力_' + batch.meta.date.replace(/-/g, '') + '_' + t.replace(':', '') + '.xlsx';
      downloadBlob(name, blob);
      toast('已下载 ' + name, 'ok');
    });
    $('#btnHelp').addEventListener('click', function () { $('#dlgHelp').showModal(); });
    $('#btnTheme').addEventListener('click', function () {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });

    $('#fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) readImportFile(f);
      e.target.value = '';
    });

    $('#btnCopyExport').addEventListener('click', function () {
      copyText($('#exportPreview').textContent).then(function (ok) {
        toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择文本', ok ? 'ok' : 'error', 2200);
      });
    });
    $('#btnDownloadExport').addEventListener('click', function () {
      var text = $('#exportPreview').textContent;
      var name = '文丘里压力_' + batch.meta.date.replace(/-/g, '') + '.txt';
      downloadText(name, text);
      toast('已下载 ' + name, 'ok');
    });

    $('#btnFill').addEventListener('click', doFill);

    $('#btnOpenRatio').addEventListener('click', function () {
      $('#dlgExport').close();
      openRatioSelect();
    });

    document.addEventListener('click', function (e) {
      var closer = e.target.closest && e.target.closest('[data-close]');
      if (closer) {
        var dlg = document.getElementById(closer.dataset.close);
        if (dlg) dlg.close('cancel');
      }
    });

    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readImportFile(f);
    });
  }

  function init() {
    var loaded = loadBatch();
    batch = loaded.batch;
    applyTheme(readStore(KEYS.theme) || 'light');
    initInstall();
    registerServiceWorker();
    bind();
    bindSwipeBack();
    render();
    if (loaded.restored) toast('已恢复上次自动保存的数据', 'ok', 2600);
    if (!storageOk) toast('当前环境无法使用本地存储，请及时导出备份', 'error', 6000);
    var hint = $('#saveHint');
    if (hint) hint.textContent = '自动保存已开启';
  }

  init();
})();
