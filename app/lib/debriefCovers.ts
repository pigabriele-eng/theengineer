// The stints a debrief covers, in one line (components/DebriefCovers.tsx). Checked by `npm test`.

type Covers = { runs: { name: string; group: number }[] };

const list = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** "Covers FP1 stint 1 and FP1 stint 2 on setup 1, FP1 stint 3 on setup 2." */
export function coversLine(c: Covers): string {
  const groups = [...new Set(c.runs.map((r) => r.group))].sort((a, b) => a - b); // as the server numbers the setups
  const names = (g: number) => c.runs.filter((r) => r.group === g).map((r) => r.name);
  if (c.runs.length < 2) return `Covers ${list(names(groups[0] ?? 0)) || 'its run'} only.`;
  if (groups.length < 2) return `Covers ${list(c.runs.map((r) => r.name))}, all on one setup.`;
  return `Covers ${groups.map((g, i) => `${list(names(g))} on setup ${i + 1}`).join(', ')}.`;
}
