import { isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { MermaidBlock } from "./blocks/MermaidBlock.tsx";
import { JsonBlock } from "./blocks/JsonBlock.tsx";
import { CsvBlock } from "./blocks/CsvBlock.tsx";
import { CodeBlockShell } from "./blocks/CodeBlockShell.tsx";
import "katex/dist/katex.min.css";

/**
 * Renders Markdown with the extensions documented in issue
 * augchatd/augchatd#5:
 *  - GFM (tables, task lists, autolinks, strikethrough)  — remark-gfm
 *  - Math (`$inline$` and `$$block$$` LaTeX)              — remark-math + rehype-katex
 *  - Mermaid diagrams (```mermaid fences)                 — MermaidBlock (lazy)
 *  - JSON viewer       (```json fences)                   — JsonBlock
 *  - CSV viewer        (```csv fences)                    — CsvBlock
 *  - Inline HTML/SVG with whitelist sanitization          — rehype-raw + rehype-sanitize
 *  - Syntax highlight (all other fences)                  — rehype-highlight (highlight.js)
 *  - Per-block copy button + language label               — CodeBlockShell
 *
 * Used only for assistant messages — user messages stay plain text.
 */

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
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
  ],
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
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
    ],
  },
};

export function MarkdownText({ text }: { text: string }) {
  return (
    <div
      className="
        leading-relaxed
        [&_p]:my-2
        [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-xl [&_h1]:font-semibold
        [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold
        [&_h3]:mb-2 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold
        [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6
        [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6
        [&_li]:my-0.5
        [&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline
        [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground
        [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:text-[0.9em] [&_:not(pre)>code]:font-mono
        [&_table]:my-3 [&_table]:border-collapse [&_table]:text-[0.95em]
        [&_th]:border [&_th]:border-border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left
        [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-1.5
        [&_hr]:my-4 [&_hr]:border-border
        [&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-lg
        [&>:first-child]:mt-0 [&>:last-child]:mb-0
      "
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeRaw,
          [rehypeSanitize, sanitizeSchema],
          rehypeKatex,
          rehypeHighlight,
        ]}
        components={{
          pre: PreBlock,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function PreBlock({ children }: { children?: ReactNode }) {
  const codeElement = Array.isArray(children) ? children[0] : children;
  if (!isValidElement<{ className?: string; children?: ReactNode }>(codeElement)) {
    return <pre>{children}</pre>;
  }

  const { className, children: codeChildren } = codeElement.props;
  const match = /language-(\w+)/.exec(className ?? "");
  const lang = match?.[1] ?? "";
  const rawCode = extractText(codeChildren).replace(/\n$/, "");

  if (lang === "mermaid") return <MermaidBlock chart={rawCode} />;
  if (lang === "json") return <JsonBlock raw={rawCode} />;
  if (lang === "csv") return <CsvBlock raw={rawCode} />;

  return (
    <CodeBlockShell language={lang} rawCode={rawCode}>
      <pre className="overflow-x-auto p-3 font-mono text-[0.9em] leading-relaxed">
        {codeElement}
      </pre>
    </CodeBlockShell>
  );
}

function extractText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }
  return "";
}
