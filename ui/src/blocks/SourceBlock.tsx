import { useState } from "react";
import { FileText, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";

type AugchatdMetadata = {
  source_descriptive_id?: string;
  index?: string;
  doc_id?: string;
  score?: number | null;
  snippet?: string;
};

type SourceProps =
  | {
      type: "source";
      sourceType: "document";
      id: string;
      title: string;
      mediaType: string;
      filename?: string;
      providerMetadata?: { [provider: string]: unknown };
    }
  | {
      type: "source";
      sourceType: "url";
      id: string;
      url: string;
      title?: string;
      providerMetadata?: { [provider: string]: unknown };
    };

export function SourceBlock(props: SourceProps) {
  if (props.sourceType === "url") {
    return (
      <Button asChild variant="secondary" size="sm" className="my-1 mr-1 inline-flex max-w-full align-top">
        <a href={props.url} target="_blank" rel="noreferrer noopener">
          <Link2 className="size-3.5" aria-hidden />
          <span className="truncate">{props.title ?? props.url}</span>
        </a>
      </Button>
    );
  }

  const meta =
    (props.providerMetadata?.["augchatd"] as AugchatdMetadata | undefined) ?? {};
  const scoreLabel =
    typeof meta.score === "number" ? meta.score.toFixed(2) : null;
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="my-1 mr-1 inline-block max-w-full rounded-md border bg-muted align-top text-[12px]"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-auto justify-start rounded-none px-2 py-1 font-normal"
        >
          <FileText className="mr-1 size-3.5" aria-hidden />
          <span className="font-medium">{props.title}</span>
          {meta.source_descriptive_id && (
            <span className="ml-2 text-muted-foreground">
              · {meta.source_descriptive_id}
            </span>
          )}
          {scoreLabel && (
            <span className="ml-2 tabular-nums text-muted-foreground">· {scoreLabel}</span>
          )}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="text-muted-foreground">
        <Separator />
        <div className="px-2 py-2">
          <div className="mb-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 font-mono text-[11px]">
            {meta.source_descriptive_id && (
              <>
                <span className="text-muted-foreground/70">connector</span>
                <span className="text-foreground">{meta.source_descriptive_id}</span>
              </>
            )}
            {meta.index && (
              <>
                <span className="text-muted-foreground/70">index</span>
                <span className="break-all text-foreground">{meta.index}</span>
              </>
            )}
            {meta.doc_id && (
              <>
                <span className="text-muted-foreground/70">id</span>
                <span className="break-all text-foreground">{meta.doc_id}</span>
              </>
            )}
            {scoreLabel && (
              <>
                <span className="text-muted-foreground/70">score</span>
                <span className="text-foreground">{scoreLabel}</span>
              </>
            )}
          </div>
          {meta.snippet && (
            <div className="mt-1 whitespace-pre-wrap text-[12px] leading-snug text-foreground">
              {meta.snippet}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
