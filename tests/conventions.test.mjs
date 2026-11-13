// tests/conventions.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, basename } from 'node:path';
import { REPO, walk, rootDocs } from '../scripts/lib/repo.mjs';

// Плоский дневной лог: сразу после Log/ идёт дата, даже если Log/ и дата
// разнесены по строке (например через markdown-таблицу или свободный текст:
// "Log/ | дневные логи YYYY-MM-DD.md"). Вложенный (Log/YYYY/MM/…) и отчёты
// (Log/Reports/…) под это не попадают — лукахед после Log/ явно их исключает.
const FLAT_LOG = /Log\/(?!YYYY\/|Reports\/|\d{4}\/)(?:(?!Log\/).)*(?:YYYY-MM-DD|\d{4}-\d{2}-\d{2})/;

// Промежуточный чекбокс `- [/]` в базе не поддерживается: ни один скилл его не
// создаёт, а семь скиллов, которые его читали, успели разойтись между собой по
// смежным правилам. Вернуться он может только тихо — ловим здесь.
const INTERMEDIATE_CHECKBOX = /- \[\/\]/;

// Ссылка на скилл вайклинком. Все файлы скиллов называются SKILL.md, поэтому
// `[[имя]]` резолвится в случайный из них, а путевая форма
// `[[skills/x/SKILL|x]]` хоть и открывается, но ломается от любого переезда
// каталога и противоречит правилу «wikilinks по имени файла». obsidian-vault
// предписывает ссылаться на скиллы код-спаном; лестница задач успела
// разойтись с этим правилом в одном месте.
const SKILL_WIKILINK = /\[\[[^\]]*(?:skills\/|\/SKILL)/;

// Общие классы приватных маркеров: абсолютные домашние пути и email-адреса.
// Конкретные приватные термины (названия компаний, городов и т.п.) сюда не
// зашиваются — они читаются из необязательного gitignored файла
// .privacy-terms (см. .privacy-terms.example), чтобы сам guard не был
// местом утечки.
const HOME_PATH = /\/home\/[^\s/'"]+|\/Users\/[^\s/'"]+|C:\\Users\\[^\s\\]+/;
const EMAIL = /[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+/;

// CHANGELOG.md обязан упоминать плоский формат в пометке BREAKING — это
// описание истории, а не действующая конвенция.
const FLAT_LOG_EXEMPT = new Set(['CHANGELOG.md']);

// cliff.toml сам называет один термин из .privacy-terms в пяти конкретных
// строках — но осознанно: commit_preprocessors/commit_parsers используют его
// как pattern/якорь sha, чтобы вычистить это слово из генерируемого
// CHANGELOG.md (см. комментарии на месте, коммиты ba2850e/cb0713e/d77ecda).
//
// Исключение — по номерам строк, а не по файлу целиком: файловое исключение
// спрятало бы от guard любой другой приватный термин, который однажды
// случайно попадёт в cliff.toml (например, домашний путь в постороннем
// комментарии) — ровно тот класс тихого пропуска, который guard обязан
// ловить. Исключение по термину («этому файлу разрешён именно этот термин»)
// тоже не годится здесь: этот тест-файл сам публичный и сам попадает под
// privacyScanFiles() (она включает tests/) — написать здесь сам термин
// буквально означало бы закоммитить в публичный репозиторий ровно то, что
// .privacy-terms обязан скрывать. Поэтому — точные номера строк, снятые
// однократно `grep`-ом по факту (см. final-fix-report.md): любая другая
// строка cliff.toml, включая новые, проверяется как обычно.
const PRIVACY_TERMS_LINE_EXEMPT = { 'cliff.toml': new Set([42, 49, 53, 57, 59]) };

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Необязательный локальный файл с проектно-специфичными приватными
// терминами, по одному на строку, `#`-строки и пустые строки игнорируются.
// Файл в .gitignore — в клоне его нет, и тест просто не проверяет термины,
// которых не знает.
function loadPrivacyTerms() {
  const p = join(REPO, '.privacy-terms');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function markdownFiles() {
  return [
    ...walk(join(REPO, 'skills')).filter((p) => p.endsWith('.md')),
    ...rootDocs(),
  ];
}

// Тот же приватный контент может попасть и мимо skills/ + корня: в образец
// .claude/vault-config.md (его новые пользователи читают и копируют), в
// скрипты/тесты (пример пути или адреса в комментарии) или в cliff.toml.
// Личные маркеры (домашние пути, email) и .privacy-terms проверяем по этому
// более широкому охвату; остальные конвенции (плоский лог, вайклинк на
// скилл и т.п.) — только про сами скиллы, им расширение не нужно.
function privacyScanFiles() {
  const exts = new Set(['.md', '.mjs', '.cjs', '.js', '.sh', '.ps1']);
  return [
    ...markdownFiles(),
    ...walk(join(REPO, '.claude')).filter((p) => p.endsWith('.md')),
    ...walk(join(REPO, 'scripts')).filter((p) => exts.has(p.slice(p.lastIndexOf('.')))),
    ...walk(join(REPO, 'tests')).filter((p) => exts.has(p.slice(p.lastIndexOf('.')))),
    ...walk(join(REPO, '.obsidian')).filter((p) => p.endsWith('.md')),
    join(REPO, 'cliff.toml'),
  ].filter((p) => existsSync(p));
}

function scanFiles(files, re, exempt = new Set()) {
  const hits = [];
  for (const path of files) {
    const rel = relative(REPO, path);
    if (exempt.has(rel)) continue;
    readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (re.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

// Как scanFiles, но исключение — конкретные номера строк конкретного файла
// (см. PRIVACY_TERMS_LINE_EXEMPT выше), а не файл целиком. Каждая остальная
// строка того же файла проверяется как обычно.
function scanFilesLineExempt(files, re, lineExempt = {}) {
  const hits = [];
  for (const path of files) {
    const rel = relative(REPO, path);
    const exemptLines = lineExempt[rel];
    readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (exemptLines && exemptLines.has(i + 1)) return;
      if (re.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

function scan(re, exempt = new Set()) {
  const hits = [];
  for (const path of markdownFiles()) {
    const rel = relative(REPO, path);
    if (exempt.has(rel)) continue;
    readFileSync(path, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (re.test(line)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

test('нет плоского формата дневных логов', () => {
  assert.deepEqual(scan(FLAT_LOG, FLAT_LOG_EXEMPT), []);
});

test('нет промежуточного чекбокса `- [/]`', () => {
  assert.deepEqual(scan(INTERMEDIATE_CHECKBOX), []);
});

test('на скиллы не ссылаются вайклинком', () => {
  assert.deepEqual(scan(SKILL_WIKILINK), []);
});

// list-tasks и weekly-review оба классифицируют задачи по одному и тому же
// порогу возраста «старых» задач — list-tasks в обзоре, weekly-review в шаге
// 3 (признак «Долгожитель»). Если наследник меняет порог в одном скилле и
// забывает про другой, list-tasks и weekly-review начинают спорить о статусе
// одной и той же задачи. Число не хардкодим (наследник вправе сменить 14 на
// своё), сверяем только равенство между файлами.
function ageThreshold(relPath) {
  const text = readFileSync(join(REPO, relPath), 'utf8');
  const matches = [...text.matchAll(/старше (\d+) дней/g)];
  assert.equal(
    matches.length,
    1,
    `ожидался ровно один порог возраста («старше N дней») в ${relPath}, найдено ${matches.length}`
  );
  return Number(matches[0][1]);
}

test('порог "старых" задач одинаков в list-tasks и weekly-review', () => {
  const listTasks = ageThreshold('skills/list-tasks/SKILL.md');
  const weeklyReview = ageThreshold('skills/weekly-review/SKILL.md');
  assert.equal(
    listTasks,
    weeklyReview,
    `list-tasks считает старой задачу старше ${listTasks} дней, weekly-review — старше ${weeklyReview} дней`
  );
});

test('нет личных маркеров (домашних путей, email) в скиллах, .claude/, scripts/, tests/, cliff.toml и корневых документах', () => {
  const files = privacyScanFiles();
  const hits = [...scanFiles(files, HOME_PATH), ...scanFiles(files, EMAIL)];
  assert.deepEqual([...new Set(hits)].sort(), []);
});

test('нет проектно-специфичных приватных терминов из .privacy-terms (если файл есть локально)', (t) => {
  const terms = loadPrivacyTerms();
  if (terms.length === 0) {
    // .privacy-terms — сам приватный (не коммитится, см. .gitignore), поэтому
    // в клоне и на CI его нет. Тест не может проверить термины, которых не
    // знает, но обязан сказать об этом явно, а не тихо выйти зелёным.
    t.skip('.privacy-terms не найден локально (это штатно вне машины автора) — термины не проверены');
    return;
  }
  const re = new RegExp(terms.map(escapeRegExp).join('|'), 'i');
  assert.deepEqual(scanFilesLineExempt(privacyScanFiles(), re, PRIVACY_TERMS_LINE_EXEMPT), []);
});

// Считаем по индексу git, а не по рабочему дереву: значение имеет только то,
// что приедет пользователю при clone. Скачанные Obsidian-плагины и
// git-ignored мусор рядом с репозиторием тест не касаются.
test('в репозитории нет симлинков', () => {
  const out = execFileSync('git', ['ls-files', '-s'], { cwd: REPO, encoding: 'utf8' });
  const links = out.split('\n')
    .filter((line) => line.startsWith('120000'))
    .map((line) => line.split('\t')[1]);
  assert.deepEqual(links, []);
});

// index.md заявлен в obsidian-vault и INTEGRATION.md как штатная точка входа.
// Битая ссылка в нём — первое, что увидит новый пользователь vault. Считаем
// по индексу git, а не по рабочему дереву: gitignored мусор рядом с
// репозиторием (например .superpowers/) не должен делать битую ссылку зелёной.
test('index.md существует, и его wikilinks резолвятся', () => {
  const path = join(REPO, 'index.md');
  assert.ok(existsSync(path), 'нет корневого index.md');
  const text = readFileSync(path, 'utf8');
  const names = [...text.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim());
  assert.ok(names.length > 0, 'в index.md нет wikilinks — это не точка входа');
  const known = new Set(
    execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: REPO, encoding: 'utf8' })
      .split('\0').filter(Boolean)
      .map((p) => basename(p, '.md'))
  );
  assert.deepEqual(names.filter((n) => !known.has(n)), [], 'битые wikilinks в index.md');
});

// Справка по хоткеям — цель онбординг-задачи «Посмотреть полезные хоткеи» в
// tasks.md, то есть первое, куда новый пользователь идёт за раскладкой. Она
// уже успела разойтись с .obsidian/hotkeys.json молча: хоткеи добавили, в
// заметку не дописали. Проверка односторонняя — каждый назначенный хоткей
// обязан быть в заметке, но не наоборот: описать полезный дефолт Obsidian,
// которого в hotkeys.json нет, законно.
const MOD_ORDER = ['Mod', 'Shift', 'Alt'];
const MOD_TEXT = { Mod: 'Ctrl', Shift: 'Shift', Alt: 'Alt' };
const KEY_TEXT = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };

// Модификатор, которого нет в MOD_TEXT, обязан уронить тест, а не тихо
// выпасть из комбинации: иначе Meta+K превратился бы в «K», нашёлся бы в
// заметке по случайному совпадению и пропал бы из-под проверки.
function renderBinding(command, b) {
  const mods = b.modifiers || [];
  const unknown = mods.filter((m) => !(m in MOD_TEXT));
  assert.deepEqual(unknown, [], `неизвестный модификатор в ${command} — допиши его в MOD_TEXT/MOD_ORDER`);
  return [...MOD_ORDER.filter((m) => mods.includes(m)).map((m) => MOD_TEXT[m]), KEY_TEXT[b.key] ?? b.key].join('+');
}

test('справка по хоткеям описывает все назначенные хоткеи', () => {
  // Заметку ищем по имени в индексе git, а не по захардкоженному пути: она
  // лежит в датированном каталоге Notes/<год>/<месяц>/ и переезд туда, куда
  // её решит положить наследник, ломать тест не должен.
  const notes = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: REPO, encoding: 'utf8' })
    .split('\0').filter(Boolean)
    .filter((p) => basename(p, '.md') === 'Хоткеи');
  assert.equal(notes.length, 1, `ожидалась ровно одна заметка «Хоткеи», найдено: ${notes.join(', ') || 'ни одной'}`);
  const note = readFileSync(join(REPO, notes[0]), 'utf8');

  const hotkeys = JSON.parse(readFileSync(join(REPO, '.obsidian', 'hotkeys.json'), 'utf8'));
  const missing = [];
  for (const [command, binds] of Object.entries(hotkeys)) {
    for (const b of binds) {
      const combo = renderBinding(command, b);
      // Ищем комбинацию в бэктиках — так она набрана в заметке, и так
      // «Ctrl+D» не засчитывается по вхождению внутрь «Ctrl+Shift+Alt+D».
      if (!note.includes(`\`${combo}\``)) missing.push(`${command} → ${combo}`);
    }
  }
  assert.deepEqual(missing, [], `хоткеи не описаны в ${notes[0]}`);
});

// Хук .githooks/pre-commit пересобирает производные файлы и гоняет тесты до
// коммита, но включается локальной настройкой, которая не переживает clone.
// Четыре из шести красных прогонов CI с июля по ноябрь 2026 — забытая
// пересборка (Skills list, EXPECTED, хэши demo-manifest) с машины, где хук
// был выключен. В CI и вне git-рабочей копии проверять нечего.
test('pre-commit хук включён (локально)', t => {
  if (process.env.CI) return t.skip('в CI хуки не нужны');
  if (!existsSync(join(REPO, '.git'))) return t.skip('не git-рабочая копия');
  let hooksPath = '';
  try {
    hooksPath = execFileSync('git', ['config', 'core.hooksPath'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch { /* не задан — git config выходит с кодом 1 */ }
  assert.equal(hooksPath, '.githooks', 'хук pre-commit выключен — включи: git config core.hooksPath .githooks');
});
