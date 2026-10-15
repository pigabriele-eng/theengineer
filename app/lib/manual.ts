// The manual's words (app/manual.tsx): every function the app has, part by part as the app is laid out, each with
// where it is (the taps, in order, as the buttons read) and what it does, in plain words. Only what is live: a new
// function adds its line here. Checked by `npm test` (lib/manual.test.mjs): every page a line opens exists.

export type ManualItem = {
  name: string; // what you'd look for: "Delete a run"
  where: string[]; // the taps, in order: ['Weekend', 'the event', 'Laps', 'Delete next to the run']
  what: string; // what it does, in a sentence or two
  href?: string; // a page of its own to open straight away
};

export type ManualPart = {
  key: string;
  title: string; // the part of the app: "Race weekends", "Debriefs"
  dek: string; // what the part is for
  href?: string; // its page, when it has one of its own
  items: ManualItem[];
};

export const MANUAL: ManualPart[] = [
  {
    key: 'everywhere',
    title: 'On every page',
    dek: 'The bar at the top, Back and the moves that work on any list of runs.',
    items: [
      { name: 'Go to a part of the app', where: ['Top of every page', 'Weekend, Upload or Settings'],
        what: 'The links under the app’s name take you to each part; the one you are in is underlined in red. “The Engineer” takes you to the race weekends.' },
      { name: 'Go back', where: ['Top of every page', '‹ Back'],
        what: 'One page back. Opened from a link, it goes up to the page above: a run to its event, everything else to the race weekends.' },
      { name: 'Open this manual', where: ['Top of every page', 'Manual'],
        what: 'Every function and where to find it. Type a word to find one. On a phone it is at the top right, beside the app’s name; it is also first in Settings.' },
      { name: 'Print or save a page as PDF', where: ['Event and run pages', 'Print / Save as PDF'],
        what: 'Prints the page or saves it as a PDF: the tab you are on, as it is. From the iPhone home-screen app it makes a PDF to share.' },
      { name: 'Send a report to your phone (computer app)', where: ['Event and run pages', 'Save PDF for phone'],
        what: 'In the app on your computer, saves the page (the tab you are on) as a PDF in your phone’s folder (OneDrive or Google Drive, picked the first time). Open it on the phone in the OneDrive or Drive app. Saving the same page again replaces the older PDF.' },
      { name: 'Where the computer app keeps your data', where: ['Computer app', 'File', 'Open the data folder'],
        what: 'Everything (logs, runs, what the app works out) is in one folder on your computer; the app needs no internet. File › Use another data folder switches folder, File › Change the phone’s PDF folder picks where PDFs go.' },
      { name: 'See the newest version after an update', where: ['Any page', 'Ctrl+Shift+R (Cmd+Shift+R on a Mac)'],
        what: 'A hard reload loads the app as it is now. On a phone, close the app and open it again.' },
      { name: 'Swipe or hold a run', where: ['Any list of runs', 'swipe the run left, or hold it'],
        what: 'On a phone or tablet, swipe a run left for Delete. Hold any run for Delete, Change driver, Rename and Tyres. Every one of these also has a button you can see.' },
      { name: 'What opens when you start the app', where: ['Starting the app'],
        what: 'The event that is on now (from the day before it), or one starting within 14 days; else the list of race weekends.' },
    ],
  },
  {
    key: 'weekends',
    title: 'Race weekends',
    dek: 'The list of events, by year and championship, each with its runs.',
    href: '/',
    items: [
      { name: 'Find an event', where: ['Weekend', 'Past, Current, Upcoming or All'],
        what: 'Picks which events are listed. They are grouped by year, then by championship; tap a heading to fold it.' },
      { name: 'Open an event', where: ['Weekend', 'tap the event'],
        what: 'Opens its weekend page: Driving, Stint, Quali and Runs.' },
      { name: 'See an event’s runs in the list', where: ['Weekend', '▸ beside the event'],
        what: 'Shows its runs day by day with each run’s best lap and its gap to the event’s best, then the event’s best lap, clean laps and track.' },
      { name: 'Rename a run', where: ['Weekend', '▸ beside the event', 'Rename next to the run'],
        what: 'Type a name or tap a quick one (FP1, Q1, Q3, R1 stint 1, R3 stint 2, Warm-up…). A name you type is kept. The weekend page’s Runs tab has the same Rename.' },
      { name: 'Delete a run', where: ['Weekend', '▸ beside the event', 'Delete next to the run'],
        what: 'Asks once, then deletes the run and its logs. The weekend page’s Runs tab has the same Delete.' },
      { name: 'Set who drove a run', where: ['Weekend', '▸ beside the event', 'the driver line under the run', 'Confirm, Change or Set'],
        what: 'Confirm takes the driver the app recognised from the driving style. Change or Set opens the list of drivers; + New driver adds one.' },
      { name: 'Set a run’s tyres', where: ['Weekend', '▸ beside the event', 'the tyres tag (New, Fresh, Used, Very used)'],
        what: 'Tap the tag, then the level. A guess ends with “?” until you pick. Fresh is under 10 laps, Used 10 or more, Very used 25 or more. Laps are compared only with laps on the same tyres.' },
      { name: 'Plan an event', where: ['Weekend', '+ New event'],
        what: 'Name, first and last day and venue. Logs recorded there on those days go into it when you upload them.' },
      { name: 'Rename or delete an event from the list', where: ['Weekend', '▸ beside the event', 'Rename or Delete'],
        what: 'The same as on the event’s page: Delete asks what to delete.' },
      { name: 'Runs in no event', where: ['Weekend', 'Unfiled'],
        what: 'Runs that are in no event. Open it to tick runs and move them into an event, or delete them.' },
      { name: 'Answer which season an upload belongs to', where: ['Weekend', '+ N questions about seasons'],
        what: 'Shows only when the app isn’t sure; one tap answers each question.' },
    ],
  },
  {
    key: 'driving',
    title: 'Driving performance',
    dek: 'Where the missing speed is: the stint and combined theoreticals, which lap of which driver made each corner, the 3D racing line and what the quickest corners did differently.',
    items: [
      { name: 'Pick the session', where: ['the event', 'Driving', '01', 'Session'],
        what: 'Opens on the latest session. Pick another session, or add stints from other sessions.' },
      { name: 'Stint and combined theoretical', where: ['the event', 'Driving', '01 Theoretical laps'],
        what: 'A stint theoretical for each stint, from its own clean laps, and one combined theoretical from every stint: each with its time, its gap to the real lap it is measured from and how many laps make it. They are not real laps.' },
      { name: 'Which lap of which driver holds each corner', where: ['the event', 'Driving', '01 Theoretical laps', 'Which lap holds each corner'],
        what: 'One row per corner: in each stint theoretical the lap that holds it (“PIA L6”) and what it gains on the stint’s fastest lap, and in the combined theoretical which stint, lap and driver. Each driver has a colour with their code in it. Tap a corner to drive the laps that make it in 3D.' },
      { name: 'What the theoretical best does differently', where: ['the event', 'Driving', '01 Theoretical laps', 'What the theoretical best does differently'],
        what: 'For each corner where the theoretical gains 0.02 s or more, biggest first: what its lap did on the line and with the pedals against the fastest lap (brake point, turn-in, apex, exit, throttle, slowest speed) and what it is worth. Combined theoretical, or a stint’s. Tap one to drive those two laps in 3D.' },
      { name: 'Racing line in 3D with the theoretical laps', where: ['the event', 'Driving', '02 Racing line, 3D'],
        what: 'The laps on the traces (the first four) and the stint and combined theoreticals driven again in 3D from the GPS and the steering. A theoretical is a hollow line and a wire car with its name over it, never like a real lap; in each corner it drives the real lap that holds it. Tap Play, or a corner in the list under it, to move them. A corner tapped in the map above drives the laps that make it; Back to the laps on the traces undoes it.' },
      { name: 'Full racing line page', where: ['the event', 'Driving', '02 Racing line, 3D', 'Open the full racing line page'], href: '/racing-line',
        what: 'The same laps and theoreticals with every camera (Chase, Above, Trackside, Bird), the numbers at the playhead, the left/right line chart and the full corner table. Remove the theoretical laps takes them off.' },
      { name: 'Every lap of the session', where: ['the event', 'Driving', '03 Every lap'],
        what: 'Every lap, stint by stint, out-laps and in-laps included, with its driver, tyres and gap. Tap a lap to put it on the traces (up to 6) or take it off. A green flag names the corners where a lap holds the session’s best.' },
      { name: 'Where the time is and the traces', where: ['the event', 'Driving', '04 Where the time is, 05 Traces'],
        what: 'The laps on the traces against each other, section by section, then speed, throttle, brake and steering. Add to graph draws a theoretical dashed. Every graph zooms: pinch, scroll or drag a box; double-tap goes back.' },
    ],
  },
  {
    key: 'stint',
    title: 'Stint analysis',
    dek: 'How the car changes over a stint: the balance, and the tyres against the fuel.',
    items: [
      { name: 'Pick a stint', where: ['the event', 'Stint', 'tap a stint'],
        what: 'The weekend’s stints, race stints first, each named with its driver (“04_R1 · PIA”).' },
      { name: 'Balance shift through the stint', where: ['the event', 'Stint', '01 Balance through the stint'],
        what: 'Where the car’s balance moved most over the stint, in words and how sure that is; then corner by corner (early laps against late laps) and lap by lap, for entry, mid-corner or exit.' },
      { name: 'Tyre degradation and fuel load', where: ['the event', 'Stint', '02 Tyres and fuel'],
        what: 'What the tyres cost a lap against what burning fuel gives back, and the net, each with its ± and whether it is clear or within the lap-to-lap scatter; then what that added up to over the stint and the lap times chart.' },
      { name: 'Tag a slow lap', where: ['the event', 'Stint', 'Every lap, to tag SC, FCY or traffic', 'SC, FCY or Traffic on the lap'],
        what: 'Takes that lap out of the trends, and every figure on the tab is worked out again without it. Tap the tag again to put it back.' },
    ],
  },
  {
    key: 'quali',
    title: 'Quali analysis',
    dek: 'How each qualifying run brought the tyres in, and their temperatures and pressures.',
    items: [
      { name: 'Tyre preparation', where: ['the event', 'Quali', '01 Tyre preparation'],
        what: 'Each driver’s qualifying run (Q, Q1 to Q3, PQ) in words and as a chart of its fronts and rears rising to the push temperature: how the out-lap and build laps brought the tyres up, and when they were ready to push. The warm-ups side by side are under the runs.' },
      { name: 'Tyre temperatures and pressures', where: ['the event', 'Quali', '02 Temperatures and pressures', 'Pressure or Temperature'],
        what: 'Each tyre, laid out like the car, from cold to hot in every run against its window on the weekend’s fastest laps, with the cold pressure to set and each run’s best lap in words. The temperatures are the tyre pressure sensors’ (the air inside the tyre): the car logs no tyre surface temperature.' },
    ],
  },
  {
    key: 'event',
    title: 'Runs and the event',
    dek: 'The event’s runs, and the event itself: its name, dates and logs.',
    items: [
      { name: 'Rename a run in place', where: ['the event', 'Runs', 'tap the run’s name, or Rename'],
        what: 'Opens the name’s editor under the run, with the quick names.' },
      { name: 'Upload into this event', where: ['the event', 'Runs', 'Upload logs or a zip'],
        what: 'Opens Upload. Logs from this event’s track and days go into it.' },
      { name: 'Move runs to another event', where: ['the event', 'Runs', 'tick the runs', 'Move…'],
        what: 'Into another event, out of this one, or into a new event.' },
      { name: 'Delete several runs', where: ['the event', 'Runs', 'tick the runs', 'Delete…'],
        what: 'Asks once, says how much space it frees, then deletes the runs and their logs.' },
      { name: 'Which session a run was', where: ['the event', 'under the tabs'],
        what: 'When the app isn’t sure which session a log was (FP1, Q2…), it asks here with one-tap answers.' },
      { name: 'Rename the event or change its dates', where: ['the event', 'This event, at the foot', 'Rename or Change dates'],
        what: 'Leave the dates empty to take them from the logs.' },
      { name: 'Delete logs or the event', where: ['the event', 'This event, at the foot', 'Delete logs or event'],
        what: 'Asks what to delete: only the logs and keep the event (ready for the right logs), the whole event, only the event and keep its runs, or nothing.' },
    ],
  },
  {
    key: 'run',
    title: 'A run',
    dek: 'One run’s page: its lap chart, every lap and the track.',
    items: [
      { name: 'Open a run', where: ['the event', 'Runs', 'tap a run’s best lap'],
        what: 'Or tap the run on Weekend. The runs of the event are listed at the top to switch to another.' },
      { name: 'Lap chart', where: ['a run', '02 Lap chart'],
        what: 'Every lap with its type, time, gap, section times, hot tyre pressures and tyre temperatures. Best of this run and of the event are at the foot.' },
      { name: 'Change a lap’s type', where: ['a run', 'Lap chart', 'tap the lap’s type (Clean, Out, In…)'],
        what: 'Set Out lap, Build lap, Push lap or In lap when the app read it wrong; Let the app read it undoes it. Your pick shows a dot and wins on every page, even after the log is read again.' },
      { name: 'Add a log to a run', where: ['a run', 'Upload a logger file'],
        what: 'A MoTeC .ld (with its .ldx) or a CSV export.' },
      { name: 'From a run to its weekend', where: ['a run', 'Its weekend: driving, stint, quali'],
        what: 'Opens the run’s event on Driving performance.' },
    ],
  },
  {
    key: 'upload',
    title: 'Upload',
    dek: 'Logs in: MoTeC .ld with .ldx, CSV exports, zips of a whole test or weekend, whole folders.',
    href: '/upload',
    items: [
      { name: 'Upload logs', where: ['Upload', 'drop or pick the files'],
        what: 'Each zip or folder becomes an event named after it. Logs from a planned event’s track and days go into that event; loose logs go to Unfiled. If the connection drops, the files are sent again by themselves.' },
      { name: 'Tyres after an upload', where: ['Upload', 'Tyres for each stint'],
        what: 'The app’s guess for each stint is ticked: Confirm all, or tap the right level.' },
      { name: 'Put an upload into an event you have', where: ['Upload', 'New event from …', 'Put its runs in'],
        what: 'When it is the same race weekend as an event you have. Otherwise name the new event, then Open it.' },
    ],
  },
  {
    key: 'settings',
    title: 'Settings',
    dek: 'The manual, the cars and seasons, and how the app looks.',
    href: '/tools',
    items: [
      { name: 'Cars, drivers and teams', where: ['Settings', 'Cars, drivers and teams'], href: '/garage',
        what: 'Cars with their number, model and loggers; drivers, teams, vehicles, and tyres with their P-Book pressures.' },
      { name: 'Seasons', where: ['Settings', 'Seasons'], href: '/seasons',
        what: 'Each championship season: our entry, its rounds as planned events and their entry lists. The official timetable names each run. Update from the series’ site brings in changes.' },
      { name: 'Light or dark', where: ['Settings', 'Appearance', 'System, Light or Dark'],
        what: 'How the app looks. System follows the phone or computer.' },
    ],
  },
];

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const wordsOf = (s: string) => fold(s).match(/[\p{L}\p{N}%+]+/gu) ?? [];

/** The parts with the functions that have every word typed at the start of one of theirs ("tc" finds TC, not
 * "switch"; any case, any accents, any order); a part found by its own name keeps all its functions. No words: every
 * part. */
export function findInManual(parts: ManualPart[], query: string): ManualPart[] {
  const words = wordsOf(query);
  if (words.length === 0) return parts;
  const has = (text: string) => {
    const own = wordsOf(text);
    return words.every((w) => own.some((o) => o.startsWith(w)));
  };
  return parts.flatMap((p) => {
    if (has(p.title)) return [p];
    const items = p.items.filter((i) => has([p.title, i.name, ...i.where, i.what].join(' ')));
    return items.length ? [{ ...p, items }] : [];
  });
}
