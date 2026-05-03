# Gameplay

## Premise

The Model Forge is a turn-based ML production simulator. You manage a model in production across 14 in-game days while incidents, tradeoffs, and operational pressure stack up.

## Goal

Finish the run with the strongest possible outcome by balancing:

- model quality
- operational cost
- reliability and SLA adherence
- long-term stability
- final score and grade

## Core loop

Each day:

1. A new incident or business pressure appears.
2. You choose from a set of mitigation or optimization actions.
3. The game updates metrics and downstream effects.
4. Your choices influence future days and the final result.

## Main systems

### Metrics

The game tracks several live metrics, including:

- Precision
- Recall
- SLA Adherence
- Feature Freshness
- Inference Cost
- Data Skew

### Scoring

Your final score reflects how well you handled the run. The game also assigns a grade.

### Scenarios

Runs may start in different scenarios such as the default path or special themed paths. Scenario choice changes the types of incidents and tradeoffs you face.

### Persistence

You can save and resume runs with a session ID or an account-backed save.

## Accounts and saves

- **Guest play** works without an account.
- **Registered accounts** save progress automatically.
- **Login** restores your account save.
- **Recovery codes** let you reset your password without email.
- **Username lookup** helps you find an existing account before logging in.

## Leaderboard

Winning runs can appear on the leaderboard. Entries show the run outcome, scenario, day reached, score, and other summary stats.

## Tips

- Protect the production model first; short-term wins can create long-term problems.
- Watch cost and skew as closely as precision and recall.
- Later incidents often compound earlier mistakes.
- Use recovery codes only if you need account access back.

## What makes a good run

A strong run usually means:

- keeping the model stable
- avoiding runaway costs
- handling incidents with minimal downstream damage
- finishing the full 14 days in a strong state
