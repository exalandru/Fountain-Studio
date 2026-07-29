import type { Catalog } from './types.js';

/**
 * French catalogue.
 *
 * Typed as `Catalog`, which is derived from the English reference: a missing key or a
 * wrong plural shape is a compile error, so translations cannot silently drift.
 *
 * Note on plurals: French treats 0 as singular ("0 scène"), unlike English ("0 scenes").
 * That is handled by Intl.PluralRules, not by the catalogue.
 */
export const fr: Catalog = {
  // ── Application ──────────────────────────────────────────────────────────
  'app.name': 'Quantum Draft',
  'window.title': '{name} — Quantum Draft',

  // ── Menu : application (macOS) ───────────────────────────────────────────
  'menu.app.about': 'À propos de {app}',
  'menu.app.services': 'Services',
  'menu.app.hide': 'Masquer {app}',
  'menu.app.hideOthers': 'Masquer les autres',
  'menu.app.unhide': 'Tout afficher',
  'menu.app.quit': 'Quitter',

  // ── Menu : Fichier ───────────────────────────────────────────────────────
  'menu.file': 'Fichier',
  'menu.file.new': 'Nouveau scénario',
  'menu.file.open': 'Ouvrir…',
  'menu.file.openRecent': 'Ouvrir un fichier récent',
  'menu.file.noRecent': 'Aucun fichier récent',
  'menu.file.clearRecent': 'Effacer le menu',
  'menu.file.save': 'Enregistrer',
  'menu.file.saveAs': 'Enregistrer sous…',
  'menu.file.exportPdf': 'Exporter en PDF…',
  'menu.file.closeTab': 'Fermer l’onglet',

  // ── Menu : Édition ───────────────────────────────────────────────────────
  'menu.edit': 'Édition',
  'menu.edit.undo': 'Annuler',
  'menu.edit.redo': 'Rétablir',
  'menu.edit.cut': 'Couper',
  'menu.edit.copy': 'Copier',
  'menu.edit.paste': 'Coller',
  'menu.edit.selectAll': 'Tout sélectionner',
  'menu.edit.find': 'Rechercher…',
  'menu.edit.replace': 'Rechercher et remplacer…',
  'menu.edit.renumberScenes': 'Numéroter les scènes',

  // ── Menu : Affichage ─────────────────────────────────────────────────────
  'menu.view': 'Affichage',
  'menu.view.showNotes': 'Afficher les notes',
  'menu.view.showBoneyard': 'Afficher les commentaires masqués',
  'menu.view.showSynopses': 'Afficher les synopsis',
  'menu.view.showSections': 'Afficher les sections',
  'menu.view.showSceneNumbers': 'Afficher les numéros de scène',
  'menu.view.showTimeline': 'Afficher la timeline',
  'menu.view.increaseFont': 'Agrandir la police',
  'menu.view.decreaseFont': 'Réduire la police',
  'menu.view.focusMode': 'Mode focus',
  'menu.view.typewriterMode': 'Mode machine à écrire',
  'menu.view.theme': 'Thème',
  'menu.view.themeSystem': 'Suivre le système',
  'menu.view.themeLight': 'Clair',
  'menu.view.themeDark': 'Sombre',
  'menu.view.commandPalette': 'Palette de commandes…',
  'menu.view.fullscreen': 'Plein écran',
  'menu.view.devTools': 'Outils de développement',

  // ── Menu : Langue ────────────────────────────────────────────────────────
  'menu.language': 'Langue',

  // ── Correcteur orthographique ────────────────────────────────────────────
  'spell.language': 'Langue du correcteur',
  'spell.english': 'Anglais',
  'spell.french': 'Français',
  'spell.noSuggestions': 'Aucune suggestion',
  'spell.addGlobal': 'Ajouter « {word} » au dictionnaire global',

  // ── Menu : Fenêtre et Aide ───────────────────────────────────────────────
  'menu.window': 'Fenêtre',
  'menu.window.minimize': 'Réduire',
  'menu.window.zoom': 'Agrandir',
  'menu.window.front': 'Tout ramener au premier plan',
  'menu.window.close': 'Fermer',
  'menu.help': 'Aide',
  'menu.help.fountainSyntax': 'Syntaxe Fountain',
  'menu.help.about': 'À propos de {app}',

  // ── Dialogues natifs ─────────────────────────────────────────────────────
  'dialog.open.title': 'Ouvrir un scénario',
  'dialog.save.title': 'Enregistrer le scénario',
  'dialog.filter.fountain': 'Scénario Fountain',
  'dialog.filter.text': 'Texte',
  'dialog.filter.all': 'Tous les fichiers',
  'dialog.discard.message': 'Enregistrer les modifications de « {name} » ?',
  'dialog.discard.detail': 'Vos modifications seront perdues si vous ne les enregistrez pas.',
  'dialog.discard.save': 'Enregistrer',
  'dialog.discard.dontSave': 'Ne pas enregistrer',
  'dialog.discard.cancel': 'Annuler',
  'dialog.openError.title': 'Ouverture impossible',
  'dialog.openError.body': '{name} n’a pas pu être ouvert.\n\n{error}',

  // ── Onglets et espace de travail ─────────────────────────────────────────
  'tab.new': 'Nouveau scénario',
  'tab.close': 'Fermer {name}',
  'workspace.empty': 'Aucun document ouvert',
  'document.untitled': 'Sans titre',
  'document.recovered': 'Document récupéré',
  'palette.title': 'Palette de commandes',
  'palette.search': 'Saisissez une commande…',
  'palette.empty': 'Aucune commande correspondante.',
  'toolbar.modes': 'Modes d’écriture et apparence',
  'toolbar.focus': 'Focus',
  'toolbar.focusHint': 'Masquer les panneaux secondaires pour se concentrer sur l’éditeur',
  'toolbar.exitFocus': 'Quitter le focus',
  'toolbar.typewriter': 'Machine à écrire',
  'toolbar.typewriterHint':
    'Garder la ligne active centrée pendant la saisie et les déplacements au clavier',
  'toolbar.sceneNumbers': 'Numéros de scène',
  'toolbar.theme': 'Thème',

  // ── Barre d’état ─────────────────────────────────────────────────────────
  'status.scenes': { one: '{count} scène', other: '{count} scènes' },
  'status.words': { one: '{count} mot', other: '{count} mots' },
  'status.characters': { one: '{count} personnage', other: '{count} personnages' },
  'status.locations': { one: '{count} lieu', other: '{count} lieux' },
  'status.warnings': { one: '{count} avertissement', other: '{count} avertissements' },
  'status.analysis': 'analyse {ms} ms',
  'status.saved': 'Enregistré — {time}',
  'status.conflict':
    'Le fichier a été modifié en dehors de l’application. Utilisez « Enregistrer sous… ».',
  'status.saveFailed': 'Échec de l’enregistrement : {error}',
  'status.appDataFailed': 'Impossible d’enregistrer la disposition du scénario.',
  'status.recovered': {
    one: '{count} document récupéré après un arrêt inattendu. Vérifiez le contenu avant d’enregistrer.',
    other:
      '{count} documents récupérés après un arrêt inattendu. Vérifiez le contenu avant d’enregistrer.',
  },
  'status.unsupportedFormat': 'Format non pris en charge : {files}',
  'status.renumberPlanned': 'Numérotation des scènes : prévue au jalon M2.',
  'status.about': '{app} {version}',

  // ── Modèle de nouveau document ───────────────────────────────────────────
  'template.titleValue': 'Sans titre',
  'template.creditValue': 'Écrit par',

  // ── Diagnostics du parser ────────────────────────────────────────────────
  'diagnostic.unterminatedBoneyard':
    'Boneyard non fermé : tout le texte jusqu’à la fin du fichier est ignoré.',
  'diagnostic.unterminatedNote': 'Note non fermée : le `]]` de fermeture est absent.',
  'diagnostic.duplicateSceneNumber':
    'Le numéro de scène « {number} » est déjà utilisé à la ligne {line}.',

  // ── Sidebar and preview ───────────────────────────────────────────────────
  'sidebar.structure': 'Structure',
  'sidebar.title': 'Navigateur',
  'sidebar.locations': 'Lieux',
  'sidebar.characters': 'Personnages',
  'sidebar.syntax': 'Mémo',
  'sidebar.syntaxIntro':
    'Un rappel rapide de Fountain. Saisissez directement les exemples dans l’éditeur.',
  'sidebar.syntax.titlePage': 'Page de garde',
  'sidebar.syntax.sceneHeading': 'Heading de scène',
  'sidebar.syntax.action': 'Action',
  'sidebar.syntax.character': 'Personnage et dialogue',
  'sidebar.syntax.transition': 'Transition',
  'sidebar.syntax.structure': 'Sections et synopsis',
  'sidebar.syntax.emphasis': 'Mise en forme',
  'sidebar.syntax.notes': 'Notes et commentaires masqués',
  'sidebar.syntax.special': 'Éléments forcés et saut de page',
  'sidebar.syntax.exampleTitle':
    'Title: Mon film\nAuthor: Prénom Nom\nDraft date: 29/07/2026\nVersion: 1.0',
  'sidebar.syntax.exampleScene': 'INT. CUISINE - JOUR #1#\nEXT. RUE - NUIT',
  'sidebar.syntax.exampleAction': 'Une tasse tombe au sol.',
  'sidebar.syntax.exampleDialogue': 'ALICE (V.O.)\nJe me souviens de cette nuit.',
  'sidebar.syntax.exampleTransition': '> FONDU AU NOIR.\n> COUPURE:',
  'sidebar.syntax.exampleStructure': '# Acte 1\n## Séquence\n= Le héros fait son choix.',
  'sidebar.syntax.exampleEmphasis': '*italique*  **gras**\n_souligné_  ***les deux***',
  'sidebar.syntax.exampleNotes': '[[ note de travail ]]\n/* commentaire masqué */',
  'sidebar.syntax.exampleSpecial': '.Heading forcé\n@PERSONNAGE\n~ Paroles\n===',
  'sidebar.filterPlaceholder': 'Filtre...',
  'sidebar.noResults': 'Aucun résultat.',
  'sidebar.loading': 'Analyse du scénario…',
  'sidebar.showSynopses': 'Afficher les synopsis',
  'sidebar.locationMixed': 'INT/EXT',
  'sidebar.occurrences': { one: '{count} occurrence', other: '{count} occurrences' },
  'sidebar.speeches': { one: '{count} réplique', other: '{count} répliques' },
  'sidebar.words': { one: '{count} mot', other: '{count} mots' },
  'sidebar.close': 'Fermer le navigateur',
  'sidebar.show': 'Afficher le navigateur',
  'sidebar.resize': 'Redimensionner le navigateur',
  'preview.title': 'Aperçu du scénario',
  'preview.syncScroll': 'Synchroniser le défilement',
  'preview.loading': 'Préparation de l’aperçu…',
  'preview.close': 'Fermer l’aperçu',
  'preview.show': 'Afficher l’aperçu',
  'preview.resize': 'Redimensionner l’aperçu',

  // ── Timeline ─────────────────────────────────────────────────────────────
  'timeline.title': 'Timeline',
  'timeline.close': 'Fermer la timeline',
  'timeline.show': 'Afficher la timeline',
  'timeline.empty': 'Ajoutez des headings de scène pour construire la timeline.',
  'timeline.colors': 'Couleurs',
  'timeline.intExt': 'INT / EXT',
  'timeline.dayNight': 'Jour / Nuit',
  'timeline.uniform': 'Largeur uniforme',
  'timeline.zoom': 'Zoom',
  'timeline.other': 'Autre',

  // ── Statistiques ─────────────────────────────────────────────────────────
  'stats.title': 'Statistiques',
  'stats.close': 'Fermer les statistiques',
  'stats.loading': 'Calcul des statistiques…',
  'stats.pages': 'pages',
  'stats.scenes': 'scènes',
  'stats.words': 'mots',
  'stats.minutes': 'minutes',
  'stats.locations': 'lieux',
  'stats.minutesPerPage': 'Minutes par page',
  'stats.balance': 'Équilibre du scénario',
  'stats.action': 'Action',
  'stats.dialogue': 'Dialogue',
  'stats.day': 'Jour',
  'stats.night': 'Nuit',
  'stats.averageScene': 'Scène moyenne',
  'stats.characters': 'Personnages',
  'stats.speeches': 'répliques',
  'stats.exportCsv': 'Exporter en CSV…',
  'stats.exportJson': 'Exporter en JSON…',
  'status.exported': 'Exporté — {path}',
  'status.exportFailed': 'Échec de l’export : {error}',
  'pdf.title': 'Exporter en PDF',
  'pdf.preview': 'Aperçu PDF',
  'pdf.format': 'Format du papier',
  'pdf.sceneNumbers': 'Numéros de scène',
  'pdf.sceneNumbers.none': 'Aucun',
  'pdf.sceneNumbers.left': 'À gauche',
  'pdf.sceneNumbers.right': 'À droite',
  'pdf.sceneNumbers.both': 'Des deux côtés',
  'pdf.includeNotes': 'Inclure les notes',
  'pdf.includeSynopses': 'Inclure les synopsis',
  'pdf.headingsBold': 'Headings de scène en gras',
  'pdf.watermark': 'Filigrane',
  'pdf.pageFrom': 'De la page',
  'pdf.pageTo': 'À la page',
  'pdf.export': 'Exporter…',
  'pdf.cancel': 'Annuler',
  'pdf.close': 'Fermer l’export PDF',
  'pdf.rendering': 'Génération du PDF…',
  'pdf.renderFailed': 'Impossible de générer le PDF.',
  'pdf.previousPage': 'Page précédente',
  'pdf.nextPage': 'Page suivante',
  'pdf.pageStatus': 'Page {page} sur {count}',
};
