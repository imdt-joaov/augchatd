import { useEffect, useState } from "react";

/**
 * Tracks the presence of the `.dark` class on <html>. Returns "dark" or
 * "light" and re-renders on toggle.
 *
 * Used to feed renderers whose config is read at JS time (not via CSS
 * `color-scheme`) — e.g. Mermaid, where `config.theme` is consumed
 * synchronously when the diagram is built.
 *
 * The CSS-level theming already follows `:root { color-scheme }` rules
 * defined in `index.css`; this hook exists only for the JS-time consumers.
 */
export function useDocumentTheme(): "dark" | "light" {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );

  useEffect(() => {
    const update = () => {
      setTheme(
        document.documentElement.classList.contains("dark") ? "dark" : "light",
      );
    };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
}
