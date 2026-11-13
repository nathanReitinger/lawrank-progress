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

The numbers are refreshed every 10 minutes on the project owner's computer by a read-only collector that reads the
running jobs' own logs and state files; nothing in a job was changed to report progress. Every change is checked for
keys, tokens, addresses, local paths and long texts before it is committed and again before it is pushed, and the
push is never forced. The page shows progress facts only: counts, rates, phases and dates. It never shows paper
texts, labels, keys or addresses.

Data: `site/status.json` (the latest status) and `site/history.jsonl` (one line per update, the last 3,000).
