import type postgres from 'postgres';
import { createOperation, operationCodeHash, resolveOperation } from './registry.js';

// Kernel-seeded file parsers minted per (org, project) on first use; a drifted source hash mints a new version.
// Contract edits must ride a source edit so the hash moves with them.

export const PARSE_XLSX_OPERATION = 'parse-xlsx';

export const PARSE_XLSX_CONTRACT = {
  inputs: {
    file: { type: 'file', description: 'the .xlsx workbook' },
    table: { type: 'param', valueType: 'string', description: 'the table the rows land in' },
  },
  outputs: {
    rows: { kind: 'dataset', description: 'the sheet as table rows', datasetFrom: 'table' },
  },
} as const;

export const PARSE_XLSX_CODE = `# parse-xlsx v1 (kernel-seeded; stdlib only - zipfile + xml.etree; zero model)
import json
import re
import zipfile
import xml.etree.ElementTree as ET

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
RNS = '{http://schemas.openxmlformats.org/package/2006/relationships}'
RID = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'

zf = zipfile.ZipFile(INPUTS['file'])
wb = ET.fromstring(zf.read('xl/workbook.xml'))
sheets = wb.findall(NS + 'sheets/' + NS + 'sheet')
if len(sheets) != 1:
    raise Exception('this workbook has %d sheets - the Excel door reads one; export the sheet you want as its own .xlsx' % len(sheets))

rels = ET.fromstring(zf.read('xl/_rels/workbook.xml.rels'))
part = None
for rel in rels.findall(RNS + 'Relationship'):
    if rel.get('Id') == sheets[0].get(RID):
        target = rel.get('Target') or ''
        part = target[1:] if target.startswith('/') else 'xl/' + target
if part is None:
    raise Exception('the workbook names no worksheet part')

shared = []
if 'xl/sharedStrings.xml' in zf.namelist():
    ss = ET.fromstring(zf.read('xl/sharedStrings.xml'))
    for si in ss.findall(NS + 'si'):
        shared.append(''.join(t.text or '' for t in si.iter(NS + 't')))

def col_of(ref):
    n = 0
    for ch in (ref or ''):
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
    return n - 1

sheet = ET.fromstring(zf.read(part))
raw_rows = []
for row in sheet.iter(NS + 'row'):
    cells = {}
    for c in row.findall(NS + 'c'):
        idx = col_of(c.get('r'))
        t = c.get('t')
        v = c.find(NS + 'v')
        if t == 'inlineStr':
            isel = c.find(NS + 'is')
            val = ''.join(x.text or '' for x in isel.iter(NS + 't')) if isel is not None else None
        elif v is None or v.text is None:
            val = None
        elif t == 's':
            val = shared[int(v.text)]
        elif t == 'b':
            val = v.text == '1'
        elif t == 'str':
            val = v.text
        else:
            num = float(v.text)
            val = int(num) if num == int(num) else num
        if val is not None and idx >= 0:
            cells[idx] = val
    if cells:
        raw_rows.append(cells)
if not raw_rows:
    raise Exception('the sheet has no rows - the first row names the columns')

header_cells = raw_rows[0]
width = max(header_cells) + 1
headers = []
for i in range(width):
    h = re.sub('[^a-z0-9]+', '-', str(header_cells.get(i, '')).strip().lower()).strip('-')
    if not h:
        raise Exception('column %d has an empty header - the first row names every column' % (i + 1))
    if h in headers:
        raise Exception("two columns share the name '%s' - headers must be unique" % h)
    headers.append(h)

body = raw_rows[1:]
types = []
for i in range(width):
    vals = [r.get(i) for r in body if r.get(i) is not None]
    if vals and all(isinstance(v, bool) for v in vals):
        types.append('boolean')
    elif vals and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in vals):
        types.append('number')
    else:
        types.append('string')

rows = []
for r in body:
    row = {}
    for i in range(width):
        v = r.get(i)
        if v is None:
            row[headers[i]] = None
        elif types[i] == 'string' and not isinstance(v, str):
            row[headers[i]] = str(v)
        else:
            row[headers[i]] = v
    rows.append(row)

columns = {}
for i in range(width):
    columns[headers[i]] = types[i]
with open(OUTPUT_DIR + '/rows.json', 'w') as f:
    json.dump({'columns': columns, 'rows': rows}, f)
`;

export const PARSE_DELIMITED_OPERATION = 'parse-delimited';

export const PARSE_DELIMITED_CONTRACT = {
  inputs: {
    file: { type: 'file', description: 'the delimited text file (.csv or .tsv)' },
    table: { type: 'param', valueType: 'string', description: 'the table the rows land in' },
  },
  outputs: {
    rows: { kind: 'dataset', description: 'the file as table rows', datasetFrom: 'table' },
  },
} as const;

export const PARSE_DELIMITED_CODE = `# parse-delimited v1 (kernel-seeded; stdlib only - csv; zero model)
import csv
import json
import re

path = INPUTS['file']
f = open(path, 'r', encoding='utf-8-sig', errors='replace', newline='')
first_line = f.readline()
if first_line.strip() == '':
    raise Exception('the file is empty - the first row names the columns')
if path.lower().endswith('.tsv') or '\\t' in first_line:
    delim = '\\t'
elif first_line.count(';') > first_line.count(','):
    delim = ';'
else:
    delim = ','
f.seek(0)
reader = csv.reader(f, delimiter=delim)
raw = [row for row in reader if any(str(c).strip() != '' for c in row)]
f.close()
if len(raw) < 1:
    raise Exception('the file is empty - the first row names the columns')

TR = str.maketrans('\\u00e7\\u011f\\u0131\\u00f6\\u015f\\u00fc\\u00c7\\u011e\\u0130\\u00d6\\u015e\\u00dc', 'cgiosucgiosu')
headers = []
for i, h in enumerate(raw[0]):
    slug = re.sub('[^a-z0-9]+', '-', str(h).translate(TR).strip().lower()).strip('-')
    if not slug:
        raise Exception('column %d has an empty header - the first row names every column' % (i + 1))
    if slug in headers:
        raise Exception("two columns share the name '%s' - headers must be unique" % slug)
    headers.append(slug)
width = len(headers)

body = raw[1:]
NUM = re.compile(r'-?\\d+(\\.\\d+)?')
types = []
for i in range(width):
    vals = [r[i].strip() for r in body if i < len(r) and r[i].strip() != '']
    if vals and all(NUM.fullmatch(v) for v in vals):
        types.append('number')
    else:
        types.append('string')

rows = []
for r in body:
    row = {}
    for i in range(width):
        v = r[i].strip() if i < len(r) else ''
        if v == '':
            row[headers[i]] = None
        elif types[i] == 'number':
            num = float(v)
            row[headers[i]] = int(num) if num == int(num) else num
        else:
            row[headers[i]] = v
    rows.append(row)

columns = {}
for i in range(width):
    columns[headers[i]] = types[i]
with open(OUTPUT_DIR + '/rows.json', 'w') as f:
    json.dump({'columns': columns, 'rows': rows}, f)
`;

/** One seeded parser per format; dispatch resolves by extension. */
export interface SeededParser {
  name: string;
  code: string;
  contract: typeof PARSE_XLSX_CONTRACT | typeof PARSE_DELIMITED_CONTRACT;
}

const SEEDED_PARSERS: Record<string, SeededParser> = {
  xlsx: { name: PARSE_XLSX_OPERATION, code: PARSE_XLSX_CODE, contract: PARSE_XLSX_CONTRACT },
  csv: { name: PARSE_DELIMITED_OPERATION, code: PARSE_DELIMITED_CODE, contract: PARSE_DELIMITED_CONTRACT },
  tsv: { name: PARSE_DELIMITED_OPERATION, code: PARSE_DELIMITED_CODE, contract: PARSE_DELIMITED_CONTRACT },
};

export function seededParserForExt(ext: string): SeededParser | null {
  return SEEDED_PARSERS[ext.toLowerCase()] ?? null;
}

/** Get-or-create: the head serves when its hash matches the shipped source, else mint head+1. */
export async function ensureSeededParser(
  sql: postgres.Sql, orgId: string, projectId: string | null, parser: SeededParser,
): Promise<{ ok: true; version: number } | { ok: false; reason: string }> {
  const head = await resolveOperation(sql, orgId, { name: parser.name }, projectId);
  if (head !== null && head.codeHash === operationCodeHash(parser.code)) {
    return { ok: true, version: head.version };
  }
  const res = await createOperation(sql, {
    orgId, projectId, name: parser.name, code: parser.code, runtime: 'wasm',
    ioContract: parser.contract, provenanceRunId: null, createdBy: 'kernel',
  });
  if (!res.ok) return { ok: false, reason: res.errors.join('; ') };
  return { ok: true, version: res.version };
}
