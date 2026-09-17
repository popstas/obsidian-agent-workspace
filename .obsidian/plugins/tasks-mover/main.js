'use strict';

const {
  Plugin, Notice, Menu, MarkdownView, moment,
  SuggestModal, Keymap, prepareFuzzySearch, renderResults,
} = require('obsidian');

// CodeMirror's fold effect — Obsidian provides @codemirror/* to plugins as
// externals. Guarded so a missing module degrades gracefully instead of
// breaking the whole plugin load.
let foldEffect = null;
try { foldEffect = require('@codemirror/language').foldEffect; } catch (e) { /* noop */ }

const FILES = ['tasks.md', 'projects.md', 'tasks-future.md', 'tasks-snoozed.md', 'tasks-recurring.md', 'ideas.md'];
const TASK_RE = /^- \[.\] /;      // top-level task line (indent 0)
const DONE_RE = /^- \[x\] /i;     // top-level completed task line
const CHILD_RE = /^\s+\S/;        // indented child line
// any list line at any indent: `- `, `* `, `+ `, `1. `, `1) `, with an
// optional `[ ]` checkbox. Group 1 = indent, whole match = marker prefix.
const LIST_RE = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(?:\[.\][ \t]+)?/;

// ---- block extraction -----------------------------------------------------

// From the cursor line, walk up over indented children to the owning
// top-level task, then down over its children. Returns null if the owning
// line is not a task.
function getBlock(editor, cursorLine) {
  let start = cursorLine;
  while (start > 0 && CHILD_RE.test(editor.getLine(start))) start--;
  if (!TASK_RE.test(editor.getLine(start))) return null;

  const total = editor.lineCount();
  let end = start + 1;
  while (end < total && CHILD_RE.test(editor.getLine(end))) end++;

  let text = '';
  for (let i = start; i < end; i++) text += editor.getLine(i) + '\n';
  return { startLine: start, endLine: end, text };
}

// ---- insert-position resolution -------------------------------------------

function firstTaskIdx(lines, from, to) {
  for (let i = from; i < to; i++) if (TASK_RE.test(lines[i])) return i;
  return to;
}

// index right after the block owned by the task at line i
function blockEndIdx(lines, i) {
  let j = i + 1;
  while (j < lines.length && CHILD_RE.test(lines[j])) j++;
  return j;
}

// index after the last top-level task's block in [from, to); -1 if no tasks
function lastTaskEndIdx(lines, from, to) {
  let last = -1;
  for (let i = from; i < to; i++) if (TASK_RE.test(lines[i])) last = i;
  if (last === -1) return -1;
  return blockEndIdx(lines, last);
}

// index after the last top-level completed task's block in [from, to); -1 if none
function lastDoneTaskEndIdx(lines, from, to) {
  let last = -1;
  for (let i = from; i < to; i++) if (DONE_RE.test(lines[i])) last = i;
  if (last === -1) return -1;
  return blockEndIdx(lines, last);
}

// line right after a header, skipping one blank line
function headerFallback(lines, hdr) {
  let i = hdr + 1;
  if (i < lines.length && lines[i].trim() === '') i++;
  return i;
}

// Returns a line index at which to splice the block into `lines`.
function findInsert(lines, targetName, positionKey) {
  if (targetName === 'tasks.md') {
    const weekHdr = lines.findIndex(l => l === '# Week:');
    const weekPlusHdr = lines.findIndex(l => l === '# Week+');
    const isPlus = positionKey.startsWith('Week+');
    const isBegin = positionKey.endsWith('begin');

    let hdr, scopeFrom, scopeTo;
    if (isPlus) {
      hdr = weekPlusHdr;
      scopeFrom = weekPlusHdr;
      // footer/EOF = first trailing blockquote or header after the tasks
      let footer = lines.length;
      for (let i = weekPlusHdr + 1; i < lines.length; i++) {
        if (/^\s*>/.test(lines[i]) || /^#/.test(lines[i])) { footer = i; break; }
      }
      scopeTo = footer;
    } else {
      hdr = weekHdr;
      scopeFrom = weekHdr;
      scopeTo = weekPlusHdr === -1 ? lines.length : weekPlusHdr;
    }

    // header missing → fall back to whole-file behaviour
    if (hdr === -1) {
      return isBegin
        ? firstTaskIdx(lines, 0, lines.length)
        : Math.max(lastTaskEndIdx(lines, 0, lines.length), 0) || lines.length;
    }

    if (isBegin) {
      // "begin" = top of the OPEN tasks: skip past completed tasks that float
      // to the top of the block, landing right after the last `- [x]`.
      const doneEnd = lastDoneTaskEndIdx(lines, scopeFrom + 1, scopeTo);
      if (doneEnd !== -1) return doneEnd;
      const idx = firstTaskIdx(lines, scopeFrom + 1, scopeTo);
      return idx === scopeTo ? headerFallback(lines, hdr) : idx;
    }
    const idx = lastTaskEndIdx(lines, scopeFrom + 1, scopeTo);
    return idx === -1 ? headerFallback(lines, hdr) : idx;
  }

  // generic files: scope is the whole file
  if (positionKey === 'begin') return firstTaskIdx(lines, 0, lines.length);
  const idx = lastTaskEndIdx(lines, 0, lines.length);
  return idx === -1 ? lines.length : idx;
}

// ---- iconize integration --------------------------------------------------

// Icon assigned to a vault file (emoji or an Iconize icon name), or null.
// Iconize keeps per-path icons in `plugin.data[path]`; frontmatter `icon` is a fallback.
function fileIcon(app, path) {
  const iconize = app.plugins.getPlugin('obsidian-icon-folder');
  const entry = iconize && iconize.data ? iconize.data[path] : null;
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && entry.iconName) return entry.iconName;

  const tf = app.vault.getAbstractFileByPath(path);
  const cache = tf && app.metadataCache.getFileCache(tf);
  return (cache && cache.frontmatter && cache.frontmatter.icon) || null;
}

// Set a menu item's title, prefixing it with the file's Iconize icon.
// Emoji are inlined as text; named Iconize icons are rendered as inline SVG.
function setItemTitle(app, item, iconName, label) {
  if (!iconName) { item.setTitle(label); return; }

  // emoji → prepend directly (Iconize stores emoji verbatim)
  if (/\p{Extended_Pictographic}/u.test(iconName)) {
    item.setTitle(`${iconName} ${label}`);
    return;
  }

  // named Iconize icon → pull its SVG via the plugin API
  const iconize = app.plugins.getPlugin('obsidian-icon-folder');
  const svg = iconize && iconize.api && iconize.api.getIconByName
    ? (iconize.api.getIconByName(iconName) || {}).svgElement
    : null;
  if (!svg) { item.setTitle(label); return; }

  const frag = document.createDocumentFragment();
  const wrap = document.createElement('span');
  wrap.style.display = 'inline-flex';
  wrap.style.alignItems = 'center';
  wrap.style.gap = '6px';
  const iconSpan = document.createElement('span');
  iconSpan.innerHTML = svg;
  const s = iconSpan.querySelector('svg');
  if (s) { s.setAttribute('width', '16'); s.setAttribute('height', '16'); }
  wrap.appendChild(iconSpan);
  wrap.appendChild(document.createTextNode(label));
  frag.appendChild(wrap);
  item.setTitle(frag);
}

// Populate a Menu with the flat "<file>: <position>" move leaves.
function addMoveItems(plugin, menu, editor, file, block) {
  let first = true;
  for (const target of FILES) {
    const label = target.replace(/\.md$/, '');
    const icon = fileIcon(plugin.app, target);
    const positions = target === 'tasks.md'
      ? ['Week begin', 'Week end', 'Week+ begin', 'Week+ end']
      : ['begin', 'end'];
    if (!first) menu.addSeparator();
    first = false;
    let prevKey = null;
    for (const key of positions) {
      // divide the Week group from the Week+ group inside tasks.md
      if (prevKey && !prevKey.startsWith('Week+') && key.startsWith('Week+')) {
        menu.addSeparator();
      }
      prevKey = key;
      menu.addItem(li => {
        setItemTitle(plugin.app, li, icon, `${label}: ${key}`);
        li.onClick(() => moveBlock(plugin, editor, file, block, target, key));
      });
    }
  }
}

// ---- the move --------------------------------------------------------------

async function moveBlock(plugin, editor, srcFile, block, targetPath, positionKey) {
  // remove the block from the source editor (keeps undo + scroll)
  const total = editor.lineCount();
  let from = { line: block.startLine, ch: 0 };
  let to;
  if (block.endLine < total) {
    to = { line: block.endLine, ch: 0 };
  } else {
    // block reaches EOF: consume the preceding newline instead
    to = { line: block.endLine - 1, ch: editor.getLine(block.endLine - 1).length };
    if (block.startLine > 0) {
      from = { line: block.startLine - 1, ch: editor.getLine(block.startLine - 1).length };
    }
  }
  editor.replaceRange('', from, to);

  if (targetPath === srcFile.name) {
    const lines = editor.getValue().split('\n');
    const idx = findInsert(lines, targetPath, positionKey);
    const lastLine = editor.lastLine();
    if (idx > lastLine) {
      const end = { line: lastLine, ch: editor.getLine(lastLine).length };
      editor.replaceRange('\n' + block.text.replace(/\n$/, ''), end);
    } else {
      editor.replaceRange(block.text, { line: idx, ch: 0 });
    }
  } else {
    const tf = plugin.app.vault.getAbstractFileByPath(targetPath);
    if (!tf) { new Notice(`Move failed: ${targetPath} not found`); return; }
    await plugin.app.vault.process(tf, data => {
      const lines = data.split('\n');
      const idx = findInsert(lines, targetPath, positionKey);
      lines.splice(idx, 0, ...block.text.replace(/\n$/, '').split('\n'));
      return lines.join('\n');
    });
  }

  new Notice(`Moved to ${targetPath} (${positionKey})`);
}

// ---- fold completed tasks --------------------------------------------------

// Fold the children of every top-level completed (`- [x]`) task inside the
// `# Week:` section, mirroring how Obsidian folds a list item by hand.
// Returns the number of tasks folded (-1 if the fold API is unavailable).
function foldDoneInWeek(editor) {
  const cm = editor.cm;
  if (!cm || !foldEffect) return foldEffect ? 0 : -1;

  const total = editor.lineCount();
  let weekHdr = -1, weekPlusHdr = -1;
  for (let i = 0; i < total; i++) {
    const l = editor.getLine(i);
    if (weekHdr === -1 && l === '# Week:') weekHdr = i;
    else if (l === '# Week+') { weekPlusHdr = i; break; }
  }
  if (weekHdr === -1) return 0;
  const scopeTo = weekPlusHdr === -1 ? total : weekPlusHdr;

  const effects = [];
  for (let i = weekHdr + 1; i < scopeTo; i++) {
    if (!DONE_RE.test(editor.getLine(i))) continue;
    // walk down over the task's indented children
    let end = i + 1;
    while (end < scopeTo && CHILD_RE.test(editor.getLine(end))) end++;
    if (end === i + 1) continue; // childless — nothing to fold
    const lastChild = end - 1;
    const from = editor.posToOffset({ line: i, ch: editor.getLine(i).length });
    const to = editor.posToOffset({ line: lastChild, ch: editor.getLine(lastChild).length });
    effects.push(foldEffect.of({ from, to }));
    i = end - 1; // skip past the children we just consumed
  }
  if (effects.length) cm.dispatch({ effects });
  return effects.length;
}

// ---- recent-files switcher -------------------------------------------------

// Quick switcher clone that keeps the list in modified-time order: newest file
// first, always — a query only filters, it never re-ranks (that is the whole
// point of this modal, so no fuzzy score sorting here).
class RecentFilesModal extends SuggestModal {
  constructor(app) {
    super(app);
    this.limit = 100;
    this.setPlaceholder('Recently modified files…');
    this.setInstructions([
      { command: '↑↓', purpose: 'navigate' },
      { command: '↵', purpose: 'open' },
      { command: 'Mod ↵', purpose: 'open in new tab' },
      { command: 'esc', purpose: 'dismiss' },
    ]);
  }

  // All openable files like the core switcher does, minus the ones excluded in
  // Settings → Files & Links (here: `files/`), so attachments do not flood the
  // top of an mtime-sorted list.
  files() {
    const mc = this.app.metadataCache;
    const ignored = typeof mc.isUserIgnored === 'function' ? p => mc.isUserIgnored(p) : () => false;
    return this.app.vault.getFiles()
      .filter(f => !ignored(f.path))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
  }

  getSuggestions(query) {
    const files = this.files();
    const q = query.trim();
    if (!q) return files.map(file => ({ file, match: null }));

    const fuzzy = prepareFuzzySearch(q);
    const out = [];
    for (const file of files) {
      // match on the path so «Log/2026» narrows by folder too
      if (!fuzzy(file.path.replace(/\.md$/, ''))) continue;
      out.push({ file, match: fuzzy(file.basename) });
    }
    return out;
  }

  renderSuggestion(item, el) {
    const content = el.createDiv({ cls: 'suggestion-content' });
    const title = content.createDiv({ cls: 'suggestion-title' });
    const name = item.file.extension === 'md' ? item.file.basename : item.file.name;
    renderResults(title, name, item.match || { score: 0, matches: [] });

    const dir = item.file.parent && item.file.parent.path !== '/' ? item.file.parent.path : '';
    const when = moment(item.file.stat.mtime).format('YYYY-MM-DD HH:mm');
    content.createDiv({ cls: 'suggestion-note', text: dir ? `${when} · ${dir}` : when });
  }

  onChooseSuggestion(item, evt) {
    this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(item.file);
  }
}

// ---- plugin ---------------------------------------------------------------

module.exports = class TasksMoverPlugin extends Plugin {
  onload() {
    this.addCommand({
      id: 'insert-created-date',
      name: 'Insert created date ( ➕ YYYY-MM-DD )',
      icon: 'calendar-plus',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'd' }],
      editorCallback: editor => {
        editor.replaceSelection(' ➕ ' + moment().format('YYYY-MM-DD'));
      },
    });

    this.addCommand({
      id: 'open-recent-files',
      name: 'Open file by modified time…',
      icon: 'clock',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'o' }],
      callback: () => new RecentFilesModal(this.app).open(),
    });

    this.addCommand({
      id: 'reload-plugin',
      name: 'Reload this plugin (tasks-mover)',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'r' }],
      callback: async () => {
        const id = this.manifest.id;
        const plugins = this.app.plugins;
        await plugins.disablePlugin(id);
        await plugins.enablePlugin(id);
        new Notice(`Reloaded plugin: ${id}`);
      },
    });

    this.addCommand({
      id: 'fold-done-tasks',
      name: 'Fold completed tasks in # Week:',
      editorCallback: editor => {
        const n = foldDoneInWeek(editor);
        if (n === -1) new Notice('Fold API unavailable (@codemirror/language)');
        else new Notice(n ? `Folded ${n} completed task(s)` : 'No completed tasks with children in # Week:');
      },
    });

    // Auto-fold completed tasks whenever tasks.md is opened.
    this.registerEvent(this.app.workspace.on('file-open', file => {
      if (!file || file.name !== 'tasks.md') return;
      // defer so the editor is mounted and Obsidian's own fold-restore has run
      window.setTimeout(() => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view && view.file === file && view.editor) foldDoneInWeek(view.editor);
      }, 100);
    }));

    this.addCommand({
      id: 'split-task-tail-to-child',
      name: 'Split list item tail into child bullet',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 's' }],
      editorCheckCallback: (checking, editor) => {
        const cur = editor.getCursor();
        const line = editor.getLine(cur.line);
        const marker = line.match(LIST_RE);
        if (!marker) return false;                    // only on a list line
        if (cur.ch <= marker[0].length) return false; // no title left of the cursor

        const dateRe = /\s*➕\s*\d{4}-\d{2}-\d{2}/;
        const after = line.slice(cur.ch);
        // drop the ➕date, then leading separators (dash/dot/comma/colon):
        // « … — url» → «url», «…: детали» → «детали»
        const afterClean = after.replace(dateRe, '').trim().replace(/^[\s.,:;—–-]+/, '');
        if (!afterClean) return false; // nothing to move past the cursor
        if (checking) return true;

        const m = line.match(dateRe);
        const date = m ? '➕ ' + m[0].match(/\d{4}-\d{2}-\d{2}/)[0] : null;
        const title = line.slice(0, cur.ch).replace(dateRe, '').replace(/\s+$/, '');
        const firstLine = date ? `${title} ${date}` : title;
        const childLine = `${marker[1]}\t- ${afterClean}`;

        editor.replaceRange(
          firstLine + '\n' + childLine,
          { line: cur.line, ch: 0 },
          { line: cur.line, ch: line.length }
        );
        editor.setCursor({ line: cur.line, ch: title.length });
        return true;
      },
    });

    this.addCommand({
      id: 'move-task',
      name: 'Move task…',
      icon: 'arrow-right-circle',
      hotkeys: [{ modifiers: ['Mod', 'Shift'], key: 'x' }],
      editorCheckCallback: (checking, editor, ctx) => {
        const file = ctx.file;
        if (!file || !FILES.includes(file.name)) return false;
        const block = getBlock(editor, editor.getCursor().line);
        if (!block) return false;
        if (checking) return true;

        const menu = new Menu();
        addMoveItems(this, menu, editor, file, block);

        // open at the caret; fall back to viewport centre
        const cm = editor.cm;
        const pos = editor.posToOffset(editor.getCursor());
        const c = cm && cm.coordsAtPos ? cm.coordsAtPos(pos) : null;
        if (c) menu.showAtPosition({ x: c.left, y: c.bottom });
        else menu.showAtPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
        return true;
      },
    });

    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      if (!view.file || !FILES.includes(view.file.name)) return;

      const block = getBlock(editor, editor.getCursor().line);
      if (!block) return;

      // A single-level submenu (flat leaves). Obsidian's 3rd-level submenus are
      // buggy (open once, then stick), so positions are inlined into the label.
      menu.addItem(item => {
        item.setTitle('Move');
        item.setIcon('arrow-right-circle');
        addMoveItems(this, item.setSubmenu(), editor, view.file, block);
      });
    }));
  }
};
