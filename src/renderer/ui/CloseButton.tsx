interface CloseButtonProps {
  /**
   * What is being closed, not "Close".
   *
   * It is the only name a screen reader gets, and three E2E specs distinguish this button
   * from a footer button literally named "Close" by matching that name exactly — shortening
   * either one turns a passing locator into a strict-mode violation.
   */
  label: string;
  /**
   * Takes the focus on open. A dialog whose focus is still on the document body cannot hear
   * Escape at all, so `Dialog` sets this and only a bare panel leaves it off.
   */
  autoFocus?: boolean;
  onClick: () => void;
}

/**
 * The multiplication sign in the corner of a panel.
 *
 * Its own component rather than a `Button` variant: it has no text, no rank and no emphasis
 * to choose — thirteen call sites that differ only in what they close. `.panel-close` is
 * also the handle several specs click through, so the class name is part of the contract.
 */
export function CloseButton({ label, autoFocus, onClick }: CloseButtonProps) {
  return (
    <button
      type="button"
      className="panel-close"
      aria-label={label}
      autoFocus={autoFocus}
      onClick={onClick}
    >
      ×
    </button>
  );
}
