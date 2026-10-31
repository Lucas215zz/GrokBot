export const colors = {
  dark: {
    bg: "#0b0b0d",
    surface: "#141417",
    surfaceAlt: "#1c1c21",
    border: "#26262c",
    text: "#f2f2f5",
    textMuted: "#9a9aa3",
    accent: "#6b4eff",
    accentAlt: "#8f7aff",
    danger: "#ff5d5d",
    ok: "#35d07f",
    warn: "#ffb020",
    inputBg: "#1c1c21",
  },
  light: {
    bg: "#f7f7f9",
    surface: "#ffffff",
    surfaceAlt: "#efeff3",
    border: "#e2e2e8",
    text: "#1a1a1e",
    textMuted: "#6b6b76",
    accent: "#6b4eff",
    accentAlt: "#5a3df0",
    danger: "#e5484d",
    ok: "#18a058",
    warn: "#e89b00",
    inputBg: "#ffffff",
  },
};

export function palette(theme) {
  return colors[theme] || colors.dark;
}
