// Единственное место, где тесты ищут PowerShell и запускают его.
//
// Два разных интерпретатора, оба реальные целевые среды: pwsh — PowerShell 7+,
// есть на Linux/macOS и на обоих раннерах CI; powershell — Windows PowerShell
// 5.1, то, что стоит на чистой Windows "из коробки", pwsh на ней обычно нет.
// Гоняем через каждый, какой реально найден в PATH; если не нашёлся ни один —
// тесты пропускаются с объяснением, а не падают.
import { execFileSync, spawnSync } from 'node:child_process';

// pwsh на раннерах GitHub изредка падает ещё до первой строки скрипта: .NET
// рушится при загрузке сборки ("Unhandled exception.
// System.IO.FileLoadException: The given assembly name was invalid", имя
// сборки в сообщении при этом побито). Скрипт не исполнялся, так что это сбой
// среды, а не регресс. Ошибки самого PowerShell-скрипта выглядят иначе (это
// записи об ошибках PS, а не необработанное .NET-исключение) и под повтор не
// попадают — настоящие падения по-прежнему валят тест.
const HOST_CRASH = /Unhandled exception\. System\./;
const ATTEMPTS = 3;

const isHostCrash = (stderr) => HOST_CRASH.test(String(stderr ?? ''));

// execFileSync с повтором при крахе .NET-хоста. Для bash и node безвреден:
// такой строки они не печатают.
export function execFileSyncRetry(cmd, args, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync(cmd, args, { stdio: 'pipe', ...opts });
    } catch (err) {
      if (attempt >= ATTEMPTS || !isHostCrash(err.stderr)) throw err;
    }
  }
}

// То же для spawnSync — там, где нужен stderr и на успешном запуске.
export function spawnSyncRetry(cmd, args, opts = {}) {
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync(cmd, args, opts);
    if (attempt >= ATTEMPTS || r.status === 0 || !isHostCrash(r.stderr)) return r;
  }
}

const PS_INTERPRETERS = [
  { label: 'pwsh', cmd: 'pwsh' },
  { label: 'Windows PowerShell 5.1', cmd: 'powershell' },
];

function hasInterpreter(cmd) {
  try {
    execFileSyncRetry(cmd, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major']);
    return true;
  } catch {
    return false;
  }
}

const availablePs = PS_INTERPRETERS.filter((s) => hasInterpreter(s.cmd));

// Пусто только когда в PATH нет вообще ни одного PowerShell — тогда один
// плейсхолдер-раннер со skip и внятной причиной вместо падения тестов.
export const psRunners = availablePs.length > 0
  ? availablePs
  : [{ label: 'PowerShell', cmd: null, skip: 'ни pwsh, ни powershell (Windows PowerShell 5.1) не найдены в PATH' }];
