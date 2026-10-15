

## Desktop and phone controls

Crew is available beside Orchestra on desktop and in the phone project tabs.
Pick Ship, Fan-out or Race in Play and limits before starting the next goal.
Each active seat shows its own work, goal spend and native context epoch. The
board keeps Planned -> Building -> Review -> Testing -> Ready to integrate -> Done;
Race waits for Choose this result before integrating a winner.

Pause finishes active turns and then prevents new turns. Resume keeps a plan
waiting for approval. Budget and team holds explain why work stopped. A native
recovery warning requires inspecting/reconciling the action first; Resume is
not offered while the receipt is uncertain. Refresh context starts a new
native epoch only when it is safe to do so.

Team requests and runner crews contains encrypted requests for owner approval
and remote runner progress. Start composer goal on my runner queues the goal
text from the composer; the runner's plan still needs the owner's approval.
Completed runner goals provide Review PR; humans merge them.

Crew cards also appear in the ordinary Board with their crew, stage and seat.
These are scheduler-owned cards; open Crew to control them. Fleet includes
active crews, and a crew notification opens the corresponding Crew view.

CLI examples:

```powershell
loom crew pause --crew ship
loom crew resume --crew ship
loom crew pick --crew ship --to builder-2
loom crew budget --crew ship --amount 15
loom crew overlap --crew ship --card c12 --decision narrow --touches 'src/api/**'
loom crew refresh --crew ship --to reviewer
loom crew deliver --crew ship
```

Physical native-phone acceptance, hosted migration acceptance and trusted
installer signing are separate checks. The local browser checks and native
Windows orchestration evidence do not substitute for them.
