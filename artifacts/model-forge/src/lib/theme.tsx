import { createContext, useContext, useEffect, useState } from "react";

type Theme = "light" | "dark";
type ColorScheme = "default" | "high-contrast" | "metric-driven";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  colorScheme: ColorScheme;
  setColorScheme: (scheme: ColorScheme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  toggleTheme: () => {},
  colorScheme: "default",
  setColorScheme: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = localStorage.getItem("modelForge_theme");
      if (stored === "dark" || stored === "light") return stored;
    } catch {}
    return "light";
  });

  const [colorScheme, setColorSchemeState] = useState<ColorScheme>(() => {
    try {
      const stored = localStorage.getItem("modelForge_colorScheme");
      if (stored === "high-contrast" || stored === "metric-driven") return stored;
    } catch {}
    return "default";
  });

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      localStorage.setItem("modelForge_theme", theme);
    } catch {}
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    if (colorScheme === "default") {
      root.removeAttribute("data-colorscheme");
    } else {
      root.setAttribute("data-colorscheme", colorScheme);
    }
    try {
      localStorage.setItem("modelForge_colorScheme", colorScheme);
    } catch {}
  }, [colorScheme]);

  const toggleTheme = () => setTheme((t) => (t === "dark" ? "light" : "dark"));
  const setColorScheme = (scheme: ColorScheme) => setColorSchemeState(scheme);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, colorScheme, setColorScheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
