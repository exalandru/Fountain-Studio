/**
 * English catalogue — the reference locale.
 *
 * This object defines the message keys and their shape for every other locale:
 * `Catalog` is derived from it, so a translation that misses a key or uses the wrong
 * plural shape fails to compile. Adding a message therefore means adding it here first.
 *
 * Placeholders use `{name}` syntax. A message with plural forms is an object keyed by
 * CLDR plural categories; the category is selected from the `count` parameter.
 *
 * Fountain syntax itself is never translated — `Title:`, `INT.`, `TO:` and friends are
 * part of the file format, not of the interface.
 */
export const en = {
  // ── Application ──────────────────────────────────────────────────────────
  'app.name': 'Quantum Draft',
  'window.title': '{name} — Quantum Draft',

  // ── Menu: application (macOS) ────────────────────────────────────────────
  'menu.app.about': 'About {app}',
  'menu.app.services': 'Services',
  'menu.app.hide': 'Hide {app}',
  'menu.app.hideOthers': 'Hide Others',
  'menu.app.unhide': 'Show All',
  'menu.app.quit': 'Quit',

  // ── Menu: File ───────────────────────────────────────────────────────────
  'menu.file': 'File',
  'menu.file.new': 'New Screenplay',
  'menu.file.open': 'Open…',
  'menu.file.openRecent': 'Open Recent',
  'menu.file.noRecent': 'No Recent Files',
  'menu.file.clearRecent': 'Clear Menu',
  'menu.file.save': 'Save',
  'menu.file.saveAs': 'Save As…',
  'menu.file.closeTab': 'Close Tab',

  // ── Menu: Edit ───────────────────────────────────────────────────────────
  'menu.edit': 'Edit',
  'menu.edit.undo': 'Undo',
  'menu.edit.redo': 'Redo',
  'menu.edit.cut': 'Cut',
  'menu.edit.copy': 'Copy',
  'menu.edit.paste': 'Paste',
  'menu.edit.selectAll': 'Select All',
  'menu.edit.find': 'Find…',
  'menu.edit.replace': 'Find and Replace…',
  'menu.edit.renumberScenes': 'Number Scenes',

  // ── Menu: View ───────────────────────────────────────────────────────────
  'menu.view': 'View',
  'menu.view.showNotes': 'Show Notes',
  'menu.view.showSynopses': 'Show Synopses',
  'menu.view.showSections': 'Show Sections',
  'menu.view.increaseFont': 'Increase Font Size',
  'menu.view.decreaseFont': 'Decrease Font Size',
  'menu.view.fullscreen': 'Toggle Full Screen',
  'menu.view.devTools': 'Developer Tools',

  // ── Menu: Language ───────────────────────────────────────────────────────
  'menu.language': 'Language',

  // ── Menu: Window and Help ────────────────────────────────────────────────
  'menu.window': 'Window',
  'menu.window.minimize': 'Minimize',
  'menu.window.zoom': 'Zoom',
  'menu.window.front': 'Bring All to Front',
  'menu.window.close': 'Close',
  'menu.help': 'Help',
  'menu.help.fountainSyntax': 'Fountain Syntax',
  'menu.help.about': 'About {app}',

  // ── Native dialogs ───────────────────────────────────────────────────────
  'dialog.open.title': 'Open a screenplay',
  'dialog.save.title': 'Save screenplay',
  'dialog.filter.fountain': 'Fountain screenplay',
  'dialog.filter.text': 'Text',
  'dialog.filter.all': 'All files',
  'dialog.discard.message': 'Save changes to “{name}”?',
  'dialog.discard.detail': 'Your changes will be lost if you don’t save them.',
  'dialog.discard.save': 'Save',
  'dialog.discard.dontSave': 'Don’t Save',
  'dialog.discard.cancel': 'Cancel',
  'dialog.openError.title': 'Cannot open file',
  'dialog.openError.body': '{name} could not be opened.\n\n{error}',

  // ── Tabs and workspace ───────────────────────────────────────────────────
  'tab.new': 'New screenplay',
  'tab.close': 'Close {name}',
  'workspace.empty': 'No document open',
  'document.untitled': 'Untitled',
  'document.recovered': 'Recovered document',

  // ── Status bar ───────────────────────────────────────────────────────────
  'status.scenes': { one: '{count} scene', other: '{count} scenes' },
  'status.words': { one: '{count} word', other: '{count} words' },
  'status.characters': { one: '{count} character', other: '{count} characters' },
  'status.locations': { one: '{count} location', other: '{count} locations' },
  'status.warnings': { one: '{count} warning', other: '{count} warnings' },
  'status.analysis': 'analysis {ms} ms',
  'status.saved': 'Saved — {time}',
  'status.conflict': 'The file was changed outside the application. Use “Save As…”.',
  'status.saveFailed': 'Save failed: {error}',
  'status.recovered': {
    one: '{count} document recovered after an unexpected shutdown. Check its contents before saving.',
    other:
      '{count} documents recovered after an unexpected shutdown. Check their contents before saving.',
  },
  'status.unsupportedFormat': 'Unsupported format: {files}',
  'status.renumberPlanned': 'Scene numbering: planned for milestone M2.',
  'status.about': '{app} {version}',

  // ── New document template ────────────────────────────────────────────────
  // Only the values are translated; the Fountain title-page keys are syntax.
  'template.titleValue': 'Untitled',
  'template.creditValue': 'Written by',

  // ── Parser diagnostics ───────────────────────────────────────────────────
  // The parser reports a code, never a sentence: it runs in a worker with no notion of
  // the interface language. The wording lives here.
  'diagnostic.unterminatedBoneyard':
    'Unterminated boneyard: all text to the end of the file is ignored.',
  'diagnostic.unterminatedNote': 'Unterminated note: the closing `]]` is missing.',
  'diagnostic.duplicateSceneNumber': 'Scene number “{number}” is already used on line {line}.',
} as const;
