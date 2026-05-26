import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

export function CodeBlockShell({
  language,
  rawCode,
  children,
}: {
  language: string;
  rawCode: string;
  children: ReactNode;
}) {
  return (
    <div className="my-3 overflow-hidden rounded-lg border bg-[#050507]">
      <div className="flex items-center justify-between border-b bg-muted px-3 py-1.5 text-xs">
        <span className="font-mono uppercase tracking-wider text-muted-foreground">
          {language || "code"}
        </span>
        <CopyButton text={rawCode} />
      </div>
      {children}
    </div>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          // ignore
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}
