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
  'menu.view.showSynopses': 'Afficher les synopsis',
  'menu.view.showSections': 'Afficher les sections',
  'menu.view.increaseFont': 'Agrandir la police',
  'menu.view.decreaseFont': 'Réduire la police',
  'menu.view.fullscreen': 'Plein écran',
  'menu.view.devTools': 'Outils de développement',

  // ── Menu : Langue ────────────────────────────────────────────────────────
  'menu.language': 'Langue',

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
};
