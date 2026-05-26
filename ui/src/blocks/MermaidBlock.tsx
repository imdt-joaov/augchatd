import { useEffect, useId, useRef, useState } from "react";

/**
 * Renders ```mermaid fenced code blocks as actual diagrams.
 *
 * mermaid is lazy-imported (~250 KB gz) — the library only loads after
 * the first mermaid fence appears in a conversation. Subsequent diagrams
 * reuse the cached module.
 */
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    // Read the session theme from the document attribute set by
    // applyTheme() during the iframe handshake (App.tsx). By the time
    // any assistant message renders a mermaid block, applyTheme has
    // already run — augchatd does not switch themes mid-session, so
    // initializing mermaid once with the live attribute is enough.
    const isDark =
      document.documentElement.getAttribute("data-theme") === "dark";
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: isDark ? "dark" : "default",
        securityLevel: "strict",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      });
      return m.default;
    });
  }
  return mermaidPromise;
}

export function MermaidBlock({ chart }: { chart: string }) {
  const id = useId().replace(/:/g, "_");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadMermaid()
      .then((mermaid) => mermaid.render(`m_${id}`, chart))
      .then(({ svg }) => {
        if (cancelled) return;
        setSvg(svg);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [chart, id]);

  if (error) {
    return (
      <div className="my-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-destructive">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wider">
          Mermaid render error
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{error}</pre>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
          {chart}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="my-3 rounded-lg border bg-muted p-3 text-muted-foreground">
        Rendering diagram…
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="my-3 flex justify-center overflow-x-auto rounded-lg border bg-muted p-3"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
