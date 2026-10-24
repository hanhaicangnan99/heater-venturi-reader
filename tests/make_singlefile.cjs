'use strict';
/*
 * 生成「读表软件_手机版.html」：把 CSS / JS 全部内联，只传一个文件到手机。
 * 用法：node tests/make_singlefile.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const css = fs.readFileSync(path.join(ROOT, 'assets', 'styles.css'), 'utf8');
if (css.indexOf('</style') >= 0) throw new Error('CSS 里出现 </style>，不能直接内联');

html = html.replace(
  '<link rel="stylesheet" href="assets/styles.css">',
  function () { return '<style>\n' + css + '\n</style>'; }
);

const scripts = ['core.js', 'xlsx-lite.js', 'xlsx-read.js', 'app.js'];
for (const name of scripts) {
  const code = fs.readFileSync(path.join(ROOT, 'js', name), 'utf8');
  if (code.indexOf('</script') >= 0) throw new Error(name + ' 里出现 </script>，不能直接内联');
  const tag = '<script src="js/' + name + '"></script>';
  if (html.indexOf(tag) < 0) throw new Error('index.html 里找不到 ' + tag);
  html = html.replace(tag, function () { return '<script>\n' + code + '\n</script>'; });
}

if (/src="js\//.test(html) || /href="assets\//.test(html)) {
  throw new Error('还有未内联的本地资源');
}

html = html.replace(
  '<head>',
  '<head>\n<!-- 单文件手机版：CSS/JS 已内联，可直接发到手机用浏览器打开 -->'
);

fs.writeFileSync(path.join(ROOT, '读表软件_手机版.html'), html, 'utf8');
console.log('written 读表软件_手机版.html');
