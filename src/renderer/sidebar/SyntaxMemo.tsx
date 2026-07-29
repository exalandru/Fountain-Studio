import { useTranslator } from '../hooks/useTranslator.js';

/** Compact Fountain reference shared by the writing workspace. */
export function SyntaxMemo() {
  const { t } = useTranslator();
  const sections = [
    ['titlePage', 'exampleTitle'],
    ['sceneHeading', 'exampleScene'],
    ['action', 'exampleAction'],
    ['character', 'exampleDialogue'],
    ['transition', 'exampleTransition'],
    ['structure', 'exampleStructure'],
    ['emphasis', 'exampleEmphasis'],
    ['notes', 'exampleNotes'],
    ['special', 'exampleSpecial'],
  ] as const;

  return (
    <div className="sidebar-syntax">
      <p>{t('sidebar.syntaxIntro')}</p>
      {sections.map(([title, example]) => (
        <section key={title}>
          <h3>{t(`sidebar.syntax.${title}`)}</h3>
          <pre>
            <code>{t(`sidebar.syntax.${example}`)}</code>
          </pre>
        </section>
      ))}
    </div>
  );
}
