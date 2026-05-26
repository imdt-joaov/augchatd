import { Children, useState, type PropsWithChildren } from "react";
import { Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";

interface ToolCallBlockProps {
  toolCallId: string;
  toolName: string;
  args: unknown;
  argsText: string;
  result?: unknown;
  isError?: boolean;
}

export function ToolCallBlock(props: ToolCallBlockProps) {
  const { connector, tool } = splitToolName(props.toolName);
  const hasResult = props.result !== undefined;
  const status: Status = props.isError ? "error" : hasResult ? "done" : "running";
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="my-1 rounded border bg-background"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto w-full justify-between rounded-none px-2.5 py-1 font-mono text-[12px] font-normal data-[state=open]:border-b"
        >
          <span className="flex items-center gap-1.5">
            <Wrench className="size-3.5" aria-hidden />
            <span>{tool}</span>
            {connector && <span className="text-muted-foreground">({connector})</span>}
          </span>
          <StatusPill status={status} />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="px-2.5 py-2 text-[12px]">
        <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Arguments
        </div>
        <pre className="mb-2 overflow-x-auto font-mono text-[11px] text-foreground">
          {formatJson(props.args ?? safeJsonParse(props.argsText))}
        </pre>
        {hasResult && (
          <>
            <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Result
            </div>
            <pre className="overflow-x-auto font-mono text-[11px] text-foreground">
              {formatResult(props.result)}
            </pre>
          </>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ToolGroup({
  children,
}: PropsWithChildren<{ startIndex: number; endIndex: number }>) {
  const count = Children.count(children);
  const [open, setOpen] = useState(false);
  if (count <= 1) return <>{children}</>;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="my-2 rounded border bg-muted"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          className="h-auto w-full justify-between rounded-none px-2.5 py-1.5 text-[12px] font-normal"
        >
          <span className="flex items-center gap-1.5 font-mono">
            <Wrench className="size-3.5" aria-hidden />
            <span>{count} tool calls</span>
          </span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            tap to expand
          </span>
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Separator />
        <div className="space-y-1 px-2.5 py-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

type Status = "running" | "error" | "done";

function StatusPill({ status }: { status: Status }) {
  if (status === "running") {
    return (
      <Badge variant="secondary" className="gap-1.5 text-[10px] uppercase tracking-wider">
        Running
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground" />
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge variant="destructive" className="text-[10px] uppercase tracking-wider">
        Error
      </Badge>
    );
  }
  return (
    <Badge className="text-[10px] uppercase tracking-wider">
      Done
    </Badge>
  );
}

function splitToolName(name: string): { connector: string | null; tool: string } {
  const sep = name.indexOf("__");
  if (sep === -1) return { connector: null, tool: name };
  return { connector: name.slice(0, sep), tool: name.slice(sep + 2) };
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function safeJsonParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "—";
  return formatJson(value);
}
