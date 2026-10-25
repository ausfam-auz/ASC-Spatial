/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    text: '#212f3b',
    tint: '#d47425',
    background: '#f8f6f2',
    foreground: '#212f3b',
    card: '#fdfdfc',
    cardForeground: '#212f3b',
    primary: '#d47425',
    primaryForeground: '#fcfaf8',
    secondary: '#e2e9ee',
    secondaryForeground: '#212f3b',
    muted: '#efece6',
    mutedForeground: '#606f7b',
    accent: '#d47425',
    accentForeground: '#fcfaf8',
    destructive: '#ca3a2f',
    destructiveForeground: '#ffffff',
    border: '#d2d9e0',
    input: '#d2d9e0',
  },
  dark: {
    text: '#eeeae2',
    tint: '#e08f4d',
    background: '#19212a',
    foreground: '#eeeae2',
    card: '#212b36',
    cardForeground: '#eeeae2',
    primary: '#e08f4d',
    primaryForeground: '#1a242d',
    secondary: '#2f3b46',
    secondaryForeground: '#eeeae2',
    muted: '#29333d',
    mutedForeground: '#9ea8b3',
    accent: '#e08f4d',
    accentForeground: '#1a242d',
    destructive: '#d34f45',
    destructiveForeground: '#ffffff',
    border: '#414f5d',
    input: '#414f5d',
  },

  radius: 8,
};

export default colors;
