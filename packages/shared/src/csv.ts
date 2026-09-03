//
// Hand-rolled RFC4180 parser: quoted fields, embedded commas/newlines
// inside quotes, "" as an escaped quote, and CRLF or LF line endings.
// Deliberately not a third-party dependency — Goodreads exports are a
// small, well-understood CSV dialect, and the project avoids adding deps
// for problems this contained (see this plan's Global Constraints).

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export function parseCsv(text: string): ParsedCsv {
  const allRows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  function pushField() {
    row.push(field);
    field = "";
  }
  function pushRow() {
    pushField();
    allRows.push(row);
    row = [];
  }

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      // Normalize CRLF -> LF by dropping the \r; the following \n (if any)
      // is handled on the next loop iteration.
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Flush a final field/row for input with no trailing newline.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  // A trailing newline produces one spurious all-blank single-field row
  // ([""]) once the loop above finishes — drop it rather than treating it
  // as a real (header-only-length) data row.
  const nonEmpty = allRows.filter((r) => !(r.length === 1 && r[0] === ""));

  const [headers, ...dataRows] = nonEmpty;
  return { headers: headers ?? [], rows: dataRows };
}
