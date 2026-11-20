import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { REPO } from '../scripts/lib/repo.mjs';

// main.js плагина — CommonJS с require('obsidian'), которого вне Obsidian нет.
// Грузим его в песочнице с заглушками модулей и берём чистые функции,
// которые плагин выставляет на module.exports.
function loadPlugin() {
  const src = readFileSync(join(REPO, '.obsidian', 'plugins', 'tasks-mover', 'main.js'), 'utf8');
  const stub = new Proxy({}, { get: () => class {} });
  const module = { exports: {} };
  const require = (id) => {
    if (id === 'obsidian') return stub;
    throw new Error(`no module ${id} in tests`); // @codemirror/* — плагин обязан пережить отсутствие
  };
  vm.runInNewContext(src, { module, exports: module.exports, require });
  return module.exports;
}

const { parseSessionLine, parseSessionText } = loadPlugin();

test('tasks-mover: строка «- Сессия <имя>» распознаётся, имя — первый токен', () => {
  const cases = [
    ['\t- Сессия demo-cve-0101', 'demo-cve-0101'],
    ['\t- Сессия └child-prepare', '└child-prepare'],
    ['\t- Сессия someone-tg-2026-11-17', 'someone-tg-2026-11-17'],
    ['\t\t- Сессия 0b7c2e1a-4f3d-4c8e-9a6b-123456789abc (Разбор задачи)', '0b7c2e1a-4f3d-4c8e-9a6b-123456789abc'],
    ['    * Сессия some_user_name-tg-2026-11-15', 'some_user_name-tg-2026-11-15'],
    ['- Сессия top-level', 'top-level'],
  ];
  for (const [line, name] of cases) {
    const s = parseSessionLine(line);
    assert.ok(s, line);
    assert.equal(s.name, name, line);
    assert.equal(line.slice(s.from, s.to), name, `диапазон имени: ${line}`);
  }
});

test('tasks-mover: прочие строки не считаются сессией', () => {
  for (const line of [
    '\t- Сессии nginx',
    '\t- Сессия',
    '\t- Сессия   ',
    '\t- [ ] Сессия nginx',
    '\t- текст Сессия nginx',
    'Сессия nginx',
    '- [ ] Задача ➕ 2026-11-20',
  ]) {
    assert.equal(parseSessionLine(line), null, line);
  }
});

test('tasks-mover: текст пункта в режиме чтения', () => {
  const s = parseSessionText('Сессия pf-inbox-head (заголовок)');
  assert.equal(s.name, 'pf-inbox-head');
  assert.equal('Сессия pf-inbox-head (заголовок)'.slice(s.from, s.to), 'pf-inbox-head');
  assert.equal(parseSessionText('Сессии нет'), null);
});
