import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { REPO } from '../scripts/lib/repo.mjs';
import { startGithubStub } from './helpers/github-stub.mjs';
import { BASH } from './helpers/bash.mjs';
import { psRunners, execFileSyncRetry, spawnSyncRetry } from './helpers/powershell.mjs';

// Поиск pwsh и Windows PowerShell 5.1 и запуск с повтором при крахе
// .NET-хоста — в tests/helpers/powershell.mjs. Раньше тесты хардкодили только
// pwsh — 5.1-специфичный баг (см. тест на BOM ниже) не ловился ни локально, ни
// в CI на windows-latest, потому что там тоже есть pwsh и именно он
// использовался.

const manifest = JSON.parse(readFileSync(join(REPO, 'obsidian-plugins.json'), 'utf8'));
const community = JSON.parse(readFileSync(join(REPO, '.obsidian', 'community-plugins.json'), 'utf8'));
const pluginData = (id) =>
  JSON.parse(readFileSync(join(REPO, '.obsidian', 'plugins', id, 'data.json'), 'utf8'));

test('каждая запись манифеста заполнена', () => {
  for (const p of manifest.plugins) {
    assert.match(p.id, /^[a-z0-9-]+$/, `плохой id: ${p.id}`);
    assert.match(p.repo, /^[\w.-]+\/[\w.-]+$/, `${p.id}: repo должен быть owner/name, получено ${p.repo}`);
    assert.match(p.minVersion, /^\d+\.\d+\.\d+/, `${p.id}: minVersion`);
    assert.equal(typeof p.enabled, 'boolean', `${p.id}: enabled`);
  }
});

test('community-plugins.json совпадает со включёнными в манифесте', () => {
  const enabled = manifest.plugins.filter((p) => p.enabled).map((p) => p.id).sort();
  assert.deepEqual([...community].sort(), enabled);
});

test('ровно один вендоренный плагин', () => {
  const vendored = manifest.plugins.filter((p) => p.vendored).map((p) => p.id);
  assert.deepEqual(vendored, ['tasks-mover']);
});

// Настройки плагинов Obsidian переписывает целиком при любом изменении в UI,
// поэтому вендоренные data.json проверяем на то, ради чего их вообще везём.
test('file-explorer-plus прячет AGENTS.md', () => {
  const paths = pluginData('file-explorer-plus').hideFilters.paths;
  const rule = paths.find((f) => f.pattern === 'AGENTS.md');
  assert.ok(rule, 'в hideFilters.paths нет правила на AGENTS.md');
  assert.equal(rule.active, true, 'правило на AGENTS.md выключено');
});

// Каталоги прячутся регуляркой, а не STRICT: хук плагина на удаление файла
// вырезает из настроек ровно STRICT-фильтры и тут же перезаписывает data.json,
// поэтому STRICT-правила на scripts/tests однажды пропали молча.
test('file-explorer-plus прячет каталоги и служебные доки, не полагаясь на STRICT', () => {
  const paths = pluginData('file-explorer-plus').hideFilters.paths;
  const hidden = (path, kind) => paths.some((f) =>
    f.active && f.patternType !== 'STRICT' &&
    (kind === 'dir' ? f.type !== 'FILES' : f.type !== 'DIRECTORIES') &&
    new RegExp(f.patternType === 'REGEX' ? f.pattern : `^${f.pattern}$`).test(path));

  for (const dir of ['scripts', 'tests']) {
    assert.ok(hidden(dir, 'dir'), `нет активного не-STRICT правила, прячущего каталог ${dir}`);
  }
  for (const file of ['CHANGELOG.md', 'CONTRIBUTING.md', 'INTEGRATION.md']) {
    assert.ok(hidden(file, 'file'), `нет активного не-STRICT правила, прячущего ${file}`);
  }
  // README читают по ссылкам из первой задачи лестницы — он остаётся видимым.
  for (const file of ['README.md', 'README_ru.md', 'tasks.md']) {
    assert.ok(!hidden(file, 'file'), `${file} не должен прятаться`);
  }
});

// Ключи верхнего уровня в data.json иконок — это пути к заметкам. Личный vault
// приносит сюда свои: так в базу чуть не уехала «Книги/Книги 2026.md».
test('иконки назначены только существующим файлам', () => {
  for (const key of Object.keys(pluginData('obsidian-icon-folder'))) {
    if (key === 'settings') continue;
    assert.ok(existsSync(join(REPO, key)), `иконка назначена несуществующему пути: ${key}`);
  }
});

// Клиентский установщик на bash разбирает obsidian-plugins.json построчно —
// без jq, которого нет на чистой macOS. Парсер валиден, только пока каждый
// объект плагина занимает ровно одну строку.
test('каждый плагин в манифесте занимает одну строку', () => {
  const raw = readFileSync(join(REPO, 'obsidian-plugins.json'), 'utf8');
  const objectLines = raw.split('\n').filter((l) => l.includes('"id"'));
  assert.equal(objectLines.length, manifest.plugins.length,
    `строк с "id" ${objectLines.length}, плагинов ${manifest.plugins.length} — объект растянулся на несколько строк`);
  for (const line of objectLines) {
    assert.match(line.trim(), /^\{.*\},?$/,
      `объект плагина не помещается в одну строку: ${line.trim()}`);
    // Ровно эти строки bash-установщик прогоняет через четыре sed'а. На
    // macOS это BSD sed с BSD же локалью — поведение на многобайтовых
    // символах не то же, что у GNU, а цена расхождения (см. тест на манифест
    // без записей) — ноль плагинов и невнятный отказ там, где Windows ставит
    // всё. Русские пояснения к плагинам живут на строке "$comment": её
    // парсер отбрасывает ДО первого sed.
    // trim() — на случай CRLF в рабочем дереве: \r не про кодировку и в этой
    // проверке был бы ложным срабатыванием.
    assert.match(line.trim(), /^[\x20-\x7e]*$/,
      `на разбираемой строке манифеста есть не-ASCII — перенеси текст на строку "$comment", ` +
      `её построчный парсер bash-установщика пропускает до всякого sed: ${line.trim()}`);
  }
});

// bash 3.2 (macOS, основная целевая ОС) под set -u трактует "$@" при нуле
// позиционных параметров как обращение к unbound variable и падает ещё до
// входа в main — обычный безаргументный запуск умер бы, ни разу не дойдя до
// разбора аргументов. ${1+"$@"} безопасен под nounset на 3.2 и не меняет
// поведение на новых bash. Не упрощай этот guard обратно до голого "$@".
test('вызов main внизу bash-установщика использует ${1+"$@"}-guard, а не голый "$@"', () => {
  const text = readFileSync(join(REPO, 'scripts', 'install-obsidian-plugins.sh'), 'utf8');
  assert.match(text, /main\s+\$\{1:?\+"\$@"\}/,
    'нижний вызов main должен использовать идиому ${1+"$@"} (или ${1:+"$@"}) — она безопасна под set -u ' +
    'на bash 3.2 (macOS) и при этом ноль аргументов остаётся нулём аргументов, а не одной пустой строкой');
  // Якорь на начало строки (/m) — намеренно: без него проверка сканирует весь
  // файл вместе с комментариями, и любая правка комментария выше main,
  // упомянувшая эту идиому дословно ("не пиши main "$@""), валила бы тест с
  // сообщением, указывающим на код, а не на комментарий. Ловим позицию
  // оператора, а не упоминание строки.
  assert.doesNotMatch(text, /^\s*main\s+"\$@"/m,
    'найден голый main "$@" — на bash 3.2 (macOS) это падает под set -u при нуле аргументов ещё до входа ' +
    'в main; замени на main ${1+"$@"}');
});

// Обходит репозиторий и находит все *.ps1 — не хардкодит список файлов,
// потому что следующая задача (Задача 5) добавит ещё один .ps1, и он обязан
// попасть под то же правило автоматически.
function findPs1Files(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...findPs1Files(full));
    else if (entry.name.endsWith('.ps1')) result.push(full);
  }
  return result;
}

// Подтверждено на живой Windows PowerShell 5.1.26100: без UTF-8 BOM в начале
// файла 5.1 читает .ps1 в системной ANSI-кодировке, а не в UTF-8. Кириллица
// в строковых литералах и комментариях разваливается и валит скрипт
// синтаксическими ошибками ещё до первой строки выполнения — pwsh (7+) от
// этого бага не страдает, поэтому раньше он не ловился. BOM здесь — не
// мусор от редактора, который можно "почистить", а обязательное условие
// запуска на целевой платформе; текстовый .gitattributes (eol=lf) его не
// трогает.
test('каждый .ps1 в репозитории начинается с UTF-8 BOM', () => {
  const files = findPs1Files(REPO);
  assert.ok(files.length > 0, 'не нашлось ни одного .ps1 — проверь findPs1Files, тест не должен молча проходить пустым');
  for (const file of files) {
    const bom = readFileSync(file).subarray(0, 3);
    assert.deepEqual([...bom], [0xef, 0xbb, 0xbf],
      `${file}: нет UTF-8 BOM в начале файла. Без BOM Windows PowerShell 5.1 читает .ps1 в системной ANSI-кодировке ` +
      `вместо UTF-8 — кириллица в строках и комментариях разваливается, скрипт не парсится (подтверждено на живой ` +
      `Windows PowerShell 5.1.26100). НЕ убирай BOM как "лишние байты" — пересохрани файл в UTF-8 с BOM.`);
  }
});

// Подтверждено на живой Windows PowerShell 5.1: без переустановки
// [Console]::OutputEncoding вывод (stdout и stderr) идёт в консольную OEM-
// кодировку (CP866 для русской локали), а не в UTF-8 — приёмная сторона
// получает синтаксически валидный JSON/текст с побитой кириллицой внутри,
// не падение, а тихая порча. BOM файла (тест выше) и кодировка потока вывода
// — разные вещи, обе обязательны. New-Object ... $false — принципиально:
// $false значит UTF8 БЕЗ BOM в потоке; С BOM в потоке ломается JSON.parse на
// приёмной стороне. НЕ убирай эту строку как "дублирует BOM файла".
test('каждый .ps1 в репозитории переустанавливает OutputEncoding в UTF-8 без BOM', () => {
  const files = findPs1Files(REPO);
  assert.ok(files.length > 0, 'не нашлось ни одного .ps1 — проверь findPs1Files, тест не должен молча проходить пустым');
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /\[Console\]::OutputEncoding\s*=\s*New-Object\s+System\.Text\.UTF8Encoding\s+\$false/,
      `${file}: нет переустановки [Console]::OutputEncoding в UTF8 без BOM. Без неё Windows PowerShell 5.1 пишет ` +
      `stdout/stderr в консольную OEM-кодировку (CP866 для русской локали) — русский текст в выводе превращается ` +
      `в мусор без ручного chcp 65001, которого обычный пользователь не делает (подтверждено на живой Windows ` +
      `PowerShell 5.1). Добавь "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding \\$false" до первого ` +
      `вывода в скрипте — не снимай эту строку как "лишнюю", она не то же самое, что BOM файла.`);
  }
});

const dryRunLines = () => manifest.plugins.map((p) =>
  [p.id, p.repo, p.minVersion, p.vendored ? 'vendored' : 'remote'].join('\t')).join('\n') + '\n';

// Наблюдаемость bash-раннера. Зелёный прогон сам по себе не отвечает на
// вопрос "а какой bash это исполнял" — а для macOS ответ и есть весь смысл
// упражнения: система там несёт /bin/bash 3.2, тогда как в PATH раннера
// GitHub первым стоит Homebrew-bash 5.x, и все .sh-тесты молча ушли бы в
// него. Тест печатает имя бинарника и его версию в вывод прогона и падает,
// если OAB_BASH указывает в никуда, — тихого отката на PATH-bash нет.
test(`bash-раннер тестов: ${BASH}`, (t) => {
  const version = execFileSync(BASH, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
  t.diagnostic(`bash-раннер: ${BASH} — ${version}`);
  assert.match(version, /bash, version/, `${BASH} не похож на bash: ${version}`);
});

test('bash-установщик разбирает манифест так же, как JSON.parse', () => {
  const out = execFileSync(BASH, [join(REPO, 'scripts', 'install-obsidian-plugins.sh'), '--dry-run'],
    { encoding: 'utf8' });
  assert.equal(out, dryRunLines());
});

// "0.9.0" < "0.10.0" — строковое сравнение этого не даёт, поэтому обе
// клиентские реализации сравнивают версии покомпонентно и численно.
const bashCompare = (a, b) => execFileSync(BASH, ['-c',
  `source "${join(REPO, 'scripts', 'install-obsidian-plugins.sh')}"; compare_versions "${a}" "${b}"`],
  { encoding: 'utf8' }).trim();

test('bash сравнивает версии покомпонентно', () => {
  assert.equal(bashCompare('0.9.0', '0.10.0'), '-1');
  assert.equal(bashCompare('0.10.0', '0.9.0'), '1');
  assert.equal(bashCompare('1.2.3', '1.2.3'), '0');
  assert.equal(bashCompare('8.3', '8.3.0'), '0');
  assert.equal(bashCompare('8.4', '8.3.9'), '1');
});

for (const ps of psRunners) {
  const skip = ps.skip || false;
  const runPs = (args) => execFileSyncRetry(ps.cmd, ['-NoProfile', '-File',
    join(REPO, 'scripts', 'install-obsidian-plugins.ps1'), ...args], { encoding: 'utf8' });

  test(`PowerShell-установщик (${ps.label}) разбирает манифест так же, как JSON.parse`, { skip }, () => {
    assert.equal(runPs(['-DryRun']).replace(/\r\n/g, '\n'), dryRunLines());
  });

  test(`PowerShell (${ps.label}) сравнивает версии покомпонентно`, { skip }, () => {
    const out = execFileSyncRetry(ps.cmd, ['-NoProfile', '-Command',
      `. '${join(REPO, 'scripts', 'install-obsidian-plugins.ps1')}';` +
      `@('0.9.0|0.10.0','0.10.0|0.9.0','1.2.3|1.2.3','8.3|8.3.0','8.4|8.3.9') | ` +
      `ForEach-Object { $p = $_ -split '\\|'; Compare-PluginVersion $p[0] $p[1] }`],
      { encoding: 'utf8' });
    assert.deepEqual(out.trim().split(/\r?\n/), ['-1', '1', '0', '0', '1']);
  });
}

// Установочный путь у bash- и PowerShell-реализаций одинаков, поэтому тест
// один и параметризован раннером. Копия на каждую ОС разошлась бы при первой
// же правке поведения. По одному раннеру на каждый реально найденный
// PowerShell-интерпретатор (см. psRunners выше) — на windows-latest в CI это
// и pwsh, и Windows PowerShell 5.1 одновременно.
const RUNNERS = [
  { name: 'bash', script: 'install-obsidian-plugins.sh', cmd: BASH, args: [], dryRun: '--dry-run' },
  ...psRunners.map((ps) => ({
    name: `PowerShell (${ps.label})`,
    script: 'install-obsidian-plugins.ps1',
    cmd: ps.cmd,
    args: ['-NoProfile', '-File'],
    dryRun: '-DryRun',
    skip: ps.skip || false,
  })),
];

// Один плагин на строку — построчный парсер bash находит на ней "id" и
// разбирает как один плагин; с несколькими плагинами на одной строке JSON
// он бы слился в одну (жадную) запись. Формат — как в настоящем
// obsidian-plugins.json (см. тест "каждый плагин в манифесте занимает одну строку").
const manifestText = (plugins) =>
  '{\n  "plugins": [\n' +
  plugins.map((p, i) => '    ' + JSON.stringify(p) + (i < plugins.length - 1 ? ',' : '')).join('\n') +
  '\n  ]\n}\n';

// Манифест, у которого ПОСЛЕДНЯЯ строка несёт плагин и не оканчивается на \n:
// закрывающие скобки прижаты к последнему объекту, завершающего перевода
// строки нет. Ровно эта форма отличает построчный парсер с охранником
// "|| [ -n "$line" ]" от парсера без него — read на неполной последней строке
// возвращает ненулевой код, но переменную уже заполнил, и без охранника цикл
// обрывается, потеряв плагин. Обычная фикстура manifestText и настоящий
// obsidian-plugins.json оканчиваются на \n, а их последняя строка — "}" без
// "id", поэтому откат охранника они не ловят вообще.
const manifestTextNoTrailingNewline = (plugins) =>
  '{\n  "plugins": [\n' +
  plugins.map((p) => '    ' + JSON.stringify(p)).join(',\n') +
  ']}';

// Манифест, который существует и непуст, но не даёт ни одной записи плагина.
// Пустой массив plugins — самая честная форма этого состояния, воспроизводимая
// обеими реализациями одинаково: у bash на такой строке нет ключа "id", у
// PowerShell ConvertFrom-Json отдаёт пустую коллекцию. На живой macOS то же
// состояние возникает иначе — BSD sed/grep -o могут разобрать строки не так,
// как GNU, и все id придут пустыми, — но наблюдаемый результат тот же: ноль
// записей там, где манифест на месте.
const manifestTextNoPlugins = () => '{\n  "plugins": [\n  ]\n}\n';

const DEFAULT_PLUGINS = [{ id: 'stub-plugin', repo: 'owner/stub', minVersion: '1.0.0', enabled: true }];

// Готовит песочницу с манифестом (по умолчанию — на один плагин) и копией
// скрипта, запускает установщик против подменённого GitHub и отдаёт телу
// теста путь и запускалку. build — как сериализовать манифест (null: не
// класть его вовсе, для проверки отказа на пропавшем манифесте).
async function inSandbox(runner, stubOpts, body, plugins = DEFAULT_PLUGINS, build = manifestText) {
  const stub = await startGithubStub(stubOpts);
  const sandbox = mkdtempSync(join(tmpdir(), 'oab-'));
  try {
    if (build) writeFileSync(join(sandbox, 'obsidian-plugins.json'), build(plugins));
    mkdirSync(join(sandbox, 'scripts'), { recursive: true });
    const script = join(sandbox, 'scripts', runner.script);
    copyFileSync(join(REPO, 'scripts', runner.script), script);
    const env = { ...process.env, OAB_GITHUB_API: stub.api, OAB_GITHUB_DOWNLOAD: stub.download };
    const run = (extra = []) => execFileSyncRetry(runner.cmd, [...runner.args, script, ...extra], {
      encoding: 'utf8', stdio: 'pipe', env,
    });
    // execFileSync отдаёт stderr только когда процесс падает (через
    // err.stderr в исключении) — на успешном (код 0) запуске stderr
    // недоступен вообще. Предупреждение о недостижимом minVersion печатается
    // именно на успешном запуске (файлы ставятся, код 0), поэтому нужен
    // отдельный помощник на spawnSync, который отдаёт stdout/stderr/status
    // независимо от того, упал процесс или нет.
    const runCapture = (extra = []) => {
      const r = spawnSyncRetry(runner.cmd, [...runner.args, script, ...extra], { encoding: 'utf8', env });
      return { stdout: r.stdout, stderr: r.stderr, status: r.status };
    };
    body({ sandbox, run, runCapture });
  } finally {
    await stub.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

// Ожидаемый вывод --dry-run для произвольного набора плагинов: тот же формат,
// что у dryRunLines выше, но не по настоящему манифесту.
const expectedDryRun = (plugins) => plugins.map((p) =>
  [p.id, p.repo, p.minVersion, p.vendored ? 'vendored' : 'remote'].join('\t')).join('\n') + '\n';

// Тексты сообщений — часть контракта паритета, а не деталь реализации: обе
// реализации обязаны печатать их ДОСЛОВНО и одинаково. Раньше проверялся
// только префикс ("FAIL ...: GitHub ответил 404", "WARN ...: установлена
// версия X, но манифест требует Y"), а весь хвост с объяснением, что делать,
// — то есть единственное, ради чего эти сообщения существуют, — не
// проверялся ни одним раннером. Опечатка, внесённая в .ps1 и не внесённая в
// .sh, оставляла все тесты зелёными и разводила инструкции для пользователей
// macOS и Windows. Константы общие для обоих раннеров именно поэтому: править
// их придётся один раз, и тогда расхождение реализаций сразу станет красным.
// Сверяем через includes, а не equal: на Windows строка приходит с хвостовым
// \r, и это ожидаемо (см. паритетные ограничения), а в stderr рядом могут
// стоять другие строки.
const EXPECTED_TEXT = {
  // Полный текст FAIL по 404 от API GitHub (describe_http_failure / Get-HttpFailureText).
  fail404: 'FAIL bad-plugin: GitHub ответил 404 — репозиторий мог быть переименован или удалён.'
    + ' Проверь и обнови obsidian-plugins.json.',
  // Полный текст WARN о недостижимом minVersion (стенд отдаёт ассет 0.5.68 при minVersion 0.5.70).
  warnUnreachableMinVersion: 'WARN stub-plugin: установлена версия 0.5.68, но манифест требует 0.5.70'
    + ' — такая версия недостижима из релизных ассетов owner/stub (тег релиза и manifest.json внутри'
    + " него расходятся version'ом). Поправь minVersion в obsidian-plugins.json на версию, которую"
    + ' реально отдают ассеты.',
  // Отказ на манифесте, из которого не разобралось ни одной записи. Путь к
  // манифесту в середине сообщения проверить дословно нельзя: bash под Git
  // Bash печатает /d/projects/..., а PowerShell — D:\projects\..., поэтому
  // текст сверяется двумя половинами вокруг пути.
  failNoPluginsHead: 'FAIL: манифест ',
  failNoPluginsTail: ' не дал ни одной записи плагина — проверь, что массив plugins не пуст'
    + ' и каждый объект плагина занимает ровно одну строку.',
};

// Дословная сверка сообщения: assert.match по префиксу пропускала бы правку
// хвоста в одной реализации из двух.
const assertContains = (actual, expected, what) =>
  assert.ok(String(actual).includes(expected),
    `${what}: текст обязан совпадать с эталоном дословно.\nожидали подстроку: ${JSON.stringify(expected)}\nполучено: ${JSON.stringify(actual)}`);

// Регресс на bash 3.2 (macOS) напрямую здесь не поймать: машина, где гоняются
// тесты, использует современный bash, а голый "$@" под nounset при пустом
// наборе позиционных параметров падает только на bash < 4.4. Это —
// поведенческая подстраховка к тексту исходника (тест выше про ${1+"$@"}):
// она ловит другую поломку того же места — откат к "${@:-}" вместо
// "${1+"$@"}", которая передаёт main ОДИН пустой аргумент вместо нуля и
// на современном bash тоже, попадая в ветку "Неизвестные аргументы".
test('bash: запуск без аргументов не попадает в ветку "Неизвестные аргументы"', async () => {
  await inSandbox(RUNNERS[0], {}, ({ run }) => {
    let err;
    try { run(); } catch (e) { err = e; }
    // Манифеста в песочнице нет, поэтому даже штатный запуск без аргументов
    // обязан упасть — но упасть на проверке манифеста (код 1), а не на
    // разборе аргументов (код 2 и текст "Неизвестные аргументы").
    assert.ok(err, 'без манифеста скрипт обязан выйти с ненулевым кодом');
    assert.notEqual(err.status, 2,
      `код возврата 2 — main получил лишний аргумент вместо нуля, guard откатили от \${1+"$@"}: ${JSON.stringify(err.stderr)}`);
    assert.doesNotMatch(err.stderr, /Неизвестные аргументы/,
      `запуск без аргументов не должен попадать в ветку неизвестных аргументов: ${JSON.stringify(err.stderr)}`);
    assert.match(err.stderr, /не найден манифест/,
      `ожидали ошибку про отсутствующий манифест: ${JSON.stringify(err.stderr)}`);
  }, DEFAULT_PLUGINS, null);
});

for (const runner of RUNNERS) {
  const skip = runner.skip || false;

  // Установочный путь целиком: скрипт ходит в подменённый GitHub, кладёт файлы
  // в .obsidian/plugins/<id>/ и пропускает отсутствующий styles.css.
  test(`${runner.name}: установщик кладёт файлы плагина и переживает отсутствие styles.css`, { skip }, async () => {
    await inSandbox(runner, {
      tag: '9.9.9',
      assets: { 'manifest.json': '{"version":"9.9.9"}', 'main.js': 'console.log(1)' },
    }, ({ sandbox, run }) => {
      run();
      const dir = join(sandbox, '.obsidian', 'plugins', 'stub-plugin');
      assert.equal(readFileSync(join(dir, 'main.js'), 'utf8'), 'console.log(1)');
      assert.equal(existsSync(join(dir, 'styles.css')), false, 'styles.css не должен создаваться');
    });
  });

  // Каталог, которого не было до запуска, при провале удаляется целиком —
  // иначе на диске остаётся полуустановленный плагин. В стенде нет даже
  // manifest.json, поэтому падение гарантировано.
  test(`${runner.name}: установщик убирает за собой при провале`, { skip }, async () => {
    await inSandbox(runner, { tag: '9.9.9', assets: {} }, ({ sandbox, run }) => {
      assert.throws(run, 'скрипт обязан выйти с ненулевым кодом');
      assert.equal(existsSync(join(sandbox, '.obsidian', 'plugins', 'stub-plugin')), false);
    });
  });

  // Регрессия на баг, который уже реально стрелял: один плагин ставится
  // успешно (печатает info-строку в stdout), другой падает на 404 API —
  // частичный провал обязан отдавать НЕНУЛЕВОЙ код возврата, а не молча
  // схлопываться в 0 из-за того, что info-сообщения об успехе смешиваются
  // с итоговым кодом выхода. Проверяем конкретный код (1 = один провал), а
  // не просто "бросило исключение": exit 0 не бросает исключение вообще, и
  // assert.throws такую регрессию бы не поймал.
  test(`${runner.name}: смешанный исход — один плагин ставится, другой падает на 404, код возврата ненулевой`, { skip }, async () => {
    const plugins = [
      { id: 'good-plugin', repo: 'owner/good', minVersion: '1.0.0', enabled: true },
      { id: 'bad-plugin', repo: 'owner/bad', minVersion: '1.0.0', enabled: true },
    ];
    await inSandbox(runner, {
      tag: '9.9.9',
      assets: { 'manifest.json': '{"version":"9.9.9"}', 'main.js': 'console.log(1)' },
      repos: { 'owner/bad': { apiStatus: 404 } },
    }, ({ sandbox, run }) => {
      let err;
      try { run(); } catch (e) { err = e; }
      assert.ok(err, 'скрипт обязан выйти с ненулевым кодом при частичном провале');
      assert.equal(err.status, 1, `код возврата должен быть ровно 1 (один провал), получено ${err.status}`);

      const goodDir = join(sandbox, '.obsidian', 'plugins', 'good-plugin');
      assert.equal(readFileSync(join(goodDir, 'main.js'), 'utf8'), 'console.log(1)',
        'успешный плагин обязан установиться, несмотря на провал соседнего');
      assert.equal(existsSync(join(sandbox, '.obsidian', 'plugins', 'bad-plugin')), false,
        'за упавшим плагином должно быть убрано');

      // Текст stderr — часть контракта, а не деталь реализации: пользователю
      // на Windows PowerShell 5.1 нужна ровно одна внятная строка. Возврат к
      // Write-Error оставил бы все проверки выше зелёными, а в консоли выдал
      // бы шестистрочный блок с CategoryInfo/FullyQualifiedErrorId вокруг
      // того же текста (ErrorView в 5.1 по умолчанию NormalView).
      assertContains(err.stderr, EXPECTED_TEXT.fail404, 'FAIL по 404 для bad-plugin');
      assert.doesNotMatch(err.stderr, /CategoryInfo/,
        'stderr содержит CategoryInfo — сообщение печатается через Write-Error вместо ' +
        '[Console]::Error.WriteLine, пользователь получит многострочный блок вместо одной строки: ' +
        JSON.stringify(err.stderr));
    }, plugins);
  });

  // Единственная ветка, регресс в которой уничтожает данные: каталог плагина
  // существовал ДО запуска (рабочая установка), обновление провалилось —
  // трогать его нельзя. Удаление проверки dir_existed / $dirExisted снесло бы
  // рабочий плагин при любом неудачном обновлении, и молча: все остальные
  // тесты остались бы зелёными.
  test(`${runner.name}: провал не трогает каталог, существовавший до запуска`, { skip }, async () => {
    await inSandbox(runner, { tag: '9.9.9', assets: {} }, ({ sandbox, run }) => {
      const dir = join(sandbox, '.obsidian', 'plugins', 'stub-plugin');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'marker.txt'), 'ранее установленный плагин');

      assert.throws(run, 'скрипт обязан выйти с ненулевым кодом: ассетов в стенде нет');
      assert.equal(existsSync(join(dir, 'marker.txt')), true,
        'провалившееся обновление снесло каталог, которого не создавало — потеря рабочей установки плагина');
      assert.equal(readFileSync(join(dir, 'marker.txt'), 'utf8'), 'ранее установленный плагин');
    });
  });

  // Дискриминирующий манифест для разбора "vendored": значение false стоит
  // ЛЕВЕЕ "enabled": true, а true — левее "enabled": false. Позиционный разбор
  // ("любой true правее ключа") дал бы здесь vendored на первой записи и
  // разошёлся бы с ConvertFrom-Json. По настоящему obsidian-plugins.json это
  // не ловится: единственная vendored-запись в нём истинна и стоит последней.
  test(`${runner.name}: "vendored" разбирается по значению, а не позиционно`, { skip }, async () => {
    const plugins = [
      { id: 'not-vendored', vendored: false, repo: 'owner/nv', minVersion: '1.0.0', enabled: true },
      { id: 'really-vendored', vendored: true, repo: 'owner/rv', minVersion: '2.0.0', enabled: false },
      { id: 'no-key', repo: 'owner/nk', minVersion: '3.0.0', enabled: true },
    ];
    await inSandbox(runner, {}, ({ run }) => {
      assert.equal(run([runner.dryRun]).replace(/\r\n/g, '\n'), expectedDryRun(plugins));
    }, plugins);
  });

  test(`${runner.name}: последняя строка манифеста без завершающего перевода строки не теряется`, { skip }, async () => {
    const plugins = [
      { id: 'first', repo: 'owner/first', minVersion: '1.0.0', enabled: true },
      { id: 'last', repo: 'owner/last', minVersion: '2.0.0', enabled: true },
    ];
    await inSandbox(runner, {}, ({ run }) => {
      assert.equal(run([runner.dryRun]).replace(/\r\n/g, '\n'), expectedDryRun(plugins));
    }, plugins, manifestTextNoTrailingNewline);
  });

  // Пропавший манифест — отказ, а не тихий успех: без явной проверки bash
  // возвращал 0 (редирект "< файл" падал, но код никто не смотрел), и
  // установочный цикл рапортовал, что всё в порядке, ничего не поставив.
  for (const mode of ['установка', '--dry-run']) {
    test(`${runner.name}: пропавший манифест — явная ошибка (${mode})`, { skip }, async () => {
      await inSandbox(runner, {}, ({ run }) => {
        let err;
        try { run(mode === '--dry-run' ? [runner.dryRun] : []); } catch (e) { err = e; }
        assert.ok(err, 'без манифеста скрипт обязан выйти с ненулевым кодом, а не отрапортовать успех');
        assert.match(err.stderr, /не найден манифест/,
          `в stderr нет объяснения про манифест: ${JSON.stringify(err.stderr)}`);
        assert.doesNotMatch(err.stderr, /CategoryInfo/,
          'stderr содержит CategoryInfo — вместо внятной строки пользователь получит исключение PowerShell');
      }, DEFAULT_PLUGINS, null);
    });
  }

  // Манифест на месте и непуст, но разбор не дал ни одной записи — отказ, а не
  // тихий успех. До этой проверки bash читал одну пустую строку, спотыкался о
  // "[ -z "$id" ] && continue" и выходил с кодом 0, не напечатав вообще ничего:
  // пользователь на macOS разумно решил бы, что всё поставилось. Именно так
  // выглядит расхождение реализаций, если BSD sed/grep -o разберут строки не
  // как GNU: на Windows тот же манифест ставится целиком через
  // ConvertFrom-Json. Проверяем оба режима: dry-run — единственный, которым
  // человек может убедиться, что установщик вообще видит его манифест, и
  // тихий пустой вывод там так же вреден.
  for (const mode of ['установка', '--dry-run']) {
    test(`${runner.name}: манифест без единой записи плагина — явная ошибка (${mode})`, { skip }, async () => {
      await inSandbox(runner, {}, ({ sandbox, run }) => {
        let err;
        try { run(mode === '--dry-run' ? [runner.dryRun] : []); } catch (e) { err = e; }
        assert.ok(err, 'манифест без плагинов обязан быть отказом с ненулевым кодом, а не тихим успехом');
        assert.equal(err.status, 1, `код возврата должен быть ровно 1, получено ${err.status}: ${JSON.stringify(err.stderr)}`);
        assert.equal(err.stdout, '', `в stdout не должно быть ничего: ${JSON.stringify(err.stdout)}`);
        assertContains(err.stderr, EXPECTED_TEXT.failNoPluginsHead, 'отказ на манифесте без плагинов (начало)');
        assertContains(err.stderr, EXPECTED_TEXT.failNoPluginsTail, 'отказ на манифесте без плагинов (хвост)');
        // Отличается от уже существующего случая "манифеста нет вовсе": это
        // разные поломки и чинятся они по-разному, поэтому и текст разный.
        assert.doesNotMatch(err.stderr, /не найден манифест/,
          `манифест есть — сообщение не должно быть про его отсутствие: ${JSON.stringify(err.stderr)}`);
        assert.doesNotMatch(err.stderr, /CategoryInfo/,
          'stderr содержит CategoryInfo — вместо внятной строки пользователь получит исключение PowerShell');
        assert.equal(existsSync(join(sandbox, '.obsidian')), false,
          'при отказе на разборе манифеста скрипт не должен трогать диск');
      }, DEFAULT_PLUGINS, manifestTextNoPlugins);
    });
  }

  // Регресс на реальный случай: tag_name latest-релиза dataview был 0.5.70,
  // а manifest.json ВНУТРИ этого же релиза нёс version 0.5.68 — тег и ассет
  // разошлись. Пока minVersion манифеста совпадает с тем, что реально даёт
  // ассет, это незаметно; но стоит поднять minVersion до тега (естественный
  // шаг после взгляда на "последний релиз" на GitHub) — и скрипт при КАЖДОМ
  // запуске молча перекачивал бы те же файлы заново, никогда не сходясь.
  // Предупреждение — не провал: файлы реально скачались и легли на диск,
  // причина не в сети и не в GitHub, а в самом манифесте, поэтому код
  // возврата остаётся 0, а сигнал уходит в stderr.
  test(`${runner.name}: недостижимый minVersion — предупреждение в stderr, файлы всё равно ставятся, код возврата 0`, { skip }, async () => {
    await inSandbox(runner, {
      tag: '9.9.9',
      assets: { 'manifest.json': '{"version":"0.5.68"}', 'main.js': 'console.log(1)' },
    }, ({ sandbox, runCapture }) => {
      const r = runCapture();
      assert.equal(r.status, 0, `код возврата обязан остаться 0: ${JSON.stringify(r)}`);

      const dir = join(sandbox, '.obsidian', 'plugins', 'stub-plugin');
      assert.equal(readFileSync(join(dir, 'main.js'), 'utf8'), 'console.log(1)',
        'файлы обязаны установиться, несмотря на недостижимый minVersion — предупреждение не отменяет установку');
      assert.match(r.stdout, /installed stub-plugin/,
        `в stdout нет строки об установке: ${JSON.stringify(r.stdout)}`);

      assertContains(r.stderr, EXPECTED_TEXT.warnUnreachableMinVersion,
        'WARN о недостижимом minVersion');
      assert.doesNotMatch(r.stderr, /CategoryInfo/,
        'stderr содержит CategoryInfo — предупреждение печатается не той функцией, что даёт паритет с bash');
    }, [{ id: 'stub-plugin', repo: 'owner/stub', minVersion: '0.5.70', enabled: true }]);
  });

  // "?" — тот же плейсхолдер, что и в info-строке "installed", когда
  // manifest.json не читается вовсе (пустые ассеты). Сравнивать "?" с
  // minVersion численно нечего: ложное предупреждение хуже отсутствующего,
  // поэтому в этом случае WARN не печатается.
  test(`${runner.name}: newv="?" не порождает WARN о недостижимом minVersion`, { skip }, async () => {
    await inSandbox(runner, {
      tag: '9.9.9',
      assets: { 'manifest.json': '{}', 'main.js': 'console.log(1)' },
    }, ({ runCapture }) => {
      const r = runCapture();
      assert.equal(r.status, 0, `код возврата обязан остаться 0: ${JSON.stringify(r)}`);
      assert.match(r.stdout, /installed stub-plugin \(\?\)/,
        `в stdout нет строки об установке с плейсхолдером версии: ${JSON.stringify(r.stdout)}`);
      assert.doesNotMatch(r.stderr, /WARN stub-plugin/,
        `WARN не должен печататься, когда версия неизвестна ("?"): ${JSON.stringify(r.stderr)}`);
    }, [{ id: 'stub-plugin', repo: 'owner/stub', minVersion: '0.5.70', enabled: true }]);
  });

  // Регресс, реально найденный на живой Windows PowerShell 5.1: без
  // [CmdletBinding()] непривязанный аргумент ("--dry-run" в unix-стиле по
  // привычке, любая опечатка) молча оседает в $args, ошибки биндинга не
  // происходит — скрипт спокойно шёл в настоящую установку вместо отказа.
  // bash-версия эту дыру уже закрывала (см. "пропавший манифест" выше);
  // здесь — паритет обеих реализаций. Стенд отдаёт настоящие ассеты, поэтому
  // если проверка аргументов отсутствует или сломана, каталог плагина
  // реально появится на диске, а не просто выживет какая-то ошибка позже.
  // НЕ упрощай стенд до assets: {} (как у соседних тестов выше): с пустыми
  // ассетами скрипт без проверки аргументов ушёл бы в установку, получил 404
  // на manifest.json, убрал за собой созданный каталог и вышел с кодом 1 —
  // и проверки "ошибка была" и "каталога нет" остались бы зелёными ПРИ
  // работающем баге. Код возврата и текст stderr ниже проверяются ровно
  // затем же: любой ненулевой код "по любой причине" тут не годится.
  test(`${runner.name}: неизвестный аргумент — явная ошибка, установка не идёт`, { skip }, async () => {
    await inSandbox(runner, {
      tag: '9.9.9',
      assets: { 'manifest.json': '{"version":"9.9.9"}', 'main.js': 'console.log(1)' },
    }, ({ sandbox, run }) => {
      let err;
      try { run(['--nonsense']); } catch (e) { err = e; }
      assert.ok(err, 'на неизвестном аргументе скрипт обязан выйти с ненулевым кодом, а не пойти в установку');
      assert.equal(err.status, 2,
        `код возврата на неизвестном аргументе обязан быть ровно 2 (разбор аргументов), получено ${err.status}: ${JSON.stringify(err.stderr)}`);
      assert.match(err.stderr, /Неизвестные аргументы/,
        `в stderr нет строки про неизвестные аргументы — скрипт упал по другой причине: ${JSON.stringify(err.stderr)}`);
      assert.equal(existsSync(join(sandbox, '.obsidian', 'plugins', 'stub-plugin')), false,
        'на неизвестном аргументе скрипт не должен трогать диск — каталог плагина не должен появляться');
    });
  });
}
