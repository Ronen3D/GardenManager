# How Garden Manager Builds a שבצ״ק: An End-to-End Walkthrough

This document explains, in plain language, exactly what happens between the moment the user clicks **"צור שבצק"** and the moment a finished **שבצ״ק** is shown on the screen.

It is meant for product people, planners, team leads, and anyone who wants to understand the reasoning behind the numbers, the warnings, and the decisions the system makes — not for developers reading the source. It avoids implementation jargon and instead describes what the system actually does, in the order in which it does it, and why each step is there.

The intent is also to demystify the algorithm itself: what it explores, what it accepts, what it rejects, and what it gives up on.

---

## Table of Contents

1. [Mental Model: What a שבצ״ק Is](#mental-model-what-a-שבצק-is)
2. [Stage 0 — Before the User Clicks "צור שבצק"](#stage-0--before-the-user-clicks-צור-שבצק)
3. [Stage 1 — Preparing the Generation Request](#stage-1--preparing-the-generation-request)
4. [Stage 2 — Materializing the Work to Be Scheduled](#stage-2--materializing-the-work-to-be-scheduled)
5. [Stage 3 — Building the Generation Context](#stage-3--building-the-generation-context)
6. [Stage 4 — The Multi-Attempt Strategy](#stage-4--the-multi-attempt-strategy)
7. [Stage 5 — The Greedy Construction Phase](#stage-5--the-greedy-construction-phase)
8. [Stage 6 — The Local Search Improvement Phase](#stage-6--the-local-search-improvement-phase)
9. [Stage 7 — Post-Search Cleanup and Polish](#stage-7--post-search-cleanup-and-polish)
10. [Stage 8 — Per-Attempt Final Validation and Scoring](#stage-8--per-attempt-final-validation-and-scoring)
11. [Stage 9 — Choosing the Winning Attempt](#stage-9--choosing-the-winning-attempt)
12. [Stage 10 — Finalising and Freezing the שבצ״ק](#stage-10--finalising-and-freezing-the-שבצק)
13. [Stage 11 — Live Mode Anchor and Past-Day Freeze](#stage-11--live-mode-anchor-and-past-day-freeze)
14. [Reference: Hard Constraints in Plain Language](#reference-hard-constraints-in-plain-language)
15. [Reference: Soft Scoring in Plain Language](#reference-soft-scoring-in-plain-language)
16. [Reference: When Things Cannot Be Solved Cleanly](#reference-when-things-cannot-be-solved-cleanly)

---

## Mental Model: What a שבצ״ק Is

A שבצ״ק is a complete plan covering a configurable number of operational days (1 to 7). It pairs every required slot of every scheduled task with exactly one participant, while respecting absolute "must-not-violate" rules (hard constraints) and minimising a numeric penalty that captures fairness, rest, daily balance, preferences, and other softer concerns (soft constraints).

The system thinks in terms of **operational days**, not calendar days. An operational day starts at a configurable hour (default 05:00) and runs for 24 hours. So a task at 02:00 belongs to the previous operational day's late-night tail, not to a fresh day.

Throughout the document, "the planner" or "the system" refers to the engine that performs the search; "the user" refers to the human running it.

---

## Stage 0 — Before the User Clicks "צור שבצק"

Before the button is even visible, the system continuously runs **preflight checks** in the background as the user edits participants, task rules, and the schedule period. The button is disabled if any **critical** preflight finding is present, and the user is told exactly which issues block generation.

The preflight pass asks four questions:

### 0.1 Skill Gap

For every slot of every task in the current configuration, the system asks: *Is there at least one participant in the master list whose level and certifications match this slot?*

- **No participant matches** → critical finding. The system refuses to generate, because no algorithm can fix a slot that has nobody in the world who is allowed to fill it.
- **Exactly one participant matches** → warning. Generation can proceed, but the user is told which slot has zero redundancy: the moment that single person is unavailable, the slot will be unfillable.

The same questions are asked for one-time tasks that fall inside the chosen schedule window.

### 0.2 Capacity (Workload Density)

The system measures total available participant hours within the schedule window and compares them to the total hours required by all tasks (slots × duration × shifts × days).

- Required hours **above** total available hours → critical finding. There is mathematically not enough labour to staff the schedule. Generation is blocked.
- Required hours above 90% of available hours → warning. Schedules at this density are still possible but tend to leave very little rest between assignments and may be hard to balance.

Total available hours respect master-data availability, recurring weekly unavailability rules, and any holes the user has carved into participants' schedules.

### 0.3 Group Integrity (for "same group required" tasks)

Some tasks (for example, the משימה משותפת family) require all of their slots to be filled by participants from the same group. For those tasks, the system asks: *Is there at least one group whose members can — together — cover every slot, matching each slot's level and certification requirements?*

This is a **bipartite matching** question, not a simple cardinality check. The reason is subtle but important: a group with five members can still fail to cover four slots if the people who hold a rare certification overlap in a way that forces a slot to be left uncovered. The system uses an exact matching primitive (augmenting-path matching) to answer this question correctly.

- **No group can cover all slots** → critical finding. Generation is blocked.
- **At least one group can cover, but some groups cannot, and the task has multiple shifts per day** → warning. The schedule can be generated, but rotation between groups across shifts will be limited.

### 0.4 Zero-Slot Tasks

A task defined with no slots is allowed to exist as configuration but produces a warning, because it will never appear in the שבצ״ק. The user is told to add slots if they want the task scheduled.

### What the user sees

When everything is green, the button shows **"⚡ צור שבצ״ק"** and is enabled. When critical issues exist, it is replaced by a list of the specific problems and the button is disabled. When there is already an existing שבצ״ק but data has changed since it was generated, the button changes to **"🔄 צור מחדש"** and a "not up to date" notice appears. Past schedules do not silently change; the user must explicitly regenerate.

---

## Stage 1 — Preparing the Generation Request

When the user clicks **"צור שבצק"**, the system gathers everything it needs to begin.

### 1.1 Read the inputs

It reads:

- **Participants**, including their level, certifications, group, master availability windows, recurring weekly unavailability rules, "preferred" and "less-preferred" task names, and any "not-with" partner exclusions.
- **Task rules** ("חוקי משימות"): each task type's recurrence (shifts per day, duration, start hour), its slots and sub-team slots, the levels and certifications each slot accepts, the "low priority" markers on certain levels, the load profile of the task, the rest rule it belongs to (if any), and its sleep-and-recovery rule (if any).
- **One-time tasks** that fall inside the selected schedule window.
- **Algorithm settings**: the scoring weights, the list of hard constraints the user has globally disabled, and the operational day boundary hour.
- **Schedule period**: the chosen start date and the number of operational days (1–7).
- **Number of attempts**: how many independent solver runs to perform. The default is 60 unless the user has changed the number in the box next to the button.
- **Continuity hand-off**, if the user has supplied a previous schedule snapshot. This causes "phantom" assignments from the prior schedule to be carried into the new run so that constraints like minimum rest, no-consecutive-heavy and rest rules see across the boundary between the old plan and the new one. Phantom assignments influence eligibility but never appear as visible assignments in the new שבצ״ק.

### 1.2 Decide which constraints are active

The user may globally disable individual hard constraints from the algorithm settings panel. The set of *currently disabled* hard constraints is captured **once** at the start of generation. From that moment on, the engine, the optimiser, the validator, the rescue tools and every other consumer use the *same frozen set*. The system never silently re-applies a constraint the user has turned off, and a feasibility precheck never blocks something a globally-disabled constraint would have blocked. Disable is an all-or-nothing global switch — there is no per-task or per-injection knob to relax constraints.

### 1.3 Switch to the schedule view, show the progress overlay

The UI switches to the שבצ״ק tab, shows the current schedule (if any) behind a frosted overlay, and displays a live progress card with:

- The current attempt number out of the total.
- The best composite score found so far.
- The number of unfilled slots in the best-so-far result.
- A "★ improvement" flash whenever a new attempt beats the previous best.
- A **cancel** button (throws the run away and keeps whatever was on screen).
- An **"accept best so far"** button (stops the loop early and uses the best result so far, after at least one attempt has completed).

The overlay updates surgically — the rest of the page does not re-render between attempts, which keeps the UI responsive while the search runs in the background.

The system also yields back to the browser between batches of attempts, so the spinner animates and clicks on cancel and accept-best are processed promptly.

---

## Stage 2 — Materializing the Work to Be Scheduled

The user's task rules are recurring templates: "this kind of task happens every day, in this many shifts, with these slots." Before any scheduling can happen, those templates must be expanded into concrete dated tasks.

### 2.1 Recurring tasks become dated instances

For every operational day in the schedule period, and for every task template, the system creates one **task instance per shift**. Each instance receives:

- An anchored start time computed from the operational-day base, the day index, and the template's start hour. If the template's start hour is earlier than the operational day boundary, the time is correctly placed on the post-midnight tail of the same operational day, never on the wrong day.
- A duration calculated from the template's hours-per-shift and shift count.
- A copy of every slot the template defines, including sub-team slots, with the same level requirements, required certifications, and forbidden certifications. Each slot gets a fresh, unique identity within the task.
- All the structural flags from the template that downstream constraints care about: whether it requires the same group across all slots, whether it blocks consecutive heavy work, whether it is "togetherness-relevant" (for the "not-with" rule), its base load weight, its load windows, its rest rule, its sleep-recovery rule, and the shift index (1, 2, 3...) within its day.

Tasks generated this way also carry display metadata (color, source name) for the schedule grid and exports.

### 2.2 One-time tasks join the task set

Any one-time task whose scheduled date falls inside the chosen window is also expanded into a single dated task instance. It contributes its own slots, its own load profile, its own rules, and so on — exactly like a recurring instance, but unique to its date.

### 2.3 Slots that cannot be staffed are filtered defensively

A slot whose level list is empty would be impossible to fill by definition. The system silently skips such slots when materialising tasks, so they cannot pollute the search.

### 2.4 The schedule period is anchored

The system records the absolute start of operational day 1 and the number of days the schedule spans. These two numbers become the **frozen schedule period** — every later step (display, export, rescue, future-SOS, validation) reads them from the schedule itself, never from the live configuration. This is what guarantees that editing the schedule period after generation does not shift days under the user's feet.

### 2.5 Phantom assignments from continuity, if any

If the user supplied a previous שבצ״ק snapshot for continuity, the relevant trailing assignments from that snapshot are loaded into a separate "phantom" lane. They do not become real assignments and never appear in the output. They exist only so that constraint checks like minimum rest, no-consecutive-heavy, and category breaks can see them and block placements that would violate continuity. The rest rules referenced by phantom tasks are also merged into the active rule map so durations carry across.

By the end of Stage 2, the system has a complete, dated, slot-by-slot task set, a participant list, a frozen schedule period, a frozen disabled-constraints set, and any phantom history needed for continuity.

---

## Stage 3 — Building the Generation Context

Before the first attempt runs, the system computes a small but important set of derived signals that will be reused across every attempt. These signals come from analysing the *structure* of the problem — they do not depend on any random ordering, so they can be computed once.

### 3.1 Eligibility pools per slot

For every slot, the system counts how many participants in the master list pass the static level / required-certification / forbidden-certification filters. This is the slot's "candidate pool size".

The minimum across a task's slots becomes that task's **bottleneck pool size**. A task whose tightest slot has only two eligible people in the world is a much harder problem than a task whose tightest slot has thirty.

### 3.2 Certification rarity

For every certification the system computes the share of the participant pool that does NOT hold it, on a 0-to-1 scale. A certification held by only 10% of the team has a rarity of 0.9. Tasks that require a rare certification will be scheduled earlier (see Stage 5).

### 3.3 Senior count by group

For every group the system counts how many of its members are seniors (any level above the most junior). This is used to estimate "senior pressure" for same-group tasks: a task that needs many senior slots from the same group, when most groups only have a few seniors, must be scheduled very early.

### 3.4 Low-priority placement risk

A slot may mark a level as "low-priority" — meaning the level is *acceptable* but only as a last resort, with a heavy soft penalty. For every task the system estimates whether the pool of normally-acceptable participants is large enough to cover the low-priority slots without forcing a low-priority placement. When this risk is positive, the task becomes an early-scheduling candidate so the system has freedom to place its non-last-resort participants first.

### 3.5 Effective hours by task

Using the task's duration, slot count, and load-weight profile (base weight plus any load windows), the system computes an "effective hours" number per task. This becomes the unit of fairness throughout scoring: a participant's workload is the sum of effective hours of the tasks they are assigned to, not raw clock duration. Tasks marked "light" or with low base load weight contribute less. Tasks with zero effective load contribute nothing to the workload at all.

### 3.6 Per-participant capacity

For every participant the system walks every operational day in the window and adds up how many hours fall inside their availability windows on that day. The result is a per-participant total and a per-day breakdown. This drives:

- The **proportional fairness target**: a participant who is available 60% of total team-hours expects 60% of total team-load, not the flat average. Without this, people with lighter availability would always look "underloaded" and the optimiser would keep trying to push more on them.
- The **daily balance** signal: days where a participant has zero available hours are excluded from their per-participant daily standard deviation, so an unavailable day does not look like an "imbalance".

### 3.7 The "not-with" pair map

Any participant who has marked one or more partners they should not be co-scheduled with on togetherness-relevant tasks has those exclusions loaded into a quick-lookup structure for the scoring step.

By the end of Stage 3 the system has a complete, factual picture of the difficulty of the problem and is ready to run attempts.

---

## Stage 4 — The Multi-Attempt Strategy

The planner does not run the algorithm once. By default it runs it 60 times and keeps the best result. Why?

### 4.1 Why many attempts

Real schedules have many local optima — points where no single change improves the score, but a different starting decision earlier in the construction would have led somewhere better. Running with diversity allows the system to escape those plateaus by simply starting from a different angle.

The cost of an attempt is small: each one is a complete construction plus a bounded local search. Running tens of attempts in a few seconds is normal. The quality gain is significant, especially when the problem is tight (high utilisation, few certified people, many same-group tasks).

### 4.2 What is different between attempts

Attempts share the participant list and the task set, but each attempt is randomised in three independent ways:

1. **Participant order**: the participant list is shuffled before each attempt (except the very first attempt, which uses the original order so the result is deterministic when run with one attempt). Shuffling matters because, when two candidates are equally good, the one listed earlier wins; shuffling explores alternate "equally good" choices.
2. **Task-order jitter**: from the second attempt onward, every task's scheduling priority is randomly perturbed by ±1 with a 30% probability. The most critical tasks (priority 0) are never perturbed. This causes attempts to schedule tasks in slightly different orders, which avoids re-discovering the same local optimum.
3. **Tiebreakers**: anywhere in the algorithm where two options would otherwise tie, a per-attempt random key breaks the tie. This includes which group to try first for a same-group task, which equally-eligible candidate to pick for a slot, and so on.

### 4.3 Progress, cancellation, and "accept best so far"

After every attempt the system computes whether the attempt **improved** the best-so-far. The progress overlay reflects that immediately. The user can:

- **Cancel** the run. The cancel signal is checked between attempts and inside long inner loops, so the cube animation freezes within a fraction of a second. The previous שבצ״ק (if any) stays on screen unchanged. Nothing is committed.
- **Accept best so far**. This stops the loop after the current batch of attempts and commits whatever the current best is, even if the requested number of attempts has not been reached. The number of attempts that actually ran is recorded in the result so the user knows.

The loop yields back to the browser in small batches so the page stays responsive throughout.

### 4.4 The "elite restart" mechanism

Every 20 attempts, if the current best result has any unfilled slots, the system inspects *which* tasks have unfilled slots and uses that information to make subsequent attempts smarter:

- **Universal ordering boost**: every task with unfilled slots gets a one-tier scheduling boost (its priority is dropped by 10) for the next batch. The reasoning is that an unfilled slot is often curable simply by scheduling that task before its blockers, which is only achievable through the ordering phase. Boosting is universal because the cost of boosting a truly-infeasible task is tiny while the cost of *not* boosting a fixable task is an unfilled slot.
- **Targeted improvement bias**: tasks whose unfilled reason looks like an adjacency conflict (back-to-back heavy work or rest-rule gap) additionally get a bias inside the local-search phase, telling it to spend more of its "try to fill this slot" budget on those specific tasks.

These two mechanisms are additive. A task can simultaneously be in both sets. When the best-so-far becomes feasible (zero unfilled), all elite hints are cleared so the remaining attempts can focus on improving fairness and penalty without distortion from old hints.

### 4.5 The overall run

Each individual attempt is composed of three internal phases (greedy construction, local search, polish), followed by a final per-attempt validation and scoring. The outcomes of the attempts are then compared and the winner is committed. The next sections walk through one attempt in detail.

---

## Stage 5 — The Greedy Construction Phase

This is the first phase of every attempt. It builds an initial שבצ״ק from scratch by walking the tasks in carefully chosen order and filling every slot as best it can.

### 5.1 Ordering the tasks (most-constrained first)

The system uses constraint-type tiers to decide which tasks to schedule first. The intuition is that tight bottlenecks must be resolved before loose ones, because a loose problem is easy to fit around an already-decided tight one but not vice versa.

The natural ordering, from earliest to latest within an attempt, is:

1. **Same-group tasks** (they pin a whole group at a moment in time and constrain everyone else's day).
2. **Tasks that have low-priority placement risk together with required certifications** (penalty-critical and tight).
3. **Tasks restricted to the most junior level only with a required certification** (very tight pool).
4. **Tasks with mixed levels but at least one certification or exclusion** (moderate).
5. **Tasks restricted to the most junior level but with no certifications** (wide pool, easy to fit).

Three structural signals can shift a task one tier earlier: if it requires a particularly rare certification (rarity above 0.7); if it is "sticky" (long duration, blocking, or rest-rule-tagged); or if it has positive low-priority placement risk. Only one of these refinements is allowed per task to keep the ordering stable, and a task can never be shifted earlier than the most critical tier.

Within a tier, two further nudges apply:

- A small bottleneck-based bias: a task whose tightest slot has fewer eligible people sorts a step earlier.
- A random tiebreaker per attempt, which gives the multi-attempt mechanism room to explore.

### 5.2 Ordering the slots within a task (most-constrained first)

Within a single task, slots are filled in descending order of their **minimum accepted level**. Slot eligibility is explicit — a participant qualifies only if their level appears in the slot's `acceptableLevels` list, with no automatic "senior fills lower slots" cascade — so this min-level sort is a heuristic that treats higher levels as the scarcer pool.

The scenario it protects against: within one task, one slot accepts only L4 while another accepts both L3 and L4. Both compete for the senior pool. If the wider slot were filled first, the workload-fairness sort in 5.3 might hand it an L4 on tiebreak, leaving the L4-only slot empty. Filling the L4-only slot first removes that risk. The same logic applies when a slot lists `lowPriority` to mark a senior level as last-resort backup for a junior-targeted slot.

When two slots in a task have disjoint pools (e.g. one accepting only L4 and another accepting only L0), the sort still runs but cannot change the outcome. Rescue and post-generation injection use a stricter variant — they sort by actual candidate count per slot rather than by min level — but greedy construction uses the cheaper level-based proxy.

### 5.3 Choosing a participant for a slot

For every slot, the system collects every participant who passes every active hard constraint, then sorts the survivors by a precise priority. The first one in the sorted list wins.

The sort is a single composite comparator with the following priorities, top to bottom:

1. **For non-same-group tasks**: prefer participants whose level is at *normal* priority for this slot over those whose level is marked *low-priority*. A low-priority participant is a last resort, used only when no normal-priority candidate exists.
2. **Workload fairness (blended, capacity-proportional)**: prefer participants who currently have the most spare capacity. The score reads in utilization space — accumulated hours divided by total available capacity for the schedule, plus hours-on-this-operational-day divided by available capacity for that day, with the day axis weighted twice as heavily as the period axis. This keeps each day balanced while respecting overall fairness, and matches the shape of the SC-3/SC-8 capacity-proportional fairness targets used in the scoring phase, so the greedy result is already close to the proportional optimum that the local-search phase polishes further.
3. **Same-group protection**: when same-group tasks exist, participants from "tight" groups (groups with fewer members eligible for same-group tasks) are slightly deprioritised here, so they remain available when their group is needed. This is a tiebreaker only — it never overrides workload or eligibility.
4. **Task-name preference**: a small nudge toward participants who have marked this task as their preferred type, away from participants who marked it as less-preferred.
5. **Random**: if everything else ties, a per-attempt random key breaks the tie. This is what gives multi-attempt diversity.

There is no separate "exact level match" or "resource conservation" step in the comparator. HC-1 already enforces that every candidate's level appears in the slot's `acceptableLevels` list, so by the time the sort runs there are no "overqualified" candidates to deprioritise. When a slot is configured to accept seniors only as a last resort, that is expressed by marking the senior level with `lowPriority` on the slot — and the very first comparator step (item 1) already pushes those candidates to the back of the queue.

For **same-group tasks**, the comparator is shorter and skips the lowPriority and same-group-protection steps: blended workload comes first; then how many same-group tasks the participant has *already* been assigned (to alternate seniors naturally instead of letting one person hoard the same-group duty); then a tiebreak preferring the lower level when the slot accepts multiple levels (e.g. a slot listing both L3 and L4); then preference; then random.

### 5.4 Filling same-group tasks

Same-group tasks cannot be filled slot by slot — every slot must come from a single group, and choosing the wrong group can make a later slot unfillable.

For each same-group task, the system considers every group as a potential candidate, in order from least-loaded to most-loaded (so groups that have been worked harder by earlier same-group tasks get a break). Within the candidates list of each slot, the per-slot priority sort still applies. For each candidate group, the system asks the matching primitive: *can we cover every slot in this task using only members of this group?*

This is again a bipartite matching question, exactly like in preflight, but now with workload-aware candidate ordering. The matching primitive is exact: it uses augmenting paths so that, when a covering matching exists, one is found, even if a naive "first eligible wins" greedy would have failed.

The first group whose members can cover all slots wins. If none can, the task's slots are recorded as unfilled with a clear reason: "no group can cover all slots; missing level X / cert Y." Cross-group fill is forbidden by the same-group hard constraint, so the system does not attempt it.

### 5.5 What happens when a slot has no eligible candidate

Sometimes the candidate list is empty. Maybe everyone qualified is already booked at this hour; maybe a heavy task ahead in the day is blocking everyone via the no-consecutive-heavy rule; maybe a category break is not yet satisfied for any candidate.

Before giving up on the slot, the system tries a **single-step backtrack chain**:

1. It looks for a participant who would pass static eligibility (level, certification, availability, no forbidden cert) for the target slot, but is currently blocked by one of *their own* existing assignments.
2. It identifies which existing assignment is the blocker — by simulation: it removes one of the participant's current assignments and re-checks eligibility. If removing that assignment makes them eligible, the assignment is the blocker. This is constraint-agnostic: it correctly catches blockers due to overlap, due to back-to-back heavy work, due to category break, or due to sleep-and-recovery.
3. It then searches for a *replacement* who can take over the blocking assignment without violating anything.
4. If both pieces are found, it executes the chain: the replacement takes the blocker's slot, the freed participant takes the target slot. Workload counters and the per-participant index are updated.

A few safeguards:

- The blocker must not itself be a same-group task (rerouting a same-group task would cascade into a group-integrity problem).
- The blocker must not be pinned, manually edited, or frozen (we never overwrite human decisions or past time).

If no chain works, the slot is recorded as unfilled with a specific Hebrew reason — for example, "all candidates with level X + cert Y are blocked by the consecutive-heavy rule" or "all candidates blocked by the rest-rule gap" — together with the constraint codes that dominated the rejections. These codes are passed to the next phase so the local search and the elite-restart mechanism know what kind of failure to attack.

### 5.6 Pinned, manual, and continuity assignments

Any assignments coming in from outside the greedy phase — pinned by a previous run, marked by the user as manual, or seeded as continuity phantoms — are treated as fixed. Greedy never overwrites them, never picks them, and never tries to chain through them.

By the end of greedy, the שבצ״ק is mostly built, but it is rarely optimal. Rest fairness, daily balance, and last-resort placements have not been reasoned about. That is the local search's job.

---

## Stage 6 — The Local Search Improvement Phase

Greedy gives a feasible starting point (or as feasible as it can manage). Local search nudges the result repeatedly toward better composite scores by trying small changes and accepting the ones that help.

The system uses a **simulated-annealing-style** local search. The intuition is borrowed from physical metallurgy: at the start of the search the "temperature" is high, and the algorithm occasionally accepts a move that makes things slightly worse, because the move might open the door to a much better region of the search space later. As the search progresses the temperature decays, the algorithm becomes pickier, and eventually it accepts only strict improvements, settling on the best configuration it can find.

### 6.1 The neighbourhood: two kinds of moves

The local search has two move types it can attempt at each iteration:

- **Swap**: pick two existing assignments at random and exchange their participants. Each swap is checked for hard-constraint feasibility (same level / certifications / availability / no double-booking / etc.) on both ends; an infeasible swap is silently rolled back. A feasible swap is then scored using an incremental scorer that only recomputes the parts of the score affected by the two participants.
- **Insert**: pick a still-unfilled slot at random, then try to find any participant from the pool who is currently eligible for that slot. If one exists and the resulting score (plus a large "feasibility bonus") improves over the current state, the participant is inserted into the slot and the slot is removed from the unfilled list.

When unfilled slots exist, insert moves are picked with a higher probability (50%) — closing the feasibility gap matters more than polishing fairness. When everything is filled, insert moves drop back to a low background probability (20%) so swaps dominate.

When the elite-restart mechanism has flagged certain tasks as adjacency-blocked, insert moves are biased (with 80% probability) toward those tasks specifically. This means later attempts spend their fill-budget where the previous best showed it was needed.

### 6.2 The acceptance rule

For a swap, the change in composite score is computed. If the swap makes things strictly better, it is accepted. If the swap makes things worse, it is accepted with a probability that depends on the temperature: a small worsening is more likely to be accepted than a large one, and high temperature accepts more readily than low temperature. As the temperature decays, the door for accepting worsening moves narrows and eventually closes.

For an insert, the move is gated by an additive feasibility bonus: filling a previously empty slot is always treated as significantly better, even if it slightly worsens fairness, because an unfilled slot is the worst kind of outcome.

The best snapshot seen so far is tracked separately. Even when the algorithm probabilistically wanders to a worse intermediate state, the best snapshot is preserved so the search can return to it.

### 6.3 Cooling and reheating

The temperature decays geometrically (each iteration multiplies the temperature by a constant slightly less than one). When the search has gone many iterations without any accepted change, the algorithm performs a **reheat**: it raises the temperature back up to roughly a third of the initial value and resets the stagnation counter. Reheating gives the search a second wind to break out of a local plateau.

The search is also bounded by:

- A maximum number of iterations.
- A maximum wall-clock time.
- The cancel signal from the user.
- The "accept best so far" signal from the user.

When any of these triggers, the local search exits cleanly with the best configuration it has accumulated.

### 6.4 Why accept worsening moves at all?

If the algorithm only ever accepted improvements, it would get stuck the first time it reached a configuration where every single-step swap is worse than the current state. That configuration may still be far from the best possible. Accepting controlled worsenings lets the algorithm climb over walls between local optima and reach the higher peaks behind them. This is the entire point of simulated annealing.

---

## Stage 7 — Post-Search Cleanup and Polish

Local search terminates with the best configuration it has seen. Two further deterministic sweeps then run, each closing a structural gap that the search neighbourhood cannot reach by design.

### 7.1 The deterministic insert sweep

Stochastic inserts during the local search may have missed some unfilled slots. After the search ends, the system rebuilds the indexes from the best configuration and tries, deterministically, to fill every slot still on the unfilled list. For each remaining slot, every participant in the pool is tried in turn; the first eligible candidate (also not duplicating the same-task or breaking the same-group) is inserted. This is a no-tradeoff cleanup: filling a slot is strictly preferable to leaving it empty, so no scoring is needed.

### 7.2 The "replace assigned with idle" polish

The local search's neighbourhood — pairwise swap and insert-into-empty — cannot reach a configuration where an *idle* eligible participant takes over an *already-assigned* slot. A swap requires both endpoints to be assignments; an insert requires the slot to be empty. So a participant who is sitting on the bench despite being a strictly better candidate for some filled slot is invisible to the search.

The polish closes this gap. It iterates every assignment in the result and asks: *is there any other participant in the pool who could take this slot, and would the composite score strictly improve if they did?* If a strictly better idle candidate exists, the assignment is replaced. The polish:

- Skips same-group tasks (within-group changes are reachable by the search; cross-group is forbidden by the hard constraint).
- Skips pinned, manual, and frozen assignments — those are user decisions or past time and must not be overwritten.
- Accepts only **strict** improvements (above a small numerical tolerance), so it cannot loop or drift.
- Runs at most three full passes; if a pass produces no improvement, polishing ends immediately.
- Reuses the same incremental scorer the local search uses, so each candidate evaluation is cheap.

After the polish ends, the שבצ״ק for this attempt is final and ready to be scored and validated.

---

## Stage 8 — Per-Attempt Final Validation and Scoring

Even though every internal step has been gated by hard-constraint checks, the system performs a fresh, full validation at the end of each attempt. There are two reasons:

1. **The incremental scorer is fast but approximate** — small floating-point drift could, in principle, accumulate over thousands of moves. A clean recomputation removes any chance of acting on a drifted score.
2. **Defence in depth** — every part of the engine writes into a shared structure; running validation independently ensures that the schedule actually satisfies every active hard constraint, not just that the optimiser believed it did.

### 8.1 Hard-constraint validation

Every active hard constraint is re-evaluated against the final assignments. The result is two things:

- A boolean **feasible** flag — true only if every hard constraint passes and every slot is filled.
- A list of **violations** — every individual breach with its constraint code, its task, its slot if relevant, its participant if relevant, and a Hebrew message describing it.

When the validator finds a slot empty (the `SLOT_UNFILLED` code), the engine deduplicates that against the optimiser's richer "infeasible slot" message (which includes the specific reason and constraint codes) so the user does not see the same empty slot reported twice in the violations panel.

### 8.2 Soft-constraint warnings

Several conditions are non-fatal but worth surfacing as **warnings**: low-priority level placements, group mismatches inside same-group tasks (a safety net warning that should never fire if the hard constraint is active), participants assigned to tasks they marked as less-preferred, participants who have a preferred task name that does not exist anywhere in the schedule, and participants whose preferred name exists but who never received any assignment to it.

### 8.3 Composite score

The composite score is the single number the optimiser tries to maximise. Higher is better. It combines:

- **+ minimum-rest weight × global minimum rest gap**. The minimum across all participants of their tightest blocking-to-blocking rest gap. Maximising this raises the floor for the most rest-starved person.
- **+ rest-per-gap weight × Σ √(every gap)**. A concave reward over every individual blocking-to-blocking rest gap. Concavity (square root) means short gaps weigh more than long ones, so improving a 4h gap to 5h matters more than improving an 8h gap to 9h. This complements the minimum-rest term: minimum-rest only sees the worst gap, while this term sees every gap, giving the search a smooth gradient even when several people share the same minimum rest.
- **− L0 fairness weight × standard deviation of effective hours among the most junior pool**. The most junior level is the largest pool and bears the most workload, so its fairness dominates the score.
- **− senior fairness weight × standard deviation of effective hours among seniors**. Seniors are balanced separately; the system never compares senior loads to junior loads, because their roles and pool sizes are different.
- **− daily balance weight × (per-participant daily standard deviation + global daily standard deviation)**. The first term penalises participants whose load is concentrated on a few days; the second penalises schedules where some operational days are loaded much more heavily than others.
- **− low-priority level penalty × (number of low-priority placements)**. Every placement of a participant onto a slot where their level is marked low-priority counts a heavy penalty. The penalty is calibrated to be very large — the system places low-priority participants only when no normal-priority placement is feasible.
- **− "not-with" penalty × (number of forbidden co-assignments on togetherness-relevant tasks)**. For each pair of people one of whom marked the other as "not with", every co-assignment within the same sub-team of a togetherness-relevant task counts once.
- **± task-name preference adjustments**. Each assignment to a participant's less-preferred task name adds a small penalty (stacking). Each participant who has a preferred task name and zero matching assignments adds a one-time penalty. Each assignment to a participant's preferred task name reduces the penalty by a small bonus, giving the optimiser a continuous gradient that keeps assigning preferred tasks beyond the first one.

When fairness is computed, **proportional targets** are used whenever the per-participant capacity data is available: each person's "fair share" is total team-load times their share of total capacity, not the flat pool average. The same proportional logic applies to the daily-balance term — each participant's expected load on a given day scales with that day's share of their available hours, and each day's expected total team-load scales with that day's share of total team capacity. This prevents the system from looking at someone with limited availability and concluding they are underloaded, and prevents reduced-capacity days (Shabbat eve, holidays) from being penalised as "imbalanced".

### 8.4 What the score means

A configuration with fewer unfilled slots is *always* preferred over a configuration with more, regardless of composite score. Within the same number of unfilled slots, the higher composite score wins. The user, indirectly, sees this through the "best score" and "unfilled" numbers in the progress overlay.

---

## Stage 9 — Choosing the Winning Attempt

After every attempt, the system asks: *is this attempt better than the best so far?*

- **Strictly fewer unfilled slots** → this attempt wins, regardless of score.
- **Same number of unfilled slots, higher composite score** → this attempt wins.
- Otherwise → the previous best stays best.

This ordering matters: a beautiful but partial schedule never beats an uglier complete one. Filling slots is a binary correctness concern; balance and rest are continuous quality concerns. The user's first expectation is that the שבצ״ק is complete; everything else is improvement above that floor.

If the loop is interrupted (cancel or accept-best), the best result accumulated up to that point is used. The system records how many attempts actually ran, and the toast at the end says "שבצ״ק generated from N attempts" so the user knows when an early stop occurred.

---

## Stage 10 — Finalising and Freezing the שבצ״ק

The winning attempt is committed as the new שבצ״ק. Several things happen at this moment, all deliberate.

### 10.1 The schedule snapshot

The שבצ״ק is built as a **frozen snapshot** that embeds everything later edits should not be able to silently change:

- The list of tasks, including all their slots and their absolute time blocks.
- The list of participants as they were at generation time.
- The complete list of assignments, including their statuses.
- The feasibility flag, the composite score, and the full breakdown of fairness, rest, daily balance, penalties, and per-pool standard deviations.
- All hard-constraint violations and soft-constraint warnings.
- The full set of algorithm settings — every weight, the disabled-constraints list, and the operational day boundary hour.
- The schedule period (absolute start of operational day 1 and the number of days).
- A snapshot of the rest-rule durations relevant to this schedule.
- A snapshot of certification id-to-label mappings, so cert badges and tooltips render correctly even if the certification labels are renamed afterward.
- An empty list of "schedule unavailability" entries, used later by the Future-SOS feature.
- A timestamp (`generatedAt`) and the actual number of attempts that ran.

### 10.2 Why everything is frozen

The שבצ״ק is meant to be a stable plan. If a user edits a participant's certifications, renames a level, changes the operational day boundary, or disables a hard constraint after the שבצ״ק was generated, the displayed schedule and its KPIs must not silently mutate. Any such edit only sets a "dirty" flag and shows a notice that the שבצ״ק is no longer up to date and should be regenerated. The user is in control.

This is enforced consistently: every screen path that reads schedule data — render, validation, rescue, manual swap, eligibility lookups, day grouping, violation filtering — reads from the frozen snapshot, not from the live configuration. The engine is the single source of truth post-generation.

Pre-schema saved schedules that are missing some of these frozen fields are detected at load time and discarded with a "old שבצ״ק detected, please regenerate" message — there is no migration path that could end up displaying a שבצ״ק whose context is unknown.

### 10.3 Persistence and the toast

The new שבצ״ק is persisted to local storage. If browser storage is full, the user is told the שבצ״ק was generated but not saved (so they know it will not survive a reload). Otherwise a success toast tells them the שבצ״ק was generated, with an indication of how long the run took.

### 10.4 Scrub effects on previous state

Two related modal flows are forcibly closed: any open rescue modal and any open emergency-task injection modal. The new שבצ״ק starts on day 1, the "unsaved snapshot" indicator is set, and any active comparison snapshot is cleared.

---

## Stage 11 — Live Mode Anchor and Past-Day Freeze

If the user has Live Mode enabled, an additional finalisation step runs.

Live Mode is the system's notion of "now": the user controls a time anchor that divides the שבצ״ק into a frozen past and a modifiable future. The anchor never advances on its own — the user moves it explicitly.

When the שבצ״ק is freshly generated and the anchor is set, the system walks every assignment and:

- If the task it points to lies entirely in the future relative to the anchor, the assignment status stays as the optimiser set it.
- If the task lies in the past or straddles the anchor, the assignment is marked **frozen**. Frozen assignments cannot be modified by manual swap, by rescue, by Future-SOS, or by emergency-task injection. The user can still see them, but they are locked as historical fact.

This is what allows the user to keep editing the future of the שבצ״ק without risking that an automated tool rewrites a shift that has already happened.

Emergency-task injection (the 🚨 button) is only available when Live Mode is enabled, because injecting a one-time emergency into a not-yet-real שבצ״ק makes no sense — its purpose is to react to mid-week reality.

---

## Reference: Hard Constraints in Plain Language

A hard constraint is something the שבצ״ק must not violate. If even one is breached, the שבצ״ק is invalid. Every active hard constraint is enforced inside greedy candidate filtering, inside the local search's swap and insert gates, inside the polish, and inside the final validation. The set of currently-active hard constraints is whatever the user has not explicitly disabled.

Each constraint is referenced internally by a code (HC-1, HC-2, etc.); these are also the codes the violations panel displays. The code list has gaps (there is no HC-9, HC-10, HC-13) for historical reasons.

| Code | Plain-language statement |
|------|---------------------------|
| HC-1 | The participant's level must appear in the slot's list of accepted levels. The list is the only source of truth for level eligibility — there is no implicit "higher level always allowed" rule. |
| HC-2 | The participant must hold every certification the slot requires. |
| HC-3 | The participant must be available for the task's entire time block. Availability is the union of their master availability windows minus their recurring weekly unavailability rules and minus any schedule-scoped unavailability windows added by the Future-SOS feature. |
| HC-4 | If the task requires "same group", every assigned participant in the task must belong to one and the same group. |
| HC-5 | A participant cannot be physically present in two overlapping tasks. This applies to *every* task, including light or zero-load tasks — physical presence is exclusive. |
| HC-6 | Every slot in every scheduled task must be assigned exactly one participant. Empty slots and overbooked slots are both violations. |
| HC-7 | A participant is never assigned to two different slots of the same task. Each task gives each person at most one role. |
| HC-8 | When a same-group task is filled, the assigned group must have enough eligible members (matching slot levels and certifications) to cover every slot. Feasibility is decided by exact bipartite matching, not greedy claim-first; the matching primitive correctly handles cases where a rare certification creates an overlap a greedy attempt would have failed. |
| HC-11 | A participant who holds a certification listed in a slot's "forbidden certifications" cannot fill that slot. |
| HC-12 | A participant cannot have two adjacent assignments where the first task blocks consecutive heavy work at its end *and* the next task blocks at its start. The blocking flag has two flavours: a task-level "blocks consecutive" flag that is unconditional (always blocks at both edges), and a per-load-window opt-in that blocks only at whichever edge the window covers. |
| HC-14 | If two of a participant's assignments both reference a rest rule, the gap between them must meet at least the rule's minimum. When the two assignments reference different rules, the smaller rule's minimum applies. The rule is enforced both within rule groups (same rule on both ends) and across rule groups (different rules on each end), checking every forward pair within the longest rule's window. |
| HC-15 | When a task carries a sleep-and-recovery rule, and the assigned shift index is one of the rule's triggering shifts, a recovery window starts at the task's end and lasts the rule's recovery hours. During that window the participant cannot be assigned to any other task that has effective load greater than zero at any instant overlapping the window. The check is symmetric: it fires regardless of which task was placed first. Tasks whose effective load is zero throughout the overlap are allowed inside the recovery window. |

When the user globally disables a hard constraint, every consumer respects that — preflight, the optimiser's eligibility checks, the local search's swap gate, the polish, and the final validator. There is no per-injection or per-rescue knob to relax constraints; disabling is a single global setting.

---

## Reference: Soft Scoring in Plain Language

Soft constraints don't make the שבצ״ק invalid — they make some valid שבצ״קים better than others. The optimiser picks among valid שבצ״קים by maximising a single composite number that rolls up all the soft signals. The exact weights are configurable per algorithm preset.

### Things the system rewards (positive contributions)

- **A larger minimum rest** across all participants. The most rest-starved person's gap between blocking heavy tasks is the floor; raising the floor is rewarded.
- **A larger total of square-rooted rest gaps**. Rewards every individual rest gap, with diminishing returns. This is what gives the search a smooth gradient when many people share the same minimum rest.
- **An assignment to a participant's preferred task name**. A small per-assignment bonus, applied as many times as the preferred name appears in their assignments.

### Things the system penalises (negative contributions)

- **Workload imbalance among the most junior pool**. The standard deviation of effective hours among the most junior level. Targets are proportional to capacity when capacity data is available.
- **Workload imbalance among seniors**. The same idea, in a separate pool. Seniors and juniors are not compared to each other.
- **Daily workload imbalance**. The sum of two terms, each measured against a **capacity-proportional target**: each participant's standard deviation between their daily load and a target that scales with that day's share of their available hours, plus the standard deviation of total team-load on each day vs that day's share of total team capacity. A participant available 4h Monday and 24h Tuesday is expected to carry roughly 6× more load on Tuesday — not equal hours on both. A Friday with reduced team availability is expected to carry less work, not the same as a fully-staffed Sunday.
- **Low-priority level placements**. Every placement of a participant on a slot where their level is marked low-priority adds a heavy penalty. The system uses these placements only when no normal-priority placement is feasible.
- **"Not-with" co-assignments**. For each pair of participants one of whom has marked the other as "not with", every time both end up on the same togetherness-relevant task within the same sub-team adds a penalty. Sub-teams matter because being on the same task in different sub-teams is not really "together".
- **Less-preferred task assignments**. Every assignment to a participant's less-preferred task name adds a small per-assignment penalty (stacking).
- **Unsatisfied preferred task name**. If a participant has a preferred task name and the שבצ״ק contains zero assignments matching it, a one-time penalty applies.

### Things that are warnings only, not part of the score

The system surfaces several warnings that don't change the composite score but are shown in the violations panel. They include: every individual low-priority level placement (so the user can see them at a glance even though the heavy penalty already pushed against them), participants with a preferred task name that does not exist in the שבצ״ק at all, participants whose preferred name does exist but who got no assignment to it, and a safety-net group-mismatch warning (which should never fire if the same-group hard constraint is active and would indicate something bypassed the check).

### Why filling slots is prioritised over beauty

The composite score is the optimiser's quality dimension, but it sits *under* a binary correctness dimension: any שבצ״ק with fewer unfilled slots beats any שבצ״ק with more unfilled slots, no matter how high its score. This is enforced both inside the local search (where filling an empty slot gets a very large additive bonus) and at the multi-attempt level (where the comparison between attempts checks unfilled count before composite score).

---

## Reference: When Things Cannot Be Solved Cleanly

The system tries hard to produce a complete, valid שבצ״ק, but sometimes it cannot. The behaviour in those cases is deliberate.

### Unfilled slots in the result

If the winning attempt still has unfilled slots, the שבצ״ק's `feasible` flag is set to false, and each unfilled slot is reported in the violations panel with:

- The task and the slot it refers to.
- A specific Hebrew reason (for example, "missing level X + cert Y", "blocked by HC-14: minimum gap; all candidates are tied to nearby gap-required tasks", or "no group can cover all slots").
- The constraint codes that dominated the rejections, so the user can see whether the issue is a level/cert gap (structural — needs more eligible people), an adjacency issue (HC-12 or HC-14 — may be fixable by re-running with different randomness or by relaxing a rule), or a rule-of-the-match problem (HC-4, HC-8 — group-level structural).

The schedule remains visible and editable; the user can manually swap to fix slots, or rescue from a participant going offline, or regenerate.

### What "feasible" means on a שבצ״ק

A שבצ״ק is feasible if every hard constraint passes *and* every slot is filled. The same flag is exposed on the schedule object, and the UI uses it to badge the שבצ״ק appropriately. A feasible שבצ״ק can still have many soft-constraint warnings — those are non-fatal.

### Diagnostic reasons and the "why" of each unfilled slot

Every unfilled slot carries a human-readable reason and a list of constraint codes. This is what powers the elite-restart mechanism in the multi-attempt loop: tasks whose unfills are dominated by adjacency conflicts get extra love from the local search; every task with any unfill gets an ordering boost in the next batch. From the user's perspective, the reasons surface in tooltips and in the violations panel so they can decide whether to add a participant, edit availability, change a rule, or accept the gap.

### Cancellation and partial runs

If the user cancels mid-run, no שבצ״ק is committed. The previous שבצ״ק (if any) remains exactly as it was. If the user clicks "accept best so far", the best result accumulated up to that moment is committed exactly the same way a full run would commit — with the actual attempt count recorded in the שבצ״ק so the user can tell.

### When all attempts fail outright

If every attempt throws an internal error (rather than just producing an unfeasible שבצ״ק — which is normal), the system shows an error card explaining that the optimisation failed and inviting the user to inspect constraints and availability. The previous שבצ״ק is left on screen so the user does not lose state.

---

This is the entire path between the click on **"צור שבצק"** and the rendered **שבצ״ק**. Every stage exists for a reason, every stage is observable through the UI in some form (the progress overlay, the violations panel, the warnings list, the freeze indicator), and every stage respects the user's intent: their disabled hard constraints, their algorithm weights, their schedule period, their participants, and their tasks. The system's job is to take those inputs, run a structured search across many attempts, and return the best plan it can construct — together with a complete, honest account of what it had to compromise on.
