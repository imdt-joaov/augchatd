import { CodeBlockShell } from "./CodeBlockShell.tsx";

/**
 * Renders ```csv fences as a table.
 *
 * Naive parser (split on `,` and `\n`). For demo purposes; quoted fields
 * with embedded commas / newlines / escapes are not handled. If we hit
 * that need, swap in `papaparse` and accept the bundle cost.
 */
export function CsvBlock({ raw }: { raw: string }) {
  const rows = parseCsv(raw);
  if (rows.length === 0) {
    return (
      <CodeBlockShell language="csv" rawCode={raw}>
        <pre className="p-3 text-muted-foreground">(empty)</pre>
      </CodeBlockShell>
    );
  }

  const [header, ...body] = rows;
  return (
    <CodeBlockShell language="csv" rawCode={raw}>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[0.9em]">
          <thead>
            <tr>
              {header.map((cell, i) => (
                <th
                  key={i}
                  className="border-b bg-muted px-3 py-2 text-left font-semibold"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="border-b px-3 py-1.5 align-top"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </CodeBlockShell>
  );
}

function parseCsv(raw: string): string[][] {
  return raw
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(",").map((cell) => cell.trim()));
}
