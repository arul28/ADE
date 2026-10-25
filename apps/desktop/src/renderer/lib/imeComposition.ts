type KeyEventLike = {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
};

/**
 * True while a key press belongs to an input method (Japanese, Chinese,
 * Korean...): the Enter that confirms a candidate, or arrows that move through
 * candidates. A handler that submits, selects or dismisses on that key must
 * leave it to the IME.
 *
 * Chromium flags the press with `isComposing`. Safari ends the composition
 * before the confirming keydown, so only its legacy key code 229 says so.
 * Takes a React or a native keyboard event.
 */
export function isImeComposing(event: KeyEventLike): boolean {
  const native = event.nativeEvent ?? event;
  return native.isComposing === true || native.keyCode === 229;
}
