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
  'menu.file.exportPdf': 'Export PDF…',
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
  'menu.view.showBoneyard': 'Show Boneyard',
  'menu.view.showSynopses': 'Show Synopses',
  'menu.view.showSections': 'Show Sections',
  'menu.view.showTimeline': 'Show Timeline',
  'menu.view.increaseFont': 'Increase Font Size',
  'menu.view.decreaseFont': 'Decrease Font Size',
  'menu.view.focusMode': 'Focus Mode',
  'menu.view.typewriterMode': 'Typewriter Mode',
  'menu.view.theme': 'Theme',
  'menu.view.themeSystem': 'Follow System',
  'menu.view.themeLight': 'Light',
  'menu.view.themeDark': 'Dark',
  'menu.view.commandPalette': 'Command Palette…',
  'menu.view.fullscreen': 'Toggle Full Screen',
  'menu.view.devTools': 'Developer Tools',

  // ── Menu: Language ───────────────────────────────────────────────────────
  'menu.language': 'Language',

  // ── Spell checker ────────────────────────────────────────────────────────
  'spell.language': 'Spell-check Language',
  'spell.english': 'English',
  'spell.french': 'French',
  'spell.noSuggestions': 'No suggestions',
  'spell.addGlobal': 'Add “{word}” to Global Dictionary',

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
  'palette.title': 'Command Palette',
  'palette.search': 'Type a command…',
  'palette.empty': 'No matching command.',

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
  'status.appDataFailed': 'Could not save the screenplay layout.',
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

  // ── Sidebar and preview ───────────────────────────────────────────────────
  'sidebar.structure': 'Structure',
  'sidebar.title': 'Navigator',
  'sidebar.locations': 'Locations',
  'sidebar.characters': 'Characters',
  'sidebar.filterPlaceholder': 'Filter...',
  'sidebar.noResults': 'No results found.',
  'sidebar.loading': 'Analysing screenplay…',
  'sidebar.showSynopses': 'Show synopses',
  'sidebar.locationMixed': 'INT/EXT',
  'sidebar.occurrences': { one: '{count} occurrence', other: '{count} occurrences' },
  'sidebar.speeches': { one: '{count} speech', other: '{count} speeches' },
  'sidebar.words': { one: '{count} word', other: '{count} words' },
  'sidebar.close': 'Close navigator',
  'sidebar.show': 'Show navigator',
  'sidebar.resize': 'Resize navigator',
  'preview.title': 'Screenplay preview',
  'preview.syncScroll': 'Sync scroll with editor',
  'preview.loading': 'Preparing preview…',
  'preview.close': 'Close preview',
  'preview.show': 'Show preview',
  'preview.resize': 'Resize preview',

  // ── Timeline ─────────────────────────────────────────────────────────────
  'timeline.title': 'Timeline',
  'timeline.close': 'Close timeline',
  'timeline.show': 'Show timeline',
  'timeline.empty': 'Add scene headings to build the timeline.',
  'timeline.colors': 'Colours',
  'timeline.intExt': 'INT / EXT',
  'timeline.dayNight': 'Day / Night',
  'timeline.uniform': 'Uniform width',
  'timeline.zoom': 'Zoom',
  'timeline.other': 'Other',

  // ── Statistics ───────────────────────────────────────────────────────────
  'stats.title': 'Statistics',
  'stats.close': 'Close statistics',
  'stats.loading': 'Calculating statistics…',
  'stats.pages': 'pages',
  'stats.scenes': 'scenes',
  'stats.words': 'words',
  'stats.minutes': 'minutes',
  'stats.locations': 'locations',
  'stats.minutesPerPage': 'Minutes per page',
  'stats.balance': 'Screenplay balance',
  'stats.action': 'Action',
  'stats.dialogue': 'Dialogue',
  'stats.day': 'Day',
  'stats.night': 'Night',
  'stats.averageScene': 'Average scene',
  'stats.characters': 'Characters',
  'stats.speeches': 'speeches',
  'stats.exportCsv': 'Export CSV…',
  'stats.exportJson': 'Export JSON…',
  'status.exported': 'Exported — {path}',
  'status.exportFailed': 'Export failed: {error}',
  'pdf.title': 'Export PDF',
  'pdf.preview': 'PDF preview',
  'pdf.format': 'Paper format',
  'pdf.sceneNumbers': 'Scene numbers',
  'pdf.sceneNumbers.none': 'None',
  'pdf.sceneNumbers.left': 'Left',
  'pdf.sceneNumbers.right': 'Right',
  'pdf.sceneNumbers.both': 'Both sides',
  'pdf.includeNotes': 'Include notes',
  'pdf.includeSynopses': 'Include synopses',
  'pdf.headingsBold': 'Bold scene headings',
  'pdf.watermark': 'Watermark',
  'pdf.pageFrom': 'From page',
  'pdf.pageTo': 'To page',
  'pdf.export': 'Export…',
  'pdf.cancel': 'Cancel',
  'pdf.close': 'Close PDF export',
  'pdf.rendering': 'Rendering PDF…',
  'pdf.renderFailed': 'Could not render the PDF.',
  'pdf.previousPage': 'Previous page',
  'pdf.nextPage': 'Next page',
  'pdf.pageStatus': 'Page {page} of {count}',
} as const;
