import { useEffect } from "react";

// There is no manual light/dark toggle anywhere in the app (yet) -- this
// hook only ever reflects the OS-level `prefers-color-scheme`, so it must
// stay reactive to that media query for the life of the page rather than
// resolving it once. An earlier version cached the resolved theme in
// localStorage, which -- with no toggle to ever write an explicit
// preference back to that key -- meant the very first resolution stuck
// permanently: reloading, or even changing the OS setting, could never
// un-stick it. Revisit persistence if/when a manual toggle is added.
export function useTheme(): void {
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = (isDark: boolean) => {
      document.documentElement.classList.toggle("dark", isDark);
    };
    applyTheme(media.matches);
    const handleChange = (e: MediaQueryListEvent) => applyTheme(e.matches);
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);
}
