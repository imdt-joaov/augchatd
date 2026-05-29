import "katex/dist/katex.min.css";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { code } from "@streamdown/code";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { cjk } from "@streamdown/cjk";
import { useDocumentTheme } from "@/hooks/use-document-theme";

/**
 * Renders assistant message text via `@assistant-ui/react-streamdown`:
 *  - GFM + KaTeX math + Mermaid diagrams + Shiki code highlight
 *  - CJK line-break + spacing optimizations (Chinese/Japanese/Korean)
 *  - Block-based streaming + `remend` (auto-closes incomplete markdown
 *    during stream) + streaming caret
 *  - Built-in copy/download controls on code blocks (and table controls)
 *
 * Reads text from the surrounding `MessagePart` context — call from
 * inside the part-typed branch of `MessagePrimitive.GroupedParts` (or
 * `Parts`). No props.
 *
 * `singleDollarTextMath: true` on the math plugin honors the demo
 * system prompt's `$inline$` convention. Without it, only `$$block$$`
 * would render.
 *
 * The mermaid theme is driven by the `.dark` class on <html> via
 * `useDocumentTheme`: streamdown reads `mermaid.config.theme` at render
 * time, not via CSS, so JS has to mirror the class toggle.
 *
 * `allowedTags` restores the SVG whitelist that the pre-streamdown
 * `Markdown.tsx` carried in its `rehype-sanitize` schema. The demo
 * system prompt tells the LLM "Inline HTML/SVG — sanitized; use
 * sparingly when markdown can't express it" — without this allowlist,
 * streamdown's default sanitization strips SVG silently.
 */

const math = createMathPlugin({ singleDollarTextMath: true });

const SVG_TAGS = [
  "svg",
  "g",
  "path",
  "circle",
  "rect",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "defs",
  "marker",
  "use",
] as const;

const SVG_ATTRS = [
  "class",
  "style",
  "viewBox",
  "xmlns",
  "fill",
  "stroke",
  "stroke-width",
  "transform",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "d",
  "points",
  "width",
  "height",
];

const ALLOWED_TAGS: Record<string, string[]> = Object.fromEntries(
  SVG_TAGS.map((tag) => [tag, SVG_ATTRS]),
);

export function MarkdownText() {
  const theme = useDocumentTheme();
  return (
    <StreamdownTextPrimitive
      plugins={{ code, math, mermaid, cjk }}
      shikiTheme={["github-light", "github-dark"]}
      caret="block"
      mermaid={{ config: { theme: theme === "dark" ? "dark" : "default" } }}
      allowedTags={ALLOWED_TAGS}
    />
  );
}
