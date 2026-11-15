# Law review subject tags: live progress

**The page:** https://nathanreitinger.github.io/lawrank-progress/

A live progress page for a research project that gives every law review paper on a list of 583,596 papers its
abstract or first pages, codes subject labels for training and testing, and trains our own model to tag each paper
with its subjects. The tags will go paper, then professor, then school on the
[law school rankings site](https://nathanreitinger.github.io/lawRankings/).

The page shows:

- the five phases (collect, labels, model, the v0.9 beta, the v1.0 public release) and where the project is now;
- what is running and must keep running, with each job's pace over the last 10 and 60 minutes;
- what the beta and v1.0 releases mean, their checklists, and rough dates (always marked as estimates, with their
  assumptions);
- recent events, and links.

The numbers are refreshed every minute on the project owner's computer by a read-only collector that reads the
running jobs' own logs and state files and the small heartbeat files some jobs write for this page. The newest status
goes to this repository's `live` branch every minute (one data file, replaced each time; GitHub Pages does not build
it), and the page with its data goes to GitHub Pages from `main` every 10 minutes (`main` is never force-pushed).
Every change is checked for keys, tokens, addresses, local paths and long texts before it is committed and again
before it is pushed. The page shows progress facts only: counts, rates, phases and dates. It never shows paper texts,
labels, keys or addresses.

Data: `site/status.json` (the latest status; the newest copy is on the `live` branch) and `site/history.jsonl` (a
point a minute for the last 6 hours, then one per 10 minutes; at most 3,600 lines).
