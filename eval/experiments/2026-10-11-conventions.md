# How a cloud engineer reads the questions (2026-10-11)

**Pattern.** After the `ids` rule, the remaining failures were readings, not searches:
- "Which instances can connect to rds-commerce-prod-4?" was answered from security-group rules, not permissions;
- "Which resources are reachable from the largest number of distinct compute instances?" counted security groups;
- queues were listed as "storage" ("What storage can the dev compute resources access?") and as "data" ("Which production data resources have no monitoring?").

**Hypothesis.** Stating the interpretations a cloud engineer brings to this estate fixes these readings. If the interpretations are general domain knowledge rather than patches for these questions, they should also hold on questions the eval does not ask.

**Change.** A conventions section in the prompt (`src/agent/conventions.ts`). To keep it general, an engineer explored the live graph without seeing the questions, the key or any run, and wrote the reading guide it would hand a new hire. The prompt carries its interpretations:
- environment from names;
- business areas;
- the graph over the descriptions;
- permission is not usage;
- calls are not network rules;
- exposure;
- monitoring;
- dead-letter queues;
- deployment;
- encryption;
- direct versus transitive impact;
- "none" versus "not recorded";
- counting distinct resources.

Two words allow two readings, and the guide and the key differ on them:
- **"Reach" and "connect".** The guide reads network rules; the key reads permissions. Here the security-group rules admit none of the declared service calls (instance 01 calls instance 05, yet no rule admits 01's group to 05's), so they cannot show that a connection works. The convention follows permissions, and the agent says in its prose when the two layers disagree.
- **"Storage".** The guide reads buckets only; the key reads buckets and databases. The convention follows the key.

| Prompt | Passed (3 runs) | Precision | Recall |
| --- | --- | --- | --- |
| `317b9644` (before) | 20, 21, 21 | 84–86% | 88–92% |
| `1f77e706` (after) | 24, 25, 25 | 92–96% | 91–94% |
| `44a02d08` (the guide's two readings instead, rejected) | 22, 21, 21 | 86–91% | 83–85% |

**Moved.** The connect, most-reachable, storage and unmonitored-data questions went from 0 or 1 of 3 runs to 3 of 3. Tool calls fell by about 10%.

**Regressed.** "The instances described as order-flow: which data resources do they actually have access to?" went from 2 of 3 runs to 0 of 3. Its key counts four queues as data resources, while the key for "Which production data resources have no monitoring?" counts none, although 14 of the 16 production queues have no monitor. One convention cannot satisfy both answers; this one follows the second. The reading was raised with dave.io and confirmed by Melih Bahar on 11 Oct: queues are not data resources.

**Verdict:** kept, with the guide's readings measured and rejected.
