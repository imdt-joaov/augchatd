import { useState } from "react";
import { CodeBlockShell } from "./CodeBlockShell.tsx";

/**
 * Renders ```json fences as a collapsible JSON tree, with a fallback to
 * the raw text if parsing fails.
 */
export function JsonBlock({ raw }: { raw: string }) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return (
      <CodeBlockShell language="json" rawCode={raw}>
        <pre className="overflow-x-auto p-3 font-mono text-[0.9em] leading-relaxed">
          <code>{raw}</code>
        </pre>
      </CodeBlockShell>
    );
  }

  return (
    <CodeBlockShell language="json" rawCode={raw}>
      <div className="overflow-x-auto p-3 font-mono text-[0.9em] leading-relaxed">
        <JsonNode value={parsed} depth={0} />
      </div>
    </CodeBlockShell>
  );
}

function JsonNode({ value, depth }: { value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);

  if (value === null) return <span className="text-muted-foreground">null</span>;
  if (typeof value === "boolean") return <span className="text-[#ffa657]">{String(value)}</span>;
  if (typeof value === "number") return <span className="text-[#ffa657]">{value}</span>;
  if (typeof value === "string") return <span className="text-[#a5d6ff]">"{value}"</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span>[]</span>;
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
        >
          {open ? "[" : `[…${value.length}]`}
        </button>
        {open && (
          <>
            <div className="pl-4">
              {value.map((item, i) => (
                <div key={i}>
                  <span className="text-muted-foreground">{i}: </span>
                  <JsonNode value={item} depth={depth + 1} />
                  {i < value.length - 1 ? "," : null}
                </div>
              ))}
            </div>
            <span>]</span>
          </>
        )}
      </>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <span>{"{}"}</span>;
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="cursor-pointer text-muted-foreground hover:text-foreground"
        >
          {open ? "{" : `{…${entries.length}}`}
        </button>
        {open && (
          <>
            <div className="pl-4">
              {entries.map(([k, v], i) => (
                <div key={k}>
                  <span className="text-[#d2a8ff]">"{k}"</span>
                  <span className="text-muted-foreground">: </span>
                  <JsonNode value={v} depth={depth + 1} />
                  {i < entries.length - 1 ? "," : null}
                </div>
              ))}
            </div>
            <span>{"}"}</span>
          </>
        )}
      </>
    );
  }

  return <span>{String(value)}</span>;
}
