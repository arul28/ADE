/**
 * Ways of talking about a view instead of about what it shows.
 *
 * The rule is "never mention the view", which is not a thing a prompt can be
 * checked against — so what is checked is this list. Every phrase in it is one
 * a brief or a turn prompt would have to contain in order to teach the model to
 * narrate its own drawing, so the prompts are asserted to contain none of them.
 * A fixture rather than a constant beside either prompt, because a phrase added
 * to one copy and not the other is a rule that quietly only applies to half the
 * words the CTO speaks. See `docs/features/cto/README.md` for the call these
 * phrases were taken from.
 *
 * Lower case: the assertion lower-cases the prompt before looking.
 */
export const CTO_VOICE_FORBIDDEN_VIEW_PHRASES = [
  "you should see",
  "beside the call",
  "the picture",
  "i drew",
  "sketch",
  "on screen",
] as const;
