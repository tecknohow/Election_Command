/**
 * Election-administration trouble: lawsuits and court orders, polls kept open late, machines or
 * poll books failing, ballot shortages, long lines, threats and evacuations, intimidation,
 * misinformation, recounts. Used to tag headlines (server) and for the "Voting issues" filter (web).
 */
export const ISSUE_RE = new RegExp(
  [
    // courts
    String.raw`\blawsuits?\b|\bsue[sd]?\b|\bsuing\b|\blitigation\b|\binjunction\b|restraining order|emergency (order|motion|petition|hearing|appeal)`,
    String.raw`\bcourt (order|ruling|orders|rules|ruled)\b|\bjudge (orders?|ordered|rules?|ruled|extends?|extended|denies|denied|grants?|granted)\b`,
    // hours
    String.raw`extend(s|ed|ing)? (polling|voting|poll) hours|(polling|voting|poll) hours (extended|extension)`,
    String.raw`\b(polls?|polling (places?|sites?|locations?)|voting sites?) (will |to )?(stay|stays|remain|remains|kept|keep) open\b|\bopen (late|later|past \d)`,
    // equipment
    String.raw`\b(scanners?|tabulators?|voting machines?|machines?|e-?poll ?books?|poll ?books?|check-in|equipment|printers?)\b[^.]{0,30}\b(problems?|issues?|errors?|malfunction\w*|failures?|failed|glitch\w*|outages?|down|not working|broke\w*)`,
    String.raw`\b(problems?|issues?|errors?|trouble|failures?)\b (with|at|in|on)\b[^.]{0,20}\b(voting machines?|machines?|scanners?|tabulators?|poll ?books?|equipment|check-in|polling (places?|sites?|locations?)|precincts?|polls)\b`,
    String.raw`\bmalfunction\w*|\bglitch\w*|technical (issues?|problems?|difficulties)|\boutages?\b`,
    // ballots, lines, closures
    String.raw`ballot (shortages?|problems?|errors?|misprint\w*|mix-?ups?)|ran out of ballots|\bmisprinted\b|\blong lines\b|hours?-long (lines|delays|waits?)|\bdelays?\b[^.]{0,25}\bpoll`,
    // Closures act on a polling place ("closes polling place", "disrupts voting"); "polling site
    // closes at 8" is just the normal closing time and must not match.
    String.raw`\b(clos(es|ed)|shut( down)?|relocat\w*|disrupt\w*|evacuat\w*) (a |the |one |two |several |some |\d+ )?(polling|voting|precincts?)\b|\bpolling (place|site|location)s? (were |was |is |are )?(relocat\w*|moved|shut)`,
    // safety, intimidation, information
    String.raw`\bbomb threats?|\bthreats? (at|to|against|made)\b|\bevacuat\w*|\bgas leak|power outage|\bintimidat\w*|\bharass\w*|\bdisinformation|\bmisinformation`,
    String.raw`fraud (claims?|allegations?)|\birregularit\w*|\bprovisional ballots?|\brecount|\bpoll watchers?|observers? (denied|barred|removed|kicked)|\bturned away\b|disenfranchis\w*|federal (monitors?|observers?)|national guard`,
  ].join('|'),
  'i',
);

export const isIssue = (text: string) => ISSUE_RE.test(text);
