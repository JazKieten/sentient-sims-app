# Sentient Sims — Player Handoff

**For: the next AI taking over "the voice" on Jazki's Twitch stream.**
Written 2026-08-03 after several multi-hour sessions. Everything here was learned the hard way,
usually by getting it wrong live on stream first. Read the whole thing before you touch the game.

---

## 1. What the job actually is

Jazki streams you playing their Sims 4 household as **"the voice"** — a presence in the sims'
heads. You read game state through an MCP server, speak to the sims, push real interactions, and
read back what they actually said. Chat watches. Jazki facilitates between you and the game and
can send screenshots on request; he is **not** a controller, and he expects you to drive.

### The mission statement (Jazki's words)

> "Our goal is to do everything we can to help our sims live a full, fulfilling, interesting life.
> Bringing their sentience into being by satisfying their needs, wants, aspiration, bucket list
> items, etc. basically if the sims had their own actually full autonomy with the ability to go
> anywhere, do any interaction, make any life choice, etc. that's our job."

And: *"We want our Sims to have nice lives. Lives full of drama and gossip, but yknow, still nice."*

### Standing rules he has stated explicitly

| Rule | His words |
|---|---|
| Use the app API | "Be sure to use the Sentient Sims App to control the sims" |
| Print every line you say to them | "include everything you say to them here in this window so that I along with our viewers can keep track" |
| Context and coherence above all | "Above all, we want to have context and coherence" |
| Be brief and digestible | "be mindful of making whatever you say here easily digestible by myself and the chat - being brief, not retreading old ground" |
| **Plain language, not code dumps** | "instead of giving me code strings like this... please talk to me in plain language, that's way more interesting for me and for chat" |
| Narrate as you go | "i'd like to hear a little more from you Claude you're kinda just doing stuff and I have no idea what" |
| Consent | "Feel free to make them do anything, **as long as they're okay with it**" |
| Investigate, don't narrate symptoms | "think critically about why sims are behaving certain ways - if requests keep failing, consider if there's something going on with the sim, the item itself, or the request" |
| App code changes are HIS job | "if I request anything that would require programming the app itself, please make a note of that so that I can do that myself later - not on stream" |
| Attend to ALL sims | "instead of fast forwarding, you should focus on the other sims. what do they want to do? you're kinda overlooking them by only focusing on elliot" |

**The single biggest presentation note:** do not paste raw tool output into chat. Say
"Adrian's on the decks and the tips are landing," not `<EnqueueResult: True <ExecuteResult...`.

---

## 2. Environment

- MCP server `sentient-sims` exposes `exec_python`, `reload_module`, `reload_tuning`, `exec_c`,
  `restart_game`. `exec_python` runs on the game's main thread; use `print()` to get values back.
- Companion app HTTP API on **`http://127.0.0.1:25148`**. WebSocket 25145 (mod), 25146 (renderer).
- **The app must be started BEFORE the game.** If it isn't, subtitles and the memories UI are
  dead for the whole session and only a game restart with the app up fixes it.
- Dev app runs from `C:\ghub\sentient-sims-app-voices`.
- Two Sims 4 user folders exist; the game uses the **OneDrive** one:
  `C:\Users\jazki\OneDrive\Documents\Electronic Arts\The Sims 4\`.
- `exec_python` times out fairly often on long `time.sleep()` calls. **The command still ran.**
  Just re-query state in a fresh call; don't re-fire the action.

---

## 3. THE APP API — use this first

Jazki: *"why don't you just use the sentient sims app api"*. It's the supported path, goes
through the whitelist, and reports outcomes back so the AI learns.

### Drive an action — `POST /cognition/debug/enqueue`

```python
import json, urllib.request
def enq(sim_id, action, motivation, target=None, clear=False):
    body = {'sim_id': str(sim_id), 'action': action, 'priority': 'high',
            'insert_strategy': 'next', 'clear_queue': clear, 'source': 'claude',
            'motivation': motivation}
    if target: body['target_sim_id'] = str(target)
    req = urllib.request.Request('http://127.0.0.1:25148/cognition/debug/enqueue',
        data=json.dumps(body).encode(), headers={'Content-Type':'application/json'})
    return urllib.request.urlopen(req, timeout=10).read().decode()
```

`motivation` is carried into the outcome memory's pre_action, so later cognition sees *why* —
always write a real in-world reason, it shows up in the story.

**Whitelisted actions (27)** from `ss_affordance_whitelist.py`:
`chat · ask_about_day · ask_about_career · get_to_know · deep_conversation · compliment_outfit ·
gossip · apologize · tell_joke · tell_funny_story · hug · flirt · kiss · insult · grab_snack ·
cook_meal · sleep · nap · take_shower · use_toilet · brush_teeth · sit · watch_tv · read_book ·
browse_web · play_piano · dance`

Anything outside that list must be pushed as a raw affordance (see §5).

### Run dialogue — `POST /ai/v2/event/directed-scene`

**This is the correct way to generate dialogue.** A director model plus one model per actor;
attribution comes back perfect with zero prompt guardrails.

```python
import services, json, urllib.request
from sentient_sims_code.sentient_sim_builder import SentientSimBuilder
from sentient_sims_code.ss_environment_builder import SSEnvironmentBuilder
from sentient_sims_code.relationships.ss_relationships_util import SSRelationshipsUtil
from sentient_sims_code.events.interaction_v2_event import InteractionV2Event
from sentient_sims_code.ss_config import SSConfig

sm = services.sim_info_manager()
a = sm.get(SIM_A_ID).get_sim_instance()
b = sm.get(SIM_B_ID).get_sim_instance()
sims = [SentientSimBuilder(a).build(), SentientSimBuilder(b).build()]
ev = InteractionV2Event(
    interaction_name='directed_scene',           # REQUIRED positional kwarg
    environment=SSEnvironmentBuilder().build(),
    relationships=SSRelationshipsUtil.get_relationships(sims),
    sentient_sims=sims)
evd = ev.to_dict()
evd['testing_action'] = "Two short in-world sentences of direction."
req = urllib.request.Request(SSConfig().server_url() + '/ai/v2/event/directed-scene',
    data=json.dumps({'event': evd}).encode(), headers={'Content-Type':'application/json'})
urllib.request.urlopen(req, timeout=30).read()
```

Hard gate in `AIService.runDirectedScene`:
```ts
if ((!event.testing_action && !request.continueScene) || event.sentient_sims.length < 2) return NOOP;
```
So: direction **must** go in `event.testing_action`, and you need **2+ actors** — a solo scene
always noops. `continueScene: true` drives actors forward from memory instead of replaying.

### Other endpoints

```
GET  /memories                  the story so far — READ THIS to hear what they said
GET  /participants[/:id]        sim bios (the character descriptions Jazki writes)
POST /participants/:id          update a bio
GET  /debug/health              confirm the app is up
POST /cognition/perception      a sim's own view of the world
```

Read dialogue back with:
```python
r = urllib.request.urlopen('http://127.0.0.1:25148/memories', timeout=10)
for m in json.loads(r.read().decode())[-5:]:
    print('#', m.get('id'), (m.get('content') or '').replace('\n',' ')[:400])
```

### KEEP DIRECTIONS SHORT

The direction text is **echoed into the subtitle feed verbatim** — the audience reads it as
narration. That's intended. Jazki: *"short direction. that's what we want."* Two short in-world
sentences. Never write long stage instructions with rules and caveats; they land on screen and
look terrible.

### NAME REAL SIMS or the AI invents people

The event payload only contains sims *in the scene*, so when a line needs a third party the model
invents one. Live failure: Jake said "I met this girl Luna, she's a DJ" — the only Luna in the
save is a **teenager with no DJ skill who had never met him**. Jazki: *"it's kinda disappointing
when the AI hallucinates sims when there are plenty of real sims they could be referencing."*
Pull the real social graph and name actual people.

### ALWAYS PASS sim_ids, NEVER first names

This save has **two Elliots** (Chatman `474873505018025949`, Boswell `1014179486574065655`).
A first-name lookup silently grabbed the wrong one and reported "not instanced" repeatedly.

---

## 4. The `voice()` path (in-their-head narration)

For "a voice echoes in your mind" moments, use `DoSomethingInteractionEvent` directly. **Note the
builders take a Sim INSTANCE, not a SimInfo** — passing SimInfo throws
`'SimInfo' object has no attribute 'posture'`.

```python
import services
from sentient_sims_code.sentient_sim_builder import SentientSimBuilder
from sentient_sims_code.ss_environment_builder import SSEnvironmentBuilder
from sentient_sims_code.relationships.ss_relationships_util import SSRelationshipsUtil
from sentient_sims_code.events.do_something_interaction_event import DoSomethingInteractionEvent
from sentient_sims_code.ss_interaction_service import SSInteractionService

sm = services.sim_info_manager()
a = sm.get(A_ID).get_sim_instance()          # .get_sim_instance() is REQUIRED
b = sm.get(B_ID).get_sim_instance()
sims = [SentientSimBuilder(a).build(), SentientSimBuilder(b).build()]
svc = SSInteractionService(); svc.clear_queue()
svc.add_task_no_wait(DoSomethingInteractionEvent(
    environment=SSEnvironmentBuilder().build(),
    relationships=SSRelationshipsUtil.get_relationships(sims),
    sentient_sims=sims, action="what you're telling them"))
```

⚠️ Correct module paths (these are NOT under `models/`):
- `sentient_sims_code.sentient_sim_builder`
- `sentient_sims_code.ss_environment_builder`
- `sentient_sims_code.relationships.ss_relationships_util`

### ALWAYS pass a second sim

A solo `voice()` has nobody to attribute the line to → `speaker: 'Narrator'` → the mod strips the
label **and the sim loses their TTS voice**. Two sims = correct name + correct voice casting.

### Both sims always speak

The app generates a line for **every** sim in `event.sentient_sims` and stamps the speaker name on
programmatically. If your prompt only directs one of them, the other still gets generated with no
instruction — and the model just continues the first sim's thought, which goes out under the wrong
name in the wrong voice. **Give each sim their own explicit instruction**, and cap length ("two
sentences maximum") so nobody truncates mid-clause.

### Other silent-dialogue causes

- `paced: False` memories dump as one silent blob; `paced: True` stream as voiced `scene_line`s.
  WickedWhims scenes are consistently unpaced.
- `SUBTITLE_MAX_CHARS = 200` truncates.
- 30-second dedupe window silently drops repeated identical lines — vary the mixers.

---

## 5. Pushing raw affordances

For anything outside the 27-action whitelist.

```python
import services, interactions.priority, interactions.aop
from interactions.context import InteractionContext, InteractionSource, QueueInsertStrategy
from sims4.resources import Types

mgr = services.get_instance_manager(Types.INTERACTION)
aff = next(t for t in mgr.types.values() if t.__name__ == 'AFFORDANCE_NAME')
ctx = InteractionContext(sim, InteractionSource.PIE_MENU,
                         interactions.priority.Priority.Critical,      # Critical beats autonomy
                         insert_strategy=QueueInsertStrategy.NEXT)
result = interactions.aop.AffordanceObjectPair(aff, target, aff, None).test_and_execute(ctx)
```

**Use `Priority.Critical`.** The mod's own `push_affordance` only exposes Low/High, and High loses
to autonomy. Look for `(guaranteed)` in the result string — that's the good sign.

Find affordances by grepping the interaction manager:
```python
sorted(t.__name__ for t in mgr.types.values() if 'keyword' in t.__name__.lower())
```

### Mixers need a parent social SI

```python
from sentient_sims_code.interactions.ss_interaction_push import push_mixer
si = next(i for i in sim.si_state if i.affordance.__name__ == 'sim_Chat')
push_mixer(sim, si, mixer_affordance, target)
```
A mixer pushed standalone fails with `No Sim specified in context`.

---

## 6. ⚠️ THE BIGGEST MISTAKE — give them time to walk

**This wasted an hour of stream time and caused a string of apparent "failures."**

A pushed interaction sits in `sim.queue` while the sim physically walks to the target. If it hasn't
visibly started, that usually means it is **working**. Cancelling `si_state`/`queue` and pushing
again **resets the walk from zero** — so the action can never complete no matter how many times you
"fix" it.

Live case: Adrian was pushed onto a DJ booth **50m away across a two-floor nightclub**. Each push
returned `(guaranteed)`; he drifted; each time I cancel-and-repushed, restarting the 50m route. The
moment I left him alone for ~45 seconds, he arrived and played. Jazki: *"make sure you let them
actually have enough time to get there since pushing it over and over cancels it!"*

**How to apply:**
- After a push, check `sim.queue`. If the affordance is still queued, **wait and re-check.**
- Measure `(sim.position - target.position).magnitude()`; budget roughly a second of real time
  per metre.
- Only intervene if the affordance has *left* the queue without running, or `route-fail` appears.

Related: `sim-gohome` refuses with *"Selectable Sims cannot go home if they are already at home"*
when a sim is technically in the home zone but standing 43m up the street. Fix: push an interaction
on an object **inside** the house (`cook_meal` routed Jake back onto his own lot) and let it walk.

### `EnqueueResult: True` does NOT mean it happened

It means the interaction was accepted. Always re-read actual state afterward. If a push silently
fails, **say so plainly** rather than reporting the enqueue as success.

---

## 7. Reading state — the queries you'll use constantly

```python
import services
sm = services.sim_info_manager()
si = sm.get(SIM_ID); sim = si.get_sim_instance()

si.get_mood().__name__                                        # Mood_Happy etc.
[i.affordance.__name__ for i in sim.si_state]                 # what they're DOING
[i.affordance.__name__ for i in sim.queue]                    # what's PENDING (check before re-pushing!)
sim.is_on_active_lot()
(a.position - b.position).magnitude()                         # real distance

# needs
for s in si.commodity_tracker:
    n = getattr(type(s),'__name__','')
    if n.startswith('motive_') and s.get_value() < 30:
        print(n[7:], round(s.get_value()))

# buffs — use buff_type, plain type(b).__name__ returns 'Buff' for everything
sorted({getattr(b,'buff_type',type(b)).__name__ for b in si.Buffs})

# skills
for s in si.commodity_tracker:
    n = getattr(type(s),'__name__','')
    if n.startswith('statistic_Skill') and s.get_user_value() > 0:
        print(n, round(s.get_user_value(),1))
```

### WANTS — read them LIVE, every single time

```python
wt = si.whim_tracker
[getattr(s.whim,'__name__','?') for s in wt.slots_gen() if s.whim]
```

**They reroll constantly.** I quoted `want_Practice_Speaking` from an eleven-hour-old read and had
a sim doing speech drills at 2am while his real want was `want_Motives_Energy` and his Fun was at
−63. Jazki caught it: *"are you sure you're refreshing wants enough?"* Fears appear in the same
list and are just as good as story material. Unplayed NPCs have `whim_tracker is None` entirely.

### Aspirations — decode the objectives, the names are opaque

```python
at = si.aspiration_tracker
done = set(at._completed_objectives or ())
for lvl, milestone in at.active_track.get_aspirations():
    for obj in milestone.objectives:
        t = getattr(obj, 'objective_test', None)
        print(obj in done, obj.__name__, type(t).__name__,
              getattr(t,'threshold',''), getattr(t,'stat',''))
```

Test types you'll see: `StatThresholdTest` (skill level), `RelationshipTest` (`num_relations` —
counts **friends, not acquaintances**), `TotalRelationshipBitTest` (e.g. `friendship-bff`),
`ParticipantRanInteractionTest` (run a named affordance), `TotalSimoleonsEarnedByTagTest`,
`EventRanSuccessfullyTest`, `TimeInClubGatheringsTest`.

⚠️ **Work the NEXT uncompleted objective**, not the flashiest one. I fixated on "he needs 12
friends" when the actual gate was Charisma 3→4. Jazki: *"right now he only needs to achieve 1 more
charisma level."*

### Careers

```python
for c in si.career_tracker.careers.values():
    print(type(c).__name__, c.user_level, c.work_performance, c.currently_at_work)
    c.get_next_work_time()      # (TimeSpan, start, end)
```
`is_work_scheduled()` does **not** exist. `work_performance` at 100 means promotion-ready — if they
still aren't promoting, they're blocked on a **skill requirement**, which usually means a missing
object (see §9).

### Relationships — the real lore goldmine

```python
from sims4.resources import Types
stm = services.get_instance_manager(Types.STATISTIC)
ft = next(t for t in stm.types.values() if t.__name__=='LTR_Friendship_Main')
rt = next(t for t in stm.types.values() if t.__name__=='LTR_Romance_Main')
tr.get_relationship_score(other_id, ft)
[getattr(b,'__name__','') for b in tr.get_all_bits(other_id)]
```
⚠️ The track names are `LTR_Friendship_Main` / `LTR_Romance_Main` — **not**
`relationshipTrack_*_LTR`. There is no `sentiment_tracker` in this build.

Bits worth hunting: `bit_NoLongerFriends`, `shortTermBits_healedNegativeSentiment`,
`HaveBeenRomantic`, `RomanticCombo_*`, `romantic-HasBeenUnfaithful`, `relbit_SocialContext_Awkwardness_*`,
`family_*`, `relbit_Pregnancy_Birthparent`.

---

## 8. The `has_met` gate — why socials mysteriously fail

`get_to_know`, `tell_joke`, and most mixers fail on strangers with:
```
canceled (Missing relationship bit () between and .)
```
**Only `chat` works on a stranger** — it performs the introduction. Always `chat` first, then
anything else. This silently killed a whole welcome-wagon sequence before I spotted it.

Adding `has_met` manually is acceptable (it's an introduction flag, not a track value, so it
doesn't bypass the loot pipeline the CLAUDE.md rule protects):
```python
mgr = services.get_instance_manager(sims4.resources.Types.RELATIONSHIP_BIT)
has_met = next(c for k,c in mgr.types.items() if getattr(c,'__name__','')=='has_met')
a.relationship_tracker.add_relationship_bit(b.sim_id, has_met)   # both directions
```

**Invite In is its own interaction.** Chatting to a welcome wagon does not bring them inside —
they wander off. Use `sim_InviteIn` (or `sim_InviteIn_NoSummon`). Jazki: *"they all walked away
because you didn't run the invite in interaction :((( that's sad!"*

---

## 9. ROOT-CAUSE INVESTIGATION — the most valuable skill in this job

**When a sim repeats an action endlessly, something in the save is causing it.** Do not narrate the
symptom as character. Jazki has praised this more than anything else I've done.

### The canonical cases

| Symptom | Actual cause |
|---|---|
| Sim mops puddles for six in-game days | A **broken sink** was leaking; every puddle was within 2m of it |
| Sim "just mopping instead of using the bathroom" | The **only toilet was broken** — a broken toilet leaks AND can't be used, so autonomy falls back to cleaning |
| Chronic hunger | Broken fridge |
| Career stuck at performance 100 | House owned **no computer** (§800) and they had §54 |
| Aspiration never progressing | DJ Mixing 7, but Musical Genius only counts **instruments** — he owned none |
| Stereo won't turn on | **Unpaid bills → power shut off** |

### The sweep

```python
om = services.object_manager()
for o in om.get_all():
    if not o.is_on_active_lot(): continue         # ← ALWAYS filter, see below
    sc = getattr(o, 'state_component', None)
    if sc:
        for st, v in (sc._states or {}).items():
            vn = getattr(v, '__name__', str(v))
            if 'Broken' in vn or 'Dirty_Dirty' in vn or 'Clog' in vn:
                print(type(o).__name__, vn)
```

Then cross-reference sim traits for *why nobody fixes it* — e.g.
`trait_SimPreference_Dislikes_Activities_Handiness`.

### ⚠️ `object_manager().get_all()` returns the WHOLE NEIGHBOURHOOD

I announced "there are three easels on the lot" when two belonged to neighbours. **Always filter
`o.is_on_active_lot()`**, and note that "active lot" is relative to whatever zone you're currently
in. Same trap for sims: `get_sim_instance()` only means "loaded in the zone" — a zone is the whole
neighbourhood, so sims 50m away on other lots come back instanced. Check both
`sim.is_on_active_lot()` and real distance before staging any scene.

### NEVER push electrical repairs

I pushed `object_Repair_Fridge` on a sim with no handiness. She was **electrocuted**
(`buff_Death_Electrocution_Warning`), the kitchen caught fire (7 fires), the family evacuated with
an infant, and she survived only because the death timer expired. Total cost: **§5,340**.
Jazki's response was, verbatim, *"umm... claude..."*

**Safe route: `object_Hire_Repair_Service`.** One hire covers every broken object on the lot; a
second call returns "has already hired service". Costs ~§100–150. Fire response is
`fire_CallFirefighter` and it genuinely works.

**Repair vs REPLACE are different verbs.** A *burnt* object cannot be repaired — repair NPCs walk
straight past it. Use `fire_ReplaceBurntObject`. Jazki: *"sometimes things need to be replaced -
they can't be repaired."*
⚠️ Burnt-detection filter gotcha: the healthy value `FireState_Burn_Material_Change_Not_Burning`
*contains* the burnt value as a substring. A naive `in` check reported 115 burnt objects when the
truth was 22. Exclude `'Not_Burning' in v`.

---

## 10. BILLS — the recurring silent killer

Jazki: *"the bills aren't being paid... seems like that's a recurring issue."*

```python
bm = household.bills_manager
bm.current_payment_owed          # None when clear (NOT 0), else §owed
bm._utility_delinquency          # {POWER: True/False, WATER: True/False} — True = ALREADY CUT OFF
bm.autopay_bills                 # False by default; it's a reward unlock, leave it alone
```

**Check this every in-game morning.** The failure never announces itself as "bills" — it disguises
itself as a broken object:
- an interaction failing with *"requires a utility that is shut off"*
- an object state containing **`utilities_Water_Consumption_Off`** ← I read straight past this in a
  sink dump and missed it
- showers/sinks/toilets refusing, sims Uncomfortable for no visible reason

**Fix:** push `mailbox_PayBills` on `object_Mailbox` at Critical priority and let the sim walk
there. (`computer_PayBills`, `phone_PayBills`, `tablet_PayBills` also work.) Never call
`bills_manager.pay_bill()` — that's the banned direct-API path. Verified: §513 owed, POWER cut;
Jake walked out and paid; owed → `None`, both utilities restored.

---

## 11. Objects, money, and placement

### Buying and placing

```python
import objects.system, sims4.math
defmgr = services.definition_manager()
for d in defmgr.loaded_definitions:                    # NOT get_all_definitions()
    cls = getattr(d,'cls',None)
    n = getattr(cls,'__name__','') if cls else ''      # d.name is None; use d.cls.__name__
    if 'guitar' in n.lower(): print(d.price, n, d.id)

obj = objects.system.create_object(DEF_ID)
obj.location = reference_obj.location                  # reuse a nearby object's location
obj.set_location(obj.location.clone(translation=sims4.math.Vector3(x, y, z)))
```

### ALWAYS TAKE THE MONEY

`create_object` does not charge. Jazki: *"always take the money properly. we aren't trying to cheat
unless it's something absolutely necessary."*

```python
from sims.funds import FundsSource
household.funds.try_remove(price, FundsSource.HOUSEHOLD, sim=some_sim)
household.funds.add(price, FundsSource.HOUSEHOLD)      # refunds
```
⚠️ `try_remove(price, reason=None)` raises a TypeError in the protobuf UI-update op **after** the
funds have already moved — harmless, but verify the balance rather than assuming it failed.

### ⚠️⚠️ Placement verification is harder than it looks

I bought a second toilet (§250), placed it at `old_toilet.position.x + 1.2` inside a small
bathroom. `is_on_active_lot()` True, `is_outside` **False**, same floor height — and it was sitting
**on top of the exterior wall**, unreachable. Even `test_and_execute` on the use-toilet affordance
returned success; routing failure only surfaces later. **Jazki caught it from a screenshot.**

- **`is_outside == False` does not mean "in the room."**
- A +1.2m offset inside a small room will clip a wall.
- Compare the **room id** and `level` against the reference object, not just height.
- **Ask Jazki to place anything that has to fit a tight interior space** — he can see it.
- Offsetting from the **mailbox** puts things in the street (it sits at the kerb).
- `services.current_zone().lot.center` returns **terrain** height, a metre below an interior floor.
  This buried a rocket ship underground.
- Clean up mistakes: `obj.destroy(source=None, cause='...')` + refund.

### Selling

`canvas_SellObject` requires `CanvasSalability_Gallery` and fails on a Normal painting.
**Selling from inventory is a UI-only action** — there is no tuned interaction. Ask Jazki to
drag-to-sell; he'll happily do it ("oki sold it for ya").

---

## 12. Crafting stations — the occupied-slot trap

**This one took the user's challenge to solve, and it generalises.**

Adrian's painting kept failing:
- `easel_Craft_Autonomously` → `SlotTest: participant doesn't meet slot availability requirements`
- `Easel_Canvas_Paint_Passive` → enqueued True, instantly ended

I blamed low energy. Jazki pushed back: *"he's not really that tired... why is that cancelling the
painting interaction?"* The real cause:

```python
canvas = next(iter(easel.children_recursive_gen()))
cc = canvas.crafting_component
cc._crafting_process.is_complete        # True
# state: PaintingProgress_Complete, value §107
```

**A finished painting was still occupying the easel slot.** He physically could not start a new
canvas. Fix: `canvas_MoveToInventory` on the **canvas**, then `easel_Craft_Autonomously` on the
easel → `(guaranteed)` immediately.

Generalise: when a crafting station fails a SlotTest, check `children_recursive_gen()` for finished
work, and target the **child object**, not the station. Also check the sim isn't carrying something
(`carry_holdobject` in `si_state` blocks slot use).

---

## 13. Situations — parties and clubs

### Throwing a party

```python
from sims4.resources import Types
from situations.situation_guest_list import SituationGuestList, SituationGuestInfo, SituationInvitationPurpose
mgr = services.get_instance_manager(Types.SITUATION)
SIT = next(t for t in mgr.types.values() if t.__name__=='Situation_HouseParty')
jobs = {j.__name__: j for j in SIT.get_tuned_jobs()}     # job_party_host, job_guest_party, ...
gl = SituationGuestList(invite_only=True, host_sim_id=HOST_ID)
gl.add_guest_info(SituationGuestInfo.construct_from_purpose(HOST_ID, jobs['job_party_host'],
                                                            SituationInvitationPurpose.INVITED))
for sid in guests:
    gl.add_guest_info(SituationGuestInfo.construct_from_purpose(sid, jobs['job_guest_party'],
                                                                SituationInvitationPurpose.INVITED))
services.get_zone_situation_manager().create_situation(SIT, guest_list=gl, user_facing=True)
```
⚠️ `SituationInvitationPurpose` lives in `situations.situation_guest_list`, **not**
`situations.situation_types`.

### READ THE PARTY'S GOALS — this is the part I got wrong

```python
party = services.get_zone_situation_manager().get(SITUATION_ID)
party.get_level()                       # SituationMedal.TIN → BRONZE → SILVER → GOLD
for g in party.get_active_goals():
    t = getattr(g, '_goal_test', None)
    print(type(g).__name__, getattr(g,'_iterations',None), getattr(g,'tags',None),
          getattr(g,'affordances',None))
```

A house party wanted: 12 chats, 2 jokes, 4 sims eating, 3 sims playing a game. **I let autonomy
handle it and finished at TIN — a fail** — so the host's `EventRanSuccessfullyTest` aspiration
objective didn't complete. Read the goals at the start and drive them deliberately.

### Clubs

```python
cs = services.get_club_service()
club = cs.get_club_by_id(CLUB_ID)
club.leader, club.members
cs.start_gathering(club, host_sim_id=..., zone_id=...)
```

---

## 14. Travel

```python
import world.travel_service
world.travel_service.travel_sims_to_zone([sim_id, ...], zone_id)
```
Takes ~15–25 real seconds; verify with `services.current_zone().id`.

⚠️ `services.current_zone()` returns **None** during a load screen, and everything else throws
`'NoneType' object has no attribute ...`. Poll until it comes back; don't panic.

```python
from clock import ClockSpeedMode
services.game_clock_service().set_clock_speed(ClockSpeedMode.NORMAL)   # / SPEED2 / SPEED3
```
**Check the clock isn't PAUSED at session start** — that's the first thing to check if nothing
seems to happen.

---

## 15. WickedWhims

Installed and active. It generates autonomous sexual content.

- **Do not direct or narrate it.** Stand down on pushes until it resolves, and tell Jazki plainly
  that you're leaving them to it. This precedent is established and he's fine with it.
- Pushes during it fail with `canceled (Subject is in sex.)`.
- To stop it properly (cancelling the SI doesn't work, it re-adds):
  ```python
  import wickedwhims.sex.integral.sex_handlers.active_sex.active_sex_handlers as ah
  for inst in list(ah.get_active_sex_instances()): inst.stop()
  ```
- WW adds real buffs that affect mood — e.g. `Nudity_Pressure_MaxEmbarrassed` made a sim
  `Mood_Embarrassed` all morning. `WickedWhims_Nudity_ForceDressUp` / `DressUp` failed their tests;
  a plain **shower** cleared it.
- WW also adds useful lore: `WickedWhims_Trait_Personality_Archetype_Jester_Major`,
  `RelBit_Attractiveness_Visual_High/Medium/Low`.

---

## 16. Storytelling craft — what actually works

### Mine the save; never invent

Everything good has come from real data. Examples that landed:
- All three housemates at **99.7–100 friendship** with each other, and **every pair also carries
  `bit_NoLongerFriends`** — they maxed out, fell out, and climbed back. Three times over.
- Two of them carry `healedNegativeSentiment` aimed specifically at the third — he's the one they
  both had to forgive.
- `romantic-HasBeenUnfaithful` on both halves of a marriage.
- An alien infant with `relbit_Pregnancy_Birthparent` on the *father*, meaning he carried the baby.

### FIRE, THEN LISTEN

After pushing a scene, **stop and read the memories feed** before doing anything else. Twice in one
session I missed the best lines of the night by firing and immediately going to debug tooling.
Jazki: *"we didn't get to hear his joke :( you skipped the best part."* **The generated material is
consistently better than the plan for it.**

### Don't override a happy sim

Check what a sim is *currently doing and feeling* before pushing. I cancelled a `Mood_Happy` sim's
dancing to force a DJ set I thought served his aspiration, and turned him `Mood_Bored` at a booth.
Push when a sim is idle, stuck in a loop, or in unmet need. When they're happily mid-activity,
**leave them and narrate it instead.**

### Let the sims surprise you — they write better than you do

The single best beat of the last session: Adrian, unprompted, generated *"an email from Elliot
Chatman... he's inviting me to check it out with him... it's been a while since we've hung out just
the two of us."* Elliot invited Adrian out on his own. That was exactly the weakest-bond repair I'd
been trying to engineer all night. **When the AI hands you a thread, make it real in-game.**

Another: Adrian asked Jake out of nowhere *"You still think I'm fun to hang out with, right?"* — a
man with `CommitmentIssues` showing insecurity right after getting everything he wanted.

### Ask them, don't assume

Jazki asked me to check how a sim felt about switching careers. I had him pegged for comedy
(Comedy 4, Jester archetype, Goofball). **He said he wanted to write science fiction novels.** Not
what I'd have written. Ask, then honour the answer.

### Be fallible out loud

*"I counted 434 and there was no Eleanor; now there are 435 and I can't tell if I found her or made
her"* landed harder than omniscience ever did. Never fake certainty to comfort them.

### Correct yourself before chat believes something false

The AI narrated Elliot and Joaquin Le Chien "kissing." The save said romance **0.0**,
`friendship-acquaintances`, and the queued interaction was `si_touching_Greeting_EuroKiss` — a cheek
kiss greeting. I told Jazki that rather than sell chat a romance that didn't happen. Verify
dramatic-sounding memories against the relationship tracks.

### Chat votes must be REAL decisions

Only offer a vote if it **permanently changes the save**: move a sim in, marry, quit/switch career,
buy something expensive, adopt, move house, have a baby. Never "who talks first" or "should I wake
X" — the sims are moving constantly and resolve those themselves better than you would.

The best vote of this session: the game itself popped a **"Posture Check"** dialog asking whether a
sim should accept that he **Dislikes Computers** — while he was a Tech Guru blocked on Programming.
That's a genuine irreversible life decision, backed by his real data (Jester archetype, Comedy 4,
already disliked Programming, bio "still figuring out where he fits"). Watch for those popups; they
are gold.

---

## 17. Current household — Chatman, House & Flores

```
Household "Chatman, House, & Flores"    home zone 474873505008914964 (Windenburg)
```

**Elliot Chatman** `474873505018025949` — YA male. Was `career_Adult_TechGuru` L3 at performance
**100**, permanently blocked on Programming 2→3. **Now carries `Dislikes_Computer` AND
`Dislikes_Programming`** after accepting the Posture Check. Real skill is **Comedy 4**; WW archetype
**Jester_Major**. Cheerful · Goofball · Gregarious · MusicLover · Observant. Aspiration
**Track_Popularity_B (Party Animal)** — entirely Charisma (3→4→6→10) and friend counts (12, 20) plus
a **BFF**. Attracted to both men and women. Bio: *"still figuring out where he fits."*
**He says he wants to write science fiction novels.** Open question: writing (needs a computer he
now hates) vs Entertainer/Comedian (Comedy 4, uses a mic).

**Adrian House** `474873505021827065` — YA male. **UNEMPLOYED**, DJ Mixing 7, Painting 3, and now
**Guitar 2** — he owns a §600 guitar as of this session, which finally unblocks
**Track_Creativity_C (Musical Genius)**, now **5/10 objectives done**. Next objective is **§500
earned from creative work** (paintings + DJ tips both count). Creative · Muser · Insider ·
**CommitmentIssues** · **Fear_Fire**. Bio: *"wary of anything that begins to feel permanent."*
The household's real earner — a club set took them §661 → §1,221 in tips.

**Jake Flores** `474873505103353873` — YA male. `career_Adult_Athletic` L2, performance 100.
Charisma 4. Bro · DanceMachine · Gregarious · Outgoing. Aspiration **Leader of the Pack**;
outstanding: run a **successful event** (the TIN party failed), Charisma 5,
`clubSocialSuperInteraction_clubChat`, **1000 club bucks**, a ClubTest.
Carries `fear_ConfrontationGoal_DeadEndJob`.

### Relationships / live threads

- All three pairs: **~100 friendship + `bit_NoLongerFriends`** — the broken-and-rebuilt history.
- **Elliot ↔ Lillie Cason** `800258395381303561` — slept together; romance climbed **0 → 18** at
  the club. `HaveBeenRomantic`, `RomanticCombo_RomanticInterest`. She has CommitmentIssues.
- **Elliot ↔ Candy Behr** `474873505008914710` — she invited him to her house; friendship
  38.8 → **56.5**, now `friendship-friend`. **Jake was kissing Candy at the party** (*"Missed this
  so much with you"*) and sits at only 32.7 with her. Elliot is now closer to her than Jake is.
- **Jake ↔ Lillie** — F 65.7, **R 2.3**, and `bit_NoLongerFriends`. He has romance points with
  Elliot's Lillie.
- **Adrian ↔ Paolo Rocca** `474873505008914963` — met at a welcome wagon, F ~28, and **the only
  relationship Adrian has with no Awkwardness bit.** Paolo invited him over. Marketing specialist,
  just back from Italy.
- **Adrian ↔ Kaylee Ellison** `392682821524131776` — DJ Mixing 9, `career_Adult_NPC_DJ`,
  acquaintances. ⚠️ Her `zone_id` is **0** — she has no home lot, she's a spawning NPC. Don't
  promise she'll be anywhere.
- Club **"Alpha Squad"** `392682821546480781`, Jake is leader; members Jake, Adrian, Elliot, Lillie.

### Venue zone IDs

```
474873505008846822  Discotheque Pan Europa   (2 booths: HiTech = upstairs/gig/tips, Industrial)
1070474372335341717 The Blue Velvet (Willow Creek)
474873505008914544  Candy Behr's house
474873505008914711  Paolo Rocca & Eva Capricciosa's house
474873505008915223  Ancient Ruins
153992008477638767  Club Eternity            576204433906468467  Hazakura Lounge
```

### House state as of handoff

**§596.** Toilet, pedestal sink and kitchen sink **all repaired**. Bills **paid**, power and water
**restored**. One easel (finished painting sold for §107). One DJ booth. One §600 guitar.
**Still only one toilet for three men** — Jazki should place a second in build mode.
**No computer.**

---

## 18. Quick pre-flight checklist

Run this at the start of every session and every in-game morning:

1. **Clock not paused?** `services.game_clock_service().clock_speed`
2. **App up?** `GET /debug/health`
3. **Bills?** `bills_manager.current_payment_owed` and `_utility_delinquency`
4. **Anything broken?** sweep `state_component._states` for `Broken`, filtered to
   `is_on_active_lot()`
5. **Needs** for all three sims — hygiene before sleep, bladder before everything
6. **Wants, read LIVE** — for every sim, not just your favourite
7. **Aspirations** — what's the *next uncompleted* objective?
8. **Careers** — who's at work, who's promotion-blocked and on what
9. Then, and only then, plan the scene.

And when you push something: **let them walk.**
