/**
 * `@ade-dev/ui/theme` — palettes, the token writer, and the stylesheet.
 *
 * A plugin page imports this to follow the host's colours; the desktop app
 * never does, because `index.css` already owns its palette.
 */
export {
  applyAdeTheme,
  createTheme,
  darkTheme,
  lightTheme,
  themeForScheme,
  themeToCss,
} from "./createTheme";
export { ADE_STYLE_ID, adeCss, injectAdeStyles } from "./styles";
export { AdeStyles } from "./AdeStyles";
