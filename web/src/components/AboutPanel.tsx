import { useEffect } from 'react';

const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer noopener">
    {children}
  </a>
);

/** In-app disclaimer and data-source attributions (opened from ⚙ Settings). */
export function AboutPanel({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal about" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="About and data sources">
        <div className="modal-head">
          <h2>About, sources &amp; disclaimer</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <section>
          <h3>Disclaimer</h3>
          <ul>
            <li>
              <b>Unofficial.</b> Election Command is an independent personal project. It is not affiliated with, endorsed by or sponsored by any of the organizations below.
            </li>
            <li>
              <b>Not an official results source.</b> Numbers are collected automatically from third-party feeds and may be delayed, incomplete or wrong. Official results come only from
              state and local election officials and are certified days or weeks after Election Day.
            </li>
            <li>
              <b>Race calls are projections.</b> Calls come from the Associated Press (via The New York Times) or CNN's decision desk, not from election officials.
            </li>
            <li>
              <b>Forecasts are opinions.</b> FLIPR (Silver Bulletin) and Cook Political Report ratings are third-party assessments, shown as categories tracked on Wikipedia.
            </li>
            <li>
              <b>Prediction-market prices are not probabilities or advice.</b> Polymarket prices reflect what traders are paying. They are shown for information only and are not an
              endorsement of Polymarket or of betting, and not financial advice.
            </li>
            <li>
              <b>Simulated data is labeled.</b> The simulator is visible only to the site admin; simulated screens carry a SIMULATION badge and banner.
            </li>
          </ul>
        </section>

        <section>
          <h3>Data sources &amp; attribution</h3>
          <table className="about-table">
            <tbody>
              <tr>
                <td>Results, race calls, expected vote, county results, candidate photos</td>
                <td>
                  <A href="https://www.nytimes.com/interactive/2026/11/03/us/elections/results.html">The New York Times</A> (data from the Associated Press); candidate photos © The New
                  York Times
                </td>
              </tr>
              <tr>
                <td>Backup results &amp; calls, ballot-measure results</td>
                <td>
                  <A href="https://www.cnn.com/election/2026">CNN</A>
                </td>
              </tr>
              <tr>
                <td>Forecast ratings, seat holders, ballot-measure list, numbers &amp; descriptions</td>
                <td>
                  Wikipedia contributors, licensed <A href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</A>:{' '}
                  <A href="https://en.wikipedia.org/wiki/2026_United_States_Senate_elections">Senate</A>,{' '}
                  <A href="https://en.wikipedia.org/wiki/2026_United_States_gubernatorial_elections">gubernatorial</A>,{' '}
                  <A href="https://en.wikipedia.org/wiki/2026_United_States_House_of_Representatives_elections">House</A>,{' '}
                  <A href="https://en.wikipedia.org/wiki/2026_United_States_House_of_Representatives_election_ratings">House ratings</A>,{' '}
                  <A href="https://en.wikipedia.org/wiki/2026_United_States_ballot_measures">ballot measures</A>. Ratings originate with{' '}
                  <A href="https://www.natesilver.net/">Silver Bulletin</A> (FLIPR) and <A href="https://www.cookpolitical.com/">The Cook Political Report</A>.
                </td>
              </tr>
              <tr>
                <td>Ballot-measure names &amp; links</td>
                <td>
                  <A href="https://ballotpedia.org/">Ballotpedia</A>. Names are taken from the Ballotpedia pages that Wikipedia's ballot-measure list cites; each measure links
                  to its Ballotpedia page, or to Wikipedia when there isn't one.
                </td>
              </tr>
              <tr>
                <td>Prediction-market odds</td>
                <td>
                  <A href="https://polymarket.com/">Polymarket</A>
                </td>
              </tr>
              <tr>
                <td>Congressional district boundaries</td>
                <td>
                  U.S. Census Bureau, <A href="https://www.census.gov/geographies/mapping-files/time-series/geo/tiger-line-file.html">TIGER/Line 2026</A> (public domain), simplified
                  for display
                </td>
              </tr>
              <tr>
                <td>State &amp; county shapes</td>
                <td>
                  <A href="https://github.com/topojson/us-atlas">us-atlas</A> (ISC license), derived from U.S. Census Bureau cartographic boundary files
                </td>
              </tr>
              <tr>
                <td>Headlines</td>
                <td>© their respective publishers; each headline links to its source.</td>
              </tr>
            </tbody>
          </table>
          <p className="muted small">
            All trademarks belong to their owners and are used only to identify data sources. Source code is MIT-licensed; see NOTICE.md in the repository for full notices.
          </p>
        </section>
      </div>
    </div>
  );
}
