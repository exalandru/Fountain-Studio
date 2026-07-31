export default {
  semi: true,
  singleQuote: true,
  tabWidth: 2,
  useTabs: false,
  trailingComma: 'all',
  printWidth: 100,
  bracketSpacing: true,
  arrowParens: 'always',
  // Keep LF everywhere, including Windows CI checkouts that would otherwise report
  // every file as misformatted under core.autocrlf.
  endOfLine: 'lf',
}
