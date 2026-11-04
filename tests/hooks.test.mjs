import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../scripts/lib/repo.mjs';
import { BASH } from './helpers/bash.mjs';
import { psRunners, execFileSyncRetry } from './helpers/powershell.mjs';

test('tasks-startup печатает вложенный путь лога', () => {
  const out = execFileSync(process.execPath, [join(REPO, '.claude', 'hooks', 'tasks-startup.mjs')], { encoding: 'utf8' });
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const expected = `Log/${d.getFullYear()}/${p(d.getMonth() + 1)}/${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.md`;
  assert.ok(ctx.includes(expected), `в подсказке нет ${expected}: ${ctx}`);
});

test('settings.json регистрирует vault как локальный marketplace', () => {
  const s = JSON.parse(readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s.extraKnownMarketplaces['obsidian-agent-workspace'].source,
    { source: 'directory', path: '.' });
  assert.equal(s.enabledPlugins['obsidian-agent-workspace@obsidian-agent-workspace'], true);
});

test('в хуках нет юниксовых зависимостей', () => {
  const s = readFileSync(join(REPO, '.claude', 'settings.json'), 'utf8');
  for (const bad of ['jq', 'bash ', 'date +']) {
    assert.ok(!s.includes(bad), `settings.json всё ещё использует ${bad}`);
  }
});

// Codex читает хуки проекта из <repo>/.codex/hooks.json и использует ту же
// схему, что Claude Code, плюс своё поле commandWindows — готовый диспетчер
// по ОС. Без него на Windows потребовался бы Git Bash, то есть ровно та
// зависимость, ради снятия которой всё и делается.
test('.codex/hooks.json разводит команды по ОС', () => {
  const h = JSON.parse(readFileSync(join(REPO, '.codex', 'hooks.json'), 'utf8'));
  const entry = h.hooks.SessionStart[0].hooks[0];
  assert.equal(entry.type, 'command');
  assert.match(entry.command, /^bash \.codex\/hooks\/tasks-startup\.sh$/);
  assert.match(entry.commandWindows, /powershell .*tasks-startup\.ps1$/);
  assert.ok(!entry.commandWindows.includes('bash'),
    'commandWindows не должен требовать bash — на чистой Windows его нет');
});

const expectedLogPath = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `Log/${d.getFullYear()}/${p(d.getMonth() + 1)}/${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.md`;
};

test('codex-хук на bash печатает тот же путь лога, что и Claude-версия', () => {
  const out = execFileSync(BASH, [join(REPO, '.codex', 'hooks', 'tasks-startup.sh')], { encoding: 'utf8' });
  const ctx = JSON.parse(out).hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes(expectedLogPath()), `в подсказке нет ${expectedLogPath()}: ${ctx}`);
});

// Совпадения пути лога мало: сама формулировка подсказки — тоже контракт, и
// три реализации (.mjs у Claude, .sh и .ps1 у Codex) обязаны говорить одно и
// то же. Правку текста в одной из них без правки остальных ничто иначе не
// ловит — .ps1 сверяется с .sh ниже, а .mjs не сверялся ни с чем.
test('codex-хук на bash и Claude-хук на Node печатают один и тот же объект', () => {
  const sh = execFileSync(BASH, [join(REPO, '.codex', 'hooks', 'tasks-startup.sh')], { encoding: 'utf8' });
  const mjs = execFileSync(process.execPath, [join(REPO, '.claude', 'hooks', 'tasks-startup.mjs')], { encoding: 'utf8' });
  assert.deepStrictEqual(JSON.parse(sh).hookSpecificOutput, JSON.parse(mjs).hookSpecificOutput);
});

// Поиск PowerShell и запуск с повтором при крахе .NET-хоста — в
// tests/helpers/powershell.mjs, общем с tests/obsidian-plugins.test.mjs.

// Кириллическая подстрока, которую ищем в сырых байтах вывода. Если вывод
// ушёл не в UTF-8 (например, в CP866 на Windows PowerShell 5.1), этих байтов
// в потоке не будет, даже когда JSON.parse после декодирования как UTF-8 не
// падает — ConvertTo-Json на PS 5.1 форматирует иначе, чем heredoc bash
// (другой отступ, лишний пробел после двоеточия, CRLF), поэтому побайтовое
// сравнение bash- и PowerShell-вывода целиком недостижимо в принципе и не
// про то, что здесь проверяется.
const UTF8_MARKER = Buffer.from('Посмотри', 'utf8');

function assertUtf8Output(raw, label) {
  assert.ok(raw.includes(UTF8_MARKER),
    `сырые байты вывода ${label} не содержат UTF-8-представление "Посмотри" — вывод ушёл не в UTF-8 ` +
    '(например, в CP866 консоли на Windows 5.1 без [Console]::OutputEncoding = New-Object ' +
    'System.Text.UTF8Encoding $false). JSON.parse на таких байтах может не упасть — получатель прочитает ' +
    'синтаксически валидный, но испорченный JSON.');
}

// Проверка кодировки дешёвая и симметричная — гоняем и для bash, не только
// для PowerShell: если байтов "Посмотри" нет и там, дело не в Windows.
test('codex-хук на bash пишет UTF-8, а не что-то ещё', () => {
  const raw = execFileSync(BASH, [join(REPO, '.codex', 'hooks', 'tasks-startup.sh')]);
  assertUtf8Output(raw, 'bash');
});

for (const ps of psRunners) {
  const skip = ps.skip || false;

  // Содержательный паритет — сравнение разобранных объектов, а не сырых
  // строк: ConvertTo-Json на PS 5.1 форматирует иначе, чем bash-heredoc,
  // при идентичном содержимом.
  test(`codex-хук на PowerShell (${ps.label}) печатает тот же объект, что и bash-версия`, { skip }, () => {
    const sh = execFileSync(BASH, [join(REPO, '.codex', 'hooks', 'tasks-startup.sh')], { encoding: 'utf8' });
    const out = execFileSyncRetry(ps.cmd, ['-NoProfile', '-File',
      join(REPO, '.codex', 'hooks', 'tasks-startup.ps1')], { encoding: 'utf8' });
    assert.deepStrictEqual(
      JSON.parse(out.replace(/\r\n/g, '\n')).hookSpecificOutput,
      JSON.parse(sh).hookSpecificOutput);
  });

  // Кодировка — отдельная проверка от содержательного паритета выше: именно
  // она ловит регресс [Console]::OutputEncoding, который JSON.parse не ловит.
  test(`codex-хук на PowerShell (${ps.label}) пишет UTF-8, а не что-то ещё`, { skip }, () => {
    const raw = execFileSyncRetry(ps.cmd, ['-NoProfile', '-File',
      join(REPO, '.codex', 'hooks', 'tasks-startup.ps1')]);
    assertUtf8Output(raw, `PowerShell (${ps.label})`);
  });
}
