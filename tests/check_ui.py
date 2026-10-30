# -*- coding: utf-8 -*-
"""静态一致性检查：HTML 里的 id / data-close / data-export 与 app.js、styles.css 是否对得上。

沙箱内无法启动浏览器（Mojo 命名管道被拒），所以用这类交叉检查代替手工点页面。
"""
import os
import re
import sys
from collections import Counter

from lxml import html

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML_PATH = os.path.join(ROOT, 'index.html')
APP_PATH = os.path.join(ROOT, 'js', 'app.js')
CSS_PATH = os.path.join(ROOT, 'assets', 'styles.css')

with open(HTML_PATH, encoding='utf-8') as f:
    html_text = f.read()
doc = html.fromstring(html_text)

ids = [el.get('id') for el in doc.iter() if el.get('id')]
dup = [k for k, v in Counter(ids).items() if v > 1]

with open(APP_PATH, encoding='utf-8') as f:
    app = f.read()
with open(CSS_PATH, encoding='utf-8') as f:
    css = f.read()

errors = []
warnings = []

if dup:
    errors.append('HTML 中存在重复 id: %s' % dup)

# app.js 里引用的 id
refs = set(re.findall(r"\$\('#([A-Za-z][\w-]*)'", app))
refs |= set(re.findall(r"getElementById\('([A-Za-z][\w-]*)'\)", app))
refs |= set(re.findall(r"document\.getElementById\('([A-Za-z][\w-]*)'\)", app))

# 由 app.js 动态创建的元素 id（el(..., {id: 'xxx'}) 或 innerHTML 模板）
dynamic = set(re.findall(r"id:\s*'([A-Za-z][\w-]*)'", app))
dynamic |= set(re.findall(r'id="([A-Za-z][\w-]*)"', app))
known = set(ids) | dynamic

missing = sorted(r for r in refs if r not in known)
if missing:
    errors.append('app.js 引用了不存在的 id: %s' % missing)

# data-close 必须指向真实 dialog
for el in doc.iter():
    target = el.get('data-close')
    if target and target not in ids:
        errors.append('data-close="%s" 找不到对应元素' % target)

# data-export 必须有处理分支
for el in doc.iter():
    kind = el.get('data-export')
    if kind and ("'%s'" % kind) not in app:
        errors.append('data-export="%s" 在 app.js 中没有处理' % kind)

# 本地资源存在
for rel in re.findall(r'(?:src|href)="([^"]+)"', html_text):
    if rel.startswith(('data:', 'http:', 'https:', '#')):
        continue
    rel_path = rel.split('?', 1)[0].split('#', 1)[0]
    if not os.path.exists(os.path.join(ROOT, rel_path)):
        errors.append('引用的本地文件不存在: %s' % rel)

# app.js 里出现的 class 是否在 CSS 中定义（忽略动态拼接的）
classes = set()
for chunk in re.findall(r"class:\s*'([^']+)'", app):
    classes.update(chunk.split())
for chunk in re.findall(r"classList\.(?:add|toggle|remove)\('([\w-]+)'", app):
    classes.add(chunk)
for chunk in re.findall(r"className\s*=\s*'([^']+)'", app):
    classes.update(chunk.split())

undefined = []
for name in sorted(classes):
    if re.search(r'\.' + re.escape(name) + r'(?![\w-])', css) is None:
        undefined.append(name)

if undefined:
    warnings.append('这些 class 在 CSS 中未定义（可能只是逻辑标记）: %s' % undefined)

# JS / CSS 语法层面的粗查
for path, src in (('js/core.js', open(os.path.join(ROOT, 'js/core.js'), encoding='utf-8').read()),
                  ('js/app.js', app)):
    if re.search(r'\bundefined\s*\.\s*\w+', src):
        warnings.append('%s 中可能有 undefined.xxx 访问' % path)

print('id 总数:', len(ids), '| app.js 引用 id 数:', len(refs))
print('检查到 class 数:', len(classes))
if warnings:
    print('\n[警告]')
    for w in warnings:
        print(' -', w)
if errors:
    print('\n[错误]')
    for e in errors:
        print(' -', e)
    sys.exit(1)
print('\n静态检查通过 ✅')
